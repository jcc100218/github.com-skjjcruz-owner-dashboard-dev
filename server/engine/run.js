// server/engine/run.js — build every connected league and store the result.
//
//   node server/engine/run.js                 # build + store (needs env below)
//   node server/engine/run.js --dry           # build only; write JSON to ./out
//   LEAGUES=id1,id2 node server/engine/run.js # override the league list
//
// Env (store mode): SUPABASE_ACCESS_TOKEN (Supabase management token, the one
// the deploy workflows already hold) and ENGINE_PROJECT_REF (the vacant
// project). The script wakes the project if it is paused, applies
// schema.sql, reads the project's service key, builds, and upserts.
'use strict';
const fs = require('fs');
const path = require('path');
const { ENGINE_VERSION, loadShared, buildLeague, slimPlayers, sleeper, espnTeamData } = require('./headless');
const { buildNewsIndex } = require('./news');
const { createProjector } = require('./dhq-proj');

const DRY = process.argv.includes('--dry');
const REF = process.env.ENGINE_PROJECT_REF || '';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN || '';
const MGMT = 'https://api.supabase.com/v1/projects/' + REF;
const OUT = path.join(__dirname, 'out');

async function mgmt(p, init) {
  const r = await fetch(MGMT + p, Object.assign({ headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', Accept: 'application/json' } }, init || {}));
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  if (!r.ok) throw new Error('management API ' + r.status + ' on ' + p + ': ' + text.slice(0, 300));
  return json;
}
async function sql(query) { return mgmt('/database/query', { method: 'POST', body: JSON.stringify({ query }) }); }

async function ensureAwake() {
  let info = await mgmt('');
  if (info.status === 'ACTIVE_HEALTHY') return info;
  if (info.status === 'INACTIVE' || info.status === 'PAUSED') {
    console.log('project is paused — restoring');
    await mgmt('/restore', { method: 'POST', body: '{}' }).catch(e => { console.warn('restore call:', e.message); });
  }
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 10000));
    info = await mgmt('');
    console.log('  status:', info.status);
    if (info.status === 'ACTIVE_HEALTHY') return info;
  }
  throw new Error('project did not become healthy: ' + info.status);
}

async function serviceKey() {
  const keys = await mgmt('/api-keys?reveal=true');
  const k = (keys || []).find(x => x.name === 'service_role') || (keys || []).find(x => /service/i.test(x.name || ''));
  if (!k || !k.api_key) throw new Error('no service_role key on project ' + REF);
  return k.api_key;
}

function rest(key) {
  const base = 'https://' + REF + '.supabase.co/rest/v1/';
  const headers = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
  return {
    async upsert(table, rows) {
      const r = await fetch(base + table, { method: 'POST', headers: Object.assign({ Prefer: 'resolution=merge-duplicates,return=minimal' }, headers), body: JSON.stringify(rows) });
      if (!r.ok) throw new Error('upsert ' + table + ' ' + r.status + ': ' + (await r.text()).slice(0, 300));
    },
    async select(table, q) {
      const r = await fetch(base + table + '?' + q, { headers });
      if (!r.ok) throw new Error('select ' + table + ' ' + r.status + ': ' + (await r.text()).slice(0, 300));
      return r.json();
    },
  };
}

(async () => {
  const started = new Date().toISOString();
  let db = null;
  if (!DRY) {
    if (!REF || !TOKEN) throw new Error('ENGINE_PROJECT_REF and SUPABASE_ACCESS_TOKEN are required (or pass --dry)');
    await ensureAwake();
    await sql(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    // New tables reach the REST layer only after its schema cache reloads.
    await sql("notify pgrst, 'reload schema'").catch(() => {});
    db = rest(await serviceKey());
    for (let i = 0; ; i++) {
      try { await db.select('connect_leagues', 'select=league_id&limit=1'); break; }
      catch (e) { if (i >= 12 || !/PGRST205|schema cache/.test(e.message)) throw e; await new Promise(r => setTimeout(r, 5000)); }
    }
  } else {
    fs.mkdirSync(OUT, { recursive: true });
  }

  // Which leagues: env override, else the active rows in connect_leagues.
  let leagues = (process.env.LEAGUES || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!leagues.length && db) leagues = (await db.select('connect_leagues', 'select=league_id&active=eq.true')).map(r => r.league_id);
  if (!leagues.length) throw new Error('no leagues to build (set LEAGUES=… or add rows to connect_leagues)');
  console.log('engine', ENGINE_VERSION, DRY ? '(dry run)' : '', '—', leagues.length, 'league(s)');

  const t0 = Date.now();
  const shared = await loadShared();
  console.log('shared data in', ((Date.now() - t0) / 1000).toFixed(1) + 's: season', shared.season, 'week', shared.nfl.display_week || shared.nfl.week, '· players', Object.keys(shared.players).length);

  // Past-season history per league lives in engine_cache so each run only
  // refreshes the current season (the engine's own fast path).
  // Monday-night fix (owner report 2026-10-12): once a game ends Sleeper
  // drops its players from the week's projections. The rows seen this week
  // are kept in engine_cache and merged back, but only for a player whose
  // team has already played: one Sleeper drops before his game stays
  // dropped (truth law). The app does the same on each device.
  if (db) {
    try {
      const live = r => r && ['pts_ppr', 'pts_half_ppr', 'pts_std', 'pass_att', 'rush_att', 'rec_tgt', 'fga', 'xpm', 'idp_tkl', 'idp_sack'].some(k => Number(r[k]) > 0);
      const key = 'sleeper_week_' + shared.season + '_' + shared.week;
      const keptRow = await db.select('engine_cache', 'select=data&key=eq.' + encodeURIComponent(key));
      const kept = (keptRow[0] && keptRow[0].data) || {};
      const fresh = {}; Object.keys(shared.projWeek || {}).forEach(pid => { if (live(shared.projWeek[pid])) fresh[pid] = shared.projWeek[pid]; });
      let back = 0;
      Object.keys(kept).forEach(pid => {
        if (fresh[pid]) return;
        const t = shared.players[pid] && shared.players[pid].team;
        if (t && shared.weekGames[t] && shared.weekGames[t].played) { shared.projWeek[pid] = kept[pid]; back++; }
      });
      await db.upsert('engine_cache', [{ key, data: Object.assign({}, kept, fresh), updated_at: new Date().toISOString() }]);
      console.log('sleeper week lines:', Object.keys(fresh).length, 'fresh ·', back, 'kept rows restored (games already played)');
    } catch (e) { console.warn('sleeper week keep:', e.message); }
  }

  const histCache = db ? {
    async get(key) { const rows = await db.select('engine_cache', 'select=data&key=eq.' + encodeURIComponent(key)); return rows[0] ? rows[0].data : null; },
    async set(key, value) { await db.upsert('engine_cache', [{ key, data: value, updated_at: new Date().toISOString() }]); },
  } : null;

  let ok = 0, failed = 0;
  const rostered = new Set();
  // DHQ weekly projections (server/engine/dhq-proj.js): one projection
  // context per run, then every rostered player per league. A failure here
  // never fails a league build; the server falls back to Sleeper's line.
  let projector = null, projectorError = null;
  const projectorFor = async () => {
    if (projector || projectorError) return projector;
    const tp = Date.now();
    try { projector = await createProjector(shared); console.log('dhq projections ready in', ((Date.now() - tp) / 1000).toFixed(1) + 's ·', JSON.stringify(projector.data), '· sleeper week', projector.sleeperWeek); }
    catch (e) { projectorError = e; console.warn('dhq projections unavailable:', e && e.message || e); }
    return projector;
  };
  for (const lid of leagues) {
    try {
      const row = await buildLeague(lid, shared, histCache);
      try {
        const pj = await projectorFor();
        if (pj && row.snapshot && row.snapshot.league) {
          const r = await pj.league(row.snapshot.league, row.snapshot.rosters || [], Object.keys(row.snapshot.proj || {}));
          row.snapshot.dhq_proj = { week: r.week, built_at: new Date().toISOString(), players: r.proj, inputs: r.data };
          console.log('  dhq projections:', r.projected, 'players (', r.no_line, 'without a Sleeper line ) in', (r.ms / 1000).toFixed(1) + 's, week', r.week);
        }
      } catch (e) { console.warn('  dhq projections failed for', lid + ':', e && e.message || e); }
      const valued = Object.keys(row.intel.playerScores || {}).length;
      ((row.snapshot || {}).rosters || []).forEach(r => (r.players || []).forEach(pid => rostered.add(String(pid))));
      console.log('✓', row.name, '(' + lid + ')', 'in', (row.build_ms / 1000).toFixed(1) + 's ·', valued, 'players valued ·', row.assessments.length, 'teams');
      if (db) await db.upsert('league_intel', [Object.assign(row, { error: null })]);
      else fs.writeFileSync(path.join(OUT, lid + '.json'), JSON.stringify(row));
      ok++;
    } catch (e) {
      failed++;
      console.error('✗', lid, e && e.message || e);
      if (db) await db.upsert('league_intel', [{ league_id: lid, platform: 'sleeper', built_at: new Date().toISOString(), engine_version: ENGINE_VERSION, intel: {}, assessments: [], snapshot: {}, error: String(e && e.message || e).slice(0, 500) }]).catch(() => {});
    }
  }

  // Shared lookups the server needs beside the leagues.
  const players = slimPlayers(shared.players);
  const trending = await sleeper('/players/nfl/trending/add?lookback_hours=24&limit=50').catch(() => []);
  const espn = await espnTeamData(shared.players).catch(e => { console.warn('espn news:', e.message); return null; });
  if (espn) {
    Object.entries(espn.ids).forEach(([pid, id]) => { if (players[pid]) players[pid].e = id; });
    console.log('news:', espn.teams, 'teams,', Object.values(espn.news).reduce((t, l) => t + l.length, 0), 'headlines,', Object.keys(espn.ids).length, 'player ids matched by name');
  }
  const news = { fetched_at: espn ? espn.fetched_at : null, teams: espn ? espn.news : {} };

  // The player news index: every story linked to the players it touches.
  // Last run's player reports ride in engine_cache so only changed ones
  // are fetched again. A failure here never fails the build.
  let newsIndex = null;
  try {
    const prior = histCache ? await histCache.get('news_reports') : null;
    newsIndex = await buildNewsIndex(shared.players, espn ? espn.ids : {}, rostered, prior || {});
    console.log('news index:', JSON.stringify(newsIndex.counts), 'in', (newsIndex.ms / 1000).toFixed(1) + 's');
  } catch (e) { console.warn('news index:', e && e.message || e); }
  if (db) {
    await db.upsert('engine_cache', [
      { key: 'players', data: players, updated_at: new Date().toISOString() },
      { key: 'nfl_state', data: shared.nfl, updated_at: new Date().toISOString() },
      { key: 'trending_add', data: trending || [], updated_at: new Date().toISOString() },
      { key: 'nfl_week', data: { week: shared.week, games: shared.weekGames || {} }, updated_at: new Date().toISOString() },
      { key: 'news', data: news, updated_at: new Date().toISOString() },
    ]);
    if (newsIndex) {
      try {
        const now = new Date().toISOString();
        for (let i = 0; i < newsIndex.rows.length; i += 500) await db.upsert('player_news', newsIndex.rows.slice(i, i + 500).map(r => Object.assign({}, r, { updated_at: now })));
        await db.upsert('engine_cache', [
          { key: 'news_reports', data: newsIndex.reports, updated_at: now },
          { key: 'news_index', data: { fetched_at: newsIndex.fetched_at, counts: newsIndex.counts }, updated_at: now },
        ]);
      } catch (e) { console.warn('news store:', e.message); }
    }
    await db.upsert('engine_runs', [{ started_at: started, finished_at: new Date().toISOString(), engine_version: ENGINE_VERSION, leagues_ok: ok, leagues_failed: failed, notes: process.env.ENGINE_RUNNER || null }]).catch(e => console.warn('run log:', e.message));
  } else {
    fs.writeFileSync(path.join(OUT, 'players.json'), JSON.stringify(players));
    fs.writeFileSync(path.join(OUT, 'nfl_week.json'), JSON.stringify({ week: shared.week, games: shared.weekGames || {} }));
    fs.writeFileSync(path.join(OUT, 'news.json'), JSON.stringify(news));
    if (newsIndex) fs.writeFileSync(path.join(OUT, 'player_news.json'), JSON.stringify(newsIndex.rows));
  }
  console.log('done:', ok, 'built,', failed, 'failed, total', ((Date.now() - t0) / 1000).toFixed(1) + 's; players table', Object.keys(players).length);
  process.exit(failed && !ok ? 1 : 0);
})().catch(e => { console.error('RUN FAILED:', e && e.stack || e); process.exit(1); });
