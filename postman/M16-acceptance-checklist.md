# M16 Teams and players (step 1): Acceptance Checklist

Tick each box when the result matches. Request names refer to the **"Kriraghor API: M16 Teams and players (step 1)"** collection
(`postman/kriraghor-teams.postman_collection.json`, rebuilt with `node postman/build-collection-m16.js`).

Step 1 covers:
- teams (any team sport) with captain, vice-captain and players. A **verified phone** is needed to create or join;
- invites by phone: **the same answer for every number** (no lookup of who has an account), always with a share link. Members with an account get an in-app notice and an SMS; numbers with no account get nothing from Kriraghor;
- linking on read: an invite is found by the caller's current verified phone (phone sign-up, OTP sign-in, a phone added later);
- hand-over, one vice-captain, jersey numbers, leave (a captain hands over first), remove, archive, succession when a captain is banned;
- the player profile (sports and positions from M03's list), the public page by username;
- gender (self-declared once, private, staff can correct) and the eligibility readiness and preview;
- the staff desk (`manage_users`).

Not in step 1 (with M14 and M15): rosters, RSVPs, lineups, suspensions, transfers, the guardian flow for under-16 players (Q151) and stronger gender proof (Q152).

## 0. Setup
- [ ] `docker compose up -d`, then `npm run release`. This applies three migrations:
  - `20261104000001-user-gender` (M01): `users.gender` (`male`, `female`, `third`) and `gender_source` (`self_declared`, `staff_corrected`);
  - `20261104000002-sport-positions` (M03): `sports.positions` JSONB;
  - `20261104000003-create-teams` (M16): `teams`, `team_members` (one active row per team and user, one captain, one vice-captain), `team_invites` (phone hash and mask only, one pending per team and number, a hashed share-link token), `player_profiles`.

  The seed adds:
  - places v2 (positions per sport);
  - settings v20 (281 settings): `teams.invite_expiry_days`, `max_members`, `max_memberships`, `invites_per_day`, `invite_resend_minutes`;
  - templates v17 (`TEAM_INVITE`, `TEAM_INVITE_ACCEPTED`, `TEAM_MEMBER_REMOVED`, `TEAM_CAPTAIN_GIVEN`).

  The M08 category `teams` and the gates `create_team` and `join_team` (a verified phone) are code changes, not seed rows.
- [ ] `npm test`: everything green, including the 100% gate on `teams.rules.js`. 🤖 marks cases only the tests cover.
- [ ] `node postman/run-m16.js` → **0 failed**.
  - The runner resets `kriraghor_test`.
  - It signs up a captain (Rafi Ahmed), a member (Sakib Hasan), an email-only account (Tanvir Islam) and a `manage_users` staff member.
  - It serves `{{controlUrl}}`: `/settle`, `/signup`, `/otp`, `/refresh-email`, `/check`.
- [ ] `run-m02.js` to `run-m23.js` still pass. M03 counts 281 settings.

## 1. A team (M16-FR-01)
- [ ] An account with no verified phone → **403 `PHONE_REQUIRED`**.
- [ ] A link in the name → **422 `TEAM_NAME_INVALID`** (URLs and phone numbers are refused).
- [ ] A sport that isn't a team sport → **422 `TEAM_SPORT_UNKNOWN`**.
- [ ] Gulshan Gladiators → **201**, the creator is captain, the short code is upper-cased, and members show only an NID boolean.

## 2. Invites (M16-FR-02)
- [ ] Inviting a member with an account and a number with no account give **the same response shape**, each with a share link `…/teams/join/{token}`.
- [ ] Inviting the same number again reuses the pending invite and returns a new link (the old link stops working).
- [ ] Inviting yourself → **422 `INVITE_SELF`**.
- [ ] The public link page shows the team, sport, the inviter's first name and the masked number, nothing else.
- [ ] Pending invites on the team show masked numbers only.
- [ ] The number signs up by phone → the invite is waiting → accept → **player**.
- [ ] The member accepts; a second accept → **409 `INVITE_STATE`**.
- [ ] The email account: a number another account uses → **409 `PHONE_IN_USE`**; it adds and verifies its own number and finds the invite sent to that number.
- [ ] Notices: one in-app `TEAM_INVITE` each (sent to the member at invite time, and to the others when they link), and `TEAM_INVITE_ACCEPTED` twice to the captain.
- [ ] 🤖 Resend cooldown (`INVITE_RESEND_TOO_SOON`), cancel, decline, accept after expiry refused before the job runs (`INVITE_EXPIRED`), `teams.tick` expires invites, `TEAM_FULL` and `TOO_MANY_TEAMS` under the team lock, the daily invite limit.

## 3. Members and captaincy (M16-FR-04)
- [ ] The captain makes the member vice-captain with jersey number 7.
- [ ] Making the new player vice-captain moves the role: still **one** vice-captain, and the jersey number stays.
- [ ] The vice-captain cannot remove the captain → **409 `CANNOT_REMOVE_CAPTAIN`**.
- [ ] The captain leaving before hand-over → **409 `CAPTAIN_MUST_HAND_OVER`**.
- [ ] Hand-over → the member is captain, the old captain is a player.
- [ ] 🤖 A banned captain: the vice-captain takes over, else the longest-serving member, else the team is archived; the new captain gets `TEAM_CAPTAIN_GIVEN`. A sole member leaving archives the team. Logo upload (type sniffed).

## 4. Player profile, gender and eligibility (M16-FR-05, FR-08)
- [ ] A position from another sport → **422 `PROFILE_SPORTS_INVALID`**.
- [ ] Football goalkeeper and cricket wicketkeeper are saved.
- [ ] Gender is set once; a second time → **409 `GENDER_ALREADY_SET`**.
- [ ] The public page `/players/{username}` shows the name, sports with EN/BN position labels and active teams. **Never gender, DOB or phone.**
- [ ] `/me/eligibility?gender=women&ageMin=30` shows readiness (phone pass, NID missing, gender pass) and a preview that fails on gender, **for the caller only**.
- [ ] The team view shows each member's NID boolean only.

## 5. Staff (`manage_users`)
- [ ] Search finds the team; the detail lists members and masked invites.
- [ ] A gender correction needs a reason → `genderSource = staff_corrected`, audited, `user.identity_changed` published with no values.
- [ ] Archive with a reason → `archived`; inviting into it → **409 `TEAM_ARCHIVED`**.
