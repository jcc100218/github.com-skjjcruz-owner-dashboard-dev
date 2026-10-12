// The question bank: real questions members ask, each with the facts a good
// answer must contain. Runs the tools over the builder's dry-run output and
// fails the deploy when a required fact is missing. Add a question every
// time an answer goes wrong, so the same mistake cannot ship twice.
//
//   LEAGUES=1312100327931019264 node server/engine/run.js --dry
//   deno run --allow-read --allow-env --allow-net server/supabase/functions/dhq-tools/question-bank.ts
import './vendor/trade-engine.js';
import './vendor/startsit-engine.js';
import './vendor/faab-engine.js';
import { runTool, type Ctx, type LeagueRow } from './tools.ts';

const OUT = new URL('../../../engine/out/', import.meta.url);
const rd = (n: string) => { try { return JSON.parse(Deno.readTextFileSync(new URL(n, OUT))); } catch { return undefined; } };
const files = [...Deno.readDirSync(OUT)].map(e => e.name).filter(n => /^\d+\.json$/.test(n));
if (!files.length) { console.error('no dry-run output in server/engine/out'); Deno.exit(1); }
const rows: LeagueRow[] = files.map(n => JSON.parse(Deno.readTextFileSync(new URL(n, OUT))));
const memberId = Deno.env.get('MEMBER') || '540392203863576576';
// deno-lint-ignore no-explicit-any
const te = (globalThis as any).App.TradeEngine;
const ctx: Ctx = {
  memberId, leagues: rows.filter(L => L.snapshot.rosters.some(r => r.owner_id === memberId)), players: rd('players.json') || {},
  nflState: rows[0].snapshot.nfl_state, trending: [], nflWeek: rd('nfl_week.json'), news: rd('news.json'), te,
  loadLeague: async id => rows.find(L => L.league_id === id) || null,
};
const L = ctx.leagues.find(x => x.league_id === '1312100327931019264') || ctx.leagues[0];
const lid = L.league_id;
const wk = Number(L.snapshot.proj_week) || 0;
// deno-lint-ignore no-explicit-any
type Any = any;
type Q = { q: string; tool: string; args: Record<string, unknown>; must: (r: Any) => string[] };
const miss = (cond: unknown, what: string) => (cond ? [] : [what]);
// Owner ruling 2026-10-12: the AI only ever sees DHQ's projection; no Sleeper projection or line anywhere in a reply.
const noSleeperProj = (r: unknown) => miss(!/sleeper\W{1,3}(s\W+)?(weekly\W+)?(projection|proj|line)|dhq_proj_this_week|"source":"sleeper"/i.test(JSON.stringify(r).replace(/never quote or mention Sleeper.s projections/g, '')), 'no Sleeper projection or line in the reply');
const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x);

// A player on a team that already played this week, and one still to play,
// picked from the data so the bank keeps working as the season moves on.
const playedTeam = Object.entries(ctx.nflWeek?.games || {}).find(([, g]) => g.played)?.[0];
const upcomingTeam = Object.entries(ctx.nflWeek?.games || {}).find(([, g]) => !g.played)?.[0];
const starterOn = (team: string | undefined) => {
  if (!team) return undefined;
  const all = L.snapshot.rosters.flatMap(r => (r.starters || []).concat(r.players || [])).map(String);
  const onTeam = all.filter(pid => ctx.players[pid] && ctx.players[pid].t === team);
  return onTeam.find(pid => ((L.snapshot.games || {})[pid] || [])[wk - 1] != null) || onTeam.find(pid => L.snapshot.proj && L.snapshot.proj[pid] != null);
};
const playedPid = starterOn(playedTeam), upcomingPid = starterOn(upcomingTeam);

// Last season's champion (or any other team when that was me) for head-to-head.
const myRid = L.snapshot.rosters.find(r => r.owner_id === memberId)?.roster_id;
const lastChamp = (L.intel.championships || {})[String(Number(L.season) - 1)]?.champion;
const rivalRid = lastChamp != null && lastChamp !== myRid ? lastChamp : L.snapshot.rosters.find(r => r.roster_id !== myRid)!.roster_id;

// Decision-tool fixtures, picked from the data so they survive roster moves.
const myRoster = L.snapshot.rosters.find(r => r.owner_id === memberId)!;
const isSF = ((L.snapshot.league || {}).roster_positions || []).includes('SUPER_FLEX');
const valueOf = (pid: string) => Math.round(Number((L.intel.playerScores || {})[pid]) || 0);
const ageOf = (pid: string) => Number((ctx.players[pid] || {}).age) || 0;
const posOfP = (pid: string) => String(((L.intel.playerMeta || {})[pid] || {}).pos || (ctx.players[pid] || {}).pos || '');
// A young front-line target on another team (a young starting QB in superflex, else a young starter worth 4,000+).
const others = L.snapshot.rosters.filter(r => r.roster_id !== myRoster.roster_id).flatMap(r => (r.players || []).map(String));
const loveOnOther = others.find(pid => (ctx.players[pid] || {}).n === 'Jordan Love');
const youngTarget = loveOnOther || others.filter(pid => (isSF && posOfP(pid) === 'QB' && ageOf(pid) > 0 && ageOf(pid) <= 29 && Number((ctx.players[pid] || {}).dco) === 1) || (valueOf(pid) >= 4000 && ageOf(pid) > 0 && ageOf(pid) <= 28)).sort((a, b) => valueOf(b) - valueOf(a))[0];
// Two of my veterans past their age cliff (RB 27+, WR 29+, TE 29+, QB 32+), the offer a rebuilder doesn't want.
const CLIFF: Record<string, number> = { QB: 32, RB: 27, WR: 29, TE: 29 };
const myVets = (myRoster.players || []).map(String).filter(pid => CLIFF[posOfP(pid)] && ageOf(pid) >= CLIFF[posOfP(pid)] && valueOf(pid) > 0).sort((a, b) => valueOf(b) - valueOf(a)).slice(0, 2);
const starterSet = new Set((myRoster.starters || []).map(String));
const taxiIr = new Set([...(myRoster.taxi || []), ...(myRoster.reserve || [])].map(String));
const nm = (pid: string) => (ctx.players[pid] || {}).n || pid;
const myNames = new Set((myRoster.players || []).map(String).map(nm));
const hasDefSlot = ((L.snapshot.league || {}).roster_positions || []).some((s: string) => /^(DEF|DST)$/i.test(s));

const BANK: Q[] = [
  // ── Decision tools (Lab parity, 2026-10-10) ─────────────────────────
  { q: 'How do I get a young starting QB? (trade_plan)', tool: 'trade_plan', args: { league_id: lid, target: youngTarget ? nm(youngTarget) : 'nobody' }, must: r => [
    ...miss(!!youngTarget, 'a young front-line target exists on another team'),
    ...miss(['offer', 'tough', 'counter', 'pass', 'no_fit'].includes(r.decision) && typeof r.recommendation === 'string', 'a decision and a recommendation first'),
    ...miss(!/Nothing you own|can't|cannot/i.test(r.recommendation), 'never says a deal can\'t be done'),
    ...miss(r.offers.every((o: Any) => !o.give.some((g: string) => { const n = g.replace(/ \(.*$/, ''); const pid = (myRoster.players || []).map(String).find(x => nm(x) === n); return pid && (starterSet.has(pid) || valueOf(pid) >= 4000); }) || /key piece of your lineup/.test(o.lineup_cost || '')), 'an offer that takes a key player says what it costs the lineup'),
    ...miss(JSON.stringify(Object.keys(r).slice(0, 3)) === JSON.stringify(['decision', 'confidence', 'recommendation']), 'verdict-first shape'),
    ...miss(['rebuilding', 'contending', 'middle'].includes(r.partner && r.partner.mode) && Array.isArray(r.partner.why), 'the partner\'s mode with evidence'),
    ...miss(r.price_floor && /^(a|two) \d{4} 1sts?\b/.test(r.price_floor.headliner_needed), 'a young starter\'s going rate is a next-draft 1st (headliner)'),
    ...miss(r.decision !== 'no_fit' || /Nothing you own meets the price/.test(r.recommendation), 'no_fit says why nothing owned meets the price'),
    ...miss(Array.isArray(r.offers) && r.offers.length <= 3 && r.offers.every((o: Any) => o.headliner_met === true && num(o.accept_chance_pct)), 'every offer meets the headliner and has a chance'),
    ...miss(r.offers.every((o: Any) => o.give.every((g: string) => /^\d{4} /.test(g) ? r.my_assets.picks.some((p: Any) => p.pick === g) : myNames.has(g.replace(/ \(.*$/, '')))), 'offers use only what I own'),
    ...miss(Array.isArray(r.rules_applied) && typeof r.method === 'string', 'rules and method attached'),
  ] },
  { q: 'Two aging vets for a young starting QB (the offer a rebuilder won\'t take)', tool: 'evaluate_trade', args: { league_id: lid, give: myVets.map(nm), get: youngTarget ? [nm(youngTarget)] : ['nobody'] }, must: r => [
    ...miss(myVets.length === 2, 'two veterans on my roster to test with'),
    ...miss(Object.keys(r)[0] === 'verdict' && ['offer', 'counter', 'pass'].includes(r.verdict.decision), 'verdict first'),
    ...miss(r.headliner && r.headliner.offer_has_it === false, 'no headliner in two veterans'),
    ...miss(r.verdict.decision !== 'offer' && num(r.acceptance_chance_pct) && r.acceptance_chance_pct <= 10, 'not an offer; chance capped at 10% without the headliner'),
    ...miss(/raw value/.test(String(r.fairness)), 'the fairness grade is labeled raw value only'),
    ...miss(/7,000\+ elite, 4,000\+ starter, 2,000\+ depth/.test(r.values_note || ''), 'one value scale stated'),
  ] },
  { q: 'Who should I pick up and who do I drop? (get_waiver_plan)', tool: 'get_waiver_plan', args: { league_id: lid }, must: r => [
    ...miss(['add', 'hold'].includes(r.decision) && typeof r.recommendation === 'string', 'a decision and a recommendation'),
    ...miss((r.adds || []).every((x: Any) => x.drop && (x.drop.player || /open active spot/.test(x.drop.why))), 'every add is paired with a drop or an open spot'),
    ...miss((r.adds || []).every((x: Any) => !x.drop.player || ![...starterSet, ...taxiIr].map(nm).includes(x.drop.player)), 'never drops a starter, taxi or IR player'),
    ...miss(new Set((r.adds || []).map((x: Any) => x.drop.player).filter(Boolean)).size === (r.adds || []).filter((x: Any) => x.drop.player).length, 'no drop used twice'),
    ...miss(hasDefSlot || (r.adds || []).every((x: Any) => x.player.pos !== 'DEF'), 'no DEF add without a DEF slot'),
    ...miss(!L.snapshot.league.settings?.waiver_budget || (r.faab && num(r.faab.max_single_bid)), 'FAAB pace cap stated'),
  ] },
  { q: 'Should I add a defense? (no DEF slot here)', tool: 'get_waiver_plan', args: { league_id: lid, position: 'DEF' }, must: r => [
    ...miss(hasDefSlot || (r.decision === 'no_slot' && r.adds.length === 0), 'a league with no DEF slot gets no DEF add'),
  ] },
  { q: 'Who should I cut? (roster_plan)', tool: 'roster_plan', args: { league_id: lid }, must: r => [
    ...miss(typeof r.decision === 'string' && typeof r.recommendation === 'string', 'a decision and a recommendation'),
    ...miss(r.roster_count && num(r.roster_count.active) && num(r.roster_count.ir), 'roster counts against the limits'),
    ...miss((r.cut_candidates || []).every((c: Any) => ![...starterSet, ...taxiIr].map(nm).includes(c.player)), 'never cuts a starter, taxi or IR player'),
    ...miss((r.keep_despite_low_value || []).filter((k: Any) => (myRoster.reserve || []).map(String).map(nm).includes(k.player)).every((k: Any) => k.value_source !== 'dhq' || k.value > 0), 'an IR player is never valued at 0 (healthy-equivalent or unknown)'),
    ...miss(typeof r.method === 'string' && /ir_fallback/.test(r.method), 'the IR fallback rule is in the method'),
  ] },
  { q: 'Is my lineup right this week? (get_start_sit, verdict first)', tool: 'get_start_sit', args: { league_id: lid }, must: r => [
    ...miss(typeof r.recommendation === 'string' && ['high', 'medium', 'low'].includes(r.confidence), 'recommendation and confidence'),
    ...miss(Array.isArray(r.changes) && Array.isArray(r.close_calls) && Array.isArray(r.do_not_start) && Array.isArray(r.questionable), 'changes, close calls, do-not-start and questionable'),
    ...miss(r.do_not_start.every((d: Any) => typeof d.reason === 'string' && d.reason.length > 0), 'every do-not-start says why'),
    ...miss(new Set(r.optimal_lineup.filter((x: Any) => x.player !== '(empty)').map((x: Any) => x.player)).size === r.optimal_lineup.filter((x: Any) => x.player !== '(empty)').length, 'nobody counted twice in the best lineup'),
    ...miss(!r.changes.some((c: Any) => r.optimal_lineup.some((x: Any) => x.locked && (x.player === c.start))), 'no change moves a locked player'),
    ...miss(r.projection && /DHQ/.test(r.projection.source || ''), 'ranks on DHQ\'s weekly projection and says so'),
    ...noSleeperProj(r),
  ] },
  { q: 'Which leagues am I in?', tool: 'list_leagues', args: {}, must: r => [
    ...miss(Array.isArray(r.leagues) && r.leagues.length >= 1, 'lists at least one league'),
    ...miss(r.leagues.some((l: Any) => l.league_id === lid), 'includes the test league'),
    ...miss(r.leagues.every((l: Any) => l.format && l.my_team), 'each league shows format and my team'),
  ] },
  { q: 'Tell me about a player (dynasty and this season must be separate numbers)', tool: 'get_player', args: { player: 'Chig Okonkwo', league_id: lid }, must: r => [
    ...noSleeperProj(r),
    ...miss(num(r.dhq_value), 'dhq_value present'),
    ...miss(r.ppg === undefined, 'no bare "ppg" field (it was mistaken for current form)'),
    ...miss('proj_this_week' in r || 'scored_this_week' in r, 'this week shown as projection or actual'),
    ...miss(typeof r.game_log === 'string' || r.season_games === undefined, 'game log present when games exist'),
    ...miss(r.nfl_opponent !== undefined, 'NFL opponent or BYE shown'),
    ...miss(r.team_news === undefined || Array.isArray(r.team_news), 'team news is a list'),
  ] },
  { q: 'Projections for several players, including one who already played', tool: 'get_weekly_projections', args: { league_id: lid, players: [playedPid, upcomingPid].filter(Boolean) }, must: r => {
    const played = r.players.find((p: Any) => p.id === playedPid), up = r.players.find((p: Any) => p.id === upcomingPid);
    return [
      ...miss(r.week === wk, 'week matches the NFL week'),
      ...miss(typeof r.before_you_answer === 'string' && /news/i.test(r.before_you_answer), 'tells the AI to read the news first'),
      ...miss(!playedPid || (played && played.proj_this_week === undefined && /ALREADY PLAYED|DID NOT PLAY/.test(played.this_week || '')), 'a player whose game happened shows actual points and is locked, not a projection'),
      ...miss(!upcomingPid || (up && (up.proj_this_week === null || num(up.proj_this_week)) && up.game_status === 'upcoming'), 'a player still to play shows a projection and upcoming status'),
      ...miss(r.players.every((p: Any) => p.nfl_opponent !== undefined), 'every player shows his NFL opponent'),
    ];
  } },
  { q: 'My matchup this week', tool: 'get_my_matchup', args: { league_id: lid }, must: r => [
    ...noSleeperProj(r),
    ...noSleeperProj(r),
    ...miss(r.opponent && r.my_lineup && r.my_lineup.length > 0, 'opponent and my lineup present'),
    ...miss(num(r.my_projected_total) && num(r.their_projected_total), 'both totals present'),
    ...miss(!r.bench_projected_above_a_starter_at_same_position.some((b: Any) => b.scored_this_week != null), 'bench suggestions never include a locked player'),
    ...miss(/actual points/.test(r.totals_note || ''), 'totals note explains actual vs projected'),
  ] },
  { q: 'Grade a trade', tool: 'evaluate_trade', args: { league_id: lid, give: ['Jonathan Taylor'], get: ['Puka Nacua'] }, must: r => [
    ...miss(typeof r.fairness === 'string' && r.fairness.length > 0, 'a fairness verdict is stated'),
    ...miss(num(r.acceptance_chance_pct), 'acceptance chance stated'),
    ...miss(r.their_posture && r.my_needs, 'partner posture and my needs considered'),
    ...miss(JSON.stringify(r).includes('Taylor') && JSON.stringify(r).includes('Nacua'), 'both players named'),
    ...miss(Object.keys(r)[0] === 'verdict' && typeof r.verdict.call === 'string' && ['offer', 'counter', 'pass'].includes(r.verdict.decision), 'the verdict comes first'),
  ] },
  { q: 'Who is a good waiver add at RB?', tool: 'get_waiver_options', args: { league_id: lid, position: 'RB', limit: 5 }, must: r => [
    ...miss(Array.isArray(r.best_available) && r.best_available.length > 0, 'a list of the best available'),
    ...miss(r.best_available.every((p: Any) => p.pos === 'RB'), 'only the asked position'),
    ...miss(num(r.faab_left), 'FAAB left stated'),
  ] },
  { q: 'What are this league\'s pick values?', tool: 'get_pick_values', args: { league_id: lid }, must: r => [
    ...miss(r.value_by_round && Object.keys(r.value_by_round).length > 0, 'values by round'),
  ] },
  { q: 'Should I start Chig Okonkwo or Courtland Sutton?', tool: 'get_start_sit', args: { league_id: lid, players: ['Chig Okonkwo', 'Courtland Sutton'] }, must: r => [
    ...miss(typeof r.verdict === 'string' && r.verdict.length > 10, 'a lineup verdict is stated'),
    ...miss(r.head_to_head && /Start|TOSS-UP|None of them/.test(r.head_to_head.call), 'a head-to-head call between the named players'),
    ...miss(r.head_to_head && r.head_to_head.players.every((p: Any) => p.injury !== undefined || p.available !== undefined), 'each named player shows availability'),
    ...miss(typeof r.method === 'string' && /Doubtful counts as out/.test(r.method), 'the start/sit method is attached'),
    ...miss(!r.swaps.some((x: Any) => /locked/i.test(String(x.sit_reason || ''))), 'no swap moves a locked player'),
    ...miss(num(r.optimal_total) && r.optimal_total >= r.current_total, 'optimal total is at least the current total'),
  ] },
  { q: 'What does my team need?', tool: 'get_roster_needs', args: { league_id: lid }, must: r => [
    ...miss(r.tier && r.window, 'tier and window stated'),
    ...miss(Array.isArray(r.positions) && r.positions.every((p: Any) => /deficit|thin|ok|surplus/.test(p.status)), 'every position has a status'),
    ...miss(Array.isArray(r.what_to_do) && r.what_to_do.length > 0, 'concrete things to do'),
  ] },
  { q: 'Should I sell Courtland Sutton?', tool: 'get_player_outlook', args: { league_id: lid, player: 'Courtland Sutton' }, must: r => [
    ...miss(r.outlook && /BUY|SELL|SELL_HIGH|HOLD|STASH|CORE/.test(r.outlook.action), 'a buy/sell/hold call'),
    ...miss(r.outlook && r.outlook.reason, 'the reason for the call'),
    ...miss(/injur|news/i.test(r.inputs_note || ''), 'warns the call does not read injuries or news'),
  ] },
  { q: 'Compare Jonathan Taylor and Derrick Henry', tool: 'compare_players', args: { league_id: lid, players: ['Jonathan Taylor', 'Derrick Henry'] }, must: r => [
    ...miss(typeof r.verdict === 'string', 'a verdict'),
    ...miss(r.by_metric && r.by_metric.length >= 4, 'measure-by-measure leaders'),
  ] },
  { q: 'Who should I trade with?', tool: 'find_trade_targets', args: { league_id: lid }, must: r => [
    ...miss(Array.isArray(r.partners) && r.partners.length > 0, 'partners listed'),
    ...miss(r.partners.every((p: Any) => num(p.score) && p.tag && Array.isArray(p.reasons)), 'each partner has a score, tag and reasons'),
    ...miss(r.partners.some((p: Any) => p.targets_for_you.length > 0), 'at least one partner has specific targets'),
  ] },
  { q: 'What does the draft look like?', tool: 'get_draft_board', args: { league_id: lid }, must: r => [
    ...miss(num(r.draft_year), 'draft year'),
    ...miss(Array.isArray(r.picks_by_team) && r.picks_by_team.length > 0, 'picks by team'),
  ] },
  { q: 'How much should I bid on a free agent?', tool: 'get_waiver_bid', args: { league_id: lid, player: (L.snapshot.rosters.flatMap(x => x.players || []).includes('7607') ? 'nobody' : 'Michael Carter') }, must: r => [
    ...miss(num(r.suggested_bid), 'a suggested bid'),
    ...miss(r.range && num(r.range.low) && num(r.range.high), 'a range'),
    ...miss(typeof r.cold_start === 'boolean', 'says whether the league has enough bid history'),
    ...miss(r.in_season_bids && num(r.in_season_bids.count) && num(r.in_season_bids.offseason_claims_excluded), 'bid history is in-season only, and says how many offseason claims it left out'),
  ] },
  // League lookups (same coverage as the in-app AI's ask-tools).
  { q: 'What are the league rules and scoring?', tool: 'get_league', args: { league_id: lid }, must: r => [
    ...miss(r.rules && r.rules.playoffs && num(r.rules.playoffs.start_week), 'playoff setup in the rules'),
    ...miss(r.rules && r.rules.waivers && r.rules.waivers.type, 'waiver type in the rules'),
    ...miss('trade_deadline_week' in (r.rules || {}), 'trade deadline stated'),
    ...miss(r.scoring && r.scoring.passing && num(r.scoring.passing.pass_td), 'scoring settings grouped (passing TD present)'),
    ...miss(r.roster_slots && num(r.roster_slots.QB), 'roster slots'),
  ] },
  { q: 'Show me the standings with points against and luck', tool: 'get_standings', args: { league_id: lid }, must: r => [
    ...miss(Array.isArray(r.teams) && r.teams.length === L.snapshot.rosters.length, 'every team listed'),
    ...miss(r.teams.every((t: Any) => num(t.points_for) && num(t.points_against)), 'points for and against for every team'),
    ...miss(r.teams.some((t: Any) => t.mine), 'my team marked'),
    ...miss(wk <= 1 || r.teams.every((t: Any) => typeof t.all_play === 'string' && num(t.luck)), 'all-play and luck once weeks are played'),
    ...miss(!L.snapshot.league.settings?.waiver_budget || r.teams.every((t: Any) => num(t.faab_left)), 'FAAB left for every team'),
  ] },
  { q: 'Who do I play the rest of the season?', tool: 'get_schedule', args: { league_id: lid }, must: r => [
    ...miss(Array.isArray(r.weeks) && r.weeks.length === Number(L.snapshot.last_reg_week), 'one row per regular-season week'),
    ...miss(r.weeks.filter((w: Any) => w.status === 'played').every((w: Any) => /^[WLT]$/.test(w.result) && /-/.test(w.score)), 'played weeks show result and score'),
    ...miss(r.weeks.filter((w: Any) => w.status === 'upcoming').every((w: Any) => w.opponent && w.opponent_roster_id != null), 'future weeks show the opponent'),
    ...miss(wk <= 1 || r.weeks.some((w: Any) => w.status === 'played'), 'some weeks already played'),
  ] },
  { q: 'Who has won this league?', tool: 'get_league_history', args: { league_id: lid }, must: r => [
    ...miss(Array.isArray(r.seasons) && r.seasons.some((s: Any) => s.champion && s.champion !== 'unknown' && s.champion !== 'in progress'), 'a past champion named'),
    ...miss(r.seasons.some((s: Any) => Array.isArray(s.bracket) && s.bracket.some((b: string) => /Championship/.test(b))), 'a championship game in a bracket'),
    ...miss(Array.isArray(r.all_time) && r.all_time.length > 0 && r.all_time.every((m: Any) => m.manager && /\d+-\d+/.test(m.record)), 'all-time records per manager'),
    ...miss(!JSON.stringify(r).includes('roster '), 'every team named, never a bare roster id'),
  ] },
  { q: 'What is my record against the league champion?', tool: 'get_head_to_head', args: { league_id: lid, team_b: String(rivalRid) }, must: r => [
    ...miss(r.this_season && typeof r.this_season.record_for_team_a === 'string', 'this season\'s record'),
    ...miss(r.all_time && /\d+-\d+/.test(r.all_time.regular_season_record_for_team_a), 'all-time regular-season record'),
    ...miss(r.all_time && Array.isArray(r.all_time.past_seasons_both_in_league), 'which past seasons were counted'),
  ] },
  { q: 'What waiver claims did I make, and what did I pay?', tool: 'get_transactions', args: { league_id: lid, type: 'waiver', team: 'me', limit: 5 }, must: r => [
    ...miss(Array.isArray(r.rows), 'rows listed'),
    ...miss(r.rows.every((x: Any) => /^waiver/.test(x.type) && num(x.faab_bid)), 'every row is a waiver claim with its bid'),
    ...miss(!(L.snapshot.txns || []).length || r.total_found > 0, 'claims found when the league has moves'),
  ] },
  { q: 'Show me the trades from last season and who won', tool: 'get_transactions', args: { league_id: lid, type: 'trade', season: String(Number(L.season) - 1), limit: 5 }, must: r => [
    ...miss(r.rows.length > 0, 'last season\'s trades found'),
    ...miss(r.rows.every((x: Any) => x.type === 'trade' && x.winner && Array.isArray(x.sides) && x.sides.every((s: Any) => s.team && Array.isArray(s.got))), 'each trade shows both sides and a winner'),
  ] },
  { q: 'How have our rookie drafts gone?', tool: 'get_draft_info', args: { league_id: lid, section: 'results', limit: 10 }, must: r => [
    ...miss(r.draft_results && r.draft_results.rows.length > 0, 'past picks listed'),
    ...miss(r.draft_results && r.draft_results.rows.every((d: Any) => d.player && d.team && d.result && /^\d+\.\d\d$/.test(d.pick)), 'each pick shows player, team, slot and result'),
  ] },
  { q: 'What picks do I own and how do first-rounders hit here?', tool: 'get_draft_info', args: { league_id: lid, team: 'me', section: 'all' }, must: r => [
    ...miss(r.picks && Array.isArray(r.picks.picks), 'my picks'),
    ...miss(Array.isArray(r.hit_rates_by_round) && r.hit_rates_by_round.length > 0, 'hit rates by round'),
    ...miss(Array.isArray(r.pick_values_next_draft) && r.pick_values_next_draft.every((x: Any) => num(x.mid)), 'pick values by round'),
  ] },
  { q: 'Who is on the trade block?', tool: 'get_trade_block', args: { league_id: lid }, must: r => [
    ...miss(typeof r.listings === 'number' && Array.isArray(r.teams), 'listings by team, read live from Sleeper'),
    ...miss(r.teams.every((t: Any) => t.team && Array.isArray(t.players)), 'each team named with its players'),
  ] },
  { q: 'Top 10 WRs in my league', tool: 'search_players', args: { league_id: lid, position: 'WR', limit: 10 }, must: r => [
    ...miss(r.players.length === 10, 'ten players'),
    ...miss(r.players.every((p: Any) => p.pos === 'WR' && num(p.dhq_value) && p.rostered_by), 'only WRs, each with value and who has him'),
    ...miss(r.players.every((p: Any, i: number) => i === 0 || p.dhq_value <= r.players[i - 1].dhq_value), 'sorted by value'),
  ] },
  { q: 'Best available RB this week', tool: 'search_players', args: { league_id: lid, position: 'RB', availability: 'free_agents', sort: 'this_week', limit: 5 }, must: r => [
    ...miss(r.players.every((p: Any) => p.rostered_by === 'free agent' && p.pos === 'RB'), 'only free-agent RBs'),
    ...miss(r.players.every((p: Any) => num(p.proj_this_week) || num(p.scored_this_week)), 'each shows this week\'s projection or points'),
  ] },
  { q: 'Tell me about this owner (biggest win and loss, trades with me)', tool: 'get_owner_profile', args: { league_id: lid, roster_id: L.snapshot.rosters.find(x => x.owner_id !== memberId && (L.intel.ownerProfiles || {})[String(x.roster_id)]?.trades)?.roster_id }, must: r => [
    ...miss(r.biggest_win || r.biggest_loss, 'biggest win or loss'),
    ...miss(r.players_acquired && num(r.players_acquired.count), 'players acquired'),
    ...miss(r.trades_with_me && num(r.trades_with_me.count), 'trades with me'),
  ] },
  { q: 'An unknown league is refused clearly', tool: 'get_team', args: { league_id: 'nope' }, must: () => ['should have thrown'] },
];

let failed = 0;
for (const t of BANK) {
  let r: Any, errMsg = '';
  try { r = await runTool(ctx, t.tool, t.args); } catch (e) { errMsg = (e as Error).message; }
  const problems = errMsg ? (t.must.toString().includes("'should have thrown'") ? [] : ['tool error: ' + errMsg]) : t.must(r);
  if (problems.length) { failed++; console.log('✗ ' + t.q + '  [' + t.tool + ']'); problems.forEach(p => console.log('    missing: ' + p)); }
  else console.log('✓ ' + t.q);
}
console.log('\n' + (BANK.length - failed) + '/' + BANK.length + ' questions answered with every required fact' + (playedPid ? '' : ' (no team has played yet this week, so the locked-player check was skipped)'));
if (failed) Deno.exit(1);
