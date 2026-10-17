#!/usr/bin/env node
// Compare two dry-run builds of the same league (GitHub runner vs engine
// server). Used once, before switching the build to the server, to prove the
// server makes the same numbers. Usage: node compare.js a.json b.json
'use strict';
const fs = require('fs');
const [a, b] = process.argv.slice(2).map(f => JSON.parse(fs.readFileSync(f, 'utf8')));

function diff(name, x, y, tol) {
  const keys = new Set(Object.keys(x || {}).concat(Object.keys(y || {})));
  let same = 0, off = 0, missing = 0, worst = 0, worstKey = null;
  for (const k of keys) {
    if (!(k in (x || {})) || !(k in (y || {}))) { missing++; continue; }
    const d = Math.abs(Number(x[k]) - Number(y[k]));
    if (d <= tol) same++; else { off++; if (d > worst) { worst = d; worstKey = k; } }
  }
  console.log(name + ': ' + same + ' same, ' + off + ' differ, ' + missing + ' only in one' + (off ? ' (largest ' + worst.toFixed(1) + ' on ' + worstKey + ')' : ''));
  return { same, off, missing, total: keys.size };
}
const pick = (j, f) => Object.fromEntries(Object.entries((j.snapshot && j.snapshot.dhq_proj && j.snapshot.dhq_proj.players) || {}).map(([k, v]) => [k, v[f]]));

console.log('league ' + a.league_id + ' | week a=' + (a.snapshot && a.snapshot.proj_week) + ' b=' + (b.snapshot && b.snapshot.proj_week));
const v = diff('dynasty values', a.intel && a.intel.playerScores, b.intel && b.intel.playerScores, 1);
const m = diff('projections (shown)', pick(a, 'median'), pick(b, 'median'), 0.1);
const n = diff('projections (average)', pick(a, 'mean'), pick(b, 'mean'), 0.1);
// Live data (injuries, news) can move between the two runs, so allow a sliver.
const ok = [v, m, n].every(r => r.total > 0 && (r.off + r.missing) / r.total <= 0.02);
console.log(ok ? 'MATCH' : 'MISMATCH');
process.exit(ok ? 0 : 1);
