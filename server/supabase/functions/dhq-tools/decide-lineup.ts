// dhq-tools/decide-lineup.ts — the start/sit decision, shared by get_start_sit.
//
// Ported from the Lab (v6-hub js/shared/startsit-engine.js exact pass and
// js/shared/ask-tools.js startSitCall, 2026-10-10). Two parts:
//
//   solveLineup   the app's greedy solver (vendored StartSit, narrowest slot
//                 first), then an exact max-weight assignment (Hungarian). A
//                 player listed at two positions (an edge rusher Sleeper
//                 lists DL and LB) breaks the greedy: with slots DL, LB and
//                 X (DL/LB, 10), Y (DL, 9), Z (LB, 1) it scored 11 where Y at
//                 DL and X at LB makes 19. The exact answer replaces the
//                 greedy one only when it fills more slots or scores more, so
//                 every lineup the greedy already got right is unchanged.
//                 Results are keyed by slot INDEX, so two slots of the same
//                 kind never get mixed up.
//   startSitCall  pure: turns the solved lineup into the call — changes with
//                 their gain, coin flips (within 1.5 pts or 10%) with the
//                 tiebreak, who must not start and why (the zero reason),
//                 Questionable starters in late games with a pivot, the
//                 head-to-head between named players, and a confidence.
//
// The number is DHQ's weekly projection (its average week) in this league's
// scoring, the Lab's number; when the build stored none, floor/ceiling and a
// win chance are missing, so a coin flip keeps the higher projection.
// deno-lint-ignore-file no-explicit-any

// ── Exact assignment ─────────────────────────────────────────────────────
// Min-cost assignment, n rows ≤ m columns; returns row → column. Same
// routine as the Lab's dhq-proj.js `hungarian`.
export function hungarian(a: number[][]): number[] {
  const n = a.length, m = n ? a[0].length : 0, INF = 1e18;
  const u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0), p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i; let j0 = 0;
    const minv = new Array(m + 1).fill(INF), used = new Array(m + 1).fill(false);
    do {
      used[j0] = true; const i0 = p[j0]; let delta = INF, j1 = 0;
      for (let j = 1; j <= m; j++) if (!used[j]) {
        const cur = a[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) { if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta; }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const out = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) out[p[j] - 1] = j - 1;
  return out;
}

export type SolvePlayer = { pid: string; pos: string; positions?: string[]; pts: number };
export type OpenSlot = { idx: number; slot: string };
export type Solved = { placed: Record<number, string>; total: number; filled: number; exact: boolean };

// SS = the vendored StartSit engine (normSlot, FLEX_ALLOWED, BASE_POSITIONS,
// optimalLineupWeekly). `open` are the slots still to fill, by index into
// the league's starting slots.
export function solveLineup(SS: any, players: SolvePlayer[], open: OpenSlot[]): Solved {
  const norm = (s: string) => String(SS.normSlot(s));
  const pool = (players || []).filter(p => p && Number.isFinite(p.pts)).map(p => {
    const pos = String(p.pos || '').toUpperCase();
    return { pid: String(p.pid), pos, pts: Number(p.pts), positions: [...new Set([pos].concat((p.positions || []).map(x => String(x || '').toUpperCase())).filter(Boolean))] };
  }).sort((a, b) => b.pts - a.pts);
  // 1. The app's greedy, mapped back onto slot indexes by slot kind.
  const greedy = SS.optimalLineupWeekly(pool.map(p => ({ ...p, available: true })), open.map(o => o.slot)) as { total: number; slots: Array<{ slot: string; pid: string | null }> };
  const gPlaced: Record<number, string> = {};
  const taken = new Set<number>();
  for (const s of greedy.slots || []) {
    const o = open.find(x => !taken.has(x.idx) && norm(x.slot) === String(s.slot));
    if (!o) continue;
    taken.add(o.idx);
    if (s.pid) gPlaced[o.idx] = String(s.pid);
  }
  const ptsOf = new Map(pool.map(p => [p.pid, p.pts]));
  const sumOf = (pl: Record<number, string>) => Object.values(pl).reduce((t, pid) => t + (ptsOf.get(pid) || 0), 0);
  const gTotal = sumOf(gPlaced), gFilled = Object.keys(gPlaced).length;
  // 2. Exact pass: rows = slots, columns = players + one "leave it empty"
  // column per slot. An empty slot costs far more than any points gap
  // (fill every slot that can be filled first); an ineligible player costs more still.
  const slots = open.map(o => { const s = norm(o.slot); const elig = SS.FLEX_ALLOWED[s] || (SS.BASE_POSITIONS.has(s) ? [s] : null); return elig ? { idx: o.idx, elig: elig as string[] } : null; }).filter(Boolean) as Array<{ idx: number; elig: string[] }>;
  const fits = (p: { positions: string[] }, sl: { elig: string[] }) => p.positions.some(x => sl.elig.includes(x));
  if (slots.length && pool.length) {
    const EMPTY = 1e6, NO = 1e9;
    const cost = slots.map(sl => pool.map(p => (fits(p, sl) ? -p.pts : NO)).concat(slots.map(() => EMPTY)));
    let pick: number[] | null = null;
    try { pick = hungarian(cost); } catch { pick = null; }
    if (Array.isArray(pick) && pick.length === slots.length) {
      const xPlaced: Record<number, string> = {}; const used = new Set<string>();
      let ok = true;
      slots.forEach((sl, i) => {
        const c = pick![i];
        const p = c >= 0 && c < pool.length ? pool[c] : null;
        if (c < 0 || (p && (!fits(p, sl) || used.has(p.pid)))) { ok = false; return; }
        if (p) { used.add(p.pid); xPlaced[sl.idx] = p.pid; }
      });
      const xTotal = sumOf(xPlaced), xFilled = Object.keys(xPlaced).length;
      if (ok && (xFilled > gFilled || (xFilled === gFilled && xTotal > gTotal + 1e-9))) return { placed: xPlaced, total: Math.round(xTotal * 10) / 10, filled: xFilled, exact: true };
    }
  }
  return { placed: gPlaced, total: Math.round(gTotal * 10) / 10, filled: gFilled, exact: false };
}

// ── The call ─────────────────────────────────────────────────────────────
export const CLOSE_PTS = 1.5;      // within this, or …
export const CLOSE_PCT = 0.10;     // … within 10% of the better player, it's a coin flip
const FAVORED_PCT = 55, UNDERDOG_PCT = 45;
const LATE_SHARE = 0.5;            // a late game: at least half the week's remaining games kick off before it
export const HARD_NO = new Set(['out', 'doubtful', 'bye', 'IR', 'PUP', 'suspended', 'not active (NA)', 'NFI', 'COVID list', 'did not report', 'no NFL team']);
export const TAG_REASON: Record<string, string> = { OUT: 'out', DOUBTFUL: 'doubtful', D: 'doubtful', IR: 'IR', 'INJURED RESERVE': 'IR', PUP: 'PUP', SUS: 'suspended', SUSPENDED: 'suspended', NA: 'not active (NA)', NFI: 'NFI', COV: 'COVID list', DNR: 'did not report' };
const r1 = (n: unknown) => Math.round(Number(n || 0) * 10) / 10;
const f1 = (n: unknown) => (n == null || !isFinite(Number(n)) ? '?' : (Math.round(Number(n) * 10) / 10).toFixed(1));
const isQ = (tag: unknown) => /^(Q|QUESTIONABLE)$/i.test(String(tag || '').trim());
function tiebreakFor(winPct: number | null | undefined, statWord: string) {
  if (winPct == null || !isFinite(winPct)) return { stat: 'proj', why: 'no win chance available: keep the higher ' + statWord };
  if (winPct >= FAVORED_PCT) return { stat: 'floor', why: 'you are favored (' + Math.round(winPct) + '% to win): take the higher floor' };
  if (winPct <= UNDERDOG_PCT) return { stat: 'ceiling', why: 'you are the underdog (' + Math.round(winPct) + '% to win): take the higher ceiling' };
  return { stat: 'proj', why: 'even game (' + Math.round(winPct) + '% to win): keep the higher ' + statWord };
}
// facts: { week, slots:[{idx,slotName,elig}], current:{idx:pid}, placed:{idx:pid},
//   current_total, best_total, locks_loaded, sleeper_loaded, win_pct,
//   players:{ pid: { name, positions[], proj, floor, ceiling, locked, kick,
//     injury_status, zero_reason, why, roster_slot } }, asked:[pid], not_found:[name],
//   game_kicks:[ms] (kickoff of each game this week not started yet),
//   stat_word (what proj is, e.g. 'projection'), source_note (one evidence line) }
export function startSitCall(facts: any) {
  const F = facts || {}, P = F.players || {};
  const statWord = String(F.stat_word || 'projection');
  const slots = F.slots || [], current = F.current || {}, placed = F.placed || {};
  const nm = (pid: string) => (P[pid] && P[pid].name) || String(pid);
  const pj = (pid: string) => (P[pid] && P[pid].proj != null ? Number(P[pid].proj) : 0);
  const slotName = (k: string) => { const s = slots.find((x: any) => String(x.idx) === String(k)); return s ? s.slotName : ''; };
  const slotElig = (k: string) => { const s = slots.find((x: any) => String(x.idx) === String(k)); return s ? s.elig : []; };
  const fitsSlot = (pid: string, k: string) => ((P[pid] && P[pid].positions) || []).some((q: string) => slotElig(k).includes(q));
  const tb = tiebreakFor(F.win_pct, statWord);
  const rules: string[] = [];
  const locked = Object.keys(P).filter(pid => P[pid].locked && P[pid].roster_slot !== 'not on roster');

  // 1. Pair each player coming in with the one going out of that slot,
  //    following any starter who only moves slots.
  const curPids = Object.values(current).map(String);
  const best = new Set(Object.values(placed).map(String));
  const out = curPids.filter(pid => !best.has(pid));
  const slotOfBest: Record<string, string> = {}; Object.keys(placed).forEach(k => { slotOfBest[String(placed[k])] = k; });
  const taken = new Set<string>();
  const changes: Array<{ start: string; sit: string | null; slot: string }> = [];
  Object.keys(placed).sort((x, y) => Number(x) - Number(y)).forEach(k => {
    const start = String(placed[k]);
    if (curPids.includes(start)) return;
    let x: string | null = current[k] ? String(current[k]) : null; const seen = new Set([String(k)]);
    while (x && best.has(x)) { const k2 = slotOfBest[x]; if (k2 == null || seen.has(String(k2))) { x = null; break; } seen.add(String(k2)); x = current[k2] ? String(current[k2]) : null; }
    let sit = x && out.includes(x) && !taken.has(x) ? x : null;
    if (!sit) sit = out.find(pid => !taken.has(pid) && fitsSlot(pid, k)) || out.find(pid => !taken.has(pid)) || null;
    if (sit) taken.add(sit);
    changes.push({ start, sit, slot: slotName(k) });
  });
  // Never move a locked player (the solver already pins them; this is the guard).
  const safe = changes.filter(c => !(P[c.start] && P[c.start].locked) && !(c.sit && P[c.sit] && P[c.sit].locked));
  if (locked.length) rules.push('Locked (game started) stay put and count actual points: ' + locked.map(nm).join(', ') + '.');

  // 2. Each change: gain, close call, why.
  const rows = safe.map(c => {
    const a = P[c.start] || {}, b = c.sit ? (P[c.sit] || {}) : null;
    const gain = pj(c.start) - (b ? pj(c.sit!) : 0);
    const top = Math.max(pj(c.start), b ? pj(c.sit!) : 0);
    const close = !!b && !(b.zero_reason && HARD_NO.has(b.zero_reason)) && (gain < CLOSE_PTS || gain < CLOSE_PCT * top);
    const bits = [nm(c.start) + ' ' + f1(pj(c.start)) + (b ? ' vs ' + nm(c.sit!) + ' ' + f1(pj(c.sit!)) : ' into an empty slot') + ' (' + statWord + ')'];
    if (b && b.zero_reason) bits.push(nm(c.sit!) + ': ' + b.zero_reason);
    if (a.injury_status) bits.push(nm(c.start) + ' is ' + a.injury_status);
    if (b && b.injury_status && !b.zero_reason) bits.push(nm(c.sit!) + ' is ' + b.injury_status);
    if (a.why) bits.push(nm(c.start) + ': ' + a.why);
    const row: Record<string, any> = { start: nm(c.start), sit: b ? nm(c.sit!) : null, slot: c.slot, gain_pts: r1(gain), close_call: close, why: bits.join('; '), _start: c.start, _sit: c.sit };
    if (close) {
      const s = tb.stat, va = s === 'proj' ? pj(c.start) : Number(a[s]), vb = s === 'proj' ? pj(c.sit!) : Number(b![s]);
      const keep = isFinite(va) && isFinite(vb) && vb > va;
      row.lean = keep ? nm(c.sit!) : nm(c.start);
      row.tiebreak = tb.why + (s !== 'proj' && isFinite(va) && isFinite(vb) ? ' (' + s + ' ' + f1(va) + ' vs ' + f1(vb) + ')' : '');
    }
    return row;
  });
  const close_calls = rows.filter(r => r.close_call).map(r => ({ start: r.start, sit: r.sit, slot: r.slot, gain_pts: r.gain_pts, call: 'coin flip', lean: r.lean, tiebreak: r.tiebreak }));
  if (close_calls.length) rules.push('Coin flip when within ' + CLOSE_PTS + ' pts or ' + Math.round(CLOSE_PCT * 100) + '%: ' + tb.why + '.');

  // 3. Who must not start.
  const hard: Array<{ player: string; reason: string }> = [], seenDNS = new Set<string>();
  Object.keys(P).forEach(pid => {
    const x = P[pid];
    if (x.roster_slot === 'not on roster') return;
    const askedHim = (F.asked || []).includes(pid);
    if ((x.roster_slot === 'IR' || x.roster_slot === 'taxi') && !askedHim) return;
    // Owner test 2026-10-10: "bench Derek Carr and Trey Hendrickson" when they
    // were already benched. Only a current starter (or a player the member
    // asked about) belongs on the do-not-start list.
    if (x.roster_slot !== 'starter' && !askedHim) return;
    let reason: string | null = null;
    if (x.locked && x.roster_slot !== 'starter') reason = 'locked: his game has started, he can\'t come off the bench';
    else if (!x.locked && (x.roster_slot === 'IR' || x.roster_slot === 'taxi')) reason = x.roster_slot === 'IR' ? 'on your IR slot' : 'on your taxi squad';
    else if (x.zero_reason && (HARD_NO.has(x.zero_reason) || x.roster_slot === 'starter' || askedHim)) reason = x.zero_reason;
    if (reason && !seenDNS.has(pid)) { seenDNS.add(pid); hard.push({ player: nm(pid), reason }); }
  });
  if (hard.length) rules.push('Never start a player who is out, doubtful, on bye, on IR/taxi, or already locked on the bench.');

  // 4. Questionable starters: late game? Is there a pivot that plays later?
  // Late = at least half of this week's remaining games kick off before his:
  // his inactive news lands after most other options have locked. Falls
  // back to the member's own players' games.
  let kicks = (F.game_kicks || []).map(Number).filter((k: number) => k > 0);
  if (!kicks.length) kicks = Object.keys(P).filter(pid => P[pid].roster_slot !== 'not on roster' && !P[pid].locked && Number(P[pid].kick) > 0).map(pid => Number(P[pid].kick));
  const questionable: Array<Record<string, unknown>> = [];
  Object.keys(placed).forEach(k => {
    const pid = String(placed[k]), x = P[pid];
    if (!x || x.locked || !isQ(x.injury_status)) return;
    const kick = Number(x.kick) || null;
    const late = kick && kicks.length ? kicks.filter((t: number) => t < kick).length / kicks.length >= LATE_SHARE : null;
    // Any active player not in the best lineup (a starter being benched counts).
    const pool = Object.keys(P).filter(q => !best.has(q) && (P[q].roster_slot === 'bench' || P[q].roster_slot === 'starter') && !P[q].locked && pj(q) > 0 && !(P[q].zero_reason) && !isQ(P[q].injury_status) && fitsSlot(q, k))
      .sort((m, n) => pj(n) - pj(m));
    const later = kick ? pool.filter(q => Number(P[q].kick) >= kick) : [];
    const piv = later[0] || pool[0] || null;
    const pivLater = !!(piv && kick && Number(P[piv].kick) >= kick);
    let note: string;
    if (!piv) note = 'No healthy bench player fits his slot.';
    else if (late === true && !pivLater) note = 'Nobody on the bench who fits his slot plays as late: if he is ruled out about 90 minutes before kickoff, you cannot swap. Best fallback is ' + nm(piv) + ' (' + f1(pj(piv)) + '), whose game starts earlier; decide before it does.';
    else if (pivLater) note = 'Start him; if he is inactive, swap in ' + nm(piv) + ' (plays in the same or a later game).';
    else note = 'If he is ruled out before ' + nm(piv) + '\'s game locks, swap in ' + nm(piv) + '.';
    questionable.push({ player: nm(pid), status: x.injury_status, slot: slotName(k), late_game: late, pivot: piv ? nm(piv) : null, pivot_proj: piv ? r1(pj(piv)) : null, pivot_plays_later: pivLater, note });
  });
  if (questionable.length) rules.push('Questionable starter in a late game: start him only with a pivot who plays the same or a later game.');

  // 5. Players the member named.
  let asked: Array<Record<string, unknown>> | null = null, h2h: Record<string, any> | null = null;
  if ((F.asked || []).length) {
    asked = F.asked.map((pid: string) => {
      const x = P[pid] || {};
      let verdict: string;
      if (x.roster_slot === 'not on roster') verdict = 'not on your roster';
      else if (x.locked) verdict = 'locked: his game has started' + (x.roster_slot === 'starter' ? ' (stays in)' : ' (stays on the bench)');
      else if (x.roster_slot === 'IR' || x.roster_slot === 'taxi') verdict = 'can\'t start: on your ' + x.roster_slot;
      else if (x.zero_reason && !(x.proj > 0)) verdict = 'don\'t start: ' + x.zero_reason;
      else verdict = best.has(pid) ? 'start' : 'sit';
      return { player: nm(pid), verdict, proj: x.proj != null ? r1(x.proj) : null, floor: x.floor != null ? r1(x.floor) : null, ceiling: x.ceiling != null ? r1(x.ceiling) : null, injury: x.injury_status || null, locked: !!x.locked };
    });
    const open = F.asked.filter((pid: string) => P[pid] && !P[pid].locked && P[pid].roster_slot !== 'not on roster' && P[pid].roster_slot !== 'IR' && P[pid].roster_slot !== 'taxi' && pj(pid) > 0).sort((m: string, n: string) => pj(n) - pj(m));
    if (open.length >= 2) {
      const [a1, b1] = open, gap = pj(a1) - pj(b1);
      const close = gap < CLOSE_PTS || gap < CLOSE_PCT * pj(a1);
      h2h = { pick: nm(a1), over: nm(b1), gap_pts: r1(gap), close_call: close };
      if (close) {
        const s = tb.stat, va = s === 'proj' ? pj(a1) : Number(P[a1][s]), vb = s === 'proj' ? pj(b1) : Number(P[b1][s]);
        if (isFinite(va) && isFinite(vb) && vb > va) { h2h.pick = nm(b1); h2h.over = nm(a1); }
        h2h.call = 'coin flip';
        h2h.tiebreak = tb.why + (s !== 'proj' && isFinite(va) && isFinite(vb) ? ' (' + s + ' ' + nm(a1) + ' ' + f1(va) + ', ' + nm(b1) + ' ' + f1(vb) + ')' : '');
      }
      const tags = [a1, b1].filter((pid: string) => P[pid].injury_status).map((pid: string) => nm(pid) + ' is ' + P[pid].injury_status);
      if (tags.length) h2h.injury_note = tags.join('; ');
    }
  }

  // 6. The call.
  const decision = rows.map(r => {
    if (r.close_call && r.lean === r.sit) return 'Keep ' + r.sit + ' over ' + r.start + (r.slot ? ' at ' + r.slot.replace(/_/g, ' ') : '') + ' (coin flip, ' + r.gain_pts + ' pts apart; tiebreak keeps him)';
    return (r.sit ? 'Start ' + r.start + ' over ' + r.sit : 'Start ' + r.start + ' in the empty slot') + (r.slot ? ' at ' + r.slot.replace(/_/g, ' ') : '') + (r.close_call ? ' (coin flip, +' + r.gain_pts + ')' : ' (+' + r.gain_pts + ' pts)');
  });
  const gainAll = r1(rows.filter(r => !(r.close_call && r.lean === r.sit)).reduce((t, r) => t + (Number(r.gain_pts) || 0), 0));
  let recommendation: string;
  if (h2h) recommendation = 'Start ' + h2h.pick + ' over ' + h2h.over + (h2h.close_call ? ': a coin flip (' + h2h.gap_pts + ' pts apart), ' + h2h.tiebreak : ' (+' + h2h.gap_pts + ' pts)') + (h2h.injury_note ? '; ' + h2h.injury_note : '') + '.';
  else if (!rows.length) recommendation = 'Your lineup is already set right: start who is in.';
  else if (rows.length === 1) recommendation = decision[0] + '.';
  else if (rows.length <= 3) recommendation = 'Make ' + rows.length + ' changes: ' + decision.map(s => s.replace(/ \(.*\)$/, '')).join('; ') + ' (+' + gainAll + ' pts in all).';
  else recommendation = 'Make ' + rows.length + ' changes worth +' + gainAll + ' pts, led by: ' + decision[0].replace(/ \(.*\)$/, '') + '.';

  let confidence = 'high';
  if (close_calls.length || (h2h && h2h.close_call) || questionable.some(q => q.late_game && !q.pivot_plays_later)) confidence = 'medium';
  if (!F.locks_loaded || F.sleeper_loaded === false) confidence = 'low';

  const evidence = [
    'Current lineup ' + f1(F.current_total) + ' vs best ' + f1(F.best_total) + ' (' + (F.source_note || statWord + ', this league\'s scoring') + (locked.length ? '; locked players at actual points' : '') + ').',
  ];
  if (F.win_pct != null) evidence.push('Win chance with the best lineup: ' + Math.round(F.win_pct) + '%.');
  evidence.push(F.locks_loaded ? 'Game locks checked: ' + locked.length + ' of your players\' games have started.' : 'Game locks NOT loaded: could not confirm whose game has started.');
  if (F.sleeper_loaded === false) evidence.push('This week\'s projections are not loaded yet, so there is no projection to rank on.');
  rules.unshift('Ranked by ' + (F.source_note || statWord + ' in this league\'s scoring') + ', never by dynasty value.');
  if ((F.not_found || []).length) evidence.push('No player found for: ' + F.not_found.join(', ') + '.');

  const optimal_lineup = Object.keys(placed).sort((x, y) => Number(x) - Number(y)).map(k => {
    const pid = String(placed[k]), x = P[pid] || {};
    return { slot: slotName(k), player: nm(pid), proj: x.proj != null ? r1(x.proj) : null, floor: x.locked ? r1(x.proj) : (x.floor != null ? r1(x.floor) : null), ceiling: x.locked ? r1(x.proj) : (x.ceiling != null ? r1(x.ceiling) : null), locked: !!x.locked };
  });
  const res: Record<string, any> = { week: F.week, decision, confidence, recommendation, optimal_lineup, changes: rows.map(({ _start: _a, _sit: _b, ...rest }) => rest), close_calls, do_not_start: hard, questionable, evidence, rules_applied: rules, locks_loaded: !!F.locks_loaded };
  if (asked) res.asked = asked;
  if (h2h) res.head_to_head = h2h;
  if (!F.locks_loaded) res.warning = 'Could not confirm which games have started: say so, and do not promise that any player named here can still be moved.';
  return res;
}
