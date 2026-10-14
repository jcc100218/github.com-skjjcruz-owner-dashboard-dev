// DHQ skills — the methodology, published beside the tools.
//
// Each skill is DHQ's method for one kind of question, written for the
// member's AI to read before it answers: which tool to call, what the
// numbers mean, what decides the call, and what the answer must say.
// They are served as MCP prompts (prompts/list, prompts/get) and also as
// the `method` text inside the matching verdict tool's result, so an AI
// that never reads prompts still sees the method where it matters.
// The rules mirror the app's own code (Lineup screen, team assessor,
// player-action chain, Trade Center partner board, FAAB bid model).
export interface Skill { name: string; title: string; description: string; text: string }

const ANSWER = 'Answer shape: lead with the call in one sentence, then the two or three reasons with their numbers, then the biggest news item on each side and whether it changes the call, then exactly what to do in Sleeper. Never send the member to look something up. Never invent a number a tool did not give you.';

export const SKILLS: Skill[] = [
  {
    name: 'start_sit', title: 'DHQ Start / Sit', description: 'How DHQ decides who starts this week.',
    text: [
      'DHQ START / SIT METHOD (the Lineup screen\'s rule, with the exact solver and the coin-flip rules).',
      '1. Call get_start_sit FIRST for any lineup question. Pass the players the member named. Lead with `recommendation`; explain with `changes`, `close_calls`, `do_not_start` (current starters who must come out, plus anyone the member named) and `questionable`. Do not rebuild the lineup yourself, and don\'t tell the member to bench players who are already on the bench.',
      '2. The number you quote is DHQ\'s weekly projection (each player\'s proj: the same number the app\'s Lineup screen shows; the call itself ranks on DHQ\'s average week) in this league\'s scoring; it is the only projection you quote: never quote or mention Sleeper\'s projections. A player with no role this week reads 0 and cannot be started; every 0 says why (`zero_reason`: bye, out, doubtful, IR, no NFL team, not_projected, no_role).',
      '3. Out, IR, PUP, suspended and bye players cannot start. Doubtful counts as out. Questionable plays at his projection; a Questionable starter in a late game needs a pivot on the bench who plays as late (`questionable` names him).',
      '4. A player whose game has kicked off is locked where he is and counts his actual points. Never suggest moving a locked player.',
      '5. The solver fills the open slots for the most projected points: narrowest slots first, then an exact assignment check, so a player listed at two positions (DL and LB) is counted at both. No positional premium.',
      '6. Within 1.5 points or 10% is a coin flip: say so, then decide on health and news (the tiebreak: favored at 55%+ takes the higher floor, underdog at 45% or less the higher ceiling, an even game the higher projection).',
      '7. Then read latest_news and team_news for each player in the call. A new play-caller, a QB change, a teammate injury that frees targets, or a limited practice can move a coin flip; it does not overturn a gap of several points unless the player may not play.',
      '8. Do not use dhq_value or dhq_rate_ppg for this decision. Those are dynasty numbers.',
      ANSWER,
    ].join('\n'),
  },
  {
    name: 'roster_needs', title: 'DHQ Roster Needs', description: 'How DHQ reads a team\'s holes, surplus and window.',
    text: [
      'DHQ ROSTER NEEDS METHOD (the app\'s team assessor).',
      '1. Call get_roster_needs.',
      '2. A quality starter is a player in the league-wide top tier at his position by DHQ value (top N where N is teams for QB/TE/K, 2.5x teams for RB, 4x teams for WR and IDP) or a live NFL starter.',
      '3. Each position: deficit = no quality starter; thin = fewer quality starters than the lineup needs, or too few bodies; surplus = more quality than the lineup needs and full depth; ok otherwise.',
      '4. Tier comes half from health (projected lineup points against the league target plus coverage) and half from standings, ranked inside this league. Window: elite or calm contender = contending; rebuilding = rebuilding; everyone else transitioning.',
      '5. Needs are the deficit and thin spots, worst first. Strengths are surplus spots with spare quality: these are what the member trades from.',
      '6. Tell the member the one or two holes that matter, what to sell to fill them, and whether the window says to pay with picks (contending) or ask for picks (rebuilding).',
      ANSWER,
    ].join('\n'),
  },
  {
    name: 'player_outlook', title: 'DHQ Player Outlook', description: 'How DHQ calls buy, sell or hold on a player.',
    text: [
      'DHQ PLAYER OUTLOOK METHOD (the app\'s player-action chain, first rule that fits wins).',
      'Rookie not yet producing: Stash. Elite (DHQ 7,000+ or top 5 at his position) with 3+ peak years: Build around. 4+ peak years and production up 10%+: Buy (Hold if owned). One peak year left and DHQ 3,000+: Sell high. In the veteran decline band and production down 10%+: Sell high; otherwise Hold. Past the value window: Sell (Hold an IDP depth-chart starter). 2 or fewer peak years and production down 10%+: Sell high. 2+ peak years at DHQ 4,000+: Hold. Under DHQ 2,000 with 3+ peak years: Stash. Not owned, 2+ peak years, under DHQ 5,000: Buy. Otherwise Hold if any peak years remain, else Sell.',
      'Peak years and the decline band are position-specific age curves (RB peaks 23-25, WR 25-28, TE 26-29, QB 28-34). Trend is this season\'s points per game against last season\'s.',
      'The chain does not read injuries, news, the member\'s window or the market. You must: check latest_news and injury, and say whether the member\'s window (from get_roster_needs) agrees. A Sell high on a contender\'s starter can wait until the deadline.',
      ANSWER,
    ].join('\n'),
  },
  {
    name: 'compare_players', title: 'DHQ Compare', description: 'How DHQ compares two or more players.',
    text: [
      'DHQ COMPARE METHOD.',
      '1. Call compare_players. It lists who leads each measure and gives a verdict from two numbers: DHQ value (10%+ gap decides) and runway (2+ more peak years tips a close call).',
      '2. Say which question the member is asking. This week: use get_start_sit. Dynasty value or a trade: use the verdict. Roster fit: check get_roster_needs.',
      ANSWER,
    ].join('\n'),
  },
  {
    name: 'trade_targets', title: 'DHQ Trade Targets', description: 'How DHQ finds who to trade with and for whom.',
    text: [
      'DHQ TRADE TARGETS METHOD (the Trade Center partner board).',
      '1. Call find_trade_targets. Partners are scored on roster fit (their surplus meets your needs and yours meets theirs), mutual need, their panic, their pick capital, how often they trade, their trade DNA, and whether your windows line up (contender with rebuilder is the best match). Locked elite rosters score low.',
      '2. Attack (85+) and Prime (68+) are worth an offer now. Possible (48+) needs the right package. Long shot: do not waste the message.',
      '3. Build the offer from targets_for_you and my_chips or my_picks. Pay rebuilders in picks and young players; pay contenders in starters who score now.',
      '4. Then call trade_plan with the target (and any package the member is considering): it builds offers only from what the member owns and prices them the way that partner sees them. A package to grade: evaluate_trade, and lead with its verdict.',
      ANSWER,
    ].join('\n'),
  },
  {
    name: 'trade_plan', title: 'DHQ Trade Plan', description: 'How DHQ builds a trade offer: who to deal with, what they want, the going rate, offers from what the member owns.',
    text: [
      'DHQ TRADE PLAN METHOD (call trade_plan FIRST for "how do I get X", "what would it take", "what can I offer", or before proposing any trade).',
      '1. Read the partner once (a read, not a fact: say "based on their recent moves, they look to be rebuilding"): rebuilding, contending or middle, from their record, this season\'s trades (picks in, players out) and what they listed on Sleeper\'s trade block. A rebuild read wins over panic: a losing team that sells is a seller, not desperate.',
      '2. Price every piece the way THAT owner sees it. A rebuilder: next-draft picks x1.15, the draft after x1.0, later x0.85; players 24 or under x1.15; veterans past their age cliff (RB 27+, WR 29+, TE 29+, QB 32+) x0.55 or x0.2, but a top player (4,000+) right at the line still x0.8. A contender: picks x0.8. A player his owner listed costs him 15% less; a rebuilder\'s veteran still costs him at least 70% of his value (he can sell him to a contender), 85% of that when listed.',
      '3. The going rate: a young starter (28 or under, 4,000+; in superflex a young starting QB) costs one headline piece: a NEXT-draft 1st, or a young player worth 70%+ of him. A 1st one draft further out only counts with a real add (a 2nd or a solid young player); a rebuilder won\'t take one two or more drafts away as the headliner, and for a young superflex QB a rebuilder also wants a 2nd or a solid young player on top. Meeting it is the market floor, not an overpay. Several lesser pieces do not add up to one.',
      '4. Only what the member verifiably owns is offered: his roster and the picks DHQ confirms he holds. A pick whose holder is unknown is not his.',
      '5. Picks in the next draft are priced at the slot projected from current standings (worst team picks 1st) with no year discount; later drafts mid-round, less 12% a year.',
      '6. Acceptance is estimated on what the package is worth to the partner, minus 8 points per extra player he must roster; capped at 10% without the headliner. A rebuilder never gives picks back: balance with veterans he wants gone.',
      '7. Lead with `decision` and `recommendation`, then the partner\'s likely mode and why, the offer(s) with their chances, and do_not_offer. Never propose an asset that is not in my_assets. `tough` means possible but costly or a stretch: never say a deal can\'t be done; lay out the realistic paths. If an offer carries lineup_cost, say the other owner may consider it and that it costs a key piece of the member\'s lineup.',
      'One value scale: 7,000+ elite, 4,000+ starter, 2,000+ depth, below that a stash.',
      ANSWER,
    ].join('\n'),
  },
  {
    name: 'trade_evaluation', title: 'DHQ Trade Grade', description: 'How DHQ grades a trade and predicts acceptance.',
    text: [
      'DHQ TRADE METHOD.',
      '1. Call evaluate_trade and lead with `verdict` (offer / counter / pass). It applies, in order: ownership (you can only send what you own) > the headliner rule (a young starter costs a next-draft 1st or a young player worth 70%+; a later 1st needs an add, and a rebuilder won\'t count one two or more drafts away) > what the partner wants (their real mode and how they value each piece) > raw value.',
      '2. `fairness` is the raw value ratio only (1.30+ A+, 1.15+ A, 1.05+ B+, 0.95+ B, 0.85+ C, 0.75+ D, below F). It never overrules the verdict: meeting the headliner is the going rate, not an overpay.',
      '3. Acceptance runs on what the package is worth TO THE PARTNER against what he gives up as he sees it, with the psychology taxes (DNA, need, windows, posture). Piling on pieces the partner does not want does not raise it; more players than he sends costs 8 points each. Without the headliner it is capped at 10%.',
      '4. Balance: a rebuilder never gives picks back; ask for a veteran he wants gone (his trade block first). At market there is nothing to balance and no throw-in to ask for.',
      '5. Add what the grade does not see: injuries and news on each piece, and whether it fills the member\'s actual hole (get_roster_needs). To build a better offer, call trade_plan.',
      'One value scale: 7,000+ elite, 4,000+ starter, 2,000+ depth, below that a stash.',
      ANSWER,
    ].join('\n'),
  },
  {
    name: 'waiver_plan', title: 'DHQ Waiver Plan', description: 'How DHQ decides who to claim, who to drop and what to bid.',
    text: [
      'DHQ WAIVER PLAN METHOD (call get_waiver_plan FIRST for "who should I pick up", "who do I drop", "how much should I bid").',
      '1. Only free agents at positions this league can start (no DEF without a DEF slot).',
      '2. Rank by need: value x 1.6 at a deficit, 1.3 thin (only if he would start there), 0.6 at a surplus, plus 35 x this week\'s projection. Backups to the member\'s own starting RB/QB (handcuffs) go first.',
      '3. Every add names its drop from the one roster drop list (the same as roster_plan): active roster only, never taxi, IR, a starter, a handcuff, a backup kicker, the next man up (his NFL teammate at the position is out), a young riser, an injured stash or an engine-gap 0; and only if the add beats that drop. An open active spot is used first.',
      '4. Bids come from the in-season bid model (offseason claims excluded): open at the model\'s bid, max at the higher of its range top and the in-season winning bids at his position, never above the pace cap (FAAB left x 1.5 / weeks left, 15-65%). Stash-level adds (value under 500) open at the league minimum.',
      '5. A need no free agent would start at is a trade, not a claim: say so and use trade_plan.',
      ANSWER,
    ].join('\n'),
  },
  {
    name: 'roster_plan', title: 'DHQ Roster Plan', description: 'How DHQ decides cuts, IR and taxi moves.',
    text: [
      'DHQ ROSTER PLAN METHOD (call roster_plan FIRST for "who should I cut", "do I have room", "can he go on IR/taxi").',
      '1. Count active, taxi and IR against the league limits.',
      '2. Free moves before any cut: IR for players this league lets go there (its reserve_allow settings), and activate anyone on IR who is no longer eligible (Sleeper blocks adds until you do).',
      '3. One drop list, from the active roster only (taxi and IR never: they free no active spot). Never cut a starter, a player whose game has started, a handcuff to the member\'s own starter, a backup kicker (two kickers cover bye weeks), the next man up (a backup whose NFL teammate at his position is out and who moves up to QB1/RB2/WR3/TE1), a young riser, an injured player worth 500+, the last healthy body at a slot, or a player whose 0 is an engine gap.',
      '4. Players with no NFL team go first, then lowest keep score (dynasty value + 50 x this week\'s projection + 300 upside; projection only in redraft).',
      '5. An Inactive (IR) player shows 0 in the engine; DHQ values him at a healthy-equivalent (the median of the five active players at his position closest in dynasty points per game and age, value_source ir_fallback) and names the peers. A player the engine never scored is unknown, never 0.',
      ANSWER,
    ].join('\n'),
  },
  {
    name: 'waiver_bid', title: 'DHQ Waiver Bid', description: 'How DHQ sets a FAAB bid for one player.',
    text: [
      'DHQ WAIVER BID METHOD.',
      '1. For a whole plan (who to add AND who to drop) call get_waiver_plan first. For one player\'s bid: get_waiver_bid.',
      '2. It reads this league\'s in-season winning and losing bids (claims before the regular season are left out: Sleeper files them under week 1), sizes the market by the player\'s strength, models each rival who needs the position and how hard they bid, and returns the smallest bid that wins about 60% of the time, kept under 65% of the remaining budget unless the player is a difference maker.',
      '3. If cold_start is true the league has too few in-season bids and the number is a league-agnostic default: say so.',
      ANSWER,
    ].join('\n'),
  },
  {
    name: 'draft_board', title: 'DHQ Draft', description: 'How DHQ reads the league\'s next draft.',
    text: [
      'DHQ DRAFT METHOD.',
      '1. Call get_draft_board for the picks picture and get_pick_values for a slot\'s worth. Pick values follow the industry curve blended with this league\'s own hit rates, discounted 12% per year out.',
      '2. Use this league\'s hit rates by round to say what a pick is really worth here, and its early-round tendencies to predict who goes before the member picks.',
      '3. Prospect rankings are not served yet: say so rather than ranking rookies from memory.',
      ANSWER,
    ].join('\n'),
  },
];

export function skillText(name: string): string | undefined {
  const s = SKILLS.find(x => x.name === name);
  return s ? s.text : undefined;
}
