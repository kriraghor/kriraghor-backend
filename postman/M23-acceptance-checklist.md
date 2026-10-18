# M23 Esports big events (step 1): Acceptance Checklist

Tick each box when the result matches. Request names refer to the **"Kriraghor API: M23 Esports big events (step 1)"** collection
(`postman/kriraghor-events.postman_collection.json`, rebuilt with `node postman/build-collection-m23.js`).

Step 1 covers:
- the event hub over M21 tournaments, run by Kriraghor staff (`manage_esports`);
- online qualifiers feeding an **invite-only** final (M21 `entry_policy`), with link checks;
- qualifications: the top N of each finalised qualifier, staff invites (wildcards) and revokes, places given back on withdraw, withdrawn on disqualification, **missed** when the final closes;
- squads bring at least `esports_events.min_core_players` of the players who qualified;
- embedded YouTube and Facebook streams (built from a parsed video reference; TikTok and other links are shown as links);
- sponsor placements (no money in the app);
- free polls (one vote, final; totals only);
- the feed, realtime pings, and in-app follow alerts paged to followers.

Not in step 1:
- automatic pass-down to the next rank (Q147);
- SMS or push for follow alerts (Q148);
- sponsor category rules (Q149);
- events run by organisers (Q150);
- hosted video;
- the mobile app.

## 0. Setup
- [ ] `docker compose up -d`, then `npm run release`. This applies two migrations:
  - `20261103000001-esports-entry-policy` (M21): `esports_tournaments.entry_policy` (`open` or `invite`, locked after publish) and `esports_streams.video_ref`;
  - `20261103000002-create-esports-events` (M23): `esports_events`, `_stages` (one active event per tournament), `_qualifications` (one live place per final and squad or user), `_streams`, `_sponsors`, `_polls`, `_poll_options`, `_poll_votes` (append-only, one per member), `_follows`, `_feed` (append-only), `_alerts`.

  The seed adds:
  - settings v19 (276 settings): `esports_events.*` (qualifying gap, core players, final reminder, alert cooldown, fan-out batch, poll options, push and cache, feed page, stages, sponsors, banner size, actions per minute);
  - templates v16 (`ESPORTS_EVENT_*`).

  The M08 category `event_alerts` (in-app) and the gate `vote_poll` (a verified phone) are code changes, not seed rows.
- [ ] `npm test`: everything green, including the coverage gates (100% on `events.rules.js` and `streams.rules.js`). 🤖 marks cases only the tests cover.
- [ ] `node postman/run-m23.js` → **0 failed**.
  - The runner resets `kriraghor_test`.
  - It publishes five tournaments and signs up seven players and a fan.
  - It serves `{{controlUrl}}`: `/settle`, `/play`, `/open`, `/close`, `/start`, `/check`.
- [ ] `run-m02.js` to `run-m22.js` still pass. M03 counts 276 settings.

## 1. The event and its links
| # | Do | Expect |
|---|---|---|
| 1.1 | **A draft event**, **Ends before it starts** | Draft (phase `draft`, accent `#f2a33a`); 422 `EVENT_DATES_INVALID` |
| 1.2 | **Publish with nothing linked** | 409 `EVENT_NOT_PUBLISHABLE` |
| 1.3 | **An open final fed by a qualifier** | 422 `EVENT_FINAL_NOT_INVITE` |
| 1.4 | **Too few final slots** | 422 `EVENT_FINAL_SLOTS` |
| 1.5 | **A qualifier finishing too late** | 422 `EVENT_QUALIFY_GAP`: the final must close registration at least `esports_events.min_qualify_gap_minutes` after the qualifier starts |
| 1.6 | **A tournament twice** | 422 `EVENT_STAGES_INVALID` |
| 1.7 | Mode, game or entry type differ 🤖; another organiser's tournament 🤖 | 422 `EVENT_LINK_MISMATCH`; 422 `EVENT_TOURNAMENT_NOT_OURS` |
| 1.8 | **Two qualifiers, top 2 each, feed the final**, **Publish** | Three stages; published |
| 1.9 | The same tournament in another event 🤖 | 409 `EVENT_TOURNAMENT_IN_OTHER_EVENT` |
| 1.10 | **The public page**, **The event list**, **The link check** | Phase live, stages final → qualifiers, prize total ৳2,100 (the linked prize pools); listed; the link check passes with 4 qualifying |
| 1.11 | A draft event's page 🤖 | 404 |
| 1.12 | The final's entry policy after publish 🤖 | 409 `ESPORTS_PRIZE_TABLE_LOCKED` |

## 2. Qualifiers
| # | Do | Expect |
|---|---|---|
| 2.1 | **Q1 finishes A, B, C**, **Q2 finishes D, E, F** | Each finalise puts its top 2 in: four `qualified` places, ranks 1 and 2 |
| 2.2 | The players hear 🤖 | `ESPORTS_EVENT_QUALIFIED` (in-app and SMS) to A, B, D and E; nothing to C or F |
| 2.3 | **The feed** | A `tournament_finalised` and a `qualified` item per qualifier |
| 2.4 | **E is disqualified in Q2 after qualifying** | E's place is revoked (`ESPORTS_EVENT_QUALIFICATION_REVOKED`). Nobody moves up (Q147) |
| 2.5 | A qualifier finalised after the final closed 🤖 | Its places are `missed` at once, and staff are told |

## 3. The invite-only final
| # | Do | Expect |
|---|---|---|
| 3.1 | **C did not qualify** | 403 `EVENT_NOT_QUALIFIED` |
| 3.2 | **A enters**, **A withdraws**, **A enters again** | Confirmed and the place is `entered`; the withdrawal gives the place back (`qualified`); A enters again |
| 3.3 | **Invite G as a wildcard**, **Twice**, **G enters** | Invited (no rank); 409 `EVENT_ALREADY_QUALIFIED`; G enters |
| 3.4 | Invite a squad of another game, or a player without a verified UID 🤖 | 422 `EVENT_INVITE_INVALID` |
| 3.5 | **Revoke B's unused place**, **B is refused now** | Revoked; 403 `EVENT_NOT_QUALIFIED` |
| 3.6 | Revoke a place already used 🤖 | 409 `EVENT_QUALIFICATION_STATE` |
| 3.7 | **registration closes; the tick** | D's unused place is `missed`; staff get `ESPORTS_EVENT_QUALIFICATION_MISSED` |
| 3.8 | A squad final 🤖 | Only the qualified squad's captain enters. With fewer than `min_core_players` of its qualified players: 422 `EVENT_CORE_PLAYERS` |
| 3.9 | The final is cancelled 🤖 | Its open places are revoked |

## 4. Viewers
| # | Do | Expect |
|---|---|---|
| 4.1 | **Follow** | Following, 1 follower. An unpublished event cannot be followed (404) 🤖 |
| 4.2 | **A plain-http stream** | 422 `STREAM_URL_INVALID` |
| 4.3 | **The main stage goes live** | `embedUrl` is youtube-nocookie for YouTube; TikTok is a link (null); a `stream_live` feed item and a room ping |
| 4.4 | **A second live stream within the cooldown**, **alerts sent** | One alert, one in-app notification to the fan: `esports_events.alert_cooldown_minutes` |
| 4.5 | Paging 🤖 | 120 followers in pages of `esports_events.fanout_batch` (50): 3 pages, 120 notifications, none to someone who unfollowed |
| 4.6 | A tournament's own stream goes live 🤖 | M21 `esports_stream.live_started` reaches the event (a feed item) |
| 4.7 | The tick 🤖 | `ESPORTS_EVENT_STARTED` once when the event starts; `ESPORTS_EVENT_FINAL_SOON` once, `esports_events.final_reminder_minutes` before the final |
| 4.8 | **A sponsor on http**, **The title sponsor**, **A gold sponsor** | 422 `SPONSOR_URL_INVALID`; added. Logos and the banner are JPEG, PNG or WebP only, checked by their first bytes 🤖 |
| 4.9 | **A poll** (duplicate options refused), **A draft takes no votes**, **Open it**, **Vote**, **Again** | 422 `POLL_OPTIONS_INVALID`; 409 `POLL_CLOSED`; totals 1 vote, 100%; 409 `POLL_ALREADY_VOTED` |
| 4.10 | **My follow and votes** | Following, with my vote (served by `/me`, so the page stays cacheable) |
| 4.11 | **An announcement**, **The page** | Sponsors title first; the poll shows totals only (no voters, no my-vote); the feed starts with the announcement |
| 4.12 | **Remove the title sponsor** | Kept with status `removed`, off the page |
| 4.13 | **Cancel while the final runs** | 409 `EVENT_TOURNAMENT_RUNNING`. A cancel never cancels tournaments 🤖 |
| 4.14 | **Unfollow** | Not following, 0 followers |
