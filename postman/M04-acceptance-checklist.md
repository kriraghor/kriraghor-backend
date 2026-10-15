# M04 Audit log and domain events: Acceptance Checklist

Work through this list before starting M08. Tick each box when the result matches.
Request names refer to the **"Kriraghor API: M04 Audit log & events"** collection
(`postman/kriraghor-audit-events.postman_collection.json`, rebuilt with `node postman/build-collection-m04.js`).

## 0. Setup
- [ ] `docker compose up -d`, then `npm run release`. This applies migrations `20261017000001` to `…04` and seeds the 7 new `operations` settings (137 in total).
- [ ] `npm test`: everything green, including the coverage gate (100% on the redactor, the retry backoff and the event registry rules). 🤖 marks cases only the tests cover.
- [ ] `node postman/run-m04.js` → **0 failed**. It resets `kriraghor_test`, signs in a master, pre-mints step-up tokens and runs a small worker loop (relay, consumers, exports) next to the API.
- [ ] `node postman/run-m03.js` still passes (M03 now writes real outbox events).

## 1. Audit rows (M04-FR-01 to FR-04, FR-11)
| # | Do | Expect |
|---|---|---|
| 1.1 | Ban a user (master + step-up `user.ban`) | Audit row `user.banned`: actor type master, module M01, severity critical, step-up true, session id. The outbox gets `user.banned`, `session.revoked` and `audit.critical_recorded` |
| 1.2 | Make a change fail after its audit row was written | Neither the audit row nor the outbox row remains 🤖 |
| 1.3 | Make the audit insert fail | The business change fails too (500) 🤖 |
| 1.4 | `UPDATE`/`DELETE` on `audit_logs` or `audit_chain` in MySQL | Refused: "… is append-only" |
| 1.5 | Change an email | `before`/`after` show `f***@example.com`; phones keep 3 digits; tokens and NID become `[redacted]` 🤖 |

## 2. Hash chain (FR-05, Q44)
| # | Do | Expect |
|---|---|---|
| 2.1 | Wait a minute after an action, open it in the portal Audit log | Tamper check: "Sealed #n, intact" |
| 2.2 | Drop the trigger, edit an audit row, restore the trigger, run `audit.chain-verify` | Reports the first bad link; the drawer shows "CHANGED since sealing"; `audit.chain_mismatch_detected` is published 🤖 |

## 3. Search and history (FR-07, FR-08, FR-09)
| # | Do | Expect |
|---|---|---|
| 3.1 | **Last 7 days** | Entries newest first with EN and BN summaries, masked IPs, cursor paging |
| 3.2 | **Range over a year** | `422 RANGE_TOO_LARGE` |
| 3.3 | Staff (not master) opens `/admin/audit-logs` | `403 MASTER_REQUIRED`; their entity history shows only rows they acted on 🤖 |
| 3.4 | **Entity history of the setting** | The `setting.changed` row for the key |

## 4. Outbox and consumers (FR-12 to FR-17)
| # | Do | Expect |
|---|---|---|
| 4.1 | **Published by the relay** | `health.pending` 0 within a couple of seconds of a change |
| 4.2 | Publish an unknown event, an invalid payload, or a payload with `phone` | `EVENT_INVALID` before commit 🤖 |
| 4.3 | Three relays at once over 25 events | Each (event, consumer) enqueued exactly once 🤖 |
| 4.4 | Deliver the same event twice | The handler runs once; `consumed_events` has one `processed` row 🤖 |
| 4.5 | A handler that always fails | Retries with growing delays, then a `dead` row and `outbox.event_dead_lettered`; other events keep flowing 🤖 |
| 4.6 | Portal **Events → Dead letters → Replay** with an authenticator code | `202`; `outbox.event_replayed` in the audit log; replaying a processed pair returns `409 EVENT_NOT_REPLAYABLE` |

## 5. Export (FR-10)
| # | Do | Expect |
|---|---|---|
| 5.1 | **Export without step-up** | `403 STEP_UP_REQUIRED` |
| 5.2 | **Request a CSV export** → **Export is ready** → **Download the CSV** | `202`, then `ready` with a row count, then a CSV whose header starts `id,occurredAt,actorType` |
| 5.3 | **The export audited itself** | `audit_log.exported`, critical |
| 5.4 | Another master opens your export; or the link is older than 24 h | `404`; `410 EXPORT_EXPIRED` 🤖 |

## 6. Portal (admin.kriraghor.localhost)
| # | Do | Expect |
|---|---|---|
| 6.1 | **Audit log**: filter `setting.changed`, open a row | Drawer with the before/after diff, reason, request, session and tamper check |
| 6.2 | **Export CSV** with a code | "Export ready: N rows", then **Download CSV** saves the file |
| 6.3 | **Fees and rules → History** on a setting | Version history plus the **Audit trail** of the setting |
| 6.4 | **Events** | Pending count, oldest age, red banner if the oldest waits over 60 s |
