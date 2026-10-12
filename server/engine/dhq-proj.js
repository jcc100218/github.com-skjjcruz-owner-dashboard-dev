// server/engine/dhq-proj.js — DHQ weekly projections in the engine build.
//
// Owner rulings: "our weekly projections should be based on DHQ scoring"
// (2026-10-10); the Lab's start/sit and Lineup Check rank on DHQ's weekly
// projection (App.DhqProj: the matchup engine's average week, gated by the
// truth law), so the server must too.
//
// This runs the app's OWN projection code, file for file, the way
// headless.js runs the valuation engine: js/shared/{weekly-proj,
// sleeper-proj, nfl-context, matchup-engine, dhq-baseline,
// matchup-feeds-espn, matchup-inputs, dhq-proj}.js and js/utils/
// sos-engine.js from this repo's checkout (identical to the Lab's copies on
// 2026-10-10 except dhq-proj.js, where the Lab only adds later-week
// functions; the current-week path is the same). The PFF and usage
// snapshots are read from the published Lab
// (https://skjjcruz.github.io/DHQ-Web-Page/data/…, public data, no key),
// exactly as the app and the website read them.
//
// Two of those files read ESPN through relays on the live app's Supabase
// project (nfl-scoreboard, nfl-depth-charts). The build never calls that
// project: functionsBase points at a local stand-in that answers both
// routes from ESPN's public feeds directly (the same upstream calls the
// relays make, ported from supabase/functions/nfl-{scoreboard,depth-charts}),
// and any other *.supabase.co request fails closed.
//
// Output per league: { pid: { mean, median, floor, ceiling } } for every
// rostered player (and every player with a Sleeper line this week) DHQ projects (mean = the average week every lineup call
// uses; a player with no Sleeper line this week reads 0, the truth law).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const FILES = [
  'reconai-shared/constants.js', 'reconai-shared/utils.js',
  'js/shared/weekly-proj.js', 'js/shared/sleeper-proj.js', 'js/shared/nfl-context.js', 'js/utils/sos-engine.js',
  'js/shared/matchup-engine.js', 'js/shared/dhq-baseline.js', 'js/shared/matchup-feeds-espn.js', 'js/shared/matchup-inputs.js',
  'js/shared/dhq-proj.js',
];
const DATA_HOME = 'https://skjjcruz.github.io/DHQ-Web-Page/';
const SNAPSHOTS = ['data/pff-matchup-snapshot.js', 'data/usage-snapshot.js'];
const LOCAL_FN = 'https://dhq-engine.local/functions/v1';
const ESPN_SITE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';

// ── The two ESPN relays, answered locally ────────────────────────────────
const SLOT_TO_POS = {
  QB: 'QB', RB: 'RB', FB: 'RB', WR: 'WR', TE: 'TE', PK: 'K',
  LDE: 'DL', RDE: 'DL', DE: 'DL', DT: 'DL', NT: 'DL', LDT: 'DL', RDT: 'DL',
  WLB: 'LB', SLB: 'LB', MLB: 'LB', LILB: 'LB', RILB: 'LB', LOLB: 'LB', ROLB: 'LB', ILB: 'LB', OLB: 'LB', LB: 'LB',
  LCB: 'DB', RCB: 'DB', CB: 'DB', NB: 'DB', FS: 'DB', SS: 'DB', S: 'DB', DB: 'DB',
};
const normName = n => String(n || '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\.?$/g, '').replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
async function espn(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'FantasyWarRoom/1.0', Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('espn ' + r.status + ' ' + url);
  return r.json();
}
let depthMemo = null;
function depthCharts() {
  if (depthMemo) return depthMemo;
  depthMemo = (async () => {
    const season = new Date().getUTCMonth() >= 2 ? new Date().getUTCFullYear() : new Date().getUTCFullYear() - 1;
    const teamsDoc = await espn(ESPN_SITE + '/teams');
    const teams = (((teamsDoc.sports || [])[0] || {}).leagues || [{}])[0].teams.map(t => ({ id: String(t.team.id), abbr: String(t.team.abbreviation || '').toUpperCase() })).filter(t => t.id && t.abbr);
    const roles = {};
    for (let i = 0; i < teams.length; i += 8) {
      await Promise.all(teams.slice(i, i + 8).map(async team => {
        try {
          const [rosterDoc, depthDoc] = await Promise.all([
            espn(ESPN_SITE + '/teams/' + team.id + '/roster'),
            espn('https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/' + season + '/teams/' + team.id + '/depthcharts'),
          ]);
          const nameById = {};
          for (const grp of rosterDoc.athletes || []) for (const a of grp.items || []) if (a && a.id && a.displayName) nameById[String(a.id)] = a.displayName;
          for (const grp of depthDoc.items || []) {
            const positions = grp.positions || {};
            for (const key of Object.keys(positions)) {
              const slot = positions[key];
              const pos = SLOT_TO_POS[String((slot.position && slot.position.abbreviation) || key).toUpperCase()];
              if (!pos) continue;
              for (const entry of slot.athletes || []) {
                const rank = Number(entry.rank) || 99;
                const aid = String((entry.athlete && entry.athlete.$ref) || '').split('/').pop().split('?')[0];
                const nm = nameById[aid];
                if (!nm) continue;
                const k = team.abbr + '|' + normName(nm);
                if (!roles[k] || rank < roles[k].rank) roles[k] = { pos, rank };
              }
            }
          }
        } catch (e) { console.warn('dhq-proj depth chart', team.abbr, String(e.message || e).slice(0, 120)); }
      }));
    }
    return { builtAt: new Date().toISOString(), teams: new Set(Object.keys(roles).map(k => k.split('|')[0])).size, roles };
  })();
  depthMemo.catch(() => { depthMemo = null; });
  return depthMemo;
}
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
async function engineFetch(input, init) {
  const url = String(input && input.url ? input.url : input);
  if (url.startsWith(LOCAL_FN + '/nfl-scoreboard')) {
    const q = new URL(url).searchParams;
    const week = parseInt(q.get('week') || '0', 10) || 0, season = parseInt(q.get('season') || '0', 10) || 0, st = parseInt(q.get('seasontype') || '2', 10) || 2;
    const qp = ['seasontype=' + st]; if (week > 0) qp.push('week=' + week); if (season > 0) qp.push('dates=' + season);
    try { return jsonResponse(await espn(ESPN_SITE + '/scoreboard?' + qp.join('&'))); } catch (e) { return jsonResponse({ error: String(e.message || e) }, 502); }
  }
  if (url.startsWith(LOCAL_FN + '/nfl-depth-charts')) {
    try { return jsonResponse(await depthCharts()); } catch { return jsonResponse({ builtAt: null, roles: {} }); }
  }
  if (/supabase\.co/i.test(url) || url.startsWith(LOCAL_FN)) throw new Error('blocked in the engine build: ' + url.split('?')[0]);
  return fetch(input, init);
}

// ── The context ──────────────────────────────────────────────────────────
function storage() {
  const s = {};
  return { getItem: k => (k in s ? s[k] : null), setItem: (k, v) => { s[k] = String(v); }, removeItem: k => { delete s[k]; }, clear: () => { for (const k in s) delete s[k]; }, key: i => Object.keys(s)[i] || null, get length() { return Object.keys(s).length; } };
}
async function snapshotCode(src) {
  try {
    const r = await fetch(DATA_HOME + src + '?v=' + Date.now(), { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(String(r.status));
    return await r.text();
  } catch (e) { console.warn('dhq-proj snapshot', src, 'not loaded:', e.message); return null; }
}
// One projection context per build run, shared across leagues (the week's
// stats, schedule, depth charts and snapshots load once).
async function createProjector(shared) {
  const ctx = {
    console: { log() {}, info() {}, debug() {}, warn() {}, error: (...a) => console.error('[dhq-proj]', ...a) },
    fetch: engineFetch, setTimeout, clearTimeout,
    // dhq-proj.js boots polling timers in a page; the build drives it directly.
    setInterval: () => 0, clearInterval: () => {},
    performance, Date, Math, Object, Array, Number, String, Boolean, JSON, RegExp, Symbol, Map, Set, WeakMap, WeakSet, Promise, Error, TypeError, RangeError,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, URLSearchParams, URL, AbortController, AbortSignal, Headers, Request, Response, structuredClone, queueMicrotask,
    localStorage: storage(), sessionStorage: storage(),
    location: { search: '', hostname: 'engine.dhqfootball.com', href: 'https://engine.dhqfootball.com/', pathname: '/', protocol: 'https:', origin: 'https://engine.dhqfootball.com' },
    navigator: { userAgent: 'dhq-engine-headless', onLine: true },
    document: { title: '', readyState: 'complete', addEventListener() {}, removeEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, getElementById() { return null; }, createElement() { return { setAttribute() {}, style: {}, appendChild() {} }; }, head: { appendChild() {} }, body: { appendChild() {} }, cookie: '' },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; },
    DYNASTY_HQ_CONFIG: { functionsBase: LOCAL_FN },
  };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  // Sleeper's week lines come from the build's own fetch (headless.loadShared).
  ctx.Sleeper = { fetchWeekProjections: async () => shared.projWeek || {} };
  ctx.S = { platform: 'sleeper', players: shared.players, nflState: shared.nfl, season: String(shared.season), currentWeek: Number(shared.week), leagues: [], rosters: [], currentLeagueId: null };
  for (const rel of FILES) vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), ctx, { filename: rel });
  // js/core.js's calcPPG (core.js is the app shell; only this helper is needed).
  ctx.App.calcPPG = ctx.App.calcPPG || function calcPPG(stats, scoring) { const raw = ctx.App.calcRawPts(stats, scoring); if (raw === null) return 0; const gp = (stats && stats.gp) || 0; return gp > 0 ? Math.max(0, raw / gp) : 0; };
  const data = {};
  for (const src of SNAPSHOTS) {
    const code = await snapshotCode(src);
    if (code) { try { vm.runInContext(code, ctx, { filename: src }); data[src] = 'loaded'; } catch (e) { data[src] = 'failed: ' + e.message; } } else data[src] = 'not loaded';
  }
  const loaded = await ctx.App.SleeperProj.loadCurrent(shared.season);
  const D = ctx.App.DhqProj;
  await D._loadDeps();
  return {
    data, sleeperWeek: loaded,
    // extraPids: players off every roster to project too (run.js passes
    // everyone with a Sleeper line this week), so a free agent the AI
    // talks about has DHQ's number like everyone else (owner ruling
    // 2026-10-12: the AI only ever quotes DHQ's projection).
    async league(snapshotLeague, rosters, extraPids) {
      const t0 = Date.now();
      const lg = snapshotLeague;
      ctx.S.leagues = [{ league_id: lg.league_id, name: lg.name, scoring_settings: lg.scoring_settings, roster_positions: lg.roster_positions, settings: lg.settings }];
      ctx.S.rosters = rosters;
      ctx.S.currentLeagueId = lg.league_id;
      const pids = [...new Set(rosters.flatMap(r => (r.players || []).map(String)).concat((extraPids || []).map(String)))];
      D.request(pids);
      const st = D._st;
      const deadline = Date.now() + 10 * 60 * 1000;
      while (!pids.every(pid => pid in st.results)) {
        if (st.error && !st.running) throw new Error('DHQ projections failed: ' + (st.error.message || st.error));
        if (Date.now() > deadline) throw new Error('DHQ projections timed out');
        await new Promise(r => setTimeout(r, 100));
      }
      const out = {};
      let n = 0, noLine = 0;
      for (const pid of pids) {
        const r = D.get(pid);   // with the truth law: no Sleeper line this week reads 0
        if (!r) continue;
        out[pid] = { mean: Number(r.mean) || 0, median: Number(r.median) || 0, floor: Number(r.floor) || 0, ceiling: Number(r.ceiling) || 0 };
        // What moved his number (the app's own reasons), so the AI can say "DHQ projects X because Y".
        if (r.why && Number(r.mean) > 0) out[pid].why = String(r.why).slice(0, 200);
        if (r.noSleeper) { out[pid].no_line = true; noLine++; }
        n++;
      }
      return { week: D.week(), proj: out, projected: n, no_line: noLine, ms: Date.now() - t0, data: Object.assign({}, data, { sleeper_week: loaded }) };
    },
  };
}

module.exports = { createProjector, engineFetch, LOCAL_FN };
