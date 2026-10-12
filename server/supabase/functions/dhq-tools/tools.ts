// dhq-tools/tools.ts — the DHQ tools, computed over what the engine builder
// stored (league_intel, engine_cache). Everything comes in through `Ctx`, so
// it is testable with the builder's dry-run JSON; the only network calls are
// the small game-day fetches in live.ts (scores, lineups, injuries) and a
// player's latest news blurb, and every one of them falls back to the cache.
// The trade math is the engine's own trade-engine.js (vendored at deploy
// time), passed in as `te`.
import { fetchLive, type LiveState } from './live.ts';
import { VERDICT_DEFS, VERDICT_NAMES, runVerdict } from './verdicts.ts';
import { LEAGUE_DEFS, LEAGUE_NAMES, runLeagueTool, rulesOf, groupScoring, rosterSlots, ownerExtras, teamArg } from './league-tools.ts';
import { evaluateTrade } from './decide-trade.ts';
import { leaguePositions, normPos } from './decide-common.ts';

export interface PlayerSlim { n: string; pos: string; fp?: string[]; t: string | null; age: number | null; yrs: number | null; st: string | null; inj: string | null; injp: string | null; dc: string | null; dco: number | null; col: string | null; num: number | null; act: boolean; e?: number | null }
export interface Roster { roster_id: number; owner_id: string; co_owners: string[] | null; players: string[]; starters: string[]; reserve: string[]; taxi: string[]; settings: Record<string, number>; metadata: { team_name?: string } | null }
export interface User { user_id: string; display_name: string; avatar: string | null; team_name: string | null; team_avatar: string | null }
export interface Pick { year: number; round: number; from: number; value: number }
export interface LeagueRow {
  league_id: string; season: string; name: string; built_at: string; engine_version: string;
  intel: Record<string, any>; assessments: any[]; dna: Record<string, any>;
  snapshot: { league: any; rosters: Roster[]; users: User[]; traded_picks: any[]; matchups: any[]; nfl_state: any; picks?: Record<string, Pick[]>; games?: Record<string, Array<number | null>>; proj?: Record<string, number>; proj_week?: number; txns?: any[];
    weeks?: Record<string, Array<{ roster_id: number; matchup_id: number | null; points: number }>>; last_reg_week?: number;
    history?: Array<{ season: string; league_id: string; last_reg_week: number; owners: Record<string, string | null>; weeks: Record<string, Array<{ roster_id: number; matchup_id: number | null; points: number }>> }> };
}
export interface TradeEngine {
  fairnessGrade(give: number, get: number): { grade: string; label: string };
  calcOwnerPosture(assessment: any, dnaKey: string): { key: string; label: string; desc: string };
  calcPsychTaxes(mine: any, theirs: any, dnaKey: string, posture: any): Array<{ name: string; impact: number; desc: string }>;
  calcAcceptanceLikelihood(give: number, get: number, dnaKey: string, taxes: any[], mine: any, theirs: any, opts: any): number;
  calcComplementarity(mine: any, theirs: any): number;
}
export interface Ctx {
  memberId: string;                       // Sleeper user id behind the key
  leagues: LeagueRow[];                   // every stored league this member is in (intel may be omitted for listing)
  loadLeague(id: string): Promise<LeagueRow | null>;
  players: Record<string, PlayerSlim>;
  nflState: any;
  trending: Array<{ player_id: string; count: number }>;
  nflWeek?: { week: number; games: Record<string, { opp: string; date: string | null; played?: boolean }> };   // who each NFL team plays this week, and whether that game already happened
  news?: { fetched_at: string | null; teams: Record<string, Array<{ d: string; h: string; s?: string }>> };   // last week of headlines per NFL team
  live?: LiveState;                        // game-day facts fetched at answer time (see live.ts)
  te: TradeEngine;
}
// Fetch the live bits for a league and the players an answer is about.
export async function goLive(ctx: Ctx, L: LeagueRow | null, pids: string[]): Promise<string | null> {
  const season = String((L && L.season) || ctx.nflState?.season || ''); const week = Number((L && L.snapshot.proj_week) || ctx.nflState?.week || 0);
  if (!season || !week) return null;
  ctx.live = await fetchLive(ctx.live, L ? L.league_id : null, season, week, pids);
  return ctx.live.at;
}
// A player's injury designation and depth chart: fresh when we have it, else from the two-hour build.
export function fresh(ctx: Ctx, pid: string): Partial<PlayerSlim> {
  const p = ctx.players[pid] || ({} as Partial<PlayerSlim>);
  const f = ctx.live && ctx.live.injuries[pid];
  return f ? { ...p, inj: f.inj, injp: f.injp, st: f.st || p.st, dc: f.dc || p.dc, dco: f.dco ?? p.dco, t: f.t || p.t } : p;
}
export function livePoints(ctx: Ctx, L: LeagueRow, pid: string): number | null {
  const rows = ctx.live && ctx.live.matchups[L.league_id];
  if (!rows) return null;
  for (const r of rows) if (r.players_points && pid in r.players_points) return Number(r.players_points[pid]) || 0;
  return null;
}

export class ToolError extends Error {}

export const round1 = (n: unknown) => Math.round(Number(n || 0) * 10) / 10;
export const norm = (s: unknown) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const ord = (n: number) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');

// ── league helpers ─────────────────────────────────────────────────
export function myRoster(L: LeagueRow, memberId: string): Roster | null {
  return L.snapshot.rosters.find(r => r.owner_id === memberId || (r.co_owners || []).includes(memberId)) || null;
}
export function rosterOf(L: LeagueRow, rid: unknown): Roster | null {
  return L.snapshot.rosters.find(r => String(r.roster_id) === String(rid)) || null;
}
export function userOf(L: LeagueRow, r: Roster | null): User | null {
  return r ? (L.snapshot.users.find(u => u.user_id === r.owner_id) || null) : null;
}
export function teamName(L: LeagueRow, rid: unknown): string {
  const r = rosterOf(L, rid); const u = userOf(L, r);
  return (r && r.metadata && r.metadata.team_name) || (u && (u.team_name || u.display_name)) || ('Team ' + rid);
}
export function ownerName(L: LeagueRow, rid: unknown): string { const u = userOf(L, rosterOf(L, rid)); return u ? u.display_name : ''; }
export function dhq(L: LeagueRow, pid: string): number { const v = (L.intel.playerScores || {})[pid]; return v > 0 ? Math.round(v) : 0; }
export function whoRosters(L: LeagueRow, pid: string): number | null { const r = L.snapshot.rosters.find(x => (x.players || []).includes(pid)); return r ? r.roster_id : null; }
export function assessOf(L: LeagueRow, rid: unknown) { return (L.assessments || []).find(a => String(a.rosterId) === String(rid)) || null; }
export function assessBrief(a: any) {
  if (!a) return null;
  return {
    tier: a.tier, window: a.window, health_score: a.healthScore, power_rank: a.powerRank,
    needs: (a.needs || []).map((n: any) => n.pos + (n.urgency ? ' (' + n.urgency + ')' : '')),
    strengths: a.strengths || [], faab_left: a.faabRemaining ?? undefined,
  };
}
export function leagueFormat(L: LeagueRow) {
  const lg = L.snapshot.league; const sc = lg.scoring_settings || {}; const pos: string[] = lg.roster_positions || [];
  const starters = pos.filter(p => !['BN', 'IR', 'TAXI'].includes(p));
  return {
    superflex: pos.includes('SUPER_FLEX'), ppr: Number(sc.rec || 0), te_premium: Number(sc.bonus_rec_te || 0),
    idp: starters.some(p => /^(DL|LB|DB|IDP_FLEX|DE|DT|CB|S)$/.test(p)), starting_slots: starters, teams: L.snapshot.rosters.length,
    faab_budget: Number((lg.settings || {}).waiver_budget || 0) || null, playoff_teams: Number((lg.settings || {}).playoff_teams || 0) || null,
    playoff_week_start: Number((lg.settings || {}).playoff_week_start || 0) || null, taxi_slots: Number((lg.settings || {}).taxi_slots || 0) || 0,
    draft_rounds: Number((lg.settings || {}).draft_rounds || 0) || null,
  };
}
function standings(L: LeagueRow, memberId: string) {
  const me = myRoster(L, memberId);
  return L.snapshot.rosters.map(r => {
    const s = r.settings || {}; const a = assessOf(L, r.roster_id);
    return { roster_id: r.roster_id, team: teamName(L, r.roster_id), owner: ownerName(L, r.roster_id), wins: s.wins || 0, losses: s.losses || 0, ties: s.ties || 0, points_for: round1((s.fpts || 0) + (s.fpts_decimal || 0) / 100), tier: a ? a.tier : undefined, power_rank: a ? a.powerRank : undefined, mine: me && me.roster_id === r.roster_id ? true : undefined };
  }).sort((a, b) => b.wins - a.wins || b.points_for - a.points_for).map((t, i) => ({ standing: i + 1, ...t }));
}
export function playerRow(ctx: Ctx, L: LeagueRow | null, pid: string, extra?: Record<string, unknown>) {
  const p = fresh(ctx, pid); const m = L ? ((L.intel.playerMeta || {})[pid] || {}) : {};
  const row: Record<string, unknown> = { id: pid, name: p.n || pid, pos: m.pos || p.pos || '', nfl_team: p.t || 'FA', age: p.age ?? m.age ?? null };
  if (L) row.dhq_value = dhq(L, pid);
  if (m.ppg != null) row.dhq_rate_ppg = round1(m.ppg);
  if (L) Object.assign(row, seasonBits(ctx, L, pid));
  if (m.peakYrsLeft != null) row.peak_years_left = m.peakYrsLeft;
  if (m.ageCurvePhase) row.age_phase = m.ageCurvePhase;
  if (m.trend) row.value_trend_pct = m.trend;
  if (m.roleLabel) row.role = m.roleLabel;
  if (p.inj) row.injury = p.inj + (p.injp ? ' (' + p.injp + ')' : '');
  if (p.dc && p.dco != null) row.depth_chart = p.dc + ' #' + p.dco;
  Object.assign(row, gameBits(ctx, p.t));
  return Object.assign(row, extra || {});
}
// This week's NFL game for a team: opponent and date, or BYE.
export function gameBits(ctx: Ctx, team: string | null | undefined): { nfl_opponent?: string; game_date?: string | null; game_status?: string } {
  if (!team) return {};
  const s = ctx.live && ctx.live.scores;
  if (s) {
    const g = s[team];
    if (!g) return { nfl_opponent: 'BYE' };
    const date = g.kick ? new Date(g.kick).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : null;
    const status = g.over ? 'final' + (g.score ? ' (' + g.score + ')' : '') + ', locked'
      : g.in_progress ? 'in progress' + (g.clock ? ' (' + g.clock.trim() + (g.score ? ', ' + g.score : '') + ')' : '') + ', locked'
      : g.started ? 'started, locked' : 'upcoming';
    return { nfl_opponent: (g.home ? 'vs ' : 'at ') + g.opp, game_date: date, game_status: status };
  }
  if (!ctx.nflWeek) return {};
  const g = ctx.nflWeek.games[team];
  return g ? { nfl_opponent: g.opp, game_date: g.date, game_status: g.played ? 'already played (locked in Sleeper)' : 'upcoming' } : { nfl_opponent: 'BYE' };
}
export function teamPlayed(ctx: Ctx, team: string | null | undefined): boolean {
  if (!team) return false;
  if (ctx.live && ctx.live.scores) return !!(ctx.live.scores[team] && ctx.live.scores[team].started);
  return !!(ctx.nflWeek && ctx.nflWeek.games[team] && ctx.nflWeek.games[team].played);
}
export function teamOver(ctx: Ctx, team: string | null | undefined): boolean {
  if (ctx.live && ctx.live.scores && team) return !!(ctx.live.scores[team] && ctx.live.scores[team].over);
  return teamPlayed(ctx, team);   // the two-hour build only knows "has a stat line", so treat it as done
}
// ── News ──────────────────────────────────────────────────────────────────
// Team headlines come from the engine's cache (refreshed with every build).
// A player's own latest blurb is fetched live from ESPN's public feed when
// Sleeper or the roster match gave us his ESPN id.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dateLabel(d: string) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d); return m ? MONTHS[Number(m[2]) - 1] + ' ' + Number(m[3]) : d; }
export function teamNews(ctx: Ctx, team: string | null | undefined, limit = 6): string[] | undefined {
  const list = ctx.news && team ? ctx.news.teams[team] : null;
  if (!list || !list.length) return undefined;
  return list.slice(0, limit).map(i => dateLabel(i.d) + ': ' + i.h + (i.s ? ' — ' + i.s : ''));
}
type Story = { date: string; kind: string; how: string; headline: string; summary?: string; url?: string; source?: string };
type Blurb = { published?: string; headline?: string; story?: string; stories?: Story[] };
// The engine's player news index (server/engine/news.js → player_news):
// every story of the last 14 days linked to the player, his own and the
// team news that reaches him (coaching/play-calling, his quarterback).
async function linkedNews(pids: string[]): Promise<Record<string, Story[]>> {
  const url = Deno.env.get('SUPABASE_URL') || '', key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const ids = [...new Set(pids)].filter(p => /^[A-Za-z0-9]{1,12}$/.test(p)).slice(0, 40);
  if (!url || !key || !ids.length) return {};
  try {
    const since = new Date(Date.now() - 14 * 864e5).toISOString();
    const r = await fetch(url + '/rest/v1/player_news?select=player_id,kind,link,why,headline,summary,url,source,published_at&player_id=in.(' + ids.join(',') + ')&link=neq.report&published_at=gte.' + since + '&order=published_at.desc&limit=400', { headers: { apikey: key, Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(3000) });
    if (!r.ok) return {};
    const out: Record<string, Story[]> = {};
    for (const x of await r.json() as Array<Record<string, string>>) {
      const list = out[x.player_id] = out[x.player_id] || [];
      if (list.length >= 5) continue;
      list.push({ date: dateLabel(x.published_at.slice(0, 10)), kind: x.kind, how: x.link === 'direct' ? 'about him' : 'via ' + (x.why || 'his team'), headline: x.headline, summary: x.summary || undefined, url: x.url || undefined, source: x.source || undefined });
    }
    return out;
  } catch { return {}; }
}
export async function latestBlurbs(ctx: Ctx, pids: string[]): Promise<Record<string, Blurb>> {
  const out: Record<string, Blurb> = {};
  const linked = linkedNews(pids);
  const want = [...new Set(pids)].filter(pid => ctx.players[pid] && ctx.players[pid].e).slice(0, 12);
  await Promise.all(want.map(async pid => {
    try {
      const r = await fetch('https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/' + ctx.players[pid].e + '/overview', { signal: AbortSignal.timeout(3500) });
      if (!r.ok) return;
      const j = await r.json();
      const rw = j && j.rotowire;
      if (rw && (rw.headline || rw.story)) out[pid] = { published: rw.published ? String(rw.published).replace(/\s\d\d:\d\d:\d\d\s\w+\s/, ' ') : undefined, headline: rw.headline, story: rw.story ? String(rw.story).slice(0, 600) : undefined };
    } catch { /* no blurb this time */ }
  }));
  const stories = await linked;
  Object.entries(stories).forEach(([pid, list]) => { if (list.length) out[pid] = { ...(out[pid] || {}), stories: list }; });
  return out;
}
// This season so far and this week, in the league's scoring.
export function seasonBits(ctx: Ctx, L: LeagueRow, pid: string) {
  const out: Record<string, unknown> = {};
  const wk = Number(L.snapshot.proj_week) || 0;
  const log = (L.snapshot.games || {})[pid];
  // This week's game, if it already happened, is reported on its own, not
  // as a projection: the member cannot change a player whose game started.
  const thisWeekPts = log && wk && log.length >= wk ? log[wk - 1] : null;
  if (log) {
    const played = log.filter((x): x is number => x != null);
    out.season_games = played.length;
    out.season_avg = played.length ? round1(played.reduce((t, x) => t + x, 0) / played.length) : null;
    const past = wk ? log.slice(0, wk - 1) : log;
    out.game_log = past.map((x, i) => 'W' + (i + 1) + ' ' + (x == null ? 'DNP' : round1(x))).join(', ') || 'no games before this week';
  }
  const team = fresh(ctx, pid).t;
  const lp = livePoints(ctx, L, pid);
  if (teamPlayed(ctx, team)) {
    const pts = lp != null ? lp : thisWeekPts;
    const over = teamOver(ctx, team);
    out.scored_this_week = round1(pts || 0);
    out.this_week = over
      ? (pts != null && (pts !== 0 || thisWeekPts != null) ? 'ALREADY PLAYED: scored ' + round1(pts) + ' (final, locked, cannot be swapped)' : 'DID NOT PLAY: his team already played this week (locked, cannot be swapped)')
      : 'IN PROGRESS: ' + round1(pts || 0) + ' so far (locked, cannot be swapped)';
  } else if (thisWeekPts != null) {
    // The build saw a stat line but the live scoreboard says the game has not started: trust the scoreboard, keep the number visible.
    out.scored_this_week = round1(thisWeekPts);
    out.this_week = 'scored ' + round1(thisWeekPts) + ' this week';
  } else {
    // Owner rulings 2026-10-12: every this-week number is DHQ's projection
    // (its average week, the number on the app's Lineup screen), and the AI
    // never sees or quotes Sleeper's. The build projects everyone with a
    // Sleeper line (truth law: no line means no role, so no projection).
    // Sleeper's line is used only when the build stored no DHQ projections
    // at all, and then it is not labeled as Sleeper's.
    const d = (L.snapshot as any).dhq_proj;
    const dhqOn = !!(d && d.players && Object.keys(d.players).length && Number(d.week) === wk);
    const dl = dhqOn ? d.players[pid] : null;
    if (dl && !dl.no_line) {
      out.proj_this_week = round1(Number(dl.mean) || 0);
      if (Number(dl.mean) > 0) { out.proj_floor = round1(Number(dl.floor) || 0); out.proj_ceiling = round1(Number(dl.ceiling) || 0); if (dl.why) out.proj_why = String(dl.why); }
    } else if (!dhqOn) {
      const pr = (L.snapshot.proj || {})[pid];
      if (pr != null) out.proj_this_week = round1(pr);
      else if (wk) out.proj_this_week = null;
    } else if (wk) out.proj_this_week = null;
  }
  return out;
}
export function compactRow(x: Record<string, any>): string {
  return [
    x.name + ' ' + x.pos + ' ' + x.nfl_team, x.age != null ? 'age ' + x.age : '',
    x.dhq_value != null ? 'DHQ ' + x.dhq_value + (x.league_rank ? ' (#' + x.league_rank + ', ' + x.pos + x.pos_rank + ')' : '') : '',
    x.nfl_opponent ? (x.nfl_opponent === 'BYE' ? 'BYE this wk' : 'vs ' + x.nfl_opponent) : '',
    x.scored_this_week != null ? 'this wk: ' + (x.scored_this_week ? 'scored ' + x.scored_this_week : 'did not play') + ' (already played, locked)' : x.proj_this_week != null ? 'this wk DHQ proj ' + x.proj_this_week : (x.proj_this_week === null ? 'this wk: no projection' : ''),
    x.season_games != null ? 'season ' + x.season_avg + ' avg (' + x.season_games + ' gp)' : 'season: no games',
    x.peak_years_left != null ? x.peak_years_left + ' peak yrs, ' + (x.age_phase || '') : '',
    x.value_trend_pct ? 'trend ' + (x.value_trend_pct > 0 ? '+' : '') + x.value_trend_pct + '%' : '', x.injury ? 'INJ ' + x.injury : '', x.slot || '',
  ].filter(Boolean).join(' | ');
}
export function leagueRank(L: LeagueRow, pid: string) {
  const rostered = new Set<string>(); L.snapshot.rosters.forEach(r => r.players.forEach(x => rostered.add(x)));
  const all = Object.entries(L.intel.playerScores || {}).filter(([id]) => rostered.has(id)).sort((a, b) => (b[1] as number) - (a[1] as number));
  const overall = all.findIndex(([id]) => id === pid) + 1;
  const pos = ((L.intel.playerMeta || {})[pid] || {}).pos;
  const posRank = all.filter(([id]) => ((L.intel.playerMeta || {})[id] || {}).pos === pos).findIndex(([id]) => id === pid) + 1;
  return overall ? { overall, pos: posRank } : null;
}
function findPlayers(ctx: Ctx, L: LeagueRow | null, q: unknown, limit = 5): string[] {
  const s = String(q || '').trim(); if (!s) return [];
  if (/^\d+$/.test(s) && ctx.players[s]) return [s];
  const n = norm(s);
  const rostered = new Set<string>(); if (L) L.snapshot.rosters.forEach(r => r.players.forEach(x => rostered.add(x)));
  const hits: Array<{ pid: string; score: number; ros: number; v: number }> = [];
  for (const pid in ctx.players) {
    const p = ctx.players[pid]; const full = norm(p.n); if (!full) continue;
    const last = norm(p.n.split(' ').slice(-1)[0]);
    let score = 0;
    if (full === n) score = 3; else if (full.startsWith(n) || last === n) score = 2; else if (n.length >= 4 && full.includes(n)) score = 1;
    if (score) hits.push({ pid, score, ros: rostered.has(pid) ? 1 : 0, v: L ? dhq(L, pid) : (p.act ? 1 : 0) });
  }
  hits.sort((a, b) => b.score - a.score || b.ros - a.ros || b.v - a.v);
  return hits.slice(0, limit).map(h => h.pid);
}
export const resolveOne = (ctx: Ctx, L: LeagueRow | null, q: unknown) => findPlayers(ctx, L, q, 1)[0] || null;
export function pickLabel(pk: Pick, holder: number, L: LeagueRow) { return pk.year + ' ' + ord(pk.round) + (pk.from !== holder ? ' (from ' + teamName(L, pk.from) + ')' : ''); }

// Which league a tool means: the given id, else the member's only league.
export async function league(ctx: Ctx, args: any): Promise<LeagueRow> {
  const id = args && args.league_id != null ? String(args.league_id) : '';
  if (id) {
    const row = await ctx.loadLeague(id);
    if (!row) throw new ToolError('No league ' + id + ' is connected for you. Call list_leagues.');
    return row;
  }
  if (ctx.leagues.length === 1) return (await ctx.loadLeague(ctx.leagues[0].league_id))!;
  throw new ToolError('Which league? Pass league_id — call list_leagues to see them.');
}

// ── the tools ──────────────────────────────────────────────────────
export const TOOL_DEFS = [
  def('list_leagues', 'The member\'s connected leagues: id, name, format, their team and record, and when the DHQ numbers were last refreshed. Call this first when league_id is unknown.', {}),
  def('get_league', 'League setup and rules: scoring format (superflex, PPR, TE premium, IDP), roster slots, the full scoring settings grouped (passing, rushing, receiving, bonuses, kicking, IDP...), and the rules (trade deadline, veto, playoffs: teams, start week, bracket and seeding; waivers: type, FAAB budget, minimum bid, processing day; taxi and IR rules; divisions), NFL week, and the standings with each team\'s DHQ tier and power rank. For points against, luck, FAAB left per team and waiver order call get_standings.', { league_id: S('League id') }),
  def('get_team', 'A team\'s roster with each player\'s DHQ dynasty value, league rank, age, points per game, peak years left, injury and lineup slot; their draft picks with values; record, tier, window, needs, strengths and FAAB. Omit roster_id for the member\'s own team.', { league_id: S('League id'), roster_id: N('Roster id from standings; omit for my team') }),
  def('find_players', 'Search NFL players by name. Returns ids, position, team, DHQ value in the league and who rosters them.', { name: S('Full or partial name'), league_id: S('League id (optional, for values)') }, ['name']),
  def('get_player', 'One player in depth: bio, NFL team, depth chart, injury, DHQ value and trend, age curve, role, league rank, who rosters him, and his trade history in this league.', { player: S('Player name or id'), league_id: S('League id') }, ['player']),
  def('evaluate_trade', 'Grade a proposed trade. Read `verdict` first: one decision (offer / counter / pass) that already reconciles ownership, the headliner rule (a young starter costs a next-draft 1st or a young player worth 70%+; a rebuilder won\'t count a 1st two or more drafts away), what this partner wants (their real mode: rebuilding / contending / middle, from their record, this season\'s trades and their trade block) and value. Also: every piece\'s DHQ value (picks in the next draft at their projected slot), the raw-value fairness grade (never overrules the verdict), the chance the other owner accepts on what the package is worth TO THEM, how to balance it, their DNA, posture, psychology and roster fit. Picks read like "2027 1st", "2026 1.03" or "2027 2nd from Gas". To BUILD an offer, call trade_plan.', { league_id: S('League id'), give: A('What the member sends'), get: A('What the member receives'), partner: S('Other team or owner (optional; inferred from what the member receives)'), partner_roster_id: N('Other team\'s roster id (optional)') }, ['give', 'get']),
  def('get_owner_profile', 'An owner\'s trading personality from the league\'s full trade history: DNA type and why, trade count, value wins/losses, positions bought and sold, favorite partners, timing, biggest win and biggest loss, players acquired and sold, recent deals, trades with me, and this season\'s waiver/FAAB activity.', { league_id: S('League id'), team: S('Team name, owner name, roster id, or "me"'), roster_id: N('Roster id (alternative to team)') }),
  def('get_recent_trades', 'Completed trades in the league, newest first, with what each side got and who won on DHQ value.', { league_id: S('League id'), days: N('Look-back window in days (default 30)'), roster_id: N('Only trades involving this roster (optional)') }),
  def('get_waiver_options', 'Best available free agents by DHQ value, Sleeper\'s trending adds, the member\'s FAAB left, and what this league usually pays by position.', { league_id: S('League id'), position: S('QB, RB, WR, TE, K, DL, LB, DB (optional)'), limit: N('How many (default 8, max 15)') }),
  def('get_pick_values', 'What draft picks are worth in this league (DHQ pick values by round and slot), plus who owns which picks.', { league_id: S('League id'), roster_id: N('Only this roster\'s picks (optional)') }),
  def('get_weekly_projections', 'START/SIT: this week\'s DHQ projection (proj_this_week with proj_floor and proj_ceiling, the app\'s Lineup screen number) for each player in this league\'s scoring, with injury status and this season\'s game log. Use this (not dynasty value or long-run rates) to decide who to start, and always include every player being compared so you never have to send the member elsewhere for a number. Then search the web for the last week of news on each player and his team (play-caller, coaching or QB changes, teammate injuries, role changes, weather) and lead with the biggest item.', { league_id: S('League id'), players: A('Player names or ids (up to 20)') }, ['players']),
  def('get_my_matchup', 'This week\'s head-to-head matchup for the member: opponent, both set lineups with each starter\'s projection and injury, projected totals, and the bench players projected higher than a starter. For the lineup decision itself call get_start_sit.', { league_id: S('League id') }),
  ...LEAGUE_DEFS,
  ...VERDICT_DEFS,
];
function def(name: string, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return { name, description, inputSchema: { type: 'object', properties, required }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } };
}
function S(d: string) { return { type: 'string', description: d }; }
function N(d: string) { return { type: 'number', description: d }; }
function A(d: string) { return { type: 'array', items: { type: 'string' }, description: d }; }

export async function runTool(ctx: Ctx, name: string, args: any): Promise<unknown> {
  args = args || {};
  switch (name) {
    case 'list_leagues': return listLeagues(ctx);
    case 'get_league': return getLeague(ctx, await league(ctx, args));
    case 'get_team': return getTeam(ctx, await league(ctx, args), args);
    case 'find_players': return findPlayersTool(ctx, args);
    case 'get_player': return getPlayer(ctx, args);
    case 'evaluate_trade': return evaluateTrade(ctx, await league(ctx, args), args);
    case 'get_owner_profile': return ownerProfile(ctx, await league(ctx, args), args);
    case 'get_recent_trades': return recentTrades(ctx, await league(ctx, args), args);
    case 'get_waiver_options': return waiverOptions(ctx, await league(ctx, args), args);
    case 'get_pick_values': return pickValues(ctx, await league(ctx, args), args);
    case 'get_weekly_projections': return weeklyProjections(ctx, await league(ctx, args), args);
    case 'get_my_matchup': return myMatchup(ctx, await league(ctx, args));
    default:
      if (LEAGUE_NAMES.has(name)) return runLeagueTool(ctx, await league(ctx, args), name, args);
      if (VERDICT_NAMES.has(name)) return runVerdict(ctx, await league(ctx, args), name, args);
      throw new ToolError('Unknown tool ' + name);
  }
}

function listLeagues(ctx: Ctx) {
  return {
    member_sleeper_user_id: ctx.memberId, nfl_week: ctx.nflState?.display_week || ctx.nflState?.week,
    leagues: ctx.leagues.map(L => {
      const me = myRoster(L, ctx.memberId); const s = (me && me.settings) || {}; const f = leagueFormat(L); const a = me ? assessOf(L, me.roster_id) : null;
      return { league_id: L.league_id, name: L.name, season: L.season, teams: f.teams, format: [f.superflex ? 'superflex' : '1QB', f.ppr ? f.ppr + ' PPR' : 'standard', f.te_premium ? 'TE premium' : '', f.idp ? 'IDP' : ''].filter(Boolean).join(', '), status: L.snapshot.league.status,
        my_team: me ? teamName(L, me.roster_id) : null, my_roster_id: me ? me.roster_id : null, record: me ? (s.wins || 0) + '-' + (s.losses || 0) + (s.ties ? '-' + s.ties : '') : null, tier: a ? a.tier : undefined, power_rank: a ? a.powerRank : undefined, numbers_as_of: L.built_at };
    }),
  };
}
function getLeague(ctx: Ctx, L: LeagueRow) {
  const me = myRoster(L, ctx.memberId);
  return { league_id: L.league_id, league: L.name, season: L.season, status: L.snapshot.league.status, nfl_week: L.snapshot.nfl_state?.week, format: leagueFormat(L), roster_slots: rosterSlots(L), rules: rulesOf(L), scoring: groupScoring((L.snapshot.league || {}).scoring_settings || {}), my_roster_id: me ? me.roster_id : null, my_team: me ? teamName(L, me.roster_id) : null, standings: standings(L, ctx.memberId), numbers_as_of: L.built_at };
}
async function getTeam(ctx: Ctx, L: LeagueRow, args: any) {
  const me = myRoster(L, ctx.memberId);
  const rid = args.roster_id != null ? args.roster_id : (me ? me.roster_id : null);
  const r = rosterOf(L, rid);
  if (!r) throw new ToolError('No roster ' + rid + ' in ' + L.name + '. Use get_league for roster ids.');
  const liveAt = await goLive(ctx, L, r.starters || []);
  const liveRow = ctx.live && ctx.live.matchups[L.league_id] && ctx.live.matchups[L.league_id].find(m => String(m.roster_id) === String(r.roster_id));
  const starters = new Set(((liveRow && liveRow.starters) || r.starters || []).filter(x => x && x !== '0')), ir = new Set(r.reserve || []), taxi = new Set(r.taxi || []);
  const rows = (r.players || []).map(pid => { const lr = leagueRank(L, pid); return playerRow(ctx, L, pid, { slot: starters.has(pid) ? 'starter' : ir.has(pid) ? 'IR' : taxi.has(pid) ? 'taxi' : 'bench', league_rank: lr ? lr.overall : undefined, pos_rank: lr ? lr.pos : undefined }); })
    .sort((a: any, b: any) => b.dhq_value - a.dhq_value);
  const picks = ((L.snapshot.picks || {})[String(r.roster_id)] || []).map(pk => pickLabel(pk, r.roster_id, L) + ' · DHQ ' + pk.value);
  const s = r.settings || {}; const a = assessOf(L, r.roster_id);
  return {
    league_id: L.league_id, roster_id: r.roster_id, team: teamName(L, r.roster_id), owner: ownerName(L, r.roster_id), is_mine: !!(me && me.roster_id === r.roster_id),
    record: (s.wins || 0) + '-' + (s.losses || 0) + (s.ties ? '-' + s.ties : ''), points_for: round1((s.fpts || 0) + (s.fpts_decimal || 0) / 100),
    assessment: assessBrief(a), total_dhq_value: rows.reduce((t: number, p: any) => t + p.dhq_value, 0),
    players_key: 'name pos NFL-team | age | DHQ dynasty value (league rank, position rank) | this week\'s NFL opponent (or BYE) | this week\'s DHQ projection in this league\'s scoring | this season\'s average and games played | peak years left, age phase | value trend | injury | slot',
    players: rows.map(compactRow), picks, live_as_of: liveAt, numbers_as_of: L.built_at,
  };
}
async function findPlayersTool(ctx: Ctx, args: any) {
  const L = args.league_id ? await ctx.loadLeague(String(args.league_id)) : (ctx.leagues.length === 1 ? await ctx.loadLeague(ctx.leagues[0].league_id) : null);
  return findPlayers(ctx, L, args.name, 6).map(pid => { const rid = L ? whoRosters(L, pid) : null; return playerRow(ctx, L, pid, { rostered_by: L ? (rid ? teamName(L, rid) + ' (roster ' + rid + ')' : 'free agent') : undefined }); });
}
async function getPlayer(ctx: Ctx, args: any) {
  const L = args.league_id ? await ctx.loadLeague(String(args.league_id)) : (ctx.leagues.length === 1 ? await ctx.loadLeague(ctx.leagues[0].league_id) : null);
  const pid = resolveOne(ctx, L, args.player);
  if (!pid) throw new ToolError('No player matches "' + args.player + '". Try find_players.');
  const p = ctx.players[pid]; const m = L ? ((L.intel.playerMeta || {})[pid] || {}) : {};
  const rid = L ? whoRosters(L, pid) : null; const lr = L ? leagueRank(L, pid) : null;
  const trades = L ? (L.intel.tradeHistory || []).filter((t: any) => Object.values(t.sides || {}).some((s: any) => (s.players || []).includes(pid))).sort((a: any, b: any) => (b.ts || 0) - (a.ts || 0)).slice(0, 5) : [];
  const [blurbs, liveAt] = await Promise.all([latestBlurbs(ctx, [pid]), goLive(ctx, L, [pid])]);
  return Object.assign(playerRow(ctx, L, pid), {
    latest_news: blurbs[pid], team_news: teamNews(ctx, fresh(ctx, pid).t), live_as_of: liveAt,
    rostered_by: L ? (rid ? teamName(L, rid) + ' (roster ' + rid + ')' : 'free agent') : undefined, league_rank: lr ? lr.overall : undefined, pos_rank: lr ? lr.pos : undefined,
    years_exp: p.yrs, college: p.col, status: p.st, last_season_ppg: m.lastYearPPG != null ? round1(m.lastYearPPG) : undefined, career_ppg: m.careerPPG != null ? round1(m.careerPPG) : undefined, games_recent: m.recentGP, status_note: m.statusReason || undefined,
    traded_in_this_league: L ? trades.map((t: any) => ({ date: t.ts ? new Date(t.ts).toISOString().slice(0, 10) : t.season, to: Object.entries(t.sides || {}).filter(([, s]: any) => (s.players || []).includes(pid)).map(([r]) => teamName(L, r))[0], value_then: Object.values(t.sides || {}).find((s: any) => (s.players || []).includes(pid)) && (Object.values(t.sides || {}).find((s: any) => (s.players || []).includes(pid)) as any).totalValue })) : undefined,
    numbers_as_of: L ? L.built_at : undefined,
  });
}
function ownerProfile(ctx: Ctx, L: LeagueRow, args: any) {
  const rid = teamArg(ctx, L, args.team, args.roster_id).roster_id;
  const pr = (L.intel.ownerProfiles || {})[String(rid)]; const dna = (L.dna || {})[String(rid)];
  const out: Record<string, unknown> = { league_id: L.league_id, roster_id: Number(rid), team: teamName(L, rid), owner: ownerName(L, rid) };
  if (dna) out.dna = { type: dna.key, confidence_pct: dna.confidence, why: dna.reasoning };
  if (pr) Object.assign(out, { style: pr.dna, trades_total: pr.trades, trades_won: pr.tradesWon, trades_lost: pr.tradesLost, trades_fair: pr.tradesFair, avg_value_edge: pr.avgValueDiff, favorite_target_pos: pr.targetPos, positions_bought: pr.posAcquired, positions_sold: pr.posSold, picks_bought: pr.picksAcquired, picks_sold: pr.picksSold, top_partners: Object.entries(pr.partners || {}).sort((a: any, b: any) => b[1] - a[1]).slice(0, 4).map(([r, n]) => teamName(L, r) + ' x' + n), week_timing: pr.weekTiming, season_activity: pr.seasonActivity });
  out.recent_trades = (recentTrades(ctx, L, { days: 400, roster_id: rid }) as any).trades.slice(0, 5);
  out.team_now = assessBrief(assessOf(L, rid));
  Object.assign(out, ownerExtras(ctx, L, rid));
  return out;
}
function recentTrades(ctx: Ctx, L: LeagueRow, args: any) {
  const days = Math.max(1, Math.min(1500, Number(args.days) || 30)); const since = Date.now() - days * 86400000;
  const rid = args.roster_id != null ? Number(args.roster_id) : null;
  const list = (L.intel.tradeHistory || []).filter((t: any) => (t.ts || 0) >= since && (rid == null || (t.roster_ids || []).includes(rid))).sort((a: any, b: any) => (b.ts || 0) - (a.ts || 0)).slice(0, 15);
  return { league_id: L.league_id, days, count: list.length, trades: list.map((t: any) => ({ date: t.ts ? new Date(t.ts).toISOString().slice(0, 10) : t.season + ' wk ' + t.week, sides: Object.entries(t.sides || {}).map(([r, s]: any) => ({ team: teamName(L, r), got: (s.players || []).map((pid: string) => (ctx.players[pid] || {}).n || pid).concat((s.picks || []).map((p: any) => p.season + ' ' + ord(p.round))), value_got: s.totalValue })), winner: t.winner != null ? teamName(L, t.winner) : 'even', value_gap_pct: t.valueDiffPct != null ? Math.round(t.valueDiffPct) : undefined })) };
}
function waiverOptions(ctx: Ctx, L: LeagueRow, args: any) {
  const pos = String(args.position || '').toUpperCase(); const limit = Math.max(1, Math.min(15, Number(args.limit) || 8));
  const rostered = new Set<string>(); L.snapshot.rosters.forEach(r => r.players.forEach(x => rostered.add(x)));
  const posOf = (pid: string) => normPos(((L.intel.playerMeta || {})[pid] || {}).pos || (ctx.players[pid] || {}).pos);
  // Only positions this league can start (no DEF without a DEF slot).
  const startable = leaguePositions(L);
  if (pos && !startable.includes(normPos(pos))) return { league_id: L.league_id, best_available: [], trending_adds_on_sleeper: [], note: 'This league has no ' + pos + ' slot, so a free agent there can\'t score for you. It starts: ' + startable.join(', ') + '.' };
  const canStart = (pid: string) => startable.includes(posOf(pid));
  const pool = Object.keys(L.intel.playerScores || {}).filter(pid => !rostered.has(pid) && ctx.players[pid] && ctx.players[pid].t && ctx.players[pid].act && canStart(pid)).filter(pid => !pos || posOf(pid) === pos || (ctx.players[pid].fp || []).includes(pos)).sort((a, b) => dhq(L, b) - dhq(L, a)).slice(0, limit);
  const trending = (ctx.trending || []).map(x => String(x.player_id)).filter(pid => !rostered.has(pid) && ctx.players[pid] && canStart(pid) && (!pos || posOf(pid) === pos)).slice(0, 8).map(pid => ({ name: ctx.players[pid].n, pos: posOf(pid), nfl_team: ctx.players[pid].t, dhq_value: dhq(L, pid), adds_24h: ((ctx.trending || []).find(x => String(x.player_id) === pid) || { count: 0 }).count }));
  const me = myRoster(L, ctx.memberId); const a = me ? assessOf(L, me.roster_id) : null;
  const market = Object.fromEntries(Object.entries(L.intel.faabByPos || {}).map(([p, m]: any) => [p, { typical_bid: m.median, avg: Math.round(m.avg), p75: m.p75, bids_seen: m.count }]));
  return { league_id: L.league_id, positions_this_league_starts: startable, faab_left: a ? a.faabRemaining : undefined, faab_min_bid: a ? a.faabMinBid : undefined, best_available: pool.map(pid => playerRow(ctx, L, pid)), trending_adds_on_sleeper: trending, what_this_league_pays_by_position: market, for_a_decision: 'For who to claim, who to drop and what to bid, call get_waiver_plan.', numbers_as_of: L.built_at };
}
// intel.dhqPickValues is keyed by OVERALL slot (1 = first pick of the draft).
export function slotValue(L: LeagueRow, slot: number): number { return Math.round((((L.intel.dhqPickValues || {})[String(slot)] || {}).value) || 0); }
export function roundMidValue(L: LeagueRow, round: number): number {
  const teams = L.snapshot.rosters.length || 12;
  return slotValue(L, (round - 1) * teams + Math.ceil(teams / 2));
}
function pickValues(ctx: Ctx, L: LeagueRow, args: any) {
  const teams = L.snapshot.rosters.length || 12; const rounds = leagueFormat(L).draft_rounds || 4;
  const byRound: Record<string, unknown> = {};
  for (let rd = 1; rd <= rounds; rd++) byRound[ord(rd) + ' round'] = { early: slotValue(L, (rd - 1) * teams + 1), mid: roundMidValue(L, rd), late: slotValue(L, rd * teams) };
  const top = []; for (let s = 1; s <= Math.min(12, teams); s++) top.push({ pick: '1.' + String(s).padStart(2, '0'), value: slotValue(L, s) });
  const rid = args.roster_id != null ? Number(args.roster_id) : null;
  const owned = Object.entries(L.snapshot.picks || {}).filter(([r]) => rid == null || Number(r) === rid).map(([r, list]) => ({ team: teamName(L, r), roster_id: Number(r), picks: (list as Pick[]).map(pk => pickLabel(pk, Number(r), L) + ' · ' + pk.value) }));
  return { league_id: L.league_id, teams, draft_rounds: rounds, value_by_round: byRound, first_round_by_slot: top, picks_owned: owned, note: 'Values for the next draft; later years are discounted 12% per year. A pick\'s slot comes from Sleeper\'s draft order when known, else the owner\'s standing.' };
}

export const NEWS_STEP = 'Before you answer, read latest_news (the player\'s own most recent report, plus latest_news.stories: every story of the last two weeks linked to him, "about him" or "via" the team news that reaches him, like a new play-caller or his quarterback\'s injury) and team_news (his team\'s headlines from the last 7 days) for EACH player and lead with the biggest item on each side: a new play-caller or head coach, a quarterback change, a teammate trade or injury that shifts targets or carries, a role change, practice status. A coaching or play-calling change outranks a cold stretch of box scores. If you can also search the web, add anything newer. Never tell the member to go check something themselves.';
export type ProjLine = { id: string; name: string; pos: string; nfl_team: string; nfl_opponent?: string; game_date?: string | null; game_status?: string; injury?: string; proj_this_week?: number | null; proj_floor?: number; proj_ceiling?: number; proj_why?: string; scored_this_week?: number; this_week?: string; season_games?: number; season_avg?: number | null; game_log?: string };
export function projLine(ctx: Ctx, L: LeagueRow, pid: string): ProjLine {
  const p = fresh(ctx, pid);
  const bits = seasonBits(ctx, L, pid) as Partial<ProjLine>;
  return { id: pid, name: p.n || pid, pos: ((L.intel.playerMeta || {})[pid] || {}).pos || p.pos || '?', nfl_team: p.t || 'FA', ...gameBits(ctx, p.t), injury: p.inj ? p.inj + (p.injp ? ' (' + p.injp + ')' : '') : undefined, ...bits };
}
async function weeklyProjections(ctx: Ctx, L: LeagueRow, args: any) {
  const ids: string[] = [], unknown: string[] = [];
  (args.players || []).slice(0, 20).forEach((q: unknown) => { const pid = resolveOne(ctx, L, q); if (pid) ids.push(pid); else unknown.push(String(q)); });
  const [blurbs, liveAt] = await Promise.all([latestBlurbs(ctx, ids), goLive(ctx, L, ids)]);
  const withNews = (pid: string) => ({ ...projLine(ctx, L, pid), latest_news: blurbs[pid], team_news: teamNews(ctx, fresh(ctx, pid).t) });
  return { league_id: L.league_id, week: L.snapshot.proj_week, scoring: 'this league\'s scoring', before_you_answer: NEWS_STEP, news_as_of: ctx.news ? ctx.news.fetched_at : undefined, live_as_of: liveAt, note: 'proj_this_week is DHQ\'s projection in this league\'s scoring (the number on the app\'s Lineup screen; proj_floor and proj_ceiling are his range; proj_why is what moved it); null means he has no role this week. game_log is points scored each week this season (DNP = did not play). A null projection means Sleeper is not projecting him this week.', players: ids.map(withNews), not_found: unknown.length ? unknown : undefined, numbers_as_of: L.built_at };
}
async function myMatchup(ctx: Ctx, L: LeagueRow) {
  const me = myRoster(L, ctx.memberId);
  if (!me) throw new ToolError('You do not have a team in ' + L.name + '.');
  const bench = (me.players || []).filter(pid => !(me.starters || []).includes(pid) && !(me.reserve || []).includes(pid) && !(me.taxi || []).includes(pid));
  const liveAt = await goLive(ctx, L, (me.starters || []).concat(bench));
  // Live matchups carry the lineup as set right now and live points; the build's copy is the fallback.
  const rows = (ctx.live && ctx.live.matchups[L.league_id]) || L.snapshot.matchups || [];
  const mine = rows.find(m => String(m.roster_id) === String(me.roster_id));
  if (!mine || mine.matchup_id == null) return { league_id: L.league_id, week: L.snapshot.proj_week, note: 'No head-to-head matchup for you this week (bye or playoffs).' };
  const opp = rows.find(m => m.matchup_id === mine.matchup_id && String(m.roster_id) !== String(me.roster_id));
  const oppR = opp ? rosterOf(L, opp.roster_id) : null;
  const proj = L.snapshot.proj || {};
  const startersOf = (row: { starters?: string[] } | null | undefined, r: Roster | null) => ((row && row.starters) || (r && r.starters) || []).filter(x => x && x !== '0');
  const lineup = (row: { starters?: string[] } | null | undefined, r: Roster | null) => startersOf(row, r).map(pid => projLine(ctx, L, pid));
  // This week: DHQ's projection (the app's Lineup number).
  const wkP = (x: ProjLine) => Number(x.proj_this_week) || 0;
  const pts = (x: ProjLine) => x.scored_this_week != null ? Number(x.scored_this_week) : wkP(x);
  const total = (list: ProjLine[]) => round1(list.reduce((t, x) => t + pts(x), 0));
  const myLine = lineup(mine, me), oppLine = lineup(opp, oppR);
  const starters = new Set(startersOf(mine, me));
  const open = (x: ProjLine) => x.scored_this_week == null;   // game not started yet, so the slot can still change
  const benchBetter = (me.players || []).filter(pid => !starters.has(pid) && !(me.reserve || []).includes(pid) && !(me.taxi || []).includes(pid) && proj[pid] != null)
    .map(pid => projLine(ctx, L, pid)).filter(b => open(b) && myLine.some(s => open(s) && s.pos === b.pos && wkP(s) < wkP(b)))
    .sort((a, b) => wkP(b) - wkP(a)).slice(0, 6);
  return {
    league_id: L.league_id, week: L.snapshot.proj_week, opponent: opp ? teamName(L, opp.roster_id) + ' (roster ' + opp.roster_id + ')' : 'unknown',
    live_score: mine.points || (opp && opp.points) ? { me: round1(mine.points), them: round1(opp && opp.points) } : undefined,
    my_projected_total: total(myLine), their_projected_total: total(oppLine),
    totals_note: 'Totals use actual points for players whose game has started or finished and projections for the rest. A player marked ALREADY PLAYED, IN PROGRESS or DID NOT PLAY is locked and cannot be moved.',
    live_as_of: liveAt,
    my_lineup: myLine, their_lineup: oppLine,
    bench_projected_above_a_starter_at_same_position: benchBetter,
    team_news_for_my_players: Object.fromEntries([...new Set(myLine.concat(benchBetter).map(x => x.nfl_team))].map(t => [t, teamNews(ctx, t, 3)]).filter(([, v]) => v)),
    before_you_answer: NEWS_STEP,
    note: 'Projections are DHQ\'s (the app\'s Lineup screen number), in this league\'s scoring. Lineups are as set in Sleeper right now.',
    numbers_as_of: L.built_at,
  };
}
