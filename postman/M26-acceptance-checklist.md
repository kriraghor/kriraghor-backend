# M26 Tournament feed: Acceptance Checklist

Tick each box when the result matches. Request names refer to the **"Kriraghor API: M26 Tournament feed"** collection
(`postman/kriraghor-tournament-feed.postman_collection.json`, rebuilt with `node postman/build-collection-m26.js`).

Unattended: `node postman/run-m26.js` (uses the `kriraghor_test` database, never a real one).

Nobody organises tournaments on Kriraghor (product owner, 3 Nov 2026; ADR-008): people post about the ones they run. No money moves in this module.

## 1. Posting (M26-FR-01 to FR-04)
- [ ] Posting needs an account (401) and a verified phone (403 `PHONE_REQUIRED`).
- [ ] A past start, registration closing after the start, a map link that isn't Google Maps and an unknown sport are each refused (422).
- [ ] A phone number in public text is refused (422 `CONTACT_NOT_ALLOWED`) and names the field.
- [ ] A valid post is live at once. Its page shows every detail, signed out, with no phone number on it.
- [ ] Only its author can edit it (403 `TOURNAMENT_POST_NOT_YOURS`).

## 2. The feed (M26-FR-05)
- [ ] The feed reads signed out.
- [ ] Sport, district, free or paid, registration open and search each narrow it. A bad sort is refused.

## 3. Comments (M26-FR-06)
- [ ] Commenting needs an account, and a phone number is refused.
- [ ] Anyone reads comments. The post's author is told about a new one.
- [ ] Only the writer or the post's author can remove a comment.

## 4. Private messages (M26-FR-07)
- [ ] You can't message your own post. Opening a thread twice finds the same one.
- [ ] A phone number is fine here. The other person sees an unread message and is told.
- [ ] Nobody else can read or write in the thread (404).

## 5. Reports and staff (M26-FR-09)
- [ ] Reports on a post and on a comment reach the Reports desk. Upholding one removes the comment.
- [ ] Staff with `approve_listings` list every post. A removal needs a reason.
- [ ] A removed post leaves the feed and is 404 for the public. Its author sees why and is told. Its threads stop.
- [ ] Restoring puts it back as it was. Restoring again is refused (409).

## 6. Closing and expiry (M26-FR-08)
- [ ] Only its author can close a post. It leaves the feed, stays readable, and takes no more comments.
- [ ] The job expires an open post past its last day plus `tournament_posts.expire_days_after_end`.
- [ ] My posts keep them all.
