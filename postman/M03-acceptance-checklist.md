# M03 Settings and esports catalogue: Acceptance Checklist

Work through this list before starting M04. Tick each box when the result matches.
Request names refer to the **"Kriraghor API: M03 Settings & esports catalogue"** collection
(`postman/kriraghor-settings.postman_collection.json`, rebuilt with `node postman/build-collection-m03.js`).

## 0. Setup
- [ ] `docker compose up -d`. PostgreSQL is healthy (`docker compose ps`).
- [ ] `npm run release`. This applies the three M03 migrations and prints `reference seed done` with `settings: 155, esports: 23, templates: 122` the first time, and `0, 0` after that.
- [ ] `npm test` → **199 passed**, and the coverage gate passes (100% on the settings and catalogue validators). 🤖 marks cases only the tests cover.
- [ ] `node postman/run-m03.js` → **22 requests, 37 assertions, 0 failed**. It resets `kriraghor_test`, signs in two masters and pre-mints step-up tokens.

## 1. Public reads (M03-FR-02, FR-18)
| # | Do | Expect |
|---|---|---|
| 1.1 | **Public settings** | `200`. `fees` has only `groundBookingPct: 5`; money is `{ amount, currency: "BDT" }`; no `auth`, `risk` or room-reveal values; `Cache-Control: public, max-age=300` |
| 1.2 | Repeat 1.1 with `If-None-Match` set to the ETag | `304` 🤖 |
| 1.3 | **Esports games catalogue** | PUBG Mobile then Free Fire. PUBG squad 4 × 25 / 100; Free Fire squad 4 × 12 / 50; maps and presets as seeded |

## 2. Admin reads and guards (M03 §3, FR-15)
| # | Do | Expect |
|---|---|---|
| 2.1 | **All settings** (master) | 155 settings with label (EN + BN), unit, bounds, approval and version |
| 2.2 | `manage_catalog` staff read settings and history | `200`; proposing returns `403 MASTER_REQUIRED` 🤖 |
| 2.3 | Staff without `manage_catalog`, and a customer token | `403 PERMISSION_REQUIRED`, `401 TOKEN_AUDIENCE_INVALID` 🤖 |
| 2.4 | **Propose WITHOUT step-up** | `403 STEP_UP_REQUIRED` |
| 2.5 | **Empty change list** | `422 VALIDATION_FAILED`, and the step-up token is not spent 🤖 |

## 3. Changes (M03-FR-11 to FR-14)
| # | Do | Expect |
|---|---|---|
| 3.1 | **Room reveal 15 → 10 min** | `201 applied`. History shows v2 (15 → 10). Audit has `setting.changed` with `severity: critical` |
| 3.2 | **Cross-key rule** (check-in close 5 < room reveal 10) | `422 SETTING_CROSS_RULE` with the rule text |
| 3.3 | Out of range, wrong type, unknown key, unchanged value, past effective time | `SETTING_OUT_OF_RANGE`, `SETTING_TYPE_INVALID`, `SETTING_UNKNOWN`, `SETTING_UNCHANGED`, `400 EFFECTIVE_AT_PAST` 🤖 |
| 3.4 | A change with a future `effectiveAt` | `approved`; the value changes only when the `settings.apply-scheduled` job runs 🤖 |
| 3.5 | A scheduled change that a later change makes invalid | The job rejects it with "Could not apply: …" 🤖 |
| 3.6 | `settings_history`: `UPDATE` or `DELETE` in PostgreSQL | Refused: "settings_history is append-only" 🤖 |

## 4. Four-eyes (M03-FR-12, Q39)
| # | Do | Expect |
|---|---|---|
| 4.1 | **A proposes shop commission 5 → 6%** | `201 proposed`, `needsSecondApprover: true`; the value is still 5 |
| 4.2 | **A approves own proposal** | `403 FOUR_EYES_REQUIRED` (rejecting your own also returns it) |
| 4.3 | **B approves** | `200 applied`; v2 has `changedBy` A and `approvedBy` B |
| 4.4 | **B approves again** | `409 CHANGE_REQUEST_CLOSED` |
| 4.5 | Two open requests for the same key; approve one | The other becomes `superseded` 🤖 |
| 4.6 | Withdraw someone else's request | `403 NOT_PROPOSER` 🤖 |

## 5. Esports catalogue (§7.1)
| # | Do | Expect |
|---|---|---|
| 5.1 | **Add a map** (karakin) | `201`; audit `catalog_item.created` |
| 5.2 | **Change its key** | `422 CATALOG_KEY_IMMUTABLE` |
| 5.3 | **Deactivate** / **Reactivate** | Hidden from / back in `GET /catalog/esports/games`; the row is never deleted |
| 5.4 | Mode with 13 squads of 4 in 50 players | `422`, field `maxPlayers` 🤖 |
| 5.5 | Edit a points preset | Creates version 2; version 1 stays for the tournaments that used it 🤖 |

## 6. Portal (admin.kriraghor.localhost or localhost:3002)
| # | Do | Expect |
|---|---|---|
| 6.1 | **Fees and rules**: change shop commission to 6 | The field turns green; the bar shows "1 unsaved change" |
| 6.2 | Type 30 | "Between 0 and 25" under the field; **Review and save** is disabled |
| 6.3 | Review → reason → authenticator code → Save | "Waiting for second approval"; the proposal appears under **Pending changes** |
| 6.4 | Sign in as the second master → **Approve** with a code | Status "Applied"; the field shows v2; **History** lists v2 with both names |
| 6.5 | **Esports catalogue**: add, edit and deactivate a row | Saved notice; the key field is locked when editing |
