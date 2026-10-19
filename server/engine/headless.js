// server/engine/headless.js — run the DHQ engine outside a browser.
//
// The engine (reconai-shared/*.js) is plain browser script that reads a few
// globals: window.S (the league state), window.App (the engine namespace),
// localStorage / IndexedDB caches, and fetch. This module creates a small
// stand-in for the browser, loads the same engine files the website ships,
// feeds them a league pulled straight from Sleeper, and returns what the
// engine computed. No engine code is changed — this is the file-for-file
// copy the app and the website run.
//
// Owner direction 2026-10-08: "let's move the engine to the server".
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const API = 'https://api.sleeper.app/v1';
const ENGINE_VERSION = 'headless-4';

// The shared engine files, in the order index.html loads them (only the
// ones the valuation path needs — no auth, UI or AI modules).
const ENGINE_FILES = [
  'constants.js', 'utils.js', 'storage.js', 'event-bus.js', 'platform-provider.js', 'sleeper-api.js',
  'pick-value-model.js', 'dhq-providers.js', 'dhq-core.js', 'intelligence-context.js', 'values-v2.js', 'pff-snapshot.js',
  'dhq-engine.js', 'team-assess.js', 'analytics-engine.js', 'trade-engine.js',
].map(f => 'reconai-shared/' + f).concat(['js/utils/player-value.js']);

function storage() {
  const s = {};
  return { getItem: k => (k in s ? s[k] : null), setItem: (k, v) => { s[k] = String(v); }, removeItem: k => { delete s[k]; }, clear: () => { for (const k in s) delete s[k]; }, key: i => Object.keys(s)[i] || null, get length() { return Object.keys(s).length; } };
}

// A browser-shaped global object. Everything the engine touches at load or
// run time is here; anything else it reaches for is wrapped in try/catch
// inside the engine itself.
function buildContext() {
  const ctx = {
    // The engine's own logging is browser-console chatter (per-player factor
    // dumps); only real errors reach the job log.
    console: { log() {}, info() {}, debug() {}, warn() {}, error: (...a) => console.error(...a) },
    fetch, setTimeout, clearTimeout, setInterval, clearInterval, performance,
    Date, Math, Object, Array, Number, String, Boolean, JSON, RegExp, Symbol, Map, Set, WeakMap, WeakSet, Promise, Error, TypeError, RangeError,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI, URLSearchParams, URL, TextEncoder, TextDecoder, structuredClone, queueMicrotask,
    AbortController, Headers, Request, Response,
    localStorage: storage(), sessionStorage: storage(),
    location: { search: '', hostname: 'engine.dhqfootball.com', href: 'https://engine.dhqfootball.com/', pathname: '/', protocol: 'https:', origin: 'https://engine.dhqfootball.com' },
    navigator: { userAgent: 'dhq-engine-headless', onLine: true },
    document: { title: '', readyState: 'complete', addEventListener() {}, removeEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, getElementById() { return null; }, createElement() { return { setAttribute() {}, style: {}, appendChild() {} }; }, head: { appendChild() {} }, body: { appendChild() {} }, currentScript: null, cookie: '' },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; },
    Event: function Event(type) { this.type = type; },
    requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: () => {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    React: { createContext: () => ({}), useState: () => [null, () => {}], useEffect() {}, useMemo: () => null, useRef: () => ({ current: null }), useCallback: f => f, createElement: () => null, Fragment: 'f' },
  };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

function loadEngine(ctx) {
  for (const rel of ENGINE_FILES) {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    vm.runInContext(code, ctx, { filename: rel });
  }
}

async function sleeper(p) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(API + p);
    if (r.ok) return r.json();
    if (r.status === 404) return null;
    if (r.status === 429 || r.status >= 500) { await new Promise(res => setTimeout(res, 1500 * (attempt + 1))); continue; }
    throw new Error('Sleeper ' + r.status + ' ' + p);
  }
  throw new Error('Sleeper kept failing: ' + p);
}

// Shared across leagues in one run: the player directory, the NFL clock and
// the five seasons of stats the engine wants.
async function loadShared() {
  const nfl = await sleeper('/state/nfl');
  const season = String(nfl.league_season || nfl.season);
  const cur = Number(season);
  const years = [cur - 4, cur - 3, cur - 2, cur - 1, cur];
  const week = Number(nfl.display_week || nfl.week || 1);
  const weeks = []; for (let w = 1; w <= Math.min(18, week); w++) weeks.push(w);
  const [players, projWeek, ...rest] = await Promise.all([
    sleeper('/players/nfl'),
    sleeper('/projections/nfl/regular/' + season + '/' + week).catch(() => ({})),
  ].concat(years.map(y => sleeper('/stats/nfl/regular/' + y).catch(() => ({})))).concat(weeks.map(w => sleeper('/stats/nfl/regular/' + season + '/' + w).catch(() => ({})))));
  const statsByYear = {}; years.forEach((y, i) => { statsByYear[y] = rest[i] || {}; });
  const weeklyStats = {}; weeks.forEach((w, i) => { weeklyStats[w] = rest[years.length + i] || {}; });
  const weekGames = await nflWeekGames(season, week).catch(() => ({}));
  // A team whose players already have a stat line this week has played
  // (or is on the field right now): its players are locked in Sleeper.
  const thisWeek = weeklyStats[week] || {};
  Object.keys(thisWeek).forEach(pid => { const t = players[pid] && players[pid].team; if (t && Number(thisWeek[pid].gp) > 0 && weekGames[t]) weekGames[t].played = true; });
  return { nfl, season, week, players, statsByYear, weeklyStats, projWeek: projWeek || {}, weekGames };
}

// Who each NFL team plays this week (and when), from Sleeper's projection
// feed, which carries the opponent on every projected player. Teams with no
// opponent in the feed are on bye.
async function nflWeekGames(season, week) {
  const url = 'https://api.sleeper.com/projections/nfl/' + season + '/' + week + '?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF';
  let rows = null;
  for (let attempt = 0; attempt < 3 && !rows; attempt++) {
    const r = await fetch(url);
    if (r.ok) rows = await r.json();
    else await new Promise(res => setTimeout(res, 1500 * (attempt + 1)));
  }
  const games = {};
  (rows || []).forEach(e => { if (e && e.team && e.opponent && !games[e.team]) games[e.team] = { opp: e.opponent, date: e.date || null }; });
  return games;
}

// Points for one stat line in a league's scoring (the engine's own dot
// product, plus the TE-premium bonus Sleeper keys on receptions).
function leaguePoints(W, line, scoring, pos) {
  if (!line) return null;
  let pts = Number(W.calcRawPts(line, scoring)) || 0;
  if (pos === 'TE' && scoring && Number(scoring.bonus_rec_te)) pts += (Number(line.rec) || 0) * Number(scoring.bonus_rec_te);
  return Math.round(pts * 100) / 100;
}

// This season's game log and this week's projection, in this league's
// scoring, for every player the league cares about (valued or rostered).
function seasonLines(W, S, shared, LI, league) {
  const scoring = league.scoring_settings || {};
  const want = new Set(Object.keys(LI.playerScores || {}));
  (S.rosters || []).forEach(r => (r.players || []).forEach(pid => want.add(String(pid))));
  Object.keys(shared.projWeek || {}).forEach(pid => { if ((shared.projWeek[pid] || {}).pts_ppr > 3) want.add(pid); });
  const games = {}, proj = {};
  const weeks = Object.keys(shared.weeklyStats).map(Number).sort((a, b) => a - b);
  for (const pid of want) {
    const p = S.players[pid]; if (!p) continue;
    const pos = String(p.position || '').toUpperCase();
    const log = weeks.map(w => { const line = shared.weeklyStats[w][pid]; return line && (Number(line.gp) > 0 || Number(line.off_snp) > 0 || Number(line.def_snp) > 0) ? leaguePoints(W, line, scoring, pos) : null; });
    if (log.some(x => x != null)) games[pid] = log;
    const pl = shared.projWeek[pid];
    if (pl) { const v = leaguePoints(W, pl, scoring, pos); if (v != null && v > 0) proj[pid] = v; }
  }
  return { week: shared.week, games, proj };
}

function divisionNames(league) {
  const md = league.metadata || {}; const out = {};
  for (let d = 1; d <= 12; d++) if (md['division_' + d]) out[d] = String(md['division_' + d]);
  return Object.keys(out).length ? out : null;
}

// Per-player row the tools need, without the 15 MB of everything else.
function slimPlayers(players) {
  const out = {};
  for (const pid in players) {
    const p = players[pid];
    if (!p || !p.position) continue;
    if (!p.active && !p.team) continue;
    out[pid] = {
      n: p.full_name || ((p.first_name || '') + ' ' + (p.last_name || '')).trim(), pos: p.position, fp: p.fantasy_positions || undefined, t: p.team || null,
      age: p.age ?? null, yrs: p.years_exp ?? null, st: p.status || null, inj: p.injury_status || null, injp: p.injury_body_part || null,
      dc: p.depth_chart_position || null, dco: p.depth_chart_order ?? null, col: p.college || null, num: p.number ?? null, act: !!p.active,
      e: p.espn_id ? Number(p.espn_id) : null,
    };
  }
  return out;
}

function playerStatsFor(statsByYear, season, calcRawPts) {
  const prev = statsByYear[Number(season) - 1] || {}, cur = statsByYear[season] || {};
  const out = {};
  Object.entries(prev).forEach(([pid, s]) => { const pts = calcRawPts(s), gp = s.gp || 0; out[pid] = { prevTotal: pts ? Math.round(pts * 10) / 10 : 0, prevAvg: gp > 0 ? Math.round(pts / gp * 10) / 10 : 0, prevRawStats: s }; });
  Object.entries(cur).forEach(([pid, s]) => { const pts = calcRawPts(s), gp = s.gp || 0; if (!out[pid]) out[pid] = {}; if (gp > 0) { out[pid].seasonTotal = pts ? Math.round(pts * 10) / 10 : 0; out[pid].seasonAvg = Math.round(pts / gp * 10) / 10; } });
  return out;
}

// Trim the per-player detail the engine keeps (factor breakdowns and the
// FantasyCalc compatibility reason list are 80% of the bytes).
function slimIntel(LI) {
  const out = Object.assign({}, LI);
  delete out.dhqPickValueFn;
  if (out.playerMeta) {
    const pm = {};
    for (const pid in out.playerMeta) {
      const m = Object.assign({}, out.playerMeta[pid]);
      delete m.sitMultFactors; delete m.fcCompatibilityReasons; delete m.opportunityBlockers;
      pm[pid] = m;
    }
    out.playerMeta = pm;
  }
  return out;
}

// Draft picks each roster owns for the next three drafts not yet held, each
// priced by the engine (slot-aware when Sleeper knows the order).
function picksByRoster(W, S, league) {
  const cur = parseInt(S.season, 10) || new Date().getFullYear();
  const n = S.nflState || {};
  const draftDone = n.season_type === 'regular' || n.season_type === 'post' || league.status === 'in_season' || league.status === 'complete';
  const years = [0, 1, 2].map(i => cur + (draftDone ? 1 : 0) + i);
  const rounds = Number((league.settings || {}).draft_rounds) || 4;
  const away = new Set(), acq = {};
  (S.tradedPicks || []).forEach(p => {
    if (String(p.owner_id) === String(p.roster_id) || typeof p.round !== 'number') return;
    away.add(p.season + '|' + p.round + '|' + p.roster_id);
    const k = p.season + '|' + p.round + '|' + p.owner_id;
    (acq[k] = acq[k] || []).push(p.roster_id);
  });
  const PV = W.App.PlayerValue;
  const value = (y, rd, from) => { try { return Math.round((PV.resolvePickValue(y, rd, from, S.rosters) || {}).value || 0); } catch (e) { return 0; } };
  const out = {};
  (S.rosters || []).forEach(r => {
    const rid = r.roster_id; out[rid] = [];
    years.forEach(y => {
      for (let rd = 1; rd <= rounds; rd++) {
        if (!away.has(y + '|' + rd + '|' + rid)) out[rid].push({ year: y, round: rd, from: rid, value: value(y, rd, rid) });
        (acq[y + '|' + rd + '|' + rid] || []).forEach(o => out[rid].push({ year: y, round: rd, from: o, value: value(y, rd, o) }));
      }
    });
  });
  return out;
}

// Every regular-season week's matchup rows, trimmed to what the schedule,
// standings luck and head-to-head tools read: who played whom and the score.
// Sleeper posts the whole season's pairings up front, so future weeks carry
// the opponent with 0 points. Regular season = weeks before playoff_week_start.
function lastRegWeek(lg) { return Math.max(1, Math.min(18, (Number(((lg && lg.settings) || {}).playoff_week_start) || 15) - 1)); }
async function seasonWeeks(leagueId, lastWeek) {
  const ws = []; for (let w = 1; w <= lastWeek; w++) ws.push(w);
  const rows = await Promise.all(ws.map(w => sleeper('/league/' + leagueId + '/matchups/' + w).catch(() => null)));
  const out = {};
  ws.forEach((w, i) => {
    const list = (rows[i] || []).filter(m => m && m.roster_id != null);
    if (list.length) out[w] = list.map(m => ({ roster_id: m.roster_id, matchup_id: m.matchup_id == null ? null : m.matchup_id, points: Math.round((Number(m.points) || 0) * 100) / 100 }));
  });
  return out;
}

// Past seasons of this league (the previous_league_id chain): who owned each
// roster that year and every regular-season score, so all-time head-to-head
// and per-manager records can be counted by manager. A finished season never
// changes, so it is cached (engine_cache) and fetched only once.
async function pastSeasons(league, histCache) {
  const out = [];
  const seen = new Set([String(league.league_id)]);
  let prev = league.previous_league_id;
  while (prev && prev !== '0' && !seen.has(String(prev)) && out.length < 10) {
    const id = String(prev); seen.add(id);
    const key = 'past_season_' + id;
    let row = histCache ? await histCache.get(key).catch(() => null) : null;
    if (!row) {
      const info = await sleeper('/league/' + id).catch(() => null);
      if (!info) break;
      const [rosters, weeks] = await Promise.all([sleeper('/league/' + id + '/rosters').catch(() => []), seasonWeeks(id, lastRegWeek(info))]);
      row = {
        season: String(info.season || ''), league_id: id, previous_league_id: info.previous_league_id || null, last_reg_week: lastRegWeek(info), status: info.status || null,
        owners: Object.fromEntries((rosters || []).map(r => [r.roster_id, r.owner_id || null])),
        weeks,
      };
      if (histCache && info.status === 'complete') await histCache.set(key, row).catch(() => {});
    }
    out.push(row);
    prev = row.previous_league_id;
  }
  return out;
}

// Build one league. `shared` comes from loadShared(); `histCache` is an
// optional {get(key), set(key, value)} that stands in for the browser's
// IndexedDB so past seasons' trades/drafts/brackets are not re-fetched.
async function buildLeague(leagueId, shared, histCache) {
  const t0 = Date.now();
  const ctx = buildContext();
  loadEngine(ctx);
  const W = ctx.window;
  // Season stats come from this run's shared download, not a per-league fetch.
  W.Sleeper.fetchSeasonStats = yr => Promise.resolve(shared.statsByYear[yr] || {});
  W.App.Sleeper = W.Sleeper;
  // The engine's "IndexedDB": serve the history cache for dhq_hist_* keys only,
  // so the LeagueIntel cache (dhq_leagueintel_*) is never used and every run
  // computes fresh values.
  const DhqStorage = vm.runInContext('DhqStorage', ctx);
  DhqStorage.idbGet = async key => (histCache && /^dhq_hist_/.test(key)) ? await histCache.get(key) : null;
  DhqStorage.idbSet = async (key, value) => { if (histCache && /^dhq_hist_/.test(key)) await histCache.set(key, value); return true; };

  const { nfl, season, players } = shared;
  const week = Number(nfl.display_week || nfl.week || 1);
  const weeksSoFar = []; for (let w = 1; w <= Math.min(18, week); w++) weeksSoFar.push(w);
  const [league, rosters, users, tradedPicks, matchups, ...txnWeeks] = await Promise.all([
    sleeper('/league/' + leagueId), sleeper('/league/' + leagueId + '/rosters'), sleeper('/league/' + leagueId + '/users'),
    sleeper('/league/' + leagueId + '/traded_picks'), sleeper('/league/' + leagueId + '/matchups/' + week),
  ].concat(weeksSoFar.map(w => sleeper('/league/' + leagueId + '/transactions/' + w).catch(() => []))));
  if (!league) throw new Error('league not found: ' + leagueId);
  // This season's waiver and free-agent moves, trimmed: what the FAAB bid
  // model reads (winning and losing bids, who made them).
  const txns = [].concat(...txnWeeks.map(list => list || []))
    .filter(t => t && (t.type === 'waiver' || t.type === 'free_agent'))
    .map(t => ({ type: t.type, status: t.status, created: t.created, leg: t.leg, settings: t.settings ? { waiver_bid: t.settings.waiver_bid, seq: t.settings.seq } : null, adds: t.adds || null, drops: t.drops || null, roster_ids: t.roster_ids || [] }));
  const leagueSeason = String(league.season || season);
  const S = {
    platform: 'sleeper', players, playerStats: playerStatsFor(shared.statsByYear, leagueSeason, W.calcRawPts),
    rosters: rosters || [], leagueUsers: users || [],
    leagues: [{ league_id: league.league_id, name: league.name, scoring_settings: league.scoring_settings, roster_positions: league.roster_positions, settings: league.settings }],
    currentLeagueId: league.league_id, season: leagueSeason, nflState: nfl, currentWeek: week, matchups: matchups || [],
    tradedPicks: W.App.normalizeTradedPicks ? W.App.normalizeTradedPicks(rosters || [], tradedPicks || []) : (tradedPicks || []),
    drafts: [], transactions: {},
  };
  W.S = S; W.App.S = S;

  await W.App.loadLeagueIntel();
  const LI = W.App.LI;
  if (!LI || !LI.playerScores || !Object.keys(LI.playerScores).length) throw new Error('engine produced no values for ' + leagueId);

  const [weeks, history] = await Promise.all([
    seasonWeeks(league.league_id, lastRegWeek(league)).catch(() => ({})),
    pastSeasons(league, histCache).catch(e => { console.error('past seasons', leagueId, e && e.message); return []; }),
  ]);
  const assessments = W.assessAllTeamsFromGlobal();
  const picks = picksByRoster(W, S, league);
  const lines = seasonLines(W, S, shared, LI, league);
  const dna = {};
  (rosters || []).forEach(r => { try { dna[r.roster_id] = W.computeWeightedDNA(r.roster_id) || null; } catch (e) { dna[r.roster_id] = null; } });

  const snapshot = {
    league: { league_id: league.league_id, name: league.name, season: leagueSeason, status: league.status, scoring_settings: league.scoring_settings, roster_positions: league.roster_positions, settings: league.settings, previous_league_id: league.previous_league_id || null, avatar: league.avatar || null, division_names: divisionNames(league) },
    rosters: (rosters || []).map(r => ({ roster_id: r.roster_id, owner_id: r.owner_id, co_owners: r.co_owners || null, players: r.players || [], starters: r.starters || [], reserve: r.reserve || [], taxi: r.taxi || [], settings: r.settings || {}, metadata: r.metadata ? { team_name: r.metadata.team_name } : null })),
    users: (users || []).map(u => ({ user_id: u.user_id, display_name: u.display_name, avatar: u.avatar || null, team_name: (u.metadata && u.metadata.team_name) || null, team_avatar: (u.metadata && u.metadata.avatar) || null })),
    traded_picks: S.tradedPicks, txns,
    picks,
    games: lines.games,           // pid -> points by week this season (null = did not play)
    proj: lines.proj,             // pid -> this week's Sleeper projection in this league's scoring
    proj_week: lines.week,
    matchups: (matchups || []).map(m => ({ roster_id: m.roster_id, matchup_id: m.matchup_id, points: m.points, starters: m.starters })),
    weeks,                        // week -> [{roster_id, matchup_id, points}] for every regular-season week (future weeks: pairings, 0 points)
    last_reg_week: lastRegWeek(league),
    history,                      // past seasons: [{season, league_id, last_reg_week, owners: {roster_id: owner_id}, weeks}]
    nfl_state: { week, season, season_type: nfl.season_type, display_week: nfl.display_week, leg: nfl.leg },
  };
  return {
    league_id: league.league_id, season: leagueSeason, name: league.name, platform: 'sleeper',
    built_at: new Date().toISOString(), engine_version: ENGINE_VERSION, build_ms: Date.now() - t0,
    intel: slimIntel(LI), assessments, dna, snapshot,
  };
}

// ── News (ESPN's public site feed, free, no key) ─────────────────────────
// Per team: the last week of headlines, and the roster so players Sleeper
// has no ESPN id for can still be matched by name. The serving endpoint
// uses the id to pull a player's latest blurb at answer time.
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const ESPN_ABBR = { WSH: 'WAS' };   // ESPN spellings that differ from Sleeper's
const normName = s => String(s || '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b/g, '').replace(/[^a-z]/g, '');
async function espnJson(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(15000) }); if (r.ok) return await r.json(); } catch { /* retry once */ }
  }
  return null;
}
async function espnTeamData(players) {
  const out = { ids: {}, news: {}, fetched_at: new Date().toISOString(), teams: 0 };
  const t = await espnJson(ESPN + '/teams?limit=40');
  const teams = ((((t || {}).sports || [])[0] || {}).leagues || [{}])[0].teams || [];
  const since = Date.now() - 7 * 864e5;
  const byKey = {};
  Object.values(players).forEach(p => { if (p && p.team && p.position) byKey[p.team + '|' + normName((p.first_name || '') + (p.last_name || ''))] = p.player_id; });
  const one = async ({ team }) => {
    const abbr = ESPN_ABBR[team.abbreviation] || team.abbreviation;
    const [roster, news] = await Promise.all([espnJson(ESPN + '/teams/' + team.id + '/roster'), espnJson(ESPN + '/news?limit=30&team=' + team.id)]);
    ((roster || {}).athletes || []).forEach(group => (group.items || []).forEach(a => {
      const pid = byKey[abbr + '|' + normName(a.fullName || ((a.firstName || '') + (a.lastName || '')))];
      if (pid && !players[pid].espn_id && a.id) out.ids[pid] = Number(a.id);
    }));
    const items = ((news || {}).articles || [])
      .filter(a => a && a.headline && a.type !== 'Media' && Date.parse(a.published) >= since && (a.categories || []).filter(c => c.type === 'team').length === 1)
      .map(a => ({ d: String(a.published).slice(0, 10), h: a.headline, s: a.description && a.description !== a.headline ? String(a.description).slice(0, 240) : undefined }));
    const seen = new Set();
    out.news[abbr] = items.filter(i => { const k = normName(i.h).slice(0, 40); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 10);
    out.teams++;
  };
  for (let i = 0; i < teams.length; i += 4) await Promise.all(teams.slice(i, i + 4).map(one));
  return out;
}

module.exports = { ENGINE_VERSION, loadShared, buildLeague, slimPlayers, sleeper, espnTeamData };
