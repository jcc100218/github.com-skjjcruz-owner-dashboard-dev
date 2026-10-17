#!/usr/bin/env node
// Engine server helper (owner direction 2026-10-17: the build moves from
// GitHub Actions to our own server; GitHub stays as the automatic fallback).
//   node lease.js take   — mark "the server is building" (engine_cache.build_lease)
//   node lease.js clear  — clear the mark
//   node lease.js gate   — for GitHub's fallback: prints build=true|false
// The lease lets GitHub's fallback see a build in progress (engine_runs is
// only written when a run finishes), so the two never build at once.
// Env: SUPABASE_ACCESS_TOKEN, ENGINE_PROJECT_REF.
'use strict';
const REF = process.env.ENGINE_PROJECT_REF || '';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN || '';
// The fallback builds only when the last finished run is older than this.
// The server builds hourly, so this is two missed builds.
const STALE_MIN = Number(process.env.ENGINE_STALE_MIN || 130);
const LEASE_MIN = 30;

async function sql(query) {
  const r = await fetch('https://api.supabase.com/v1/projects/' + REF + '/database/query', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error('management API ' + r.status + ': ' + text.slice(0, 200));
  return JSON.parse(text || '[]');
}

(async () => {
  const cmd = process.argv[2];
  if (!REF || !TOKEN) throw new Error('ENGINE_PROJECT_REF and SUPABASE_ACCESS_TOKEN are required');
  if (cmd === 'take') {
    await sql("insert into public.engine_cache (key, data, updated_at) values ('build_lease', jsonb_build_object('by', 'server', 'started_at', now()), now()) on conflict (key) do update set data = excluded.data, updated_at = excluded.updated_at");
  } else if (cmd === 'clear') {
    await sql("delete from public.engine_cache where key = 'build_lease'");
  } else if (cmd === 'gate') {
    // Fail open: if the check itself fails (project paused, API down), build.
    let build = true, why = 'check failed';
    try {
      const rows = await sql(
        "select extract(epoch from (now() - (select max(finished_at) from public.engine_runs where leagues_ok > 0 and coalesce(kind, 'full') = 'full')))/60 as age_min, " +
        "(select extract(epoch from (now() - updated_at))/60 from public.engine_cache where key = 'build_lease') as lease_min");
      const age = rows[0] && rows[0].age_min != null ? Number(rows[0].age_min) : null;
      const lease = rows[0] && rows[0].lease_min != null ? Number(rows[0].lease_min) : null;
      if (lease != null && lease < LEASE_MIN) { build = false; why = 'server build in progress (' + lease.toFixed(0) + ' min)'; }
      else if (age != null && age < STALE_MIN) { build = false; why = 'last build ' + age.toFixed(0) + ' min ago'; }
      else { build = true; why = age == null ? 'no finished build on record' : 'last build ' + age.toFixed(0) + ' min ago'; }
    } catch (e) { why = 'check failed: ' + e.message; }
    console.log('build=' + build);
    console.error('fallback gate: ' + why);
  } else {
    throw new Error('usage: lease.js take|clear|gate');
  }
})().catch(e => { console.error(e.message); process.exit(1); });
