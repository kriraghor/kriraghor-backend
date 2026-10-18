# M14 Tournaments (step 1, with M15 lite results): Acceptance Checklist

Tick each box when the result matches. Request names refer to the **"Kriraghor API: M14 Tournaments (step 1)"** collection
(`postman/kriraghor-tournaments.postman_collection.json`, rebuilt with `node postman/build-collection-m14.js`).

Step 1 covers:
- physical-sport tournaments run by verified organisations of kind `sports` (M14 lite), reviewed on the Moderation desk (M05 kind `tournament`);
- rules from the M03 sport rule schemas (presets, ranges, allowed tiebreakers), locked at the first result and unlocked with a reason;
- registrations of M16 teams with a squad (one team per player per tournament), the entry fee into escrow (M06 purpose `tournament_entry`), the reserve list and offers, approve, reject, remove, waive, withdraw;
- the four formats with a draw (registration order, manual, random with a published seed), generation, the automatic schedule (no M10 courts yet, Q85), publish, moves with clash checks, postpone, walkover, cancel;
- M15 lite: final results entered by the organiser, amendments with a reason, standings with tiebreakers and lots, placeholders resolved as results arrive;
- money: 50% of every entry released (less 5%) at the first result and the rest at completion; refunds per §6.9; prizes shown but not held (Q86).

Not in step 1: live ball-by-ball scoring, player stats and stat disputes (M15), court booking through M10 (Q85), officials and scorers with M11 hire, broadcasts, RSVPs, lineups, suspensions and transfers (M16), versioned material edits after approval, pots seeding.

## 0. Setup
- [ ] `docker compose up -d`, then `npm run release`. This applies five migrations:
  - `20261105000001-tournament-kinds`: organisation kind `sports`; M05 kind `tournament`;
  - `20261105000002-sport-rule-schemas` (M03): fields, presets and allowed tiebreakers per sport and version;
  - `20261105000003-create-tournaments` (M14): `tournaments`, `tournament_rules`, `tournament_venues`, `stages`, `groups`, `group_teams`, `registrations` (one live registration per team, an idempotency key per captain), `matches` (unique numbers; regenerated drafts excluded);
  - `20261105000004-create-rosters` (M16): `rosters`, `roster_players` (one active squad per player per tournament), `eligibility_checks`;
  - `20261105000005-create-scoring` (M15 lite): `match_results` (one current row per match), `standings`.

  The seed adds:
  - rules v1 (8 sports);
  - settings v21 (289 settings): `tournament.payment_hold_minutes`, `reserve_offer_hours`, `withdraw_refund_after_close_pct`, `entry_fee_max_poisha`, `max_teams`, `min_start_days`, `rules_relock_hours`, `actions_per_minute`;
  - templates v18 (`TOURNAMENT_*`, `REGISTRATION_*`, `RESERVE_OFFERED`, `FIXTURES_PUBLISHED`, `MATCH_RESCHEDULED`, `LOTS_NEEDED`);
  - moderation v3 (the `tournament` rubric).
- [ ] `npm test`: everything green, including the 100% gates on `fixtures.rules.js`, `schedule.rules.js`, `tournaments.rules.js`, `sport-rules.rules.js` and `standings.rules.js`. 🤖 marks cases only the tests cover.
- [ ] `node postman/run-m14.js` → **0 failed**.
  - The runner resets `kriraghor_test`.
  - It makes a verified sports organisation (the owner has an active payout account), a reviewer, and five captains with an NID and a badminton team.
  - It serves `{{controlUrl}}`: `/approve`, `/pay`, `/settle`, `/check`.
- [ ] `run-m02.js` to `run-m23.js` still pass. M03 counts 289 settings.

## 1. Draft and review (M14-FR-04 to FR-08)
- [ ] The badminton rule schema lists three presets and its tiebreakers.
- [ ] A sports organisation gets **404** from the esports console.
- [ ] A draft without a venue cannot be submitted: **422 `TOURNAMENT_INCOMPLETE`** with `venue_present`.
- [ ] A rule out of range → **422 `RULE_OUT_OF_RANGE`**.
- [ ] The league draft takes the first preset; changing the preset changes the values and the summary.
- [ ] Submitted → `pending_review`, not public (404). Approved → `registration_open` with `feeBps` 500 and `releasePct` 50; listed in discover.
- [ ] 🤖 Changes requested and rejected keep the reason; the organisation must be verified (locked check).

## 2. Registrations and escrow (FR-10 to FR-13)
- [ ] Four captains register with a squad and pay with bKash: `pending_payment` → `pending_approval`.
- [ ] The same team again → **409 `TEAM_ALREADY_REGISTERED`**. A fifth team → `reserve`, position 1, no payment.
- [ ] The organiser sees four ready squads with NID booleans and **no gender, DOB or phone**.
- [ ] Approve four; twice → **409 `REGISTRATION_STATE`**. Overview: 4 approved, ৳72,000 held.
- [ ] 🤖 Reject refunds 100% and offers the place; an offer accepted needs payment; an offer lapses after `reserve_offer_hours`; withdraw before close 100%, after close 50%, after the first result nothing; waive (audited); `PLAYER_IN_OTHER_TEAM`; `ROSTER_NOT_READY` until gender is recorded for a women's event; the NID gate.

## 3. Draw and fixtures (FR-14 to FR-18)
- [ ] A draw before close → **409 `REGISTRATION_STILL_OPEN`**.
- [ ] Close: the reserve team lapses. The draw preview shows 6 matches; the random draw publishes a 32-character seed.
- [ ] A dry run with a schedule places all 6 matches and writes nothing; generate and publish; the four captains are told.
- [ ] A move with a stale version → **409 `VERSION_CONFLICT`**.
- [ ] 🤖 Groups and knockout: snake groups 1/4/5/8 and 2/3/6/7; semis A1 v B2 and B1 v A2; third place and final from the semis; a walkover; schedule clashes (`SCHEDULE_CLASH`).

## 4. Results, money and the hub (FR-09, FR-16, FR-24, M15 lite)
- [ ] A score that does not fit the rules → **422 `RESULT_INVALID`**.
- [ ] The first result releases tranche 1: the owner's payable is **৳34,200** (4 × (৳9,000 − ৳450)).
- [ ] The rules are locked → **409 `RULES_LOCKED`**. An amendment needs a reason; with one it becomes version 2.
- [ ] The hub is `live` with the rules locked.
- [ ] After the last result the rest is released: payable **৳68,400**; overview `released` ৳72,000, `fees` ৳3,600, `held` 0.
- [ ] The hub is `completed` with a 4-team table (12 played in all) and no personal data.
- [ ] Staff see the tournament with its 5 registrations and ৳72,000 collected.
- [ ] 🤖 An amendment is refused once a dependent match has a result (`AMEND_BLOCKED`); unlocking the rules with a reason is audited and rebuilds the standings; cancel after the first result refunds what is still held (৳9,000 each) and tells the captains.
