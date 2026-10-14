// dhq-tools/verdicts.ts — the tools where DHQ decides and the AI narrates.
//
// Each tool here runs the same method the app runs (the lineup solver, the
// team assessor's numbers, the player-action chain, the FAAB bid model) over
// the stored league and the live game-day facts, and returns a verdict with
// its reasons. The AI's job is to explain it, add the news angle, and say
// what to do in Sleeper, not to reassemble the parts. Every result carries
// `method`, the plain-English DHQ method it followed (also served as an MCP
// prompt), so the AI can quote it.
// deno-lint-ignore-file no-explicit-any
import {
  type Ctx, type LeagueRow, type Roster, type ProjLine, ToolError,
  myRoster, rosterOf, teamName, ownerName, dhq, whoRosters, assessOf, leagueRank, round1, pickLabel,
  playerRow, projLine, fresh, teamPlayed, goLive, latestBlurbs, teamNews, resolveOne, NEWS_STEP,
} from './tools.ts';
import { skillText } from './skills.ts';
import { solveLineup, startSitCall, TAG_REASON } from './decide-lineup.ts';
import { tradePlan } from './decide-trade.ts';
import { rosterPlan, waiverPlan, inSeason, bidStats, posComps, compSummary, faabInputs } from './decide-roster.ts';
import { normPos } from './decide-common.ts';

const engines = () => (globalThis as any).App || {};
const OUT_SET = new Set(['OUT', 'IR', 'PUP', 'SUS', 'NA', 'DNP', 'COV']);
const BENCH = new Set(['BN', 'BE', 'BENCH', 'IR', 'TAXI', 'RES']);
const name = (ctx: Ctx, pid: string) => (ctx.players[pid] && ctx.players[pid].n) || pid;
// Fantasy position, normalised (DE/DT → DL, CB/S → DB) so the solver's slot eligibility matches.
const posOf = (ctx: Ctx, L: LeagueRow, pid: string) => normPos(((L.intel.playerMeta || {})[pid] || {}).pos || (ctx.players[pid] || {}).pos || '');

// ── 1. Start / sit and the whole lineup ──────────────────────────────────
// One number per player (DHQ's projection in this league's scoring).
// Out/IR/Doubtful and bye players are unavailable, players whose game has
// started are locked where they are at their actual points, then the open
// slots are solved: the app's greedy solver, checked by an exact assignment
// (decide-lineup.ts) so a DL/LB-eligible player never costs points. The
// call (decide-lineup.ts startSitCall, the Lab's rules): changes with their
// gain, coin flips within 1.5 pts or 10% with the tiebreak, who must not
// start and why, Questionable starters in late games with a pivot.
type Line = ProjLine & { pts: number | null; shown?: number | null; available: boolean; locked: boolean; why_unavailable?: string; zero_reason?: string; source?: 'dhq' | 'sleeper'; dhq_proj?: number; floor?: number | null; ceiling?: number | null };
// DHQ's weekly projection for this week (the engine build runs the app's own
// projection engine and stores snapshot.dhq_proj): { mean, median, floor,
// ceiling, no_line } per rostered player. The Lab ranks every lineup call on
// `mean` (DHQ's average week, `pts`); the number quoted is `median` (the
// typical week the Lineup screen shows, `shown`; owner rule 2026-10-14). A
// player with no Sleeper line reads 0 (the truth law), except an every-down
// defender the engine kept (Lab LAB287: no_line unset, a number above 0). Null when the build didn't store this week's projections.
type DhqLine = { mean: number; median: number; floor: number; ceiling: number; no_line?: boolean };
export function dhqProjOn(L: LeagueRow): boolean {
  const d = (L.snapshot as any).dhq_proj;
  return !!(d && d.players && Object.keys(d.players).length && Number(d.week) === Number(L.snapshot.proj_week));
}
function dhqLine(L: LeagueRow, pid: string): DhqLine | null { return dhqProjOn(L) ? ((L.snapshot as any).dhq_proj.players[pid] || null) : null; }
function lineFor(ctx: Ctx, L: LeagueRow, pid: string): Line {
  const p = projLine(ctx, L, pid);
  const f = fresh(ctx, pid);
  const inj = String((f.inj || '')).toUpperCase().trim();
  const locked = p.scored_this_week != null;
  let available = true, why: string | undefined, zero: string | undefined;
  if (!f.t && !locked) { available = false; why = 'no NFL team'; zero = 'no NFL team'; }
  else if (p.nfl_opponent === 'BYE') { available = false; why = 'bye week'; zero = 'bye'; }
  else if (OUT_SET.has(inj) || /^OUT/.test(inj) || /^IR\b/.test(inj)) { available = false; why = 'ruled ' + (f.inj || 'out'); zero = TAG_REASON[inj] || (/^IR\b/.test(inj) ? 'IR' : 'out'); }
  else if (inj === 'DOUBTFUL' || inj === 'D') { available = false; why = 'Doubtful: DHQ treats doubtful as out (he misses far more often than he plays)'; zero = 'doubtful'; }
  // Truth law: no Sleeper line this week means no role, so no projection (never named to the member as Sleeper's).
  else if (!locked && (L.snapshot.proj || {})[pid] == null) { available = false; why = 'not projected this week: no role'; zero = 'not_projected'; }
  else if (!locked && !(Number(p.proj_this_week) > 0)) zero = 'no_role';
  // DHQ's number when the build stored one for him; Sleeper's line otherwise.
  const d = dhqLine(L, pid);
  if (d && !locked) {
    const dq = { source: 'dhq' as const, dhq_proj: d.median, floor: d.floor, ceiling: d.ceiling };
    // Every-down defender with no Sleeper line: the engine kept his number (LAB287).
    if (!available && zero === 'not_projected' && !d.no_line && d.mean > 0) { available = true; why = undefined; zero = undefined; }
    if (available && !(d.mean > 0)) {
      available = false;
      why = d.no_line ? 'not projected this week: no role' : 'DHQ projects him for 0 this week';
      zero = d.no_line ? 'not_projected' : 'no_role';
    } else if (available && (zero === 'not_projected' || zero === 'no_role')) zero = undefined;
    return { ...p, pts: available ? d.mean : null, shown: available ? d.median : null, available, locked, why_unavailable: why, zero_reason: zero, ...dq };
  }
  const pts = locked ? Number(p.scored_this_week) : (available ? Number(p.proj_this_week) : null);
  return { ...p, pts, available, locked, why_unavailable: why, zero_reason: locked ? undefined : zero, source: 'sleeper', floor: null, ceiling: null };
}
// The Lab's win chance (App.Matchup dist/forecast via DhqProj.matchup): each
// lineup's mean is the sum of DHQ average weeks (actual points once locked),
// its spread half of each player's floor-to-ceiling band; P(win) from the
// normal curve. My best lineup against the opponent's current one.
function normCdf(z: number) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}
function lineupDist(lines: Line[]) {
  let mean = 0, varSum = 0, n = 0;
  lines.forEach(x => {
    if (!x) return;
    let med: number, f: number, c: number;
    if (x.locked) { med = f = c = Number(x.pts) || 0; }
    else if (x.source === 'dhq') { if (!x.available) return; med = Number(x.pts) || 0; f = x.floor != null ? Number(x.floor) : med * 0.7; c = x.ceiling != null ? Number(x.ceiling) : med * 1.35; }
    else return;   // no DHQ number: left out, as the Lab does
    const sd = Math.max(0.5, (c - f) / 2);
    mean += med; varSum += sd * sd; n++;
  });
  return { mean: Math.round(mean * 10) / 10, sd: Math.sqrt(varSum), n };
}
function winChance(mine: Line[], theirs: Line[]): number | null {
  const a = lineupDist(mine), b = lineupDist(theirs);
  if (!a.n || !b.n) return null;
  const z = (a.mean - b.mean) / (Math.sqrt(a.sd * a.sd + b.sd * b.sd) || 1);
  return Math.max(1, Math.min(99, Math.round(normCdf(z) * 100)));
}
export async function startSit(ctx: Ctx, L: LeagueRow, args: any) {
  const me = myRoster(L, ctx.memberId);
  const rid = args.roster_id != null ? Number(args.roster_id) : (me ? me.roster_id : null);
  const r = rosterOf(L, rid);
  if (!r) throw new ToolError('No roster to set a lineup for in ' + L.name + '.');
  const SS = engines().StartSit;
  if (!SS) throw new Error('lineup solver not loaded');
  const wkNow = Number(L.snapshot.proj_week) || 0;
  if (args.week != null && Number(args.week) && wkNow && Number(args.week) !== wkNow) throw new ToolError('Start/sit is decided for this week (week ' + wkNow + ') only: later weeks\' injuries and lineups are not known yet.');
  const named: string[] = [], unknown: string[] = [];
  const asked = Array.isArray(args.players) ? args.players : (args.players ? String(args.players).split(/\s*(?:,|\bvs\.?\b|\bor\b|\band\b|\/)\s*/i) : []);
  asked.map((x: unknown) => String(x || '').trim()).filter(Boolean).slice(0, 6).forEach((q: string) => { const pid = resolveOne(ctx, L, q); if (pid) { if (!named.includes(pid)) named.push(pid); } else unknown.push(q); });
  const reserve = (r.reserve || []).map(String), taxi = (r.taxi || []).map(String);
  const pool = (r.players || []).map(String).filter(pid => !reserve.includes(pid) && !taxi.includes(pid));
  const rows0 = L.snapshot.matchups || [];
  const myRow0 = rows0.find((m: any) => String(m.roster_id) === String(r.roster_id));
  const oppRow0 = myRow0 && myRow0.matchup_id != null ? rows0.find((m: any) => m.matchup_id === myRow0.matchup_id && String(m.roster_id) !== String(r.roster_id)) : null;
  const liveAt = await goLive(ctx, L, pool.concat(named, ((oppRow0 && oppRow0.starters) || []).map(String)));
  const liveRow = ctx.live && ctx.live.matchups[L.league_id] && ctx.live.matchups[L.league_id].find(m => String(m.roster_id) === String(r.roster_id));
  const slotNames: string[] = ((L.snapshot.league && L.snapshot.league.roster_positions) || []).filter((s: string) => !BENCH.has(String(s).toUpperCase()));
  const current: string[] = ((liveRow && liveRow.starters) || r.starters || []).slice(0, slotNames.length).map((x: string) => (x && x !== '0' ? String(x) : ''));
  const lines: Record<string, Line> = {};
  for (const pid of new Set(pool.concat(current.filter(Boolean), named))) lines[pid] = lineFor(ctx, L, pid);
  const val = (pid: string) => (pid && lines[pid] && lines[pid].pts != null ? Number(lines[pid].pts) : 0);
  // The number to quote (the Lineup screen's): DHQ's typical week; actual points once locked.
  const shownOf = (pid: string) => (pid && lines[pid] && !lines[pid].locked && lines[pid].shown != null ? Number(lines[pid].shown) : val(pid));
  // Locked starters keep their slot; everything else is solved.
  const lockedSlots = new Set<number>();
  current.forEach((pid, i) => { if (pid && lines[pid] && lines[pid].locked) lockedSlots.add(i); });
  const openSlots = slotNames.map((s, i) => ({ s, i })).filter(x => !lockedSlots.has(x.i));
  const positionsOf = (pid: string) => [...new Set([posOf(ctx, L, pid)].concat((fresh(ctx, pid).fp || []).map((x: string) => normPos(x))))].filter(Boolean);
  const candidates = pool.filter(pid => lines[pid] && !lines[pid].locked && lines[pid].available)
    .map(pid => ({ pid, pos: posOf(ctx, L, pid), positions: positionsOf(pid), pts: val(pid) }));
  const solved = solveLineup(SS, candidates, openSlots.map(x => ({ idx: x.i, slot: x.s })));
  const placed: Record<number, string> = {};
  lockedSlots.forEach(i => { placed[i] = current[i]; });
  Object.entries(solved.placed).forEach(([i, pid]) => { placed[Number(i)] = pid; });
  const lockedTotal = [...lockedSlots].reduce((t, i) => t + val(current[i]), 0);
  const currentTotal = round1(current.reduce((t, pid) => t + (pid && lines[pid] && (lines[pid].locked || lines[pid].available) ? val(pid) : 0), 0));
  const optimalTotal = round1(lockedTotal + (solved.total || 0));
  const optimalSet = new Set<string>(Object.values(placed));
  const currentSet = new Set(current.filter(Boolean));

  // The facts the call is made from.
  const kickOf = (pid: string) => { const t = fresh(ctx, pid).t; const g = t && ctx.live && ctx.live.scores ? ctx.live.scores[t] : null; return g && g.kick ? Number(g.kick) : null; };
  const slotOfRoster = (pid: string) => currentSet.has(pid) ? 'starter' : reserve.includes(pid) ? 'IR' : taxi.includes(pid) ? 'taxi' : (r.players || []).map(String).includes(pid) ? 'bench' : 'not on roster';
  const facts: Record<string, any> = {};
  for (const pid of new Set(Object.keys(lines).concat(named))) {
    const x = lines[pid] || lineFor(ctx, L, pid);
    lines[pid] = x;
    // proj = the number quoted (the Lineup screen's); avg = the average week the call ranks on.
    facts[pid] = { name: x.name, positions: positionsOf(pid), proj: x.locked ? val(pid) : x.available ? shownOf(pid) : 0, avg: x.locked ? val(pid) : x.available ? val(pid) : 0, floor: x.locked ? null : x.floor ?? null, ceiling: x.locked ? null : x.ceiling ?? null, locked: x.locked, kick: kickOf(pid), injury_status: fresh(ctx, pid).inj || null, zero_reason: x.zero_reason || null, why: x.locked ? null : (x.proj_why || null), roster_slot: slotOfRoster(pid) };
  }
  const elig = (s: string) => { const n = SS.normSlot(s); return SS.FLEX_ALLOWED[n] || [n]; };
  const gameKicks: number[] = [];
  if (ctx.live && ctx.live.scores) {
    const seen = new Set<string>();
    Object.entries(ctx.live.scores).forEach(([t, g]) => { if (!g || g.started || !(Number(g.kick) > 0)) return; const k = [t, g.opp].sort().join('@'); if (seen.has(k)) return; seen.add(k); gameKicks.push(Number(g.kick)); });
  }
  // Win chance (the close-call tiebreak): my best lineup vs the opponent's current one.
  const useDhq = dhqProjOn(L);
  let winPct: number | null = null;
  if (useDhq) {
    const liveRows = (ctx.live && ctx.live.matchups[L.league_id]) || L.snapshot.matchups || [];
    const myRow = liveRows.find((m: any) => String(m.roster_id) === String(r.roster_id));
    const opp = myRow && myRow.matchup_id != null ? liveRows.find((m: any) => m.matchup_id === myRow.matchup_id && String(m.roster_id) !== String(r.roster_id)) : null;
    const oppStarters = ((opp && opp.starters) || []).filter((x: string) => x && x !== '0').map(String);
    if (oppStarters.length) winPct = winChance(Object.values(placed).map(pid => lines[pid] || lineFor(ctx, L, pid)), oppStarters.map((pid: string) => lineFor(ctx, L, pid)));
  }
  const call = startSitCall({
    week: wkNow, slots: slotNames.map((s, i) => ({ idx: i, slotName: s, elig: elig(s) })),
    current: Object.fromEntries(current.map((pid, i) => [i, pid]).filter(([, pid]) => pid)), placed,
    current_total: currentTotal, best_total: optimalTotal,
    locks_loaded: !!(ctx.live && ctx.live.scores), sleeper_loaded: Object.keys(L.snapshot.proj || {}).length > 0,
    win_pct: winPct, players: facts, asked: named, not_found: unknown, game_kicks: gameKicks,
    stat_word: useDhq ? 'DHQ projection' : 'projection',
    source_note: useDhq ? 'DHQ\'s average week in this league\'s scoring (quote each player\'s proj: DHQ\'s projection, the number the Lineup screen shows)' : 'DHQ\'s full projections are still building; numbers are the base weekly projection in this league\'s scoring',
  });

  // Head to head, when the member named players: the call plus each player's line and news.
  let head_to_head: Record<string, unknown> | undefined;
  if (named.length >= 2) {
    const rows = named.map(pid => lines[pid]);
    const others = rows.filter(x => !(x.available && !x.locked) || facts[x.id].roster_slot === 'IR' || facts[x.id].roster_slot === 'taxi' || facts[x.id].roster_slot === 'not on roster').map(x => x.name + ' is ' + (x.locked ? 'locked (' + x.this_week + ')' : !x.available ? 'not startable: ' + x.why_unavailable : 'on your ' + facts[x.id].roster_slot.replace('not on roster', 'list of players you do not roster')));
    const h = call.head_to_head;
    let text: string;
    if (h) text = 'Start ' + h.pick + ' over ' + h.over + (h.close_call ? ': a coin flip (' + h.gap_pts + ' pts apart), ' + h.tiebreak : ' (+' + h.gap_pts + ' pts projected)') + (h.injury_note ? '; ' + h.injury_note : '') + '.' + (others.length ? ' ' + others.join('. ') + '.' : '');
    else {
      const open = rows.filter(x => x.available && !x.locked && (facts[x.id].proj || 0) > 0 && !['IR', 'taxi', 'not on roster'].includes(facts[x.id].roster_slot));
      text = open.length ? 'Start ' + open[0].name + ' (' + facts[open[0].id].proj + ' projected). ' + others.join('. ') + '.' : 'None of them can be started: ' + rows.map(x => x.name + ' (' + (x.locked ? 'locked, ' + x.this_week : x.why_unavailable || 'on your ' + facts[x.id].roster_slot) + ')').join('; ') + '.';
    }
    const blurbs = await latestBlurbs(ctx, named);
    head_to_head = { ...(h || {}), call: text, coin_flip: h ? !!h.close_call : undefined, players: rows.map(x => ({ ...x, in_optimal_lineup: optimalSet.has(x.id), on_my_roster: pool.includes(x.id) || reserve.includes(x.id) || taxi.includes(x.id), latest_news: blurbs[x.id], team_news: teamNews(ctx, x.nfl_team) })) };
  }
  // Owner ask 2026-10-12: the answer needs the story, not just the number.
  // Each player in the call (named, or in a change) comes with how he has
  // played, his health, his latest news and what drives DHQ's number.
  let player_context: Record<string, unknown> | undefined;
  try {
    const nameToPid: Record<string, string> = {};
    Object.keys(lines).forEach(pid => { nameToPid[lines[pid].name] = pid; });
    const ctxPids = [...new Set(named.concat((call.changes || []).flatMap((c: any) => [nameToPid[c.start], nameToPid[c.sit]]).filter(Boolean)))].slice(0, 4);
    if (ctxPids.length) {
      const blurbs0 = await latestBlurbs(ctx, ctxPids);
      player_context = Object.fromEntries(ctxPids.map(pid => { const x = lines[pid] || lineFor(ctx, L, pid); return [x.name, { this_week: x.locked ? x.this_week : { proj: x.proj_this_week, floor: x.proj_floor, ceiling: x.proj_ceiling, why: x.proj_why }, injury: x.injury, season_avg: x.season_avg, season_games: x.season_games, game_log: x.game_log, latest_news: blurbs0[pid], team_news: teamNews(ctx, x.nfl_team, 3) }]; }));
    }
  } catch { player_context = undefined; }
  const slotOf = (pid: string) => { const i = current.indexOf(pid); return i >= 0 ? slotNames[i] : 'bench'; };
  const lineup = (pids: Array<{ pid: string; slot: string }>) => pids.map(x => ({ slot: x.slot, player: x.pid ? name(ctx, x.pid) : '(empty)', pos: x.pid ? posOf(ctx, L, x.pid) : undefined, pts: x.pid ? round1(shownOf(x.pid)) : 0, locked: x.pid && lines[x.pid] ? lines[x.pid].locked : undefined, status: x.pid && lines[x.pid] ? (lines[x.pid].locked ? lines[x.pid].this_week : lines[x.pid].available ? 'projected' : 'NOT STARTABLE: ' + lines[x.pid].why_unavailable) : undefined, injury: x.pid && lines[x.pid] ? lines[x.pid].injury : undefined }));
  const left = round1(optimalTotal - currentTotal);
  return {
    league_id: L.league_id, week: L.snapshot.proj_week, team: teamName(L, r.roster_id), is_mine: !!(me && me.roster_id === r.roster_id),
    recommendation: call.recommendation, decision: call.decision, confidence: call.confidence,
    verdict: call.recommendation,
    head_to_head, asked: call.asked,
    player_context, answer_with_context: player_context ? 'Tell the story from player_context in this shape: (1) the call plus his status (active or not, how he practiced, what the coach said, from injury and latest_news); (2) what to expect: DHQ\'s projection with its floor and ceiling and what drives it (this_week.why), his season average and games missed (season_avg, game_log), his role and snap share, and the injury to watch; (3) the realistic alternative, if any: only a bench player whose game has not started, never someone locked, and never quote points already scored as a projection. Two short paragraphs, conversational, never just a number.' : undefined,
    changes: call.changes, close_calls: call.close_calls, do_not_start: call.do_not_start, questionable: call.questionable,
    points_left_on_bench: left, lineup_is_optimal: left <= 0.05, current_total: currentTotal, optimal_total: optimalTotal,
    swaps: call.changes.map((c: any) => ({ slot: c.slot, start: c.start, sit: c.sit, gain: c.gain_pts, close_call: c.close_call, why: c.why })),
    current_lineup: lineup(current.map((pid, i) => ({ pid, slot: slotNames[i] }))),
    optimal_lineup: lineup(slotNames.map((s, i) => ({ pid: placed[i] || '', slot: s }))),
    bench: pool.filter(pid => !currentSet.has(pid)).map(pid => ({ player: name(ctx, pid), pos: posOf(ctx, L, pid), pts: lines[pid].pts == null ? null : round1(shownOf(pid)), status: lines[pid].locked ? lines[pid].this_week : lines[pid].available ? 'projected' : 'not startable: ' + lines[pid].why_unavailable, zero_reason: lines[pid].zero_reason, injury: lines[pid].injury, slot_now: slotOf(pid) })).sort((a, b) => Number(b.pts || 0) - Number(a.pts || 0)),
    evidence: call.evidence, rules_applied: call.rules_applied, locks_loaded: call.locks_loaded, warning: call.warning,
    projection: useDhq ? { source: 'DHQ weekly projection, this league\'s scoring: each pts is the number the app\'s Lineup screen shows; the lineup and totals are ranked on DHQ\'s average week', built_at: (L.snapshot as any).dhq_proj.built_at, win_chance_pct: winPct } : { source: 'DHQ base weekly projection, this league\'s scoring (full DHQ projections still building)' },
    solver: solved.exact ? 'exact assignment (it beat the greedy fill: a player eligible at two positions)' : 'greedy fill (the exact assignment found nothing better)',
    not_found: unknown.length ? unknown : undefined,
    before_you_answer: NEWS_STEP, method: skillText('start_sit'), live_as_of: liveAt, numbers_as_of: L.built_at,
  };
}

// ── 2. Roster needs ───────────────────────────────────────────────────────
export function rosterNeeds(ctx: Ctx, L: LeagueRow, args: any) {
  const me = myRoster(L, ctx.memberId);
  const rid = args.roster_id != null ? Number(args.roster_id) : (me ? me.roster_id : null);
  const r = rosterOf(L, rid); const a = r ? assessOf(L, r.roster_id) : null;
  if (!r || !a) throw new ToolError('No assessment for roster ' + rid + ' in ' + L.name + '.');
  const positions = Object.entries(a.posAssessment || {}).map(([pos, x]: [string, any]) => ({
    pos, status: x.status, bodies: x.actual, ideal_bodies: x.ideal, quality_starters: x.nflStarters, quality_needed: x.minQuality, starting_slots: x.startingReq,
    top_players: (x.sortedIds || []).slice(0, Math.max(1, (x.startingReq || 1) + 1)).map((pid: string) => name(ctx, pid) + ' (DHQ ' + dhq(L, pid) + ((x.nflStarterIds || []).includes(pid) ? ', quality starter' : '') + ')'),
    read: x.status === 'deficit' ? 'No quality starter here: this is the hole.' : x.status === 'thin' ? (x.nflStarters < x.minQuality ? 'Short of quality starters (' + x.nflStarters + ' of ' + x.minQuality + ').' : 'Enough quality, not enough bodies (' + x.actual + ' of ' + x.ideal + ').') : x.status === 'surplus' ? 'More quality than the lineup needs: tradeable.' : 'Covered.',
  }));
  const needs = (a.needs || []).map((n: any) => n.pos + ' (' + n.urgency + ')');
  const strengths = a.strengths || [];
  const pk = a.picksAssessment || {};
  const todo: string[] = [];
  (a.needs || []).forEach((n: any) => { const x = (a.posAssessment || {})[n.pos] || {}; todo.push((n.urgency === 'deficit' ? 'Priority: ' : '') + 'Add a quality ' + n.pos + ' (you have ' + (x.nflStarters || 0) + ' of the ' + (x.minQuality || 1) + ' the lineup needs). Use find_trade_targets for teams with ' + n.pos + ' surplus (then trade_plan), and get_waiver_plan position=' + n.pos + '.'); });
  strengths.forEach((pos: string) => { const x = (a.posAssessment || {})[pos] || {}; todo.push(pos + ' is a tradeable surplus: ' + x.nflStarters + ' quality starters for ' + x.minQuality + ' slots. Sell from the back of that room, not the front.'); });
  if (pk.status === 'deficit' || pk.status === 'thin') todo.push('Draft capital is ' + pk.status + ' (' + pk.totalPicks + ' picks over the next ' + (pk.pickYears || []).length + ' drafts, ' + pk.roundsMissing + ' rounds with none). A rebuilding team should fix this first; a contender can live with it.');
  if (a.window === 'CONTENDING') todo.push('Window: contending. Spend future picks and youth for starters who score now.');
  else if (a.window === 'REBUILDING') todo.push('Window: rebuilding. Sell veterans with 1-2 peak years left for picks and players 25 and under.');
  else todo.push('Window: transitioning. Do not pay for both now and later; pick a lane before the deadline.');
  return {
    league_id: L.league_id, team: teamName(L, r.roster_id), owner: ownerName(L, r.roster_id), is_mine: !!(me && me.roster_id === r.roster_id),
    record: (a.wins || 0) + '-' + (a.losses || 0) + (a.ties ? '-' + a.ties : ''), tier: a.tier, tier_basis: a.tierBasis, window: a.window, health_score: a.healthScore, panic_0_to_5: a.panic, power_rank: a.powerRank,
    optimal_lineup_ppg: round1(a.weeklyPts), needs, strengths, positions,
    picks: { status: pk.status, total: pk.totalPicks, ideal: pk.idealTotal, by_year: pk.pickCountByYear, rounds_missing: pk.roundsMissing },
    faab_left: a.faabRemaining, what_to_do: todo, method: skillText('roster_needs'), numbers_as_of: L.built_at,
  };
}

// ── 3. Player outlook (buy / sell / hold) ────────────────────────────────
export async function playerOutlook(ctx: Ctx, L: LeagueRow, args: any) {
  const pid = resolveOne(ctx, L, args.player);
  if (!pid) throw new ToolError('No player matches "' + args.player + '". Try find_players.');
  const m = (L.intel.playerMeta || {})[pid] || {};
  const value = dhq(L, pid); const lr = leagueRank(L, pid);
  const me = myRoster(L, ctx.memberId); const holder = whoRosters(L, pid);
  const owned = !!(me && holder === me.roster_id);
  const peak = Number(m.peakYrsLeft ?? 0), trend = Number(m.trend ?? 0), age = Number(m.age ?? (ctx.players[pid] || {}).age ?? 0);
  const valueYrs = m.declineEnd != null && age ? Number(m.declineEnd) - age : null;
  const pos = posOf(ctx, L, pid);
  const elite = value >= 7000 || (lr != null && lr.pos != null && lr.pos <= 5);
  const idpStarter = /^(DL|LB|DB)$/.test(pos) && Number(fresh(ctx, pid).dco) === 1;
  const pastPeak = m.ageCurvePhase === 'decline' || m.ageCurvePhase === 'post_decline' || (peak <= 0 && m.ageCurvePhase !== 'peak');
  const inBand = pastPeak && valueYrs != null && valueYrs > 0;
  const pastBand = pastPeak && valueYrs != null && valueYrs <= 0;
  let action: string, label: string, reason: string;
  const tp = (trend > 0 ? '+' : '') + trend + '%';
  if (m.source === 'FC_ROOKIE') { action = 'STASH'; label = 'Stash'; reason = 'Incoming rookie: hold and develop.'; }
  else if (elite && peak >= 3) { action = 'CORE'; label = 'Build around'; reason = 'Elite value (DHQ ' + value + ') with ' + peak + ' peak years ahead.'; }
  else if (peak >= 4 && trend >= 10 && !owned) { action = 'BUY'; label = 'Buy'; reason = 'Trending up (' + tp + ') with ' + peak + ' peak years ahead.'; }
  else if (peak >= 4 && trend >= 10) { action = 'HOLD'; label = 'Hold'; reason = 'Rising asset: trending ' + tp + ' with ' + peak + ' peak years ahead. Keep and ride it.'; }
  else if (peak === 1 && value >= 3000) { action = 'SELL_HIGH'; label = 'Sell high'; reason = 'One peak year left at starter value; the market still pays for the name.'; }
  else if (inBand && trend <= -10) { action = 'SELL_HIGH'; label = 'Sell high'; reason = 'In the veteran decline band and production is slipping (' + tp + ').'; }
  else if (inBand) { action = 'HOLD'; label = 'Hold'; reason = valueYrs + ' value year' + (valueYrs === 1 ? '' : 's') + ' left in the veteran band; still useful, not a sell-for-pennies.'; }
  else if (pastBand && idpStarter) { action = 'HOLD'; label = 'Hold'; reason = 'Past the age window but a depth-chart starter: live production outruns the curve.'; }
  else if (pastBand && trend <= -10) { action = 'SELL'; label = 'Sell'; reason = 'Past the value window and declining (' + tp + ').'; }
  else if (pastBand) { action = 'SELL'; label = 'Sell'; reason = 'Past the value window.'; }
  else if (peak <= 2 && trend <= -10) { action = 'SELL_HIGH'; label = 'Sell high'; reason = 'Window closing (' + peak + ' peak years) and production declining (' + tp + ').'; }
  else if (peak >= 2 && value >= 4000) { action = 'HOLD'; label = 'Hold'; reason = peak + ' peak years left at starter value.'; }
  else if (value < 2000 && peak >= 3) { action = 'STASH'; label = 'Stash'; reason = 'Cheap with ' + peak + ' peak years ahead: a roster-spot bet, not a starter.'; }
  else if (!owned && peak >= 2 && value < 5000) { action = 'BUY'; label = 'Buy'; reason = 'Undervalued: ' + peak + ' peak years left under DHQ 5,000.'; }
  else if (peak >= 1) { action = 'HOLD'; label = 'Hold'; reason = peak + ' peak year' + (peak === 1 ? '' : 's') + ' left.'; }
  else { action = 'SELL'; label = 'Sell'; reason = 'Past prime.'; }
  const windowLabel = m.ageCurvePhase === 'peak' ? 'Prime' : (m.ageCurvePhase === 'build' || m.ageCurvePhase === 'developmental') ? 'Rising' : m.ageCurvePhase === 'decline' ? 'Veteran' : m.ageCurvePhase === 'post_decline' ? 'Post-window' : 'Unknown';
  const [blurbs, liveAt] = await Promise.all([latestBlurbs(ctx, [pid]), goLive(ctx, L, [pid])]);
  const row = playerRow(ctx, L, pid);
  return {
    ...row, league_rank: lr ? lr.overall : undefined, pos_rank: lr ? lr.pos : undefined,
    rostered_by: holder ? teamName(L, holder) + (owned ? ' (you)' : '') : 'free agent',
    outlook: { action, label, reason, window: windowLabel, peak_years_left: peak, value_years_left: valueYrs, trend_pct: trend, elite, from_your_side: owned ? 'you own him' : 'you do not own him' },
    inputs_note: 'The outlook is the app\'s own player-action chain: value tier, peak years left, value years left, production trend and ownership. It does not read injuries or news; read latest_news and injury before you repeat it.',
    last_season_ppg: m.lastYearPPG != null ? round1(m.lastYearPPG) : undefined, career_ppg: m.careerPPG != null ? round1(m.careerPPG) : undefined,
    latest_news: blurbs[pid], team_news: teamNews(ctx, fresh(ctx, pid).t),
    method: skillText('player_outlook'), live_as_of: liveAt, numbers_as_of: L.built_at,
  };
}

// ── 4. Compare players ───────────────────────────────────────────────────
export async function comparePlayers(ctx: Ctx, L: LeagueRow, args: any) {
  const ids: string[] = [], unknown: string[] = [];
  (args.players || []).slice(0, 6).forEach((q: unknown) => { const pid = resolveOne(ctx, L, q); if (pid && !ids.includes(pid)) ids.push(pid); else if (!pid) unknown.push(String(q)); });
  if (ids.length < 2) throw new ToolError('Name at least two players to compare.' + (unknown.length ? ' Not found: ' + unknown.join(', ') : ''));
  const liveAt = await goLive(ctx, L, ids);
  const rows = ids.map(pid => { const lr = leagueRank(L, pid); const holder = whoRosters(L, pid); return { ...playerRow(ctx, L, pid), league_rank: lr ? lr.overall : undefined, pos_rank: lr ? lr.pos : undefined, rostered_by: holder ? teamName(L, holder) : 'free agent' } as Record<string, any>; });
  const metrics: Array<{ key: string; label: string; higher: boolean }> = [
    { key: 'dhq_value', label: 'DHQ dynasty value', higher: true }, { key: 'peak_years_left', label: 'peak years left', higher: true }, { key: 'age', label: 'youth', higher: false },
    { key: 'proj_this_week', label: 'this week\'s projection', higher: true }, { key: 'season_avg', label: 'season average', higher: true }, { key: 'dhq_rate_ppg', label: 'long-run rate', higher: true },
  ];
  const leads: Record<string, number> = {}; ids.forEach(pid => { leads[pid] = 0; });
  const by_metric = metrics.map(mt => {
    const have = rows.filter(r => typeof r[mt.key] === 'number');
    if (have.length < 2) return { metric: mt.label, leader: null };
    const best = have.reduce((a, b) => (mt.higher ? b[mt.key] > a[mt.key] : b[mt.key] < a[mt.key]) ? b : a);
    const tie = have.filter(r => r[mt.key] === best[mt.key]).length > 1;
    if (!tie) leads[best.id]++;
    return { metric: mt.label, leader: tie ? 'tie' : best.name, values: Object.fromEntries(have.map(r => [r.name, r[mt.key]])) };
  });
  const byValue = [...rows].sort((a, b) => (b.dhq_value || 0) - (a.dhq_value || 0));
  const top = byValue[0], second = byValue[1];
  const gapPct = top.dhq_value ? Math.round(((top.dhq_value - (second.dhq_value || 0)) / top.dhq_value) * 100) : 0;
  const runway = (r: any) => Number(r.peak_years_left ?? 0);
  let verdict: string;
  if (gapPct >= 10) verdict = top.name + ' is the better dynasty asset: DHQ ' + top.dhq_value + ' vs ' + second.dhq_value + ' (' + gapPct + '% gap)' + (runway(second) - runway(top) >= 2 ? ', though ' + second.name + ' has the longer runway (' + runway(second) + ' vs ' + runway(top) + ' peak years)' : '') + '.';
  else if (runway(top) !== runway(second) && Math.abs(runway(top) - runway(second)) >= 2) { const longer = runway(top) > runway(second) ? top : second; verdict = 'Close on value (DHQ ' + top.dhq_value + ' vs ' + second.dhq_value + '); ' + longer.name + ' has the longer runway (' + runway(longer) + ' peak years), which tips it for a dynasty roster.'; }
  else verdict = 'Too close to call on dynasty value (DHQ ' + top.dhq_value + ' vs ' + second.dhq_value + ') and runway. For a lineup decision use get_start_sit; for a trade, the one who fits the roster need wins.';
  return { league_id: L.league_id, verdict, leads: Object.fromEntries(ids.map(pid => [name(ctx, pid), leads[pid]])), by_metric, players: rows, not_found: unknown.length ? unknown : undefined, method: skillText('compare_players'), live_as_of: liveAt, numbers_as_of: L.built_at };
}

// ── 5. Find trade targets ────────────────────────────────────────────────
// The Trade Center's partner board, from stored intel: roster fit, mutual
// need, their panic, their pick capital, their trade activity, their DNA,
// and whether your windows line up. Then the specific players on each
// partner's roster that fill your needs, and the chips you can pay with.
export function findTradeTargets(ctx: Ctx, L: LeagueRow, args: any) {
  const me = myRoster(L, ctx.memberId);
  if (!me) throw new ToolError('You do not have a team in ' + L.name + '.');
  const mine = assessOf(L, me.roster_id);
  if (!mine) throw new ToolError('No assessment for your team yet.');
  const te = ctx.te;
  const want: string[] = args.position ? [String(args.position).toUpperCase()] : (mine.needs || []).map((n: any) => n.pos);
  const DNA_SCORE: Record<string, number> = { FLEECER: -15, DOMINATOR: -18, STALWART: 4, ACCEPTOR: 8, DESPERATE: 10 };
  const partners = (L.snapshot.rosters || []).filter(r => r.roster_id !== me.roster_id).map(r => {
    const them = assessOf(L, r.roster_id); if (!them) return null;
    const dna = (L.dna || {})[String(r.roster_id)] || null; const dnaKey = dna ? dna.key : 'NONE'; const conf = dna ? Number(dna.confidence || 0) / 100 : 0;
    const compat = Number(te.calcComplementarity(mine, them)) || 0;
    const mutual = (them.needs || []).filter((n: any) => (mine.strengths || []).includes(n.pos)).length;
    const theyHave = (mine.needs || []).filter((n: any) => (them.strengths || []).includes(n.pos)).length;
    const panicScore = Math.min(8, Number(them.panic || 0) * 2);
    const pickCapital = ((L.snapshot.picks || {})[String(r.roster_id)] || []).reduce((t, p) => t + (Number(p.value) || 0), 0);
    const pickCapitalScore = Math.min(5, Math.round(pickCapital / 4200));
    const trades = Number(((L.intel.ownerProfiles || {})[String(r.roster_id)] || {}).trades || 0);
    const posture = te.calcOwnerPosture(them, dnaKey);
    const fit = (mine.window === 'CONTENDING' && them.window === 'REBUILDING') || (mine.window === 'REBUILDING' && them.window === 'CONTENDING') ? 14 : 3;
    const dnaScore = (DNA_SCORE[dnaKey] || 0) * conf;
    const raw = compat * 0.62 + mutual * 13 + theyHave * 10 + panicScore + pickCapitalScore + Math.min(7, trades) + fit + dnaScore + (posture.key === 'LOCKED' ? -18 : 0);
    const cap = compat >= 80 ? 99 : compat >= 65 ? 94 : compat >= 50 ? 88 : compat >= 35 ? 78 : 68;
    const score = Math.max(0, Math.min(cap, Math.round(raw)));
    const tag = score >= 85 ? 'Attack' : score >= 68 ? 'Prime' : score >= 48 ? 'Possible' : Number(them.panic || 0) >= 3 ? 'Monitor' : 'Long shot';
    const targets = want.flatMap(pos => (((them.posAssessment || {})[pos] || {}).sortedIds || []).filter((pid: string) => dhq(L, pid) >= (/^(DL|LB|DB|K|DEF)$/.test(pos) ? 500 : 2000)).slice(0, 2).map((pid: string) => ({ player: name(ctx, pid), pos, dhq_value: dhq(L, pid), age: (ctx.players[pid] || {}).age, their_status_at_pos: ((them.posAssessment || {})[pos] || {}).status })));
    const reasons: string[] = [];
    if (mutual) reasons.push('your surplus matches ' + mutual + ' of their needs');
    if (theyHave) reasons.push('they have surplus at ' + theyHave + ' of your needs');
    reasons.push(compat + '% roster fit');
    if (dna) reasons.push(dnaKey.toLowerCase() + ' DNA (' + Math.round(conf * 100) + '% sure): ' + String(dna.reasoning || '').slice(0, 120));
    if (Number(them.panic || 0) >= 3) reasons.push('panic ' + them.panic + ' of 5: a hurting team deals');
    if (posture.key === 'LOCKED') reasons.push('locked roster: elite and calm, hard to move');
    if (fit === 14) reasons.push('your windows line up (' + mine.window.toLowerCase() + ' vs ' + them.window.toLowerCase() + ')');
    return { roster_id: r.roster_id, team: teamName(L, r.roster_id), owner: ownerName(L, r.roster_id), score, tag, tier: them.tier, window: them.window, posture: posture.label, their_needs: (them.needs || []).map((n: any) => n.pos + ' (' + n.urgency + ')'), their_strengths: them.strengths || [], pick_capital_dhq: Math.round(pickCapital), trades_made: trades, targets_for_you: targets, reasons };
  }).filter(Boolean).sort((a: any, b: any) => b.score - a.score) as any[];
  const chips = (mine.strengths || []).flatMap((pos: string) => { const x = (mine.posAssessment || {})[pos] || {}; return (x.sortedIds || []).slice(Math.max(1, x.minQuality || 1)).slice(0, 2).map((pid: string) => ({ player: name(ctx, pid), pos, dhq_value: dhq(L, pid), why: 'beyond the ' + x.minQuality + ' quality ' + pos + ' your lineup needs' })); });
  const myPicks = ((L.snapshot.picks || {})[String(me.roster_id)] || []).map(pk => pickLabel(pk, me.roster_id, L) + ' · DHQ ' + pk.value);
  return {
    league_id: L.league_id, my_team: teamName(L, me.roster_id), my_window: mine.window, my_needs: (mine.needs || []).map((n: any) => n.pos + ' (' + n.urgency + ')'), looking_for: want,
    partners: partners.slice(0, Number(args.limit) || 6),
    my_chips: chips, my_picks: myPicks,
    how_to_use: 'Pick a partner and a target, then call trade_plan (target, partner): it reads the partner\'s real mode, sets the going rate and builds offers only from what you own, each with its acceptance chance. To grade a package you already have, call evaluate_trade and lead with its verdict.',
    method: skillText('trade_targets'), numbers_as_of: L.built_at,
  };
}

// ── 6. Draft board (the league's next rookie draft) ──────────────────────
export function draftBoard(ctx: Ctx, L: LeagueRow, args: any) {
  const me = myRoster(L, ctx.memberId);
  const picks = L.snapshot.picks || {};
  const years = [...new Set(Object.values(picks).flat().map(p => Number(p.year)))].sort();
  const year = args.year ? Number(args.year) : years[0];
  if (!year) throw new ToolError('No upcoming draft picks are stored for ' + L.name + ' yet.');
  const rounds = Number((L.snapshot.league && L.snapshot.league.settings && L.snapshot.league.settings.draft_rounds) || 0) || undefined;
  const byTeam = (L.snapshot.rosters || []).map(r => {
    const mine = (picks[String(r.roster_id)] || []).filter(p => Number(p.year) === year).sort((a, b) => a.round - b.round);
    return { roster_id: r.roster_id, team: teamName(L, r.roster_id), is_mine: !!(me && me.roster_id === r.roster_id), tier: (assessOf(L, r.roster_id) || {}).tier, picks: mine.map(p => pickLabel(p, r.roster_id, L) + ' · DHQ ' + p.value), capital_dhq: Math.round(mine.reduce((t, p) => t + (Number(p.value) || 0), 0)) };
  }).sort((a, b) => b.capital_dhq - a.capital_dhq);
  const hit = L.intel.hitRateByRound || {};
  const hitRates = Object.entries(hit).map(([rd, x]: [string, any]) => ({ round: Number(rd), picks_seen: x.total, became_starter_pct: x.rate, became_elite_pct: x.eliteRate, best_positions: (x.bestPos || []).slice(0, 3).map((b: any) => b.pos + ' ' + b.rate + '%') }));
  const adp = L.intel.adpByPos || {};
  const tendencies = Object.entries(adp).map(([pos, x]: [string, any]) => ({ pos, avg_pick: x.avgPick, drafted: x.count, first_taken_in_round: x.topRound }));
  return {
    league_id: L.league_id, draft_year: year, rounds, teams: (L.snapshot.rosters || []).length,
    order_note: 'Slots come from Sleeper\'s draft order when it is set, otherwise from the team\'s waiver position (a stand-in for finishing order). Values are DHQ pick values for this league, discounted 12% per year out.',
    picks_by_team: byTeam, my_picks: byTeam.find(t => t.is_mine) || null,
    this_league_hit_rates_by_round: hitRates, what_this_league_drafts_early: tendencies,
    prospects: 'Prospect rankings are not served here yet; this is the league\'s pick picture. Use get_pick_values for a slot\'s worth.',
    method: skillText('draft_board'), numbers_as_of: L.built_at,
  };
}

// ── 7. FAAB bid ──────────────────────────────────────────────────────────
// The Free Agency screen's bid model: what this league pays for a player of
// this strength, which rivals need the position and how hard they bid, and
// the smallest bid that clears 60% of them.
export function waiverBid(ctx: Ctx, L: LeagueRow, args: any) {
  const me = myRoster(L, ctx.memberId);
  if (!me) throw new ToolError('You do not have a team in ' + L.name + '.');
  const pid = resolveOne(ctx, L, args.player);
  if (!pid) throw new ToolError('No player matches "' + args.player + '". Try find_players.');
  const F = engines().Faab;
  if (!F) throw new Error('bid model not loaded');
  if (!L.snapshot.txns) throw new ToolError('This league\'s waiver history is not stored yet; the bid model will work after the next engine build (within two hours).');
  const pos = posOf(ctx, L, pid);
  // In-season bids only (decide-roster.ts inSeason): Sleeper files every
  // offseason claim under week 1, which drags the league's bid levels down.
  const ins = inSeason(ctx, L, L.snapshot.txns as any[]);
  const est = F.estimate({ ...faabInputs(ctx, L, me), txns: ins.txns, targetPid: pid, targetPos: pos, dhq: dhq(L, pid), playerValue: (id: string) => dhq(L, id) });
  if (!est) throw new ToolError('No bid estimate: this is not a FAAB league, or the budget is spent.');
  const an = est.analysis || {};
  const pays = (L.intel.faabByPos || {})[pos];
  const allComps = posComps(ctx, L, ins.txns, pos, 999);
  return {
    league_id: L.league_id, player: name(ctx, pid), pos, dhq_value: dhq(L, pid), rostered_by: whoRosters(L, pid) ? teamName(L, whoRosters(L, pid)) + ' (not a free agent)' : 'free agent',
    suggested_bid: est.sug, range: { low: est.lo, high: est.hi, high_capped_by_budget: !!est.hiCapped }, win_chance_pct_at_suggested: est.winPct != null ? Math.round(Number(est.winPct) * 100) : undefined, capped_by_spend_rule: !!est.capped,
    my_faab_left: est.myLeft, budget: est.budget, league_min_bid: est.minBid,
    cold_start: !!est.coldStart, bids_seen_this_season: est.sampleSize,
    in_season_bids: Object.assign(bidStats(ins.txns), { since: ins.start, offseason_claims_excluded: ins.excluded }),
    recent_winning_bids_at_position: allComps.length ? allComps.slice(0, 5) : undefined, position_in_season_wins: compSummary(allComps),
    rivals: (an.rivals || []).slice(0, 8), ladder: (an.ladder || []).map((x: any) => ({ bid: x.bid, win_pct: Math.round(Number(x.winPct) * 100) })),
    what_this_league_pays_at_pos: pays ? { typical: pays.median, average: pays.avg, p75: pays.p75, bids_seen: pays.count } : undefined,
    based_on: est.coldStart ? 'Only ' + est.sampleSize + ' in-season bids in this league so far: league-typical defaults, not per-rival reads.' : est.sampleSize + ' in-season FAAB bids from this league (winning and losing; offseason claims left out).',
    for_a_whole_plan: 'For who to claim AND who to drop, call get_waiver_plan.',
    method: skillText('waiver_bid'), numbers_as_of: L.built_at,
  };
}

const S = (d: string) => ({ type: 'string', description: d });
const A = (d: string) => ({ type: 'array', items: { type: 'string' }, description: d });
const N = (d: string) => ({ type: 'number', description: d });
const def = (n: string, d: string, props: Record<string, unknown>, required: string[] = []) => ({ name: n, description: d, inputSchema: { type: 'object', properties: { league_id: S('League id'), ...props }, required } });
export const VERDICT_DEFS = [
  def('trade_plan', 'START HERE before proposing any trade. One verdict for getting a player (or dealing with a team): decision (offer / tough / counter / pass / no_fit; tough = possible but costly or a stretch) and one plain recommendation; the partner\'s likely mode (rebuilding / contending / middle), read from their record, this season\'s trades and their Sleeper trade block, what they want and won\'t take; the going rate for the target (a young starter needs a headliner: a next-draft 1st, or a young player worth 70%+; a rebuilder selling a young superflex QB also wants a 2nd or a solid young player on top); up to 3 offers built ONLY from what the member owns, each with its acceptance chance (and lineup_cost when it takes one of his key players); and what not to offer and why. Pass `give` to check and improve a package the member is considering.', { target: S('The player (or pick) the member wants, e.g. "Jordan Love". Default: the best player on the partner\'s trade block.'), partner: S('The other team or owner (default: whoever has the target)'), partner_roster_id: N('Optional: the partner\'s roster id'), give: A('Optional: a package the member is thinking of sending, to check it') }),
  def('get_start_sit', 'THE call for any start/sit or lineup question this week, verdict first: `recommendation` (start X over Y and the points), confidence, coin-flip close calls (within 1.5 pts or 10%) with the tiebreak, who must not start and why (out, doubtful, bye, IR, no NFL team, no Sleeper line, already played), and Questionable starters in late games with a pivot who plays as late. Exact lineup solver (dual-position IDP players counted at every position). Pass `players` when the member names who he is choosing between. Ranks on DHQ\'s weekly projection in this league\'s scoring (the app\'s Lineup screen number; Sleeper\'s line where DHQ has none), with floor/ceiling and a win chance for the tiebreak; never dynasty value. Players whose game has started are locked.', { players: A('Optional: players to decide between (names or ids)'), roster_id: N('Optional: another roster in the league'), week: N('Optional NFL week; only the current week can be decided') }),
  def('get_waiver_plan', 'The waiver decision for the member\'s team, verdict first: who to claim, each paired with who to drop (active roster only, never taxi/IR, an injured stash or a handcuff to his own starter), an opening bid and a max from this season\'s in-season bids (offseason claims excluded) with comparable winning bids at the position, handcuffs to his starters on the wire, FAAB pacing by weeks left, and who not to add (a need no free agent would start at is a trade). Only positions this league starts (no DEF without a DEF slot). Use for "who should I pick up", "who do I drop", "how much should I bid".', { position: S('Optional: limit adds to one position (QB, RB, WR, TE, K, DL, LB, DB, FLEX)'), budget_pct: N('Optional: most of the remaining FAAB to put on any one claim, in percent (default: the pace cap)') }),
  def('roster_plan', 'Roster spots, cuts, IR and taxi for the member\'s team, verdict first: active/taxi/IR counts against the league limits, IR moves (this league\'s IR eligibility rules) and taxi moves that free a spot, the ordered cut list from the active roster (one drop rule, the same get_waiver_plan uses), and who to keep despite a low number (IR stashes valued at a healthy-equivalent from their peers, handcuffs, the backup kicker, the next man up when an NFL teammate is out, young upside). Use for "who should I cut", "do I have room", "can he go on IR/taxi".', {}),
  def('get_roster_needs', 'DHQ\'s read of a team: tier, window, health, panic, every position\'s status (deficit, thin, ok, surplus) with the quality-starter counts behind it, draft capital, and what to do about it.', { roster_id: N('Optional: defaults to the member\'s team') }),
  def('get_player_outlook', 'DHQ\'s buy / sell / hold call on one player for this league (the app\'s player-action chain over value tier, peak years, value years, trend and ownership), with the latest news and this season\'s line.', { player: S('Player name or id') }, ['player']),
  def('compare_players', 'Side by side for 2-6 players in this league: dynasty value, peak years, age, this week, season average, long-run rate, who leads each, and a verdict.', { players: A('Player names or ids (2-6)') }, ['players']),
  def('find_trade_targets', 'The Trade Center\'s partner board for the member: which owners to call and why (roster fit, mutual need, panic, pick capital, DNA, windows), the specific players on their rosters that fill your needs, and the chips you can pay with. Follow up with evaluate_trade on a package.', { position: S('Optional: a position you are shopping for'), limit: N('Partners to return (default 6)') }),
  def('get_draft_board', 'The league\'s next rookie draft: every team\'s picks and their DHQ worth, your picks, this league\'s hit rates by round and what it drafts early. Prospect rankings are not included yet.', { year: N('Optional draft year (default: the next draft)') }),
  def('get_waiver_bid', 'A FAAB bid for a free agent from the Free Agency screen\'s model: what this league pays, which rivals need the position and how hard they bid, the smallest bid that clears 60% of them, and the range.', { player: S('Free agent name or id') }, ['player']),
];
export async function runVerdict(ctx: Ctx, L: LeagueRow, name: string, args: any): Promise<unknown> {
  switch (name) {
    case 'trade_plan': return tradePlan(ctx, L, args);
    case 'get_waiver_plan': return waiverPlan(ctx, L, args);
    case 'roster_plan': return rosterPlan(ctx, L, args);
    case 'get_start_sit': return startSit(ctx, L, args);
    case 'get_roster_needs': return rosterNeeds(ctx, L, args);
    case 'get_player_outlook': return playerOutlook(ctx, L, args);
    case 'compare_players': return comparePlayers(ctx, L, args);
    case 'find_trade_targets': return findTradeTargets(ctx, L, args);
    case 'get_draft_board': return draftBoard(ctx, L, args);
    case 'get_waiver_bid': return waiverBid(ctx, L, args);
  }
  throw new ToolError('Unknown tool: ' + name);
}
export const VERDICT_NAMES = new Set(VERDICT_DEFS.map(d => d.name));
export type { Roster };
