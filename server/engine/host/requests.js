#!/usr/bin/env node
// Builds leagues members just opened (owner go-ahead 2026-10-17). The app
// sends league ids to dhq-request, which queues them in build_requests; this
// checks the queue every 15 seconds and runs a one-league request build
// (build.sh with LEAGUES and ENGINE_PARTIAL=1). Run by dhq-requests.service.
// Env (from /etc/dhq-engine.env): SUPABASE_ACCESS_TOKEN, ENGINE_PROJECT_REF.
'use strict';
const { spawnSync } = require('child_process');
const REF = process.env.ENGINE_PROJECT_REF || '';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN || '';
const EVERY_MS = 15000;
const BATCH = 5;

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

async function tick() {
  // The table may not exist until the first build applies schema.sql.
  const rows = await sql("select league_id from public.build_requests where status = 'pending' order by requested_at limit " + BATCH);
  const ids = rows.map(r => String(r.league_id)).filter(id => /^\d{10,20}$/.test(id));
  if (!ids.length) return;
  console.log('building on request:', ids.join(','));
  // build.sh waits for the hourly build if one is running.
  const res = spawnSync('/opt/dhq/app/server/engine/host/build.sh', [], {
    env: Object.assign({}, process.env, { LEAGUES: ids.join(','), ENGINE_PARTIAL: '1', ENGINE_RUNNER: 'request' }),
    stdio: 'inherit', timeout: 50 * 60 * 1000,
  });
  if (res.status !== 0) console.warn('request build exited', res.status);
  // Anything still pending (the build never reached it) is marked failed so
  // one bad id can't loop forever; a later request re-queues it.
  const quoted = ids.map(id => "'" + id + "'").join(',');
  await sql("update public.build_requests set status = 'failed', last_error = coalesce(last_error, 'build did not finish') where status = 'pending' and league_id in (" + quoted + ')');
}

(async function loop() {
  if (!REF || !TOKEN) { console.error('ENGINE_PROJECT_REF and SUPABASE_ACCESS_TOKEN are required'); process.exit(1); }
  console.log('watching build requests every', EVERY_MS / 1000, 's');
  for (;;) {
    try { await tick(); } catch (e) { console.warn('request check:', e.message); }
    await new Promise(r => setTimeout(r, EVERY_MS));
  }
})();
