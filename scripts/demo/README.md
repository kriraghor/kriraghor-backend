# Demo data

Realistic demo content for every public section, so the sites can be shown before real businesses join. Docs: kriraghor-docs `00-platform/13-demo-data.md`.

## Commands

| Command | What it does |
|---|---|
| `npm run demo:seed -- --profile=full` | Everything, locally: listings plus bookings, orders, passes, hire jobs, finished esports events with results and prizes, leaderboards, top players, reviews (venues, pros, shops, gyms) with owner replies, pro earnings and stats, and notifications. Payments go through the simulator, so it needs `PAYMENTS_SIMULATOR=true` and never runs in production. |
| `npm run demo:seed -- --profile=listings` | Venues, shops and products, gyms, hire profiles and trainers (the demo referee and trainer with an availability calendar), players with game IDs, upcoming esports events (free entry), the showcase and sports events. Takes no payment. Safe for production with `--confirm-live`. |
| `npm run demo:hide -- --dry-run` | Lists what hiding would change. |
| `npm run demo:hide` | Hides all demo data (add `--confirm-live` in production). |

**On a host without a shell** (Render's free plan): set the environment variable `DEMO_SEED=listings` on the backend service. After the API starts and is ready, it runs the listings seeder in the background with its own environment; the log shows each step and "Demo records: …" at the end. Remove the variable afterwards. `DEMO_SEED=hide` runs the hide command the same way. Only these two values are accepted (never the full profile). If the host restarts mid-run (a free instance sleeps after 15 minutes without visitors), the next start resumes it.

Both commands are safe to re-run: the seeder skips what exists, and a second run takes under a minute. A fresh run takes about 3.5 minutes for listings (it waits one minute for esports registration to open), plus about 3 minutes for the full profile.

Local needs: PostgreSQL, Redis and the S3 container from `docker compose up -d` (photos are uploaded to the public bucket), and the S3 and simulator lines from `.env.example` in `.env`.

## Demo sign-in (no SMS needed)

SMS codes are not delivered yet, so one account of each kind can sign in with a **phone number and a password**. The password is never in the code or the logs: set `DEMO_PASSWORD` (12 to 128 characters) in the host's environment, then run the seeder (`DEMO_SEED=listings` adds them at the end) or only this step: `DEMO_SEED=access` on Render, or `npm run demo:seed -- --access-only` locally. The access-only run also adds the demo business staff to their teams when the listings exist. The run prints the list, without the password.

| Phone | Account | Sign in at |
|---|---|---|
| 01300000001 | Venue owner (Kamal Hossain) | vendor.kriraghor.com |
| 01300000008 | Shop owner (Mahbub Alam) | vendor.kriraghor.com |
| 01300000010 | Gym owner (Nusrat Jahan) | vendor.kriraghor.com |
| 01300000011 | Sports events organiser (Tanvir Hossain) | vendor.kriraghor.com |
| 01300000021 | Football referee for hire (Jahid Hasan) | kriraghor.com/pro |
| 01300000030 | Gym trainer with monthly plans (Sabbir Hossain) | kriraghor.com/pro |
| 01300000041 | Esports player, Free Fire (Fahim Shahriar) | esports.kriraghor.com |
| 01300000052 | Esports player, PUBG Mobile (Arnob Saha) | esports.kriraghor.com |
| 01300000090 | Member who books, buys and hires (Ayesha Siddiqua) | kriraghor.com |
| 01300000194 | Venue staff, front desk at Kick Off Arena Mirpur (Mithun Barua) | vendor.kriraghor.com |
| 01300000195 | Gym staff, front desk at PowerHouse Gym Mirpur (Moushumi Khatun) | vendor.kriraghor.com |
| 01300000196 | Shop staff, packer at Iron Supply Tejgaon (Shohel Rana) | vendor.kriraghor.com |
| 01300000191 | Staff: users, listings, documents, reports | admin.kriraghor.com |
| 01300000192 | Staff: payouts view, small refunds | admin.kriraghor.com |
| 01300000193 | Staff: esports desk and results | admin.kriraghor.com |

- Use **Sign in with a password**. Staff then scan the two-factor QR code with an authenticator app on their first sign-in, so there is no shared second factor.
- The three business staff (Round B3) are ordinary members with a verified phone, never Kriraghor staff. Their owner adds them with the business type's default permissions: the venue desk (bookings view, check-in, no-show, extend, collect balance, walk-ins), the gym desk (admit, admissions) and the shop (orders view, accept, ship, deliver, stock view and adjust). See `steps/team.js` below.
- No demo account is ever a master: the step skips any account holding `master_admin`. Your own master comes from `BOOTSTRAP_MASTER` with your email (email codes work).
- Re-running keeps passwords already set. `demo:hide` suspends these accounts and offboards the demo staff with the rest of the demo data. Hide them before launch.

## How it works

- `runtime.js` starts the API in-process on a loopback port and calls the real routes, so every gate, validation rule, Moderation review, ledger posting and event applies. It mints sessions for demo accounts instead of signing in, and relays and consumes events in-process (what the worker does).
- `steps/people.js`: two demo staff (a master who drafts Kriraghor's own events and a reviewer for the four-eyes desk), members, NID verification and business roles through M01, M02 and M05.
- `steps/listings.js`: every listing is created by its owner, submitted and approved on the Moderation desk.
- `steps/team.js` (listings profile, after the gyms, and `--access-only`): the Round B3 business staff from `data.js` `BUSINESS_STAFF` sign up with a demo phone (so it is verified; no NID) and their owner adds them through `POST /me/team` with the default permissions. It needs the owner and the listing, so `--access-only` (`DEMO_SEED=access`) adds them to a database that already has the listings and reports "missing" otherwise. A re-run leaves someone already on the team as is (`ALREADY_MEMBER` is accepted) and never adds back someone the owner removed. Their password comes from `steps/access.js`.
- `steps/availability.js` (both profiles): the demo referee (01300000021) and trainer (01300000030) save a weekly repeat (Friday 09:00–13:00) and two one-off blocks in the next two weeks through `PUT /pro/availability/blocks`. A re-run keeps a calendar that still has an upcoming block.
- `steps/full.js`: paid flows through the simulator. Past activity is made as the tests make it: created in the near future, played through, then moved back in time. Only time columns of demo rows are changed. Demo players who are staff on a local database are left out (staff cannot use the customer API).
- `steps/reviews.js` (full profile, Round B1): released hire jobs for the referee, the umpire and the physio, received shop orders and used gym subscriptions, each rated by the demo player who paid, with a few owner replies; then the nightly hire stats recompute. The referee, the umpire, Iron Supply Tejgaon and PowerHouse Gym Mirpur show a rating (from `reviews.min_count_display`), the referee's `/pro/insights` shows earnings, and the demo member (01300000090) has a hire job, a sub-order and a gym pass waiting for a rating. Hire jobs and orders are moved back up to four weeks; gym visits stay today because front-desk admissions (`pass_redemptions`), like order lines and ledger postings, are append-only. A re-run finds each item by its demo account and skips it.
- `data.js`: the content. Names are invented; no real business or person.
- `photos/`: 54 Unsplash photos with `CREDITS.md`.

## How demo data is marked

- Every record the seeder creates is in `demo_records` (entity, id, run, profile). No other table has a demo flag.
- Demo phones are `+8801300000001` to `+8801300000199`.
- Fake NID numbers use district code 99, which no real NID has.
- Game UIDs are 12 digits starting `9999`, outside what the games hand out.
- Demo accounts have no email address, so no email is sent.
- The demo master and the demo review desk have no phone, email, password or Google link, so nobody can sign in as them. The demo sign-in staff (above) get a password only when `DEMO_PASSWORD` is set, and are never masters.

## Hiding

`demo:hide` changes statuses and deletes nothing:
1. Cancels the unfinished demo esports events (entries are refunded) and the showcase.
2. Cancels the demo sports events, as their organiser.
3. Suspends the demo accounts. The existing `user.suspended` consumers then pause their venues, gyms, shops and hire profiles. The business staff are demo accounts too: they are suspended, and their owners' suspension takes away their workplaces at once. Their team memberships are left as they are, so restoring the accounts brings the teams back.
4. Offboards the demo reviewer.

In the full local profile, the six finished esports events stay as history, and their suspended players leave the leaderboards and top players (Q161).

Hidden demo data stays hidden: the seeder notices the suspended demo accounts and does nothing. To show it again, restore those accounts on the admin desk.
