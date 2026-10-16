-- One signup, one count, in Mission Control's "via the App / via the Website"
-- rows (owner report 2026-10-16: "Signup succeeded: 1" but "via the App: 2").
-- A Google/Apple signup records two events for the same new account
-- (oauth_succeeded with isNew, and signup_succeeded), and the doors rollup
-- counted rows. Now it counts accounts: distinct account id, else the session.
-- Same function as 20260927000000 otherwise; create or replace, safe to re-run.
create or replace function public.admin_doors_surfaces(p_since timestamp with time zone)
returns jsonb
language sql
security definer
set search_path to 'public'
as $function$
  with test_sessions as (
    select t.session_id from public.analytics_test_sessions(p_since) t
  ),
  scoped as (
    select
      coalesce(nullif(metadata->>'surface',''), 'unknown') as surface,
      session_id, user_id, event_name, metadata,
      -- Same production fence the rollup uses: the live website or the app
      -- shell. Everything else (lab, localhost, rig) is sandbox noise.
      (metadata->>'host' = 'dhqfootball.com' or metadata->>'surface' = 'ios_app') as is_prod,
      (session_id like 'edge\_app:%') as is_server,
      -- Robots and the owners (owner ask 2026-09-27: filter out test traffic).
      coalesce(session_id in (select ts.session_id from test_sessions ts), false) as is_test
    from analytics_events
    where event_ts >= p_since
  )
  select jsonb_build_object(
    'surfaces', coalesce((
      select jsonb_object_agg(surface, jsonb_build_object('events', ev, 'sessions', ss))
      from (
        select surface, count(*) as ev, count(distinct session_id) as ss
        from scoped where is_prod and not is_test group by surface
      ) s
    ), '{}'::jsonb),
    'signups', coalesce((
      select jsonb_object_agg(surface, n)
      from (
        select surface, count(distinct coalesce(user_id::text, nullif(metadata->>'accountId', ''), session_id)) as n from scoped
        where is_prod and not is_test and (event_name = 'signup_succeeded'
              or (event_name = 'oauth_succeeded' and metadata->>'isNew' = 'true'))
        group by surface
      ) g
    ), '{}'::jsonb),
    'devSandbox', (
      select jsonb_build_object('events', count(*), 'sessions', count(distinct session_id))
      from scoped where not is_prod and not is_server and not is_test
    ),
    'testTraffic', (
      select jsonb_build_object('events', count(*), 'sessions', count(distinct session_id))
      from scoped where is_test
    ),
    'serverEvents', (select count(*) from scoped where is_server and not is_test)
  );
$function$;

revoke all on function public.admin_doors_surfaces(timestamptz) from public, anon, authenticated;
grant execute on function public.admin_doors_surfaces(timestamptz) to service_role;
