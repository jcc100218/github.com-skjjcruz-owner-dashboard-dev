-- ESPN and MFL guests in Mission Control (owner ask 2026-10-12: "we're not
-- tracking the ESPN visitor as a guest and we need those numbers").
--
-- A Sleeper guest is visible because every event carries the handle they
-- connected with (metadata.sleeper / metadata.sleeperUsername). An ESPN or MFL
-- guest has no handle, so their visits only ever showed as anonymous sessions.
-- This function names those sessions, one row per session:
--
--   guest_key   'espn:<league>:<team>' (or 'espn:<league>' when the team is
--               unknown), 'mfl:<league>:<franchise>' likewise
--   guest_label 'ESPN · <team name>', or 'ESPN league <id>' with no name
--
-- A session belongs to an ESPN/MFL guest when it has NO account id, NO
-- username and NO Sleeper handle on any event (those are members or Sleeper
-- guests — never double-counted), and either
--   1. it has a guest espn_connected / mfl_connected event (the connect page),
--      or an event the client stamped with metadata.guestPlatform 'espn'/'mfl'
--      (shared analytics client, from 2026-10-12), or
--   2. it worked in an ESPN/MFL league: league_id 'espn_<id>_<year>' /
--      'mfl_<id>_<year>' (how the app has always stamped those leagues).
-- (2) is what makes history visible: the connect page and the app keep
-- separate session ids, so the app session never had the connect event.
--
-- Older events carry no team id. When the window holds exactly one known team
-- for that league, the team-less sessions fold into it (same person, before
-- and after the team stamp shipped); otherwise they stay keyed by league.
-- Team names come only from the connect events (the team the guest picked),
-- looked up 180 days back so a returning guest keeps their name.
--
-- Read-only, no new columns, no change to existing functions: the test-traffic
-- fence (analytics_test_sessions) and the production fence are applied by the
-- caller (admin-analytics-report) exactly as for Sleeper guests.
--
-- Idempotent (create or replace) — safe to re-run from deploy-functions.yml.

create or replace function public.analytics_guest_sessions(p_since timestamptz)
returns table(session_id text, guest_key text, guest_label text, guest_platform text, league_id text, team_id text, team_name text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with ev as (
    select e.session_id, e.event_ts, e.event_name, e.user_id, e.username, e.league_id, e.metadata
    from public.analytics_events e
    where e.event_ts >= p_since
      and e.session_id is not null
      and e.session_id not like 'edge\_app:%'
  ),
  -- Sessions that already have an identity: members and Sleeper guests.
  claimed as (
    select distinct ev.session_id
    from ev
    where ev.user_id is not null
       or coalesce(ev.username, '') <> ''
       or coalesce(ev.metadata->>'sleeper', '') <> ''
       or coalesce(ev.metadata->>'sleeperUsername', '') <> ''
  ),
  marks as (
    -- strength 1: an explicit guest mark (connect event or client stamp)
    select ev.session_id, ev.event_ts,
      case ev.event_name
        when 'espn_connected' then 'espn'
        when 'mfl_connected' then 'mfl'
        else lower(ev.metadata->>'guestPlatform')
      end as plat,
      nullif(coalesce(ev.metadata->>'guestLeague', ev.metadata->>'espnLeagueId', ev.metadata->>'mflLeagueId'), '') as league,
      nullif(coalesce(ev.metadata->>'guestTeam', ev.metadata->>'espnTeamId', ev.metadata->>'mflFranchiseId'), '') as team,
      1 as strength
    from ev
    where (ev.event_name in ('espn_connected', 'mfl_connected') and ev.metadata->>'guest' = 'true')
       or lower(coalesce(ev.metadata->>'guestPlatform', '')) in ('espn', 'mfl')
    union all
    -- strength 2: the ESPN/MFL league the session worked in
    select ev.session_id, ev.event_ts, x.m[1], x.m[2], null, 2
    from ev
    cross join lateral (select regexp_match(ev.league_id, '^(espn|mfl)_([0-9]+)_[0-9]{4}$') as m) x
    where x.m is not null
  ),
  picked as (
    select distinct on (mk.session_id) mk.session_id, mk.plat, mk.league
    from marks mk
    where mk.plat in ('espn', 'mfl')
      and mk.league is not null
      and not exists (select 1 from claimed c where c.session_id = mk.session_id)
    order by mk.session_id, mk.strength, mk.event_ts desc
  ),
  sess as (
    select p.session_id, p.plat, p.league,
      (select mk.team from marks mk
        where mk.session_id = p.session_id and mk.plat = p.plat and mk.league = p.league and mk.team is not null
        order by mk.event_ts desc limit 1) as team
    from picked p
  ),
  one_team as (
    select s.plat, s.league, min(s.team) as team
    from sess s
    where s.team is not null
    group by s.plat, s.league
    having count(distinct s.team) = 1
  ),
  keyed as (
    select s.session_id, s.plat, s.league, coalesce(s.team, t.team) as team
    from sess s
    left join one_team t on t.plat = s.plat and t.league = s.league
  ),
  names as (
    select distinct on (n.plat, n.league, n.team) n.plat, n.league, n.team, n.team_name
    from (
      select
        case e.event_name when 'espn_connected' then 'espn' else 'mfl' end as plat,
        coalesce(e.metadata->>'espnLeagueId', e.metadata->>'mflLeagueId') as league,
        coalesce(e.metadata->>'espnTeamId', e.metadata->>'mflFranchiseId') as team,
        left(nullif(btrim(coalesce(e.metadata->>'espnTeamName', e.metadata->>'mflTeamName')), ''), 40) as team_name,
        e.event_ts
      from public.analytics_events e
      where e.event_ts >= p_since - interval '180 days'
        and e.event_name in ('espn_connected', 'mfl_connected')
    ) n
    where n.team is not null and n.team_name is not null
    order by n.plat, n.league, n.team, n.event_ts desc
  )
  select
    k.session_id,
    k.plat || ':' || k.league || coalesce(':' || k.team, '') as guest_key,
    case
      when nm.team_name is not null then upper(k.plat) || ' · ' || nm.team_name
      else upper(k.plat) || ' league ' || k.league || coalesce(' · team ' || k.team, '')
    end as guest_label,
    k.plat as guest_platform,
    k.league as league_id,
    k.team as team_id,
    nm.team_name
  from keyed k
  left join names nm on nm.plat = k.plat and nm.league = k.league and nm.team = k.team;
$function$;

revoke all on function public.analytics_guest_sessions(timestamptz) from public, anon, authenticated;
grant execute on function public.analytics_guest_sessions(timestamptz) to service_role;
