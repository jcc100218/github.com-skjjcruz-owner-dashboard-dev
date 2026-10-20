-- Burst robots leave the production numbers (owner ask 2026-10-20: "yep, do
-- it" — keep scripts from polluting Mission Control).
--
-- 2026-10-20 between 12:18 and 1:08 AM ET a script opened the landing page 57
-- times on dhqfootball.com (several in the same second), clicked the sign-up
-- and sign-in buttons and started Apple sign-in 20 times without once coming
-- back. It hid navigator.webdriver, so the client's metadata.internal stamp
-- never fired, and its rows looked like people's (desktop, normal click
-- delays). What gives it away is the burst: in the 60 days before it, the
-- busiest half hour had 4 anonymous landing visits.
--
-- Rule: an anonymous landing session that got nowhere (no sign-in, sign-up,
-- Sleeper connect or app open) is a robot when 15 or more such sessions began
-- within 15 minutes of it AND nobody on the website got anywhere from 15
-- minutes before to 45 minutes after it. A real rush of visitors (a post that
-- takes off) brings sign-ups, so it is never hidden. Checked on the last 60
-- days: it marks exactly that night's 57 sessions and nothing else.
--
-- Like the other test traffic, these sessions are still counted (under
-- 'testTraffic'); every view reads this one list, so a tile and its detail
-- table can never disagree. Idempotent (create or replace).

create or replace function public.analytics_test_sessions(p_since timestamptz)
returns table(session_id text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with owners as (
    select u.id as uid, lower(nullif(u.platform_usernames->>'sleeper', '')) as handle
    from public.app_user_roles r
    join public.app_users u on u.id = r.user_id
    where r.role in ('admin', 'owner')
  ),
  handles as (
    select handle from owners where handle is not null
    union
    select 'skjjcruz'
  ),
  web as (
    select e.session_id, e.event_ts, e.event_name, e.user_id, e.username, e.metadata
    from public.analytics_events e
    where e.event_ts >= p_since - interval '15 minutes'
      and e.session_id is not null
      and e.metadata->>'host' = 'dhqfootball.com'
  ),
  web_sessions as (
    select session_id, min(event_ts) as t0,
      bool_and(user_id is null and username is null
               and coalesce(metadata->>'sleeper', '') = ''
               and coalesce(metadata->>'internal', '') = '') as anon,
      bool_or(event_name = 'landing_viewed') as landed,
      bool_or(event_name in ('signup_succeeded', 'signin_succeeded', 'oauth_succeeded',
                             'sleeper_connected', 'entered_app', 'app_loaded')) as progressed
    from web
    group by session_id
  ),
  stalled as (
    select session_id, t0 from web_sessions where anon and landed and not progressed
  ),
  burst_robots as (
    select c.session_id
    from stalled c
    where c.t0 >= p_since
      and (select count(*) from stalled o
           where o.t0 between c.t0 - interval '15 minutes' and c.t0 + interval '15 minutes') >= 15
      and not exists (select 1 from web_sessions p
                      where p.progressed
                        and p.t0 between c.t0 - interval '15 minutes' and c.t0 + interval '45 minutes')
  )
  select distinct e.session_id
  from public.analytics_events e
  where e.event_ts >= p_since
    and e.session_id is not null
    and (
      coalesce(e.metadata->>'internal', '') <> ''
      or e.user_id in (select uid from owners)
      or lower(e.username) in (select handle from handles)
      or lower(e.metadata->>'sleeper') in (select handle from handles)
      or lower(e.metadata->>'sleeperUsername') in (select handle from handles)
    )
  union
  select session_id from burst_robots;
$function$;

revoke all on function public.analytics_test_sessions(timestamptz) from public, anon, authenticated;
grant execute on function public.analytics_test_sessions(timestamptz) to service_role;
