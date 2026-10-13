// server/engine/watch.js — keeps the engine's numbers fresh between
// GitHub's unreliable timers (engine move, step 2; owner 2026-10-13: "figure
// it out"). GitHub's scheduled runs slipped 5-8 hours apart on a 2-hour
// schedule, and a 15-minute schedule never fired. This runs inside one
// GitHub job for about 5 h 45 min, then the workflow starts the next watcher
// (engine-watch.yml), so the passes never wait on GitHub's clock:
//
//   every minute     new leagues only (a member just opened one)   NEW_ONLY=1
//   every 5 minutes  leagues that changed in Sleeper               FAST=1
//   every 2 hours    full rebuild + news + shared tables           (plain run)
//
// Each pass is its own `node run.js` process, so a failed pass never stops
// the watcher. Env: what run.js needs (SUPABASE_ACCESS_TOKEN, ENGINE_PROJECT_REF).
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const RUN = path.join(__dirname, 'run.js');
const LIFETIME_MS = Number(process.env.WATCH_MINUTES || 345) * 60 * 1000;
const NEW_EVERY = 60 * 1000, CHANGED_EVERY = 5 * 60 * 1000, FULL_EVERY = 2 * 60 * 60 * 1000;
const started = Date.now();
let lastChanged = 0, lastFull = Number(process.env.WATCH_SKIP_FIRST_FULL === '1' ? Date.now() : 0);

function pass(label, env) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [RUN], { env: Object.assign({}, process.env, { FAST: '', NEW_ONLY: '' }, env), stdio: 'inherit', timeout: 40 * 60 * 1000 });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  if (r.status !== 0) console.log('[watch]', label, 'pass ended with code', r.status, 'after', secs + 's');
  else if (label !== 'new') console.log('[watch]', label, 'pass done in', secs + 's');
}
const sleep = ms => new Promise(res => setTimeout(res, ms));

(async () => {
  console.log('[watch] started; runs for', Math.round(LIFETIME_MS / 60000), 'minutes');
  while (Date.now() - started < LIFETIME_MS) {
    const t = Date.now();
    if (t - lastFull >= FULL_EVERY) { lastFull = t; lastChanged = t; pass('full', {}); }
    else if (t - lastChanged >= CHANGED_EVERY) { lastChanged = t; pass('changed', { FAST: '1' }); }
    else pass('new', { NEW_ONLY: '1' });
    const wait = NEW_EVERY - (Date.now() - t);
    if (wait > 0) await sleep(wait);
  }
  console.log('[watch] lifetime reached; the workflow starts the next watcher');
})();
