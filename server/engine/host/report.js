#!/usr/bin/env node
// Engine status for engine-server.yml: the last builds and the database size
// (the engine project is on Supabase's free plan: 500 MB).
// Env: SUPABASE_ACCESS_TOKEN, ENGINE_PROJECT_REF.
'use strict';
async function sql(query) {
  const r = await fetch('https://api.supabase.com/v1/projects/' + process.env.ENGINE_PROJECT_REF + '/database/query', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.SUPABASE_ACCESS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error('management API ' + r.status);
  return r.json();
}
(async () => {
  console.table(await sql('select started_at, finished_at, leagues_ok, leagues_failed, notes as runner, kind from public.engine_runs order by id desc limit 6'));
  console.table(await sql(
    "select pg_size_pretty(pg_database_size(current_database())) as db_size, " +
    "(select count(*) from public.league_intel) as leagues, " +
    "pg_size_pretty(pg_total_relation_size('public.league_intel')) as league_rows, " +
    "(select pg_size_pretty(avg(pg_column_size(t.*))::bigint) from public.league_intel t) as avg_league, " +
    "pg_size_pretty(pg_total_relation_size('public.engine_cache')) as cache, " +
    "pg_size_pretty(pg_total_relation_size('public.player_news')) as news, " +
    "(select count(*) from public.build_requests) as requested, " +
    "(select count(*) from public.build_requests where status = 'pending') as pending"));
})().catch(e => console.log('report:', e.message));
