# Demo data

Realistic demo content for every public section, so the sites can be shown before real businesses join. Docs: kriraghor-docs `00-platform/13-demo-data.md`.

## Commands

| Command | What it does |
|---|---|
| `npm run demo:seed -- --profile=full` | Everything, locally: listings plus bookings, orders, passes, hire jobs, finished esports events with results and prizes, leaderboards, top players, reviews and notifications. Payments go through the simulator, so it needs `PAYMENTS_SIMULATOR=true` and never runs in production. |
| `npm run demo:seed -- --profile=listings` | Venues, shops and products, gyms, hire profiles and trainers, players with game IDs, upcoming esports events (free entry), the showcase and sports events. Takes no payment. Safe for production with `--confirm-live`. |
| `npm run demo:hide -- --dry-run` | Lists what hiding would change. |
| `npm run demo:hide` | Hides all demo data (add `--confirm-live` in production). |

**On a host without a shell** (Render's free plan): set the environment variable `DEMO_SEED=listings` on the backend service. After the API starts and is ready, it runs the listings seeder in the background with its own environment; the log shows each step and "Demo records: …" at the end. Remove the variable afterwards. `DEMO_SEED=hide` runs the hide command the same way. Only these two values are accepted (never the full profile). If the host restarts mid-run (a free instance sleeps after 15 minutes without visitors), the next start resumes it.

Both commands are safe to re-run: the seeder skips what exists, and a second run takes under a minute. A fresh run takes about 3.5 minutes for listings (it waits one minute for esports registration to open), plus about 3 minutes for the full profile.

Local needs: PostgreSQL, Redis and the S3 container from `docker compose up -d` (photos are uploaded to the public bucket), and the S3 and simulator lines from `.env.example` in `.env`.

## How it works

- `runtime.js` starts the API in-process on a loopback port and calls the real routes, so every gate, validation rule, Moderation review, ledger posting and event applies. It mints sessions for demo accounts instead of signing in, and relays and consumes events in-process (what the worker does).
- `steps/people.js`: two demo staff (a master who drafts Kriraghor's own events and a reviewer for the four-eyes desk), members, NID verification and business roles through M01, M02 and M05.
- `steps/listings.js`: every listing is created by its owner, submitted and approved on the Moderation desk.
- `steps/full.js`: paid flows through the simulator. Past activity is made as the tests make it: created in the near future, played through, then moved back in time. Only time columns of demo rows are changed.
- `data.js`: the content. Names are invented; no real business or person.
- `photos/`: 54 Unsplash photos with `CREDITS.md`.

## How demo data is marked

- Every record the seeder creates is in `demo_records` (entity, id, run, profile). No other table has a demo flag.
- Demo phones are `+8801300000001` to `+8801300000199`.
- Fake NID numbers use district code 99, which no real NID has.
- Game UIDs are 12 digits starting `9999`, outside what the games hand out.
- Demo accounts have no email address, so no email is sent.
- The two demo staff accounts have no phone, email, password or Google link, so nobody can sign in as them.

## Hiding

`demo:hide` changes statuses and deletes nothing:
1. Cancels the unfinished demo esports events (entries are refunded) and the showcase.
2. Cancels the demo sports events, as their organiser.
3. Suspends the demo accounts. The existing `user.suspended` consumers then pause their venues, gyms, shops and hire profiles.
4. Offboards the demo reviewer.

In the full local profile, the six finished esports events stay as history, and their suspended players leave the leaderboards and top players (Q161).

Hidden demo data stays hidden: the seeder notices the suspended demo accounts and does nothing. To show it again, restore those accounts on the admin desk.
