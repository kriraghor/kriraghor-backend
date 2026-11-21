# M24 · WhatsApp: acceptance checklist (M24 §25, ADR-012)

Tester feedback item 5 (19 Nov 2026); decisions 19 and 21 Nov 2026. Run unattended with
`DB_NAME=kriraghor_wa_postman node postman/run-m24-whatsapp.js` (its own database; the run switches sending on
against the memory driver). Rebuild the collection with `node postman/build-collection-m24-whatsapp.js`.

Last run 21 Nov 2026: 28 requests, 47 assertions, 0 failed.

## Step 1 (works today, every plan)
- [x] The owner's number for every branch: any Bangladesh form, stored E.164; a non-mobile is 422 (M24-FR-157)
- [x] The gym page returns the number; a branch's own number wins; staff cannot change it (M24-FR-157, FR-158)
- [x] The desk records a member's two consents ("the member agreed"); staff see the last 4 digits only (M24-FR-159)
- [x] The member reads and changes their own; another member's is 404 (M24-FR-159, FR-160)
- [x] Every change is an append-only row with the consent text's version (jest `gym-whatsapp.test.js`)

## Step 2 (built, switched off by `gym_whatsapp.api_enabled`)
- [x] Everything refused while off, and below the Standard plan (jest `gym-whatsapp-api.test.js`)
- [x] Units on with the month's allowance (M24-FR-166)
- [x] Connecting needs an Idempotency-Key; the number is stored without exposing the token; 16 templates created (M24-FR-161 to FR-163)
- [x] The webhook: Meta's check, a wrong signature 401, template approvals (M24-FR-169)
- [x] The estimate: who is reached and why not, the units needed (M24-FR-166)
- [x] Staff need `whatsapp.send` (M24-FR-168)
- [x] A notice: queued only to members who agreed to news, units held; history and the member's messages with text, no number (M24-FR-164, FR-168, FR-170)
- [x] A single update to a member who agreed to nothing is refused (M24-FR-164)
- [x] The automatic kinds per branch (M24-FR-165)
- [x] Disconnecting; sending then needs a number; twice is refused (M24-FR-161)
- [x] Delivered keeps the units, failed and expired give them back, statuses never move back, STOP opts out, a receipt on WhatsApp replaces the SMS, Meta removing the partner disconnects (jest)
