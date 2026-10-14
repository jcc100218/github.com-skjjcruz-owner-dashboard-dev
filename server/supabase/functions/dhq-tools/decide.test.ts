// Fixture tests for the decision modules, ported from the Lab's tests
// (v6-hub js/shared/ask-tools-trade-plan.test.js, ask-tools-moves.test.js,
// ask-tools-roster.test.js, ask-tools.test.js startSitCall cases and
// startsit-engine.test.js exact-solver cases, 2026-10-10). Same fixtures,
// same expected answers, in the server's data shapes (LeagueRow + Ctx).
//
//   deno test --allow-read server/supabase/functions/dhq-tools/decide.test.ts
//
// Needs the vendored engines (vendor/*.js), made the way engine-deploy.yml
// makes them. No network: Sleeper's trade block is stubbed.
// deno-lint-ignore-file no-explicit-any
import './vendor/trade-engine.js';
import './vendor/startsit-engine.js';
import './vendor/faab-engine.js';
import { runTool, type Ctx, type LeagueRow } from './tools.ts';
import { solveLineup, startSitCall } from './decide-lineup.ts';
import { ownerIntent, pickValue, nextDraftYear, projectedSlot, isVet, costToOwner, headlinerMet, headlinerRuleFor, postureFor, appealFor, faabPiece, reconcile } from './decide-trade.ts';
import { valueRead, cutPlan, faabInputs } from './decide-roster.ts';
import { SCALE } from './decide-common.ts';

const App = (globalThis as any).App;
function ok(c: unknown, msg = 'expected truthy') { if (!c) throw new Error(msg); }
function eq(a: unknown, b: unknown, msg = '') { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error((msg ? msg + ': ' : '') + x + ' !== ' + y); }
function match(s: unknown, re: RegExp, msg = '') { if (!re.test(String(s))) throw new Error((msg ? msg + ': ' : '') + JSON.stringify(s) + ' !~ ' + re); }
async function throwsLike(p: Promise<unknown>, re: RegExp) { try { await p; } catch (e) { match((e as Error).message, re); return; } throw new Error('expected an error matching ' + re); }

// ── Exact lineup solver (startsit-engine.test.js) ────────────────────────
const SS = App.StartSit;
const solve = (players: any[], slots: string[]) => {
  const open = slots.map((slot, idx) => ({ idx, slot })).filter(o => !['BN', 'IR', 'TAXI'].includes(SS.normSlot(o.slot)));
  const r = solveLineup(SS, players.filter(p => p.available !== false), open);
  return { ...r, at: Object.fromEntries(open.map(o => [o.idx, r.placed[o.idx] || null])) };
};
function greedyTotal(players: any[], rosterPositions: string[]) {
  const pool = players.filter(p => p.available !== false).map(p => ({ ...p, positions: [...new Set([p.pos].concat(p.positions || []))] })).sort((a, b) => b.pts - a.pts);
  const slots = (rosterPositions.map(SS.normSlot) as string[]).filter((s: string) => !['BN', 'IR', 'TAXI'].includes(s)).map((s: string) => SS.FLEX_ALLOWED[s] || [s]).sort((a: string[], b: string[]) => a.length - b.length);
  const used = new Set(); let t = 0;
  for (const el of slots) { const p = pool.find(x => !used.has(x.pid) && x.positions.some((q: string) => el.includes(q))); if (p) { used.add(p.pid); t += p.pts; } }
  return Math.round(t * 10) / 10;
}
function bruteTotal(players: any[], rosterPositions: string[]) {
  const pool = players.filter(p => p.available !== false).map(p => ({ ...p, positions: [...new Set([p.pos].concat(p.positions || []))] }));
  const slots = (rosterPositions.map(SS.normSlot) as string[]).filter((s: string) => !['BN', 'IR', 'TAXI'].includes(s)).map((s: string) => SS.FLEX_ALLOWED[s] || [s]);
  let best = { n: -1, t: -Infinity };
  (function go(i: number, used: number, n: number, t: number) {
    if (i === slots.length) { if (n > best.n || (n === best.n && t > best.t)) best = { n, t }; return; }
    pool.forEach((p, j) => { if (used & (1 << j) || !p.positions.some((q: string) => slots[i].includes(q))) return; go(i + 1, used | (1 << j), n + 1, t + p.pts); });
    go(i + 1, used, n, t);
  })(0, 0, 0, 0);
  return Math.round(best.t * 10) / 10;
}
Deno.test('solver: DL then LB with a DL/LB player scores 19, not 11', () => {
  const players = [{ pid: 'X', pos: 'DL', positions: ['DL', 'LB'], pts: 10 }, { pid: 'Y', pos: 'DL', positions: ['DL'], pts: 9 }, { pid: 'Z', pos: 'LB', positions: ['LB'], pts: 1 }];
  eq(greedyTotal(players, ['DL', 'LB']), 11, 'the old greedy really did return 11');
  const opt = solve(players, ['DL', 'LB', 'BN']);
  eq(opt.total, 19); eq(opt.at, { 0: 'Y', 1: 'X' }); eq(opt.exact, true);
});
Deno.test('solver: Psycho League IDP slots with three DL/LB players match the exhaustive best', () => {
  const slots = ['DL', 'DL', 'DL', 'LB', 'LB', 'DB', 'DB', 'DB', 'IDP_FLEX', 'IDP_FLEX', 'IDP_FLEX', 'BN', 'BN'];
  const P = (pid: string, positions: string[], pts: number) => ({ pid, pos: positions[0], positions, pts });
  const players = [P('nwosu', ['DL', 'LB'], 9), P('chop', ['DL', 'LB'], 8), P('jjohnson', ['DL', 'LB'], 7.5), P('donald', ['DL'], 7), P('hall', ['DL'], 6.5), P('hemingway', ['DL'], 6),
    P('oluokun', ['LB'], 2), P('ewilson', ['LB'], 1.5), P('lassiter', ['DB'], 7.7), P('humphrey', ['DB'], 6.1), P('stukes', ['DB'], 3.9), P('masses', ['DB'], 2), P('henderson', ['DB'], 1)];
  const opt = solve(players, slots);
  eq(greedyTotal(players, slots), 65.2); eq(opt.total, 65.7); eq(opt.filled, 11);
  eq(new Set(Object.values(opt.placed)).size, 11, 'no player counted twice');
  eq([opt.at[3], opt.at[4]].sort(), ['chop', 'nwosu'], 'the dual-eligible rushers take the LB slots');
});
Deno.test('solver: equals exhaustive search on 300 random small leagues, never worse than the greedy', () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const POS = [['DL'], ['LB'], ['DL', 'LB'], ['DB'], ['RB'], ['WR'], ['TE'], ['QB'], ['WR', 'RB']];
  const SLOTS = ['DL', 'LB', 'DB', 'IDP_FLEX', 'RB', 'WR', 'TE', 'FLEX', 'SUPER_FLEX', 'QB', 'REC_FLEX'];
  for (let k = 0; k < 300; k++) {
    const nS = 2 + Math.floor(rnd() * 4), nP = 2 + Math.floor(rnd() * 7);
    const slots = Array.from({ length: nS }, () => SLOTS[Math.floor(rnd() * SLOTS.length)]);
    const players = Array.from({ length: nP }, (_, i) => { const ps = POS[Math.floor(rnd() * POS.length)]; return { pid: 'p' + i, pos: ps[0], positions: ps, available: rnd() > 0.1, pts: Math.round(rnd() * 200) / 10 }; });
    const opt = solve(players, slots);
    eq(opt.total, bruteTotal(players, slots), 'case ' + k);
    ok(opt.total >= greedyTotal(players, slots), 'never worse than the greedy, case ' + k);
  }
});
Deno.test('solver: nested formats come back exactly as the greedy placed them, by slot index', () => {
  const P = (pid: string, pos: string, pts: number) => ({ pid, pos, pts });
  const opt = solve([P('qb1', 'QB', 20), P('qb2', 'QB', 18), P('rb1', 'RB', 15), P('rb2', 'RB', 12), P('wr1', 'WR', 14), P('wr2', 'WR', 12), P('te1', 'TE', 9)], ['QB', 'RB', 'WR', 'TE', 'FLEX', 'SUPER_FLEX', 'BN']);
  eq(opt.at, { 0: 'qb1', 1: 'rb1', 2: 'wr1', 3: 'te1', 4: 'rb2', 5: 'qb2' }); eq(opt.total, 88); eq(opt.exact, false);
});
Deno.test('solver: slots keep their own index even when the league lists flex before IDP', () => {
  // The old mapping read the solver's narrowest-first order as the league's order.
  const opt = solve([{ pid: 'w', pos: 'WR', pts: 10 }, { pid: 'r', pos: 'RB', pts: 9 }, { pid: 'd', pos: 'DL', pts: 5 }], ['FLEX', 'WR', 'DL']);
  eq(opt.at, { 0: 'r', 1: 'w', 2: 'd' });
});
Deno.test('solver: an empty slot stays empty when nobody fits; unavailable players never start', () => {
  const opt = solve([{ pid: 'a', pos: 'DL', positions: ['DL', 'LB'], available: false, pts: 30 }, { pid: 'b', pos: 'LB', pts: 4 }], ['DL', 'LB', 'K']);
  eq(opt.at, { 0: null, 1: 'b', 2: null }); eq(opt.total, 4);
});

// ── startSitCall rules (ask-tools.test.js) ───────────────────────────────
const base = (players: any, extra?: any) => Object.assign({ week: 5, locks_loaded: true, current_total: 10, best_total: 11, slots: [{ idx: 0, slotName: 'FLEX', elig: ['RB', 'WR', 'TE'] }], current: { 0: 'b' }, placed: { 0: 'a' }, players }, extra || {});
const SP = (name: string, proj: number, o?: any) => Object.assign({ name, positions: ['WR'], proj, floor: proj * 0.7, ceiling: proj * 1.35, locked: false, kick: 2, injury_status: null, zero_reason: null, roster_slot: 'bench' }, o || {});
Deno.test('start/sit: close call, favored: the higher floor wins the tiebreak', () => {
  const out = startSitCall(base({ a: SP('Q Guy', 8.0, { floor: 4.8, injury_status: 'Questionable' }), b: SP('Steady', 7.5, { roster_slot: 'starter' }) }, { win_pct: 70 }));
  eq(out.changes[0].close_call, true); eq(out.close_calls[0].call, 'coin flip'); eq(out.close_calls[0].lean, 'Steady');
  match(out.close_calls[0].tiebreak, /favored \(70%/); match(out.decision[0], /^Keep Steady over Q Guy/); eq(out.confidence, 'medium');
});
Deno.test('start/sit: close call, underdog: the higher ceiling wins', () => {
  const out = startSitCall(base({ a: SP('Boom', 8.0, { ceiling: 14 }), b: SP('Safe', 7.5, { ceiling: 9, roster_slot: 'starter' }) }, { win_pct: 30 }));
  eq(out.close_calls[0].lean, 'Boom'); match(out.decision[0], /^Start Boom over Safe at FLEX \(coin flip/);
});
Deno.test('start/sit: no win chance (the server) keeps the higher projection', () => {
  const out = startSitCall(base({ a: SP('More', 8.0), b: SP('Less', 7.5, { roster_slot: 'starter' }) }));
  eq(out.close_calls[0].lean, 'More'); match(out.close_calls[0].tiebreak, /no win chance available: keep the higher projection/);
});
Deno.test('start/sit: a clear gain is a firm call with high confidence', () => {
  const out = startSitCall(base({ a: SP('Chop Robinson', 4.4, { positions: ['DL', 'LB'] }), b: SP('Derick Hall', 0.4, { positions: ['DL'], roster_slot: 'starter' }) }, { slots: [{ idx: 0, slotName: 'DL', elig: ['DL'] }], win_pct: 50 }));
  eq(out.changes[0].close_call, false); eq(out.changes[0].gain_pts, 4);
  eq(out.recommendation, 'Start Chop Robinson over Derick Hall at DL (+4 pts).'); eq(out.confidence, 'high');
});
Deno.test('start/sit: gains rank on the average week (avg); the why quotes the shown number (proj)', () => {
  const out = startSitCall(base({ a: SP('Typical', 7.0, { avg: 9.0 }), b: SP('Other', 7.4, { avg: 5.0, roster_slot: 'starter' }) }, { win_pct: 50, stat_word: 'DHQ projection' }));
  eq(out.changes[0].gain_pts, 4);
  eq(out.changes[0].why.startsWith('DHQ projects Typical 7.0 vs Other 7.4'), true);
});
Deno.test('start/sit: a sit who is out is never a coin flip; locks not loaded means low confidence', () => {
  const out = startSitCall(base({ a: SP('Backup', 1.0), b: SP('Hurt', 0, { roster_slot: 'starter', zero_reason: 'out' }) }, { locks_loaded: false }));
  eq(out.changes[0].close_call, false); eq(out.confidence, 'low'); ok(out.warning); eq(out.do_not_start, [{ player: 'Hurt', reason: 'out' }]);
});
Deno.test('start/sit: do_not_start lists current starters (or players asked about), never players already on the bench', () => {
  const P2 = { s: SP('Starter Out', 0, { roster_slot: 'starter', zero_reason: 'out' }), b: SP('Bench Out', 0, { zero_reason: 'out' }), c: SP('Bench NoTeam', 0, { zero_reason: 'no NFL team' }), a: SP('Healthy', 5) };
  const out = startSitCall(base(P2, { current: { 0: 's' }, placed: { 0: 'a' } }));
  eq(out.do_not_start, [{ player: 'Starter Out', reason: 'out' }]);
  const asked = startSitCall(base(P2, { current: { 0: 's' }, placed: { 0: 'a' }, asked: ['b', 'c'] }));
  eq(asked.do_not_start.map((x: any) => x.player).sort(), ['Bench NoTeam', 'Bench Out', 'Starter Out']);
});
Deno.test('start/sit: a locked player is never moved, even if handed a swap', () => {
  const out = startSitCall(base({ a: SP('Bench Lock', 20, { locked: true }), b: SP('Starter', 5, { roster_slot: 'starter' }) }));
  eq(out.changes.length, 0); eq(out.do_not_start, [], 'a benched player is already benched: nothing to say');
});
Deno.test('start/sit: swaps chain through a starter who only changes slots', () => {
  const slots = [{ idx: 0, slotName: 'DL', elig: ['DL'] }, { idx: 1, slotName: 'LB', elig: ['LB'] }];
  const out = startSitCall(base({ nwosu: SP('Uchenna Nwosu', 9, { positions: ['DL', 'LB'], roster_slot: 'starter' }), wilson: SP('Eric Wilson', 2, { positions: ['LB'], roster_slot: 'starter' }), donald: SP('Aaron Donald', 8, { positions: ['DL'] }) }, { slots, current: { 0: 'nwosu', 1: 'wilson' }, placed: { 0: 'donald', 1: 'nwosu' } }));
  eq(out.changes.map((c: any) => [c.start, c.sit]), [['Aaron Donald', 'Eric Wilson']]); eq(out.changes[0].gain_pts, 6);
});
Deno.test('start/sit: Questionable starter in a late game with no later pivot names the fallback', () => {
  const slots = [{ idx: 0, slotName: 'DB', elig: ['DB'] }];
  const out = startSitCall(base({ hum: SP('Marlon Humphrey', 6.1, { positions: ['DB'], injury_status: 'Questionable', kick: 300, roster_slot: 'starter' }), early: SP('Treydan Stukes', 3.9, { positions: ['DB'], kick: 100 }), hurt: SP('Hurt DB', 5, { positions: ['DB'], kick: 400, zero_reason: 'out' }) }, { slots, current: { 0: 'hum' }, placed: { 0: 'hum' }, game_kicks: [100, 100, 100, 300] }));
  const q = out.questionable[0];
  eq(q.late_game, true); eq(q.pivot, 'Treydan Stukes', 'an out player is never the pivot'); eq(q.pivot_plays_later, false); match(q.note, /cannot swap/); eq(out.confidence, 'medium');
});
Deno.test('start/sit: an early-game Questionable is not "late"', () => {
  const slots = [{ idx: 0, slotName: 'DB', elig: ['DB'] }];
  const out = startSitCall(base({ hum: SP('Early Q', 6, { positions: ['DB'], injury_status: 'Questionable', kick: 100, roster_slot: 'starter' }) }, { slots, current: { 0: 'hum' }, placed: { 0: 'hum' }, game_kicks: [50, 100, 100, 100, 300, 400] }));
  eq(out.questionable[0].late_game, false); eq(out.questionable[0].pivot, null);
});
Deno.test('start/sit: Questionable starter with a bench pivot in a later game: start him, swap if inactive', () => {
  const slots = [{ idx: 0, slotName: 'DB', elig: ['DB'] }];
  const out = startSitCall(base({ hum: SP('Marlon Humphrey', 6.1, { positions: ['DB'], injury_status: 'Questionable', kick: 300, roster_slot: 'starter' }), late: SP('Late DB', 3, { positions: ['DB'], kick: 400 }), early: SP('Early DB', 3.9, { positions: ['DB'], kick: 100 }) }, { slots, current: { 0: 'hum' }, placed: { 0: 'hum' }, game_kicks: [100, 100, 100, 300, 400] }));
  const q = out.questionable[0];
  eq(q.pivot, 'Late DB'); eq(q.pivot_plays_later, true); match(q.note, /swap in Late DB/);
});
Deno.test('start/sit: head to head within 1.5 pts is a coin flip that names the injury tag', () => {
  const out = startSitCall(base({ a: SP('Courtland Sutton', 8.4), b: SP('George Holani', 7.7, { injury_status: 'Questionable', roster_slot: 'starter' }) }, { asked: ['b', 'a'] }));
  eq(out.head_to_head.close_call, true); eq(out.head_to_head.call, 'coin flip'); eq(out.head_to_head.pick, 'Courtland Sutton');
  match(out.head_to_head.injury_note, /George Holani is Questionable/); match(out.recommendation, /coin flip/);
  eq(out.asked.map((x: any) => [x.player, x.verdict]), [['George Holani', 'sit'], ['Courtland Sutton', 'start']]);
});

// ── Trade fixture (ask-tools-trade-plan.test.js), the Psycho League shape ─
// Superflex; the member (skjjcruz, 3-1) holds his 2029 1st and TWhy123's
// 2027 2nd but not his own 2027 or 2028 1st; bwit13 is 1-3, sold Olave,
// G. Wilson, LaPorta and Dobbins for 8 picks this season and listed Jordan
// Love, Barkley, Pittman and Addison.
const TP = (n: string, pos: string, t: string, age: number, dco: number, inj: string | null = null) => ({ n, pos, fp: [pos], t, age, yrs: 5, st: 'Active', inj, injp: null, dc: pos, dco, col: null, num: null, act: true });
const tradePlayers: Record<string, any> = {
  stafford: TP('Matthew Stafford', 'QB', 'LAR', 38, 1), andrews: TP('Mark Andrews', 'TE', 'BAL', 31, 1), pickens: TP('George Pickens', 'WR', 'DAL', 25, 1),
  jt: TP('Jonathan Taylor', 'RB', 'IND', 27, 1), jwill: TP('Jaylen Williams', 'RB', 'ATL', 23, 2), kick: TP('Brandon Aubrey', 'K', 'DAL', 30, 1),
  love: TP('Jordan Love', 'QB', 'GB', 27, 1), barkley: TP('Saquon Barkley', 'RB', 'PHI', 29, 1), pittman: TP('Michael Pittman', 'WR', 'IND', 29, 1),
  addison: TP('Jordan Addison', 'WR', 'MIN', 24, 2), dart: TP('Jaxson Dart', 'QB', 'NYG', 23, 4, 'IR'), jsmith: TP('Jonnu Smith', 'TE', 'PIT', 31, 1),
  olave: TP('Chris Olave', 'WR', 'NO', 26, 1), gwilson: TP('Garrett Wilson', 'WR', 'NYJ', 26, 1), laporta: TP('Sam LaPorta', 'TE', 'DET', 25, 1),
  dobbins: TP('J.K. Dobbins', 'RB', 'DEN', 27, 1), lawrence: TP('Trevor Lawrence', 'QB', 'JAX', 27, 1),
};
const TR = (roster_id: number, owner_id: string, players: string[], wins: number, losses: number, fpts: number) => ({ roster_id, owner_id, co_owners: null, players, starters: [], reserve: [], taxi: [], settings: { wins, losses, fpts }, metadata: null });
const tradedPicks = [
  { season: '2027', round: 1, roster_id: 13, owner_id: 4 }, { season: '2028', round: 1, roster_id: 13, owner_id: 9 },
  { season: '2027', round: 2, roster_id: 13, owner_id: 7 }, { season: '2027', round: 3, roster_id: 13, owner_id: 9 },
  { season: '2028', round: 2, roster_id: 13, owner_id: 16 }, { season: '2028', round: 3, roster_id: 13, owner_id: 16 },
  { season: '2027', round: 2, roster_id: 4, owner_id: 13 },
  { season: '2027', round: 1, roster_id: 4, owner_id: 5 }, { season: '2028', round: 1, roster_id: 4, owner_id: 5 }, { season: '2029', round: 1, roster_id: 4, owner_id: 5 },
  { season: '2027', round: 2, roster_id: 7, owner_id: 5 }, { season: '2028', round: 3, roster_id: 7, owner_id: 5 },
  { season: '2027', round: 1, roster_id: 9, owner_id: 5 }, { season: '2028', round: 2, roster_id: 9, owner_id: 5 }, { season: '2027', round: 3, roster_id: 16, owner_id: 5 },
];
const tradeRosters = [TR(13, 'u13', ['stafford', 'andrews', 'pickens', 'jt', 'jwill', 'kick'], 3, 1, 520), TR(5, 'u5', ['love', 'barkley', 'pittman', 'addison', 'dart', 'jsmith'], 1, 3, 380), TR(4, 'u4', ['olave', 'gwilson'], 4, 0, 560), TR(7, 'u7', ['laporta'], 1, 3, 400), TR(9, 'u9', ['dobbins', 'lawrence'], 2, 2, 450), TR(16, 'u16', [], 0, 4, 350)];
// The build's pick ownership (headless.js picksByRoster): 2027-2029, rounds 1-3.
const picksFrom = (tp: any[]) => {
  const out: Record<string, any[]> = {};
  tradeRosters.forEach(r => {
    out[r.roster_id] = [];
    [2027, 2028, 2029].forEach(y => { for (let rd = 1; rd <= 3; rd++) {
      if (!tp.some(p => Number(p.season) === y && p.round === rd && p.roster_id === r.roster_id && p.owner_id !== p.roster_id)) out[r.roster_id].push({ year: y, round: rd, from: r.roster_id, value: 0 });
      tp.filter(p => Number(p.season) === y && p.round === rd && p.owner_id === r.roster_id && p.owner_id !== p.roster_id).forEach(p => out[r.roster_id].push({ year: y, round: rd, from: p.roster_id, value: 0 }));
    } });
  });
  return out;
};
// The engine-shaped slot curve (by overall slot, undiscounted).
const dhqPickValues: Record<string, { value: number }> = {};
[1, 2, 3].forEach(rd => { const top = ({ 1: 7000, 2: 3000, 3: 1500 } as any)[rd], bottom = ({ 1: 4000, 2: 2000, 3: 900 } as any)[rd]; for (let s = 1; s <= 6; s++) dhqPickValues[String((rd - 1) * 6 + s)] = { value: Math.round(top - (top - bottom) * (s - 1) / 5) }; });
const pk = (season: string, round: number) => ({ season, round });
const DEF_A = { tier: 'CROSSROADS', window: 'CROSSROADS', panic: 1, needs: [], strengths: [], posAssessment: {} };
const A: Record<string, any> = { 13: { tier: 'CONTENDER', window: 'CONTENDING', panic: 1, needs: [{ pos: 'QB', urgency: 'thin' }], strengths: ['RB'], posAssessment: {} }, 5: { tier: 'CROSSROADS', window: 'CROSSROADS', panic: 4, needs: [], strengths: [], posAssessment: {} }, 9: { ...DEF_A } };
const TL: LeagueRow = {
  league_id: '999', season: '2026', name: 'The Psycho League', built_at: '2026-10-10T00:00:00Z', engine_version: 'test',
  intel: {
    playerScores: { stafford: 2090, andrews: 2400, pickens: 5200, jt: 4288, jwill: 2600, kick: 300, love: 3574, barkley: 3100, pittman: 1900, addison: 3300, dart: 2800, jsmith: 900, olave: 4800, gwilson: 4700, laporta: 3900, dobbins: 1500, lawrence: 4128 },
    playerMeta: { stafford: { peakYrsLeft: 0 }, andrews: { peakYrsLeft: 0 }, pickens: { peakYrsLeft: 5 }, jt: { peakYrsLeft: 0 }, jwill: { peakYrsLeft: 5 }, love: { peakYrsLeft: 5 }, barkley: { peakYrsLeft: 0 }, pittman: { peakYrsLeft: 1 }, addison: { peakYrsLeft: 6 }, dart: { peakYrsLeft: 8 }, lawrence: { peakYrsLeft: 5 }, jsmith: { peakYrsLeft: 0 } },
    dhqPickValues,
    tradeHistory: [
      { season: '2026', week: 5, ts: Date.UTC(2026, 9, 9), roster_ids: [5, 4], sides: { 4: { players: ['olave', 'gwilson'], picks: [] }, 5: { players: [], picks: [pk('2027', 1), pk('2028', 1), pk('2029', 1)] } } },
      { season: '2026', week: 3, ts: Date.UTC(2026, 8, 23), roster_ids: [5, 7], sides: { 7: { players: ['laporta'], picks: [] }, 5: { players: [], picks: [pk('2027', 2), pk('2028', 3)] } } },
      { season: '2026', week: 1, ts: Date.UTC(2026, 8, 8), roster_ids: [5, 9], sides: { 9: { players: ['dobbins'], picks: [] }, 5: { players: [], picks: [pk('2027', 1), pk('2028', 2), pk('2027', 3)] } } },
    ],
    ownerProfiles: {},
  },
  assessments: tradeRosters.map(r => ({ rosterId: r.roster_id, ...(A[String(r.roster_id)] || DEF_A) })),
  dna: {},
  snapshot: {
    league: { league_id: '999', status: 'in_season', settings: { draft_rounds: 3, num_teams: 6 }, roster_positions: ['QB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'SUPER_FLEX'] },
    rosters: tradeRosters as any, users: [['u13', 'skjjcruz'], ['u5', 'bwit13'], ['u4', 'TWhy123'], ['u7', 'Malibooch'], ['u9', 'DJAlexB'], ['u16', 'MangaMaw']].map(([user_id, display_name]) => ({ user_id, display_name, avatar: null, team_name: null, team_avatar: null })),
    traded_picks: tradedPicks, matchups: [], nfl_state: { week: 5, season: '2026' }, picks: picksFrom(tradedPicks), proj_week: 5,
  },
};
const tctx: Ctx = { memberId: 'u13', leagues: [TL], loadLeague: async () => TL, players: tradePlayers, nflState: { week: 5, season: '2026' }, trending: [], te: App.TradeEngine };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, opts: any) => {
  if (!/api\.sleeper\.app\/graphql/.test(String(url))) throw new Error('no network in tests: ' + url);
  match(JSON.parse(opts.body).query, /league_players/);
  return new Response(JSON.stringify({ data: { league_players: ['love', 'barkley', 'pittman', 'addison'].map(player_id => ({ player_id, metadata: null, settings: { otb: 1, otb_added_at: Date.UTC(2026, 9, 9) } })) } }), { status: 200 });
}) as typeof fetch;
const tr = (n: string, a: any) => runTool(tctx, n, { league_id: '999', ...a }) as Promise<any>;
const PICKY = /\b(1st|2nd|3rd|pick|picks|round)\b/i;

Deno.test('trade: bwit13 reads REBUILDING (sold for picks, vets listed, 1-3) and a seller, not "desperate"', async () => {
  const it = await ownerIntent(tctx, TL, TL.snapshot.rosters[1]);
  eq(it.mode, 'REBUILDING'); ok(it.evidence.some(e => /8 draft picks/.test(e)), it.evidence.join(' | '));
  eq(it._vetsListed.map(pid => tradePlayers[pid].n).sort(), ['Michael Pittman', 'Saquon Barkley']);
  const r = await tr('evaluate_trade', { give: ['2029 1st'], get: ['Jordan Love'] });
  match(r.their_posture, /^Active Seller/); ok(!r.psychology.some((p: any) => p.factor === 'Panic Premium'), 'no Panic Premium for a rebuilder'); eq(r.verdict.partner_mode, 'rebuilding');
});
Deno.test('trade: pick slots: the worst team\'s next-draft 1st projects early; only later drafts are discounted', () => {
  eq(nextDraftYear(TL), 2027);
  const manga = pickValue(TL, 2027, 1, null, 16), bwit = pickValue(TL, 2027, 1, null, 5), dj = pickValue(TL, 2027, 1, null, 9), twhy = pickValue(TL, 2027, 1, null, 4);
  ok(manga > bwit && bwit > dj && dj > twhy, [manga, bwit, dj, twhy].join(' > '));
  eq(manga, 7000); eq(pickValue(TL, 2027, 1, 3), 5800);
  eq(pickValue(TL, 2028, 1, null, 16), Math.round(5800 * 0.88)); eq(pickValue(TL, 2029, 1, null, 13), Math.round(5800 * 0.88 * 0.88));
  eq(projectedSlot(TL, 2027, 13), 5); eq(projectedSlot(TL, 2028, 5), null);
});
Deno.test('trade: my assets are only what I own; the 2027 1st I traded is never offered', async () => {
  const r = await tr('trade_plan', { target: 'Jordan Love', give: ['2027 1st'] });
  eq(r.my_assets.picks.filter((p: any) => p.round === 1).map((p: any) => p.year), [2029]);
  ok(r.my_assets.picks.some((p: any) => p.year === 2027 && p.round === 2 && /TWhy123/.test(p.original_owner)));
  ok(r.do_not_offer.some((d: any) => /2027 1st/.test(d.asset) && /TWhy123 holds it/.test(d.reason)), JSON.stringify(r.do_not_offer));
  r.offers.forEach((o: any) => ok(!o.give.some((g: string) => /^2027 1st/.test(g)), o.give.join(' + ')));
  ok(['counter', 'pass'].includes(r.decision), r.decision);
  const e = await tr('evaluate_trade', { give: ['2027 1st'], get: ['Jordan Love'] });
  eq(e.verdict.decision, 'pass'); match(e.verdict.call, /TWhy123 does/);
});
Deno.test('trade: a pick with an unknown holder is never treated as mine', async () => {
  const keep = TL.snapshot.picks; TL.snapshot.picks = undefined;
  try {
    const e = await tr('evaluate_trade', { give: ['2029 1st'], get: ['Jordan Love'] });
    eq(e.headliner.offer_has_it, false); eq(e.verdict.confidence, 'low'); ok(e.warnings.some((w: string) => /Couldn't confirm you own 2029 1st/.test(w)));
    const p = await tr('trade_plan', { target: 'Jordan Love' });
    eq(p.my_assets.picks, []); eq(p.offers.length, 0); eq(p.decision, 'tough'); eq(p.confidence, 'low');
  } finally { TL.snapshot.picks = keep; }
});
// Owner ruling 2026-10-10 (Love test): a rebuilder won't trade a young
// starting QB for a 1st three drafts away; it takes a next-draft 1st plus a
// little something (a 2nd or a nice player).
Deno.test('trade: young SF starting QB from a rebuilder: a next-draft 1st plus a little more; a far-off 1st is not the headliner', async () => {
  const r = await tr('trade_plan', { target: 'Jordan Love' });
  match(r.price_floor.headliner_needed, /^a 2027 1st \(a rebuilder also wants a 2nd or a solid young player on top\)/); match(r.price_floor.rule, /superflex/);
  // The member's only 1st is a 2029: no pick-led deal. Owner ruling: the
  // realistic path is one of his top players plus a pick, said as a tough
  // deal that costs a key piece of the lineup, never "can't be done".
  ok(r.offers.length >= 1);
  r.offers.forEach((o: any) => { ok(o.give.some((g: string) => /George Pickens|Jonathan Taylor/.test(g)), o.give.join(' + ')); match(o.lineup_cost, /key piece of your lineup/); ok(!o.give.some((g: string) => /^2029 1st/.test(g))); });
  eq(r.decision, 'tough'); match(r.recommendation, /^This will be a tough deal to pull off/); match(r.recommendation, /may consider/); match(r.recommendation, /looks to be rebuilding/);
  ok(!/Nothing you own|can't/i.test(r.recommendation), r.recommendation);
  const far = await tr('evaluate_trade', { give: ['2029 1st', '2027 2nd from TWhy123'], get: ['Jordan Love'] });
  eq(far.headliner.offer_has_it, false); ok(far.headliner.notes.some((n: string) => /too far off/.test(n)), JSON.stringify(far.headliner));
  // The rule itself: a next-draft 1st alone isn't enough from a rebuilder; plus a 2nd it is.
  const rule = headlinerRuleFor(tctx, TL, { kind: 'player', pid: 'love', pos: 'QB', age: 27, value: 3574 });
  const t = { value: 3574 };
  const p27 = { kind: 'pick', round: 1, year: 2027, holder: 13, label: '2027 1st' }, s27 = { kind: 'pick', round: 2, year: 2027, holder: 13, label: '2027 2nd' };
  const p28 = { kind: 'pick', round: 1, year: 2028, holder: 13, label: '2028 1st' }, s28 = { kind: 'pick', round: 2, year: 2028, holder: 13, label: '2028 2nd' };
  eq(headlinerMet(rule, t, [p27], 13, 'REBUILDING').ok, false);
  eq(headlinerMet(rule, t, [p27, s27], 13, 'REBUILDING').ok, true);
  eq(headlinerMet(rule, t, [p28, s27], 13, 'REBUILDING').ok, false, 'a 2028 1st spends its add standing in for a 2027');
  eq(headlinerMet(rule, t, [p28, s27, s28], 13, 'REBUILDING').ok, true);
  eq(headlinerMet(rule, t, [p27], 13, 'CONTENDING').ok, true, 'the add is a rebuilder\'s ask');
  const e = await tr('evaluate_trade', { give: ['George Pickens'], get: ['Jordan Love'] });
  eq(e.headliner.offer_has_it, false); eq(e.verdict.decision, 'counter'); ok(e.acceptance_chance_pct <= 10);
});
Deno.test('trade: Stafford + Andrews for Love: a rebuilder doesn\'t want aging vets, low chance, counter with my 2029 1st', async () => {
  const r = await tr('trade_plan', { target: 'Jordan Love', give: ['Matthew Stafford', 'Mark Andrews'] });
  eq(r.partner.mode, 'rebuilding'); eq(r.decision, 'counter'); ok(r.your_offer.accept_chance_pct <= 10, String(r.your_offer.accept_chance_pct)); eq(r.your_offer.headliner_met, false);
  for (const n of ['Matthew Stafford', 'Mark Andrews']) ok(r.do_not_offer.some((d: any) => d.asset.startsWith(n)), n);
  ok(r.partner.wont_take.some((w: string) => /age cliff/.test(w)));
  r.offers.forEach((o: any) => ok(!o.give.some((g: string) => /Stafford|Andrews/.test(g)), o.give.join(' + ')));
  match(r.recommendation, /^Don't send Matthew Stafford \+ Mark Andrews/); match(r.recommendation, /tough one/);
  const e = await tr('evaluate_trade', { give: ['Matthew Stafford', 'Mark Andrews'], get: ['Jordan Love'] });
  eq(e.verdict.decision, 'counter'); ok(e.verdict.accept_chance_pct <= 10); match(e.partner_view.verdict, /not appealing/);
});
Deno.test('trade: acceptance runs on what the partner values: piling on vets doesn\'t raise it', async () => {
  // (Owner ruling: Jonathan Taylor at 27 is a top player at the age line, not a relic, so this pile is Stafford + Andrews alone.)
  const e = await tr('evaluate_trade', { give: ['Matthew Stafford', 'Mark Andrews'], get: ['Jordan Love'] }); ok(e.acceptance_chance_pct <= 10); ok(e.partner_view.worth_to_them < e.partner_view.what_they_give_up_as_they_see_it);
  const young = await tr('evaluate_trade', { give: ['Jaylen Williams'], get: ['Michael Pittman'] });
  const vets = await tr('evaluate_trade', { give: ['Mark Andrews', 'Matthew Stafford'], get: ['Michael Pittman'] });
  ok(young.acceptance_chance_pct >= vets.acceptance_chance_pct, young.acceptance_chance_pct + ' vs ' + vets.acceptance_chance_pct);
});
Deno.test('trade: 2029 1st alone for Love: a rebuilder won\'t take a 1st three drafts away for a young starting QB', async () => {
  const e = await tr('evaluate_trade', { give: ['2029 1st'], get: ['Jordan Love'] });
  eq(Object.keys(e)[0], 'verdict'); eq(e.verdict.decision, 'counter'); eq(e.headliner.offer_has_it, false);
  ok(e.verdict.accept_chance_pct <= 10, String(e.verdict.accept_chance_pct)); match(e.fairness, /raw value/);
  ok(!e.balance, 'the fix is the headliner, not balance');
});
Deno.test('trade: balance when the member overpays a rebuilder: their veterans, never their picks', async () => {
  const e = await tr('evaluate_trade', { give: ['Jaylen Williams'], get: ['Michael Pittman'] });
  ok(e.balance && e.balance.options.length, JSON.stringify(e.balance)); match(e.balance.how, /won't give picks back/);
  e.balance.options.forEach((o: string) => ok(!PICKY.test(o), o)); ok(e.balance.options[0].includes('on their block'));
});
Deno.test('trade: listed vets cost their owner less (down to a market floor); Love (listed, not a vet) only the listing discount', async () => {
  const r = await tr('trade_plan', { target: 'Saquon Barkley' });
  // A listed vet costs his rebuilding owner less, but never below his market floor (70%, 85% of that when listed).
  eq(r.price_floor.their_price, Math.round(3100 * 0.7 * 0.85), String(r.price_floor.their_price)); match(r.price_floor.headliner_needed, /^none/);
  const love = await tr('trade_plan', { target: 'Jordan Love' });
  eq(love.price_floor.their_price, Math.round(3574 * 0.85));
});
Deno.test('trade: Trevor Lawrence (DJAlexB, contending) for my 2029 1st + TWhy123\'s 2027 2nd: at market', async () => {
  const e = await tr('evaluate_trade', { give: ['2029 1st', '2027 2nd from TWhy123'], get: ['Trevor Lawrence'] });
  eq(e.headliner.offer_has_it, true); eq(e.verdict.decision, 'offer'); eq(e.verdict.partner_mode, 'contending'); eq(e.warnings, undefined);
});
Deno.test('trade: trade_plan answer shape and comparables from this season\'s league trades', async () => {
  const r = await tr('trade_plan', { partner: 'bwit13' });
  eq(Object.keys(r).slice(0, 3), ['decision', 'confidence', 'recommendation']);
  match(r.evidence[0], /most valuable player on .*trade block/); ok(r.comparables.length >= 1);
  ok(r.rules_applied.length >= 5 && typeof r.method === 'string'); ok(r.offers.length <= 3);
  await throwsLike(tr('trade_plan', { target: 'Jordan Love', partner: 'DJAlexB' }), /is on bwit13/);
});
Deno.test('trade: FAAB is a trade piece at the Trade Room rate (1 FAAB dollar = 2 value)', async () => {
  const e = await tr('evaluate_trade', { give: ['2029 1st', '$100 FAAB'], get: ['Jordan Love'] });
  ok(JSON.stringify(e).includes('$100 FAAB')); eq(e.total_give, pickValue(TL, 2029, 1, null, 13) + 200);
  eq(e.you_give.find((x: any) => x.pick === '$100 FAAB').value, 200);
  eq(faabPiece('250 faab'), { kind: 'faab', label: '$250 FAAB', dollars: 250, value: 500 }); eq(faabPiece('2027 1st'), null);
  eq(appealFor(TL, 'REBUILDING', { kind: 'faab' }).mult, 1);
});
Deno.test('trade: an offer the partner is unlikely to take says so plainly', () => {
  const v = reconcile({ ownIssues: [], headliner: null, pv: { ratio: 1.2, toThem: 3000, theirCost: 2500 }, mode: 'NEUTRAL', tg: 2500, tt: 2600, accept: 12, partnerName: 'bwit13' });
  eq(v.decision, 'counter'); eq(v.call, 'The value works on paper, but bwit13 is unlikely to take it (about 12%). Add a piece of the kind they value, or look elsewhere.');
  eq(reconcile({ ownIssues: [], headliner: null, pv: { ratio: 1.2 }, mode: 'NEUTRAL', tg: 2500, tt: 2600, accept: 40, partnerName: 'bwit13' }).decision, 'offer');
});
Deno.test('trade rules: vet cutoffs, listed cost, headliner holder, posture, appeal, one scale', () => {
  eq([isVet('QB', 27), isVet('QB', 32), isVet('RB', 27), isVet('WR', 28), isVet('WR', 29), isVet('TE', 29), isVet('TE', 26)], [false, true, true, false, true, true, false]);
  const henry = { kind: 'player', pid: 'henry', label: 'Derrick Henry', pos: 'RB', age: 32, value: 2096, peak_years_left: 0 };
  const unlisted = costToOwner(TL, 'REBUILDING', henry, false), listed = costToOwner(TL, 'REBUILDING', henry, true);
  ok(listed.cost < unlisted.cost && listed.cost < Math.round(2096 * 0.85), 'a listed vet costs his owner less');
  const young = { kind: 'player', pid: 'n', label: 'Young', pos: 'WR', age: 23, value: 6500 };
  ok(costToOwner(TL, 'REBUILDING', young, true).cost < costToOwner(TL, 'REBUILDING', young, false).cost); ok(costToOwner(TL, 'NEUTRAL', young, true).cost < 6500);
  const rule = { qb: true, firsts: 1, rule: 'x' }, target = { kind: 'player', value: 3574, pos: 'QB' };
  eq(headlinerMet(rule, target, [{ kind: 'pick', round: 1, holder: null, label: '2029 1st' }], 13).ok, false);
  eq(headlinerMet(rule, target, [{ kind: 'pick', round: 1, holder: '2', label: '2029 1st' }], 13).ok, false);
  eq(headlinerMet(rule, target, [{ kind: 'pick', round: 1, holder: '13', label: '2029 1st' }], 13).ok, true);
  const stub = (key: string) => ({ ...tctx, te: { ...App.TradeEngine, calcOwnerPosture: () => ({ key, label: key, desc: key }) } }) as Ctx;
  eq(postureFor(stub('DESPERATE'), { panic: 4 }, 'NONE', { mode: 'REBUILDING' }).key, 'SELLER');
  eq(postureFor(stub('DESPERATE'), { panic: 4 }, 'NONE', { mode: 'CONTENDING' }).key, 'DESPERATE');
  eq(postureFor(stub('BUYER'), { panic: 2, tier: 'CROSSROADS' }, 'NONE', { mode: 'NEUTRAL' }).key, 'NEUTRAL');
  eq(postureFor(stub('BUYER'), { panic: 2 }, 'NONE', { mode: 'CONTENDING' }).key, 'BUYER');
  const near = appealFor(TL, 'REBUILDING', { kind: 'pick', year: 2027 }).mult, next = appealFor(TL, 'REBUILDING', { kind: 'pick', year: 2028 }).mult, far = appealFor(TL, 'REBUILDING', { kind: 'pick', year: 2029 }).mult;
  ok(near > next && next > far);
  ok(appealFor(TL, 'REBUILDING', { kind: 'player', pos: 'QB', age: 38 }).mult <= 0.2); eq(appealFor(TL, 'REBUILDING', { kind: 'player', pos: 'QB', age: 27, peak_years_left: 5 }).mult, 1);
  eq(SCALE, { ELITE: 7000, STARTER: 4000, DEPTH: 2000 });
});

// ── Roster / waiver fixture (ask-tools-roster.test.js), roster 13, week 5 ─
const STARTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'SUPER_FLEX', 'K', 'DL', 'LB', 'DB', 'IDP_FLEX'];
const BENCH = ['hill', 'knight', 'davis', 'carr', 'donald', 'hendrickson', 'fitz', 'gsmith', 'vidal'];
const STARTERS = ['dak', 'jt', 'henry', 'pickens', 'adams', 'andrews', 'meyers', 'staff', 'santos', 'hemingway', 'oluokun', 'masses', 'lassiter'];
const RP = (n: string, pos: string, t: string | null, x: any = {}) => ({ n, pos, fp: [pos], t, age: x.age ?? null, yrs: x.years_exp ?? null, st: x.status || 'Active', inj: x.injury_status || null, injp: null, dc: null, dco: x.depth_chart_order ?? null, col: null, num: null, act: true });
const rosterPlayers: Record<string, any> = {
  dak: RP('Dak Prescott', 'QB', 'DAL', { depth_chart_order: 1, age: 33, years_exp: 10 }), staff: RP('Matthew Stafford', 'QB', 'LAR', { depth_chart_order: 1, age: 38, years_exp: 17 }),
  jt: RP('Jonathan Taylor', 'RB', 'IND', { depth_chart_order: 1, age: 27, years_exp: 7 }), henry: RP('Derrick Henry', 'RB', 'BAL', { depth_chart_order: 1, age: 32, years_exp: 10 }),
  pickens: RP('George Pickens', 'WR', 'DAL', { age: 25, years_exp: 4 }), adams: RP('Davante Adams', 'WR', 'LAR', { age: 33, years_exp: 12 }), meyers: RP('Jakobi Meyers', 'WR', 'JAX', { age: 29, years_exp: 7 }),
  andrews: RP('Mark Andrews', 'TE', 'BAL', { age: 31, years_exp: 8 }), santos: RP('Cairo Santos', 'K', 'CHI', { age: 34, years_exp: 12 }),
  hemingway: RP('Tonka Hemingway', 'DL', 'LV', { age: 24, years_exp: 2 }), oluokun: RP('Foyesade Oluokun', 'LB', 'JAX', { age: 31, years_exp: 8 }),
  masses: RP('Hezekiah Masses', 'DB', 'LV', { age: 22, years_exp: 1 }), lassiter: RP('Kamari Lassiter', 'DB', 'HOU', { age: 23, years_exp: 2 }),
  hill: RP('Justice Hill', 'RB', 'BAL', { depth_chart_order: 2, age: 28, years_exp: 7 }), knight: RP('Zonovan Knight', 'RB', 'ARI', { depth_chart_order: 3, age: 25, years_exp: 4 }),
  davis: RP('Isaiah Davis', 'RB', 'NYJ', { depth_chart_order: 2, age: 24, years_exp: 2 }), vidal: RP('Kimani Vidal', 'RB', 'LAC', { depth_chart_order: 3, age: 25, years_exp: 2 }),
  carr: RP('Derek Carr', 'QB', null, { age: 34, years_exp: 11, injury_status: 'NA' }), donald: RP('Aaron Donald', 'DL', 'LAR', { depth_chart_order: 1, age: 35, years_exp: 12 }),
  hendrickson: RP('Trey Hendrickson', 'DL', 'BAL', { depth_chart_order: 1, age: 31, years_exp: 9, injury_status: 'Out' }), fitz: RP('Ryan Fitzgerald', 'K', 'CAR', { age: 26, years_exp: 1 }),
  gsmith: RP('Genesis Smith', 'DB', 'LAC', { age: 21, years_exp: 0 }),
  garrett: RP('Myles Garrett', 'DL', 'LAR', { status: 'Inactive', injury_status: 'IR', age: 30, years_exp: 9, depth_chart_order: 1 }), conner: RP('James Conner', 'RB', 'ARI', { status: 'Inactive', injury_status: 'IR', age: 31, years_exp: 9, depth_chart_order: 4 }),
  levis: RP('Will Levis', 'QB', 'NYJ', { age: 27, years_exp: 3 }), wright: RP('Jacardia Wright', 'RB', 'SEA', { age: 26, years_exp: 1, injury_status: 'Out' }), ponds: RP("D'Angelo Ponds", 'DB', 'NYJ', { age: 21, years_exp: 0 }),
  anderson: RP('Will Anderson', 'DL', 'HOU', { age: 25 }), hutch: RP('Aidan Hutchinson', 'DL', 'DET', { age: 26 }), crosby: RP('Maxx Crosby', 'DL', 'LV', { age: 29 }), hunter: RP('Danielle Hunter', 'DL', 'HOU', { age: 31 }),
  bosa: RP('Nick Bosa', 'DL', 'SF', { age: 28 }), jha: RP('Josh Hines-Allen', 'DL', 'JAX', { age: 29 }), jones: RP('Aaron Jones', 'RB', 'MIN', { age: 31 }), kamara: RP('Alvin Kamara', 'RB', 'NO', { age: 31 }),
  montgomery: RP('David Montgomery', 'RB', 'HOU', { age: 29 }), mcgowan: RP('Seth McGowan', 'RB', 'IND', { depth_chart_order: 2, age: 23 }),
  parrish: RP('Jacob Parrish', 'DB', 'TB', { depth_chart_order: 1, age: 22, years_exp: 1 }), bennett: RP('Stetson Bennett', 'QB', 'LAR', { depth_chart_order: 2, age: 28, years_exp: 3 }),
  howell: RP('Sam Howell', 'QB', 'DAL', { depth_chart_order: 2, age: 26, years_exp: 4 }), hawes: RP('Hawes', 'TE', 'BUF', { age: 25, years_exp: 2 }), cle: RP('Cleveland Browns', 'DEF', 'CLE'),
  sneed: RP("L'Jarius Sneed", 'DB', 'TEN'), willlee: RP('Will Lee', 'DB', 'NYJ'), mccollum: RP('Zyon McCollum', 'DB', 'TB'), robertson: RP('Mike Robertson', 'DB', 'ARI'), oldclaim: RP('Offseason Guy', 'DB', 'MIA'),
};
const SC: Record<string, number> = {
  dak: 4012, staff: 2090, jt: 4285, henry: 2141, pickens: 2625, adams: 1528, meyers: 1452, andrews: 1364, santos: 484, hemingway: 1204, oluokun: 1307, masses: 2241, lassiter: 1416,
  hill: 318, knight: 100, davis: 62, vidal: 304, carr: 300, hendrickson: 799, fitz: 90, gsmith: 1299, garrett: 0, conner: 0, levis: 2039,
  anderson: 3811, hutch: 2194, crosby: 1673, hunter: 1426, bosa: 1782, jha: 1326, jones: 1070, kamara: 784, montgomery: 1362, parrish: 1252, bennett: 350, howell: 250, hawes: 269, cle: 500,
};
const M = (ppg: number, age: number, x: any = {}) => ({ ppg, age, statusCode: 'active', ...x });
const W = (pid: string, bid: number, leg: number, created: number, status = 'complete', rid = 2) => ({ type: 'waiver', status, leg, created, roster_ids: [rid], adds: { [pid]: rid }, settings: { waiver_bid: bid } });
const D = (m: number, d: number) => Date.UTC(2026, m - 1, d);
const TX: any[] = [];
for (let i = 0; i < 30; i++) TX.push(W(i % 2 ? 'oldclaim' : 'knight', 13, 1, D(4, 1 + i % 28)));
TX.push(W('oldclaim', 300, 1, D(8, 20)));
TX.push(W('sneed', 47, 2, D(9, 16)), W('willlee', 55, 3, D(9, 23)), W('mccollum', 65, 4, D(9, 30)), W('robertson', 101, 5, D(10, 7)));
for (let i = 0; i < 14; i++) TX.push(W('hawes', 20 + i * 5, 2 + (i % 4), D(9, 16 + i)));
TX.push(W('robertson', 90, 5, D(10, 7), 'failed', 13));
const me13 = { roster_id: 13, owner_id: 'me', co_owners: null, players: STARTERS.concat(BENCH, ['garrett', 'conner', 'levis', 'wright', 'ponds']), starters: STARTERS.slice(), reserve: ['garrett', 'conner'], taxi: ['levis', 'wright', 'ponds'], settings: { waiver_budget_used: 1297 } as Record<string, number>, metadata: { team_name: 'Dirty Mike' } };
const RL: LeagueRow = {
  league_id: '998', season: '2026', name: 'Psycho', built_at: '2026-10-10T00:00:00Z', engine_version: 'test',
  intel: {
    playerScores: SC,
    playerMeta: {
      garrett: M(15.7, 30, { statusCode: 'inactive', statusReason: 'Inactive', peakYrsLeft: 0 }), conner: M(8.7, 31, { statusCode: 'inactive', peakYrsLeft: 0 }),
      anderson: M(11.6, 25), hutch: M(8.6, 26), crosby: M(8.1, 29), hunter: M(7.4, 31), bosa: M(8.1, 28), jha: M(6.5, 29), hendrickson: M(4.3, 31, { peakYrsLeft: 0 }), hemingway: M(5.9, 24, { peakYrsLeft: 5 }),
      jones: M(9.4, 31), kamara: M(7.7, 31), montgomery: M(8.2, 29), henry: M(15.9, 32, { peakYrsLeft: 0 }), hill: M(3.4, 28, { peakYrsLeft: 0, trend: -43 }), jt: M(22, 27),
      knight: M(0.7, 25, { peakYrsLeft: 0, trend: -92 }), davis: M(0.4, 24, { peakYrsLeft: 1, trend: -92 }), vidal: M(4.7, 25, { peakYrsLeft: 0, trend: -54 }),
      fitz: M(10.6, 26, { peakYrsLeft: 9 }), carr: M(0, 34, { peakYrsLeft: 0 }), gsmith: M(7.5, 21, { peakYrsLeft: 6 }),
      parrish: M(13.5, 22, { peakYrsLeft: 6 }), bennett: M(1, 28, { peakYrsLeft: 2 }), howell: M(1, 26, { peakYrsLeft: 2 }), hawes: M(0.7, 25, { peakYrsLeft: 2 }),
    },
  },
  assessments: [{ rosterId: 13, tier: 'CONTENDER', window: 'CONTENDING', needs: [{ pos: 'TE', urgency: 'deficit' }, { pos: 'DB', urgency: 'thin' }], strengths: [] }],
  dna: {},
  snapshot: {
    league: { league_id: '998', roster_positions: STARTS.concat(BENCH.map(() => 'BN')), settings: { type: 2, waiver_budget: 3012, waiver_bid_min: 13, waiver_type: 2, reserve_slots: 10, reserve_allow_out: 0, reserve_allow_doubtful: 0, reserve_allow_na: 0, reserve_allow_sus: 0, reserve_allow_cov: 1, reserve_allow_dnr: 0, taxi_slots: 10, taxi_years: 3, taxi_deadline: 4, taxi_allow_vets: 1, playoff_week_start: 15 } },
    rosters: [me13, { roster_id: 2, owner_id: 'them', co_owners: null, players: ['anderson', 'hutch', 'crosby', 'hunter', 'bosa', 'jha', 'jones', 'kamara', 'montgomery', 'mcgowan'], starters: [], reserve: [], taxi: [], settings: { waiver_budget_used: 413 }, metadata: null }],
    users: [{ user_id: 'me', display_name: 'skjjcruz', avatar: null, team_name: 'Dirty Mike', team_avatar: null }, { user_id: 'them', display_name: 'Malibooch', avatar: null, team_name: null, team_avatar: null }],
    traded_picks: [], matchups: [], nfl_state: { week: 5, season: '2026' }, txns: TX, proj_week: 5,
    proj: { davis: 6.5, vidal: 5.7, hill: 5.6, donald: 4.2, parrish: 7, hawes: 0.7, jt: 22.4, henry: 22.3 },
  },
};
const rctx: Ctx = { memberId: 'me', leagues: [RL], loadLeague: async () => RL, players: rosterPlayers, nflState: { season: '2026', season_type: 'regular', week: 5, display_week: 5, season_start_date: '2026-09-09' }, trending: [], te: App.TradeEngine };
const rr = (n: string, a: any = {}) => runTool(rctx, n, { league_id: '998', ...a }) as Promise<any>;

Deno.test('roster: an Inactive (IR) player valued 0 gets a peer value, never 0', () => {
  const g = valueRead(rctx, RL, 'garrett');
  eq(g.value_source, 'ir_fallback'); eq(g.value, 1426); match(g.basis, /Maxx Crosby 1673/);
  const c = valueRead(rctx, RL, 'conner'); eq(c.value_source, 'ir_fallback'); eq(c.value, 1070);
  const d = valueRead(rctx, RL, 'donald'); eq(d.value_source, 'unscored'); eq(d.value, null);
  eq(valueRead(rctx, RL, 'knight'), { value: 100, value_source: 'dhq' });
});
Deno.test('roster_plan: full roster, Carr first, IR and taxi never cut, value gaps kept', async () => {
  const r = await rr('roster_plan');
  eq(r.roster_count, { active: 22, max: 22, open: 0, taxi: 3, taxi_max: 10, ir: 2, ir_max: 10 }); eq(r.decision, 'full'); match(r.recommendation, /Derek Carr/);
  const cuts = r.cut_candidates.map((c: any) => c.player);
  eq(cuts[0], 'Derek Carr');
  // Owner ruling: never cut the backup kicker (two kickers for bye weeks).
  ok(!cuts.includes('Ryan Fitzgerald'), 'backup K is never a cut');
  match(r.keep_despite_low_value.find((k: any) => k.player === 'Ryan Fitzgerald').reason, /Your backup kicker: you need 2 kickers to cover bye weeks/);
  eq(cuts.slice(1, 3), ['Zonovan Knight', 'Isaiah Davis']);   // then the low-upside RBs
  for (const never of ['Myles Garrett', 'James Conner', 'Aaron Donald', 'Will Levis', 'Jacardia Wright', "D'Angelo Ponds", 'Justice Hill', 'Genesis Smith', 'Trey Hendrickson', 'Dak Prescott', 'Cairo Santos']) ok(!cuts.includes(never), never + ' must not be a cut');
  const keep = Object.fromEntries(r.keep_despite_low_value.map((k: any) => [k.player, k]));
  eq(keep['Myles Garrett'].value_source, 'ir_fallback'); eq(keep['Myles Garrett'].value, 1426); match(keep['Myles Garrett'].reason, /IR stash/);
  match(keep['Justice Hill'].reason, /Handcuff.*Derrick Henry/); match(keep['Aaron Donald'].reason, /NFL role/);
  eq(keep['Genesis Smith'], undefined); match(cutPlan(rctx, RL, me13 as any).keep.find((k: any) => k.pid === 'gsmith')!.reason, /Young upside/);
  match(keep['Jacardia Wright'].reason, /taxi slot/);
});
Deno.test('roster_plan: OUT is not IR-eligible here; taxi deadline passed; taxi is not depth', async () => {
  const r = await rr('roster_plan');
  const hend = r.ir_moves.find((m: any) => m.player === 'Trey Hendrickson'); eq(hend.eligible, false); match(hend.why, /reserve_allow_out = 0/);
  ok(!r.ir_moves.some((m: any) => m.player === 'Myles Garrett'));
  const gs = r.taxi_moves.find((m: any) => m.player === 'Genesis Smith'); eq(gs.eligible, false); match(gs.why, /deadline was week 4/);
  eq(r.depth.RB.active_healthy, 6); ok(r.method.length > 50 && r.rules_applied.length >= 5);
});
Deno.test('roster_plan: IR-eligible bench player goes to IR first; an ineligible IR player must be activated', async () => {
  const saved = JSON.stringify({ players: me13.players, reserve: me13.reserve });
  rosterPlayers.etienne = RP('Travis Etienne', 'RB', 'NO', { injury_status: 'IR', age: 27 }); SC.etienne = 0;
  me13.players = me13.players.concat('etienne');
  try {
    let r = await rr('roster_plan');
    eq(r.decision, 'cut_now'); match(r.recommendation, /Travis Etienne to IR/); eq(r.ir_moves.find((m: any) => m.player === 'Travis Etienne').eligible, true);
    rosterPlayers.conner.inj = null;
    r = await rr('roster_plan');
    eq(r.decision, 'activate_from_ir'); match(r.recommendation, /James Conner/);
  } finally { rosterPlayers.conner.inj = 'IR'; Object.assign(me13, JSON.parse(saved)); delete rosterPlayers.etienne; delete SC.etienne; }
});
Deno.test('roster_plan: a bye week is not "projects 0" (season ppg instead); only a third kicker is a cut', async () => {
  // A third kicker (Santos starts, Lutz backs up): only now can Fitzgerald be a cut.
  const base = rctx.players, savedPlayers = me13.players;
  rctx.players = Object.assign({}, base, { lutz: RP('Wil Lutz', 'K', 'DEN', { age: 31, years_exp: 10 }) });
  SC.lutz = 400; me13.players = me13.players.concat('lutz');
  const teams = ['DAL', 'LAR', 'IND', 'BAL', 'JAX', 'CHI', 'LV', 'HOU', 'NYJ', 'ARI', 'LAC', 'TB', 'BUF', 'CLE', 'TEN', 'MIA', 'DET', 'SF', 'MIN', 'NO', 'SEA', 'WAS', 'NYG', 'GB', 'PHI', 'DEN', 'KC', 'ATL', 'PIT', 'CIN'];   // CAR not playing: a bye
  rctx.nflWeek = { week: 5, games: Object.fromEntries(teams.map(t => [t, { opp: 'X', date: null }])) };
  try {
    const r = await rr('roster_plan');
    const fitz = r.cut_candidates.find((c: any) => c.player === 'Ryan Fitzgerald');
    match(fitz.why, /on bye this week \(averages 10\.6 a game\)/); match(fitz.why, /a third kicker: you only need 2/);
    ok(!/projects 0/.test(fitz.why)); eq(fitz.keep_score, 90 + Math.round(10.6 * 50));
    const cuts = r.cut_candidates.map((c: any) => c.player);
    ok(cuts.indexOf('Ryan Fitzgerald') > cuts.indexOf('Isaiah Davis'), cuts.join(', '));
  } finally { delete (rctx as any).nflWeek; rctx.players = base; me13.players = savedPlayers; delete SC.lutz; }
});
Deno.test('roster_plan: reads DHQ\'s weekly projection (median) when the build stored it', async () => {
  (RL.snapshot as any).dhq_proj = { week: 5, players: { davis: { mean: 0.5, median: 0.4, floor: 0.3, ceiling: 0.7 }, knight: { mean: 0, median: 0, floor: 0, ceiling: 0, no_line: true } } };
  try {
    const r = await rr('roster_plan');
    const davis = r.cut_candidates.find((c: any) => c.player === 'Isaiah Davis');
    eq(davis.keep_score, 62 + Math.round(0.4 * 50)); match(davis.why, /projects 0\.4 this week/);
    const cuts = r.cut_candidates.map((c: any) => c.player);
    ok(cuts.indexOf('Isaiah Davis') < cuts.indexOf('Zonovan Knight'), cuts.join(', '));
  } finally { delete (RL.snapshot as any).dhq_proj; }
});
// Owner ruling 2026-10-10: "Davis is a keeper, Breece Hall is out this week, he's up as an RB2."
Deno.test('roster_plan: next man up is never a cut (Breece Hall out, Isaiah Davis moves up)', async () => {
  // As Sleeper lists it live: the injured starter drops to depth 5, Allen is 1, Davis 2.
  const base = rctx.players;
  rctx.players = Object.assign({}, base, {
    breece: RP('Breece Hall', 'RB', 'NYJ', { depth_chart_order: 5, age: 25, injury_status: 'Out' }),
    allen: RP('Braelon Allen', 'RB', 'NYJ', { depth_chart_order: 1, age: 22 }),
  });   // new object: the depth index rebuilds
  SC.breece = 3900;
  try {
    const r = await rr('roster_plan');
    ok(!r.cut_candidates.some((c: any) => c.player === 'Isaiah Davis'), 'Davis must not be a cut');
    const k = r.keep_despite_low_value.find((x: any) => x.player === 'Isaiah Davis');
    ok(k, JSON.stringify(r.keep_despite_low_value.map((x: any) => x.player)));
    match(k.reason, /Next man up: Breece Hall \(Out\) is out, so he moves up to NYJ RB2/);
    // A lesser injured teammate below him on the chart does not count.
    SC.breece = 40;
    const r2 = await rr('roster_plan');
    ok(r2.cut_candidates.some((c: any) => c.player === 'Isaiah Davis'), 'a 40-value teammate at depth 5 is not "above" him');
  } finally { rctx.players = base; delete SC.breece; }
});
Deno.test('get_waiver_plan: every add paired with an active-roster drop; handcuffs; TE is a trade', async () => {
  const r = await rr('get_waiver_plan');
  eq(r.decision, 'add');
  const names = r.adds.map((x: any) => x.player.name);
  ok(names.includes('Sam Howell') && names.includes('Stetson Bennett') && names.includes('Jacob Parrish'), names.join(','));
  ok(!names.includes('Cleveland Browns'), 'no DEF slot');
  const active = new Set(BENCH.map(p => rosterPlayers[p].n)); const used = new Set();
  r.adds.forEach((x: any) => { ok(x.drop && x.drop.player, x.player.name + ' has no drop'); ok(active.has(x.drop.player), x.drop.player + ' is not an active bench player'); ok(!used.has(x.drop.player), 'drop reused'); used.add(x.drop.player); ok(x.drop.value_source !== 'ir_fallback'); });
  eq(r.adds.find((x: any) => x.player.name === 'Sam Howell').drop.player, 'Derek Carr'); ok(r.adds.find((x: any) => x.player.name === 'Stetson Bennett').handcuff);
  for (const never of ['Justice Hill', 'Aaron Donald', 'Genesis Smith', 'Trey Hendrickson', 'Myles Garrett', 'Will Levis']) ok(!used.has(never), never);
  ok(r.do_not_add.some((d: any) => /TE is a deficit.*trade/.test(d.why))); ok(r.evidence.some((e: string) => /Jonathan Taylor's backup Seth McGowan is on .*trade/.test(e)));
  match(r.recommendation, /^Claim .* and drop /);
});
Deno.test('get_waiver_plan: bids from in-season comps only, within the pace cap', async () => {
  const r = await rr('get_waiver_plan');
  eq([r.faab.left, r.faab.min_bid, r.faab.weeks_left, r.faab.per_week, r.faab.max_single_bid], [1715, 13, 9, 191, 286]);
  const par = r.adds.find((x: any) => x.player.name === 'Jacob Parrish');
  ok(!par.bid.comps.map((c: any) => c.player).includes('Offseason Guy'), 'offseason claims excluded');
  eq(par.bid.comps.map((c: any) => c.bid), [101, 65, 55, 47]);
  ok(par.bid.open >= 13 && par.bid.open <= par.bid.max && par.bid.max <= 286); ok(par.bid.max >= 60, 'max reaches the position median of in-season wins (' + par.bid.max + ')');
  eq(r.adds.find((x: any) => x.player.name === 'Stetson Bennett').bid.open, 13);
  ok(r.evidence.some((e: string) => /31 offseason claims left out/.test(e)));
});
Deno.test('get_waiver_plan: DEF filtered when the league has no DEF slot; an open spot means no drop', async () => {
  const def = await rr('get_waiver_plan', { position: 'DEF' });
  eq(def.decision, 'no_slot'); eq(def.adds.length, 0);
  const rp = RL.snapshot.league.roster_positions as string[];
  rp.push('BN');
  try {
    const r = await rr('get_waiver_plan', { position: 'DB' });
    eq(r.adds[0].player.name, 'Jacob Parrish'); eq(r.adds[0].drop.player, null); match(r.adds[0].drop.why, /open active spot/);
  } finally { rp.pop(); }
});
Deno.test('get_waiver_bid: offseason claims are excluded from the bid history', async () => {
  const r = await rr('get_waiver_bid', { player: 'Jacob Parrish' });
  eq(r.in_season_bids.offseason_claims_excluded, 31); eq(r.in_season_bids.count, 19); eq(r.in_season_bids.since, '2026-09-09');
  eq(r.recent_winning_bids_at_position.map((c: any) => c.player), ['Mike Robertson', 'Zyon McCollum', 'Will Lee', "L'Jarius Sneed"]);
  match(r.based_on, /in-season/);
});
Deno.test('free-agent lists only show positions this league can start', async () => {
  const s = await rr('search_players', { position: 'DEF', availability: 'free_agents' });
  eq(s.matches, 0); match(s.note, /no DEF slot/);
  const fa = await rr('search_players', { availability: 'free_agents', limit: 40 });
  ok(!fa.players.some((p: any) => p.pos === 'DEF'), fa.players.map((p: any) => p.pos).join(','));
  const w = await rr('get_waiver_options', { position: 'DEF' });
  eq(w.best_available.length, 0); match(w.note, /no DEF slot/);
  const all = await rr('search_players', { sort: 'value', limit: 40 });
  ok(all.players.some((p: any) => p.pos === 'DEF'), 'league-wide rankings still list everyone');
});
Deno.test('bid model gets normalised positions: raw CB/S/DE rivals bid the same as DB/DL ones', async () => {
  // The model counts a rival's healthy players at the position through
  // App.normPos, which the edge function does not define; raw Sleeper
  // positions made every rival look empty at DB and inflated the bid.
  const before = await rr('get_waiver_bid', { player: 'Jacob Parrish' });
  const raw: Record<string, string> = { anderson: 'DE', hutch: 'DE', crosby: 'DE', hunter: 'DE', bosa: 'DE', jha: 'DE', masses: 'CB', lassiter: 'S', gsmith: 'S', sneed: 'CB' };
  const saved = Object.fromEntries(Object.keys(raw).map(k => [k, rosterPlayers[k].pos]));
  Object.entries(raw).forEach(([k, v]) => { rosterPlayers[k].pos = v; });
  try {
    eq(faabInputs(rctx, RL, me13 as any).playersData.masses.position, 'DB');
    const after = await rr('get_waiver_bid', { player: 'Jacob Parrish' });
    eq([after.suggested_bid, after.range, after.rivals.map((r: any) => r.need)], [before.suggested_bid, before.range, before.rivals.map((r: any) => r.need)]);
  } finally { Object.entries(saved).forEach(([k, v]) => { rosterPlayers[k].pos = v; }); }
});
Deno.test({ name: 'restore fetch', fn: () => { globalThis.fetch = realFetch; } });
