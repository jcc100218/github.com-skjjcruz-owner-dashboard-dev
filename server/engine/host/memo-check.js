#!/usr/bin/env node
// Proves the server's projection speed-up changes no number (transition
// step 2). One process, one snapshot of live data: every league is projected
// twice, with the speed-up off and on, and the two results must be exactly
// equal (every player, every field). Nothing is stored.
//   LEAGUES=id,id node server/engine/host/memo-check.js
'use strict';
const { loadShared, buildLeague } = require('../headless');
const { createProjector } = require('../dhq-proj');

(async () => {
  const leagues = (process.env.LEAGUES || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!leagues.length) throw new Error('LEAGUES=… required');
  const shared = await loadShared();
  const off = await createProjector(shared, { memo: false });
  const on = await createProjector(shared, { memo: true });
  let same = true, tOff = 0, tOn = 0, players = 0;
  for (const lid of leagues) {
    const row = await buildLeague(lid, shared, null);
    const extra = Object.keys(row.snapshot.proj || {});
    let t = Date.now(); const a = await off.league(row.snapshot.league, row.snapshot.rosters || [], extra); tOff += Date.now() - t;
    t = Date.now(); const b = await on.league(row.snapshot.league, row.snapshot.rosters || [], extra); tOn += Date.now() - t;
    const ids = new Set(Object.keys(a.proj).concat(Object.keys(b.proj)));
    let diff = 0;
    for (const pid of ids) if (JSON.stringify(a.proj[pid]) !== JSON.stringify(b.proj[pid])) { if (diff < 3) console.log('  DIFF', pid, JSON.stringify(a.proj[pid]), JSON.stringify(b.proj[pid])); diff++; }
    players += ids.size;
    console.log((diff ? '✗ ' : '✓ ') + row.name + ': ' + ids.size + ' players, ' + diff + ' differ · off ' + (a.ms / 1000).toFixed(1) + 's, on ' + (b.ms / 1000).toFixed(1) + 's');
    if (diff) same = false;
  }
  console.log((same ? 'IDENTICAL' : 'DIFFERENT') + ' · ' + players + ' players · projections ' + (tOff / 1000).toFixed(1) + 's → ' + (tOn / 1000).toFixed(1) + 's');
  process.exit(same ? 0 : 1);
})().catch(e => { console.error('memo-check failed:', e && e.stack || e); process.exit(1); });
