'use strict';

/**
 * User-facing words (19 Oct 2026): Grounds → Venues, Tournaments → Events, big events → Showcases.
 * Code names, API paths and tables do not change. Text only, and only where it still reads as the
 * seed wrote it, so anything staff edited on the desks is left alone:
 *  - message templates (M08): a new active version per (code, channel, locale), the old one kept;
 *  - setting labels (M03), document requirement texts (M02), rubric items and rejection reasons (M05),
 *    one hire credential tier label (M11): updated in place.
 * The pairs are frozen here; the seed files carry the same words for new databases.
 */
const PAIRS = {
  "templates": [
    {
      "code": "ESPORTS_UID_VERIFIED",
      "channel": "in_app",
      "locale": "en",
      "subjectFrom": "UID verified",
      "subjectTo": "UID verified",
      "bodyFrom": "Your game UID is verified. You can join tournaments now.",
      "bodyTo": "Your game UID is verified. You can join events now."
    },
    {
      "code": "ESPORTS_UID_VERIFIED",
      "channel": "in_app",
      "locale": "bn",
      "subjectFrom": "UID যাচাই হয়েছে",
      "subjectTo": "UID যাচাই হয়েছে",
      "bodyFrom": "আপনার গেম UID যাচাই হয়েছে। এখন টুর্নামেন্টে যোগ দিতে পারবেন।",
      "bodyTo": "আপনার গেম UID যাচাই হয়েছে। এখন ইভেন্টে যোগ দিতে পারবেন।"
    },
    {
      "code": "ESPORTS_CANCELLED",
      "channel": "in_app",
      "locale": "en",
      "subjectFrom": "Tournament cancelled",
      "subjectTo": "Event cancelled",
      "bodyFrom": "{{title}} is cancelled. Paid entries are refunded in full.",
      "bodyTo": "{{title}} is cancelled. Paid entries are refunded in full."
    },
    {
      "code": "ESPORTS_CANCELLED",
      "channel": "in_app",
      "locale": "bn",
      "subjectFrom": "টুর্নামেন্ট বাতিল",
      "subjectTo": "ইভেন্ট বাতিল",
      "bodyFrom": "{{title}} বাতিল হয়েছে। পরিশোধিত এন্ট্রির পুরো টাকা ফেরত দেওয়া হবে।",
      "bodyTo": "{{title}} বাতিল হয়েছে। পরিশোধিত এন্ট্রির পুরো টাকা ফেরত দেওয়া হবে।"
    },
    {
      "code": "BUSINESS_DOC_REVIEW_NEEDED",
      "channel": "in_app",
      "locale": "en",
      "subjectFrom": "Owner documents to review",
      "subjectTo": "Owner documents to review",
      "bodyFrom": "A ground owner's {{doc}} is waiting on the Moderation desk.",
      "bodyTo": "A venue owner's {{doc}} is waiting on the Moderation desk."
    },
    {
      "code": "BUSINESS_DOC_REVIEW_NEEDED",
      "channel": "in_app",
      "locale": "bn",
      "subjectFrom": "মালিকের কাগজ যাচাই",
      "subjectTo": "মালিকের কাগজ যাচাই",
      "bodyFrom": "মডারেশন ডেস্কে একজন মাঠ মালিকের {{doc}} অপেক্ষায়।",
      "bodyTo": "মডারেশন ডেস্কে একজন ভেন্যু মালিকের {{doc}} অপেক্ষায়।"
    },
    {
      "code": "GROUND_LIVE",
      "channel": "in_app",
      "locale": "en",
      "subjectFrom": "Ground approved",
      "subjectTo": "Venue approved",
      "bodyFrom": "{{name}} is approved and live on Kriraghor.",
      "bodyTo": "{{name}} is approved and live on Kriraghor."
    },
    {
      "code": "GROUND_LIVE",
      "channel": "in_app",
      "locale": "bn",
      "subjectFrom": "মাঠ অনুমোদিত",
      "subjectTo": "ভেন্যু অনুমোদিত",
      "bodyFrom": "{{name}} অনুমোদিত হয়েছে এবং ক্রীড়াঘরে লাইভ।",
      "bodyTo": "{{name}} অনুমোদিত হয়েছে এবং ক্রীড়াঘরে লাইভ।"
    },
    {
      "code": "GROUND_REJECTED",
      "channel": "in_app",
      "locale": "en",
      "subjectFrom": "Ground not approved",
      "subjectTo": "Venue not approved",
      "bodyFrom": "{{name}} was not approved: {{reason}}.",
      "bodyTo": "{{name}} was not approved: {{reason}}."
    },
    {
      "code": "GROUND_REJECTED",
      "channel": "in_app",
      "locale": "bn",
      "subjectFrom": "মাঠ অনুমোদিত হয়নি",
      "subjectTo": "ভেন্যু অনুমোদিত হয়নি",
      "bodyFrom": "{{name}} অনুমোদিত হয়নি: {{reason}}।",
      "bodyTo": "{{name}} অনুমোদিত হয়নি: {{reason}}।"
    },
    {
      "code": "GROUND_REVIEW_NEEDED",
      "channel": "in_app",
      "locale": "en",
      "subjectFrom": "Ground to review",
      "subjectTo": "Venue to review",
      "bodyFrom": "A ground ({{name}}) is waiting on the Moderation desk.",
      "bodyTo": "A venue ({{name}}) is waiting on the Moderation desk."
    },
    {
      "code": "GROUND_REVIEW_NEEDED",
      "channel": "in_app",
      "locale": "bn",
      "subjectFrom": "যাচাইয়ের জন্য মাঠ",
      "subjectTo": "যাচাইয়ের জন্য ভেন্যু",
      "bodyFrom": "মডারেশন ডেস্কে একটি মাঠ ({{name}}) অপেক্ষায়।",
      "bodyTo": "মডারেশন ডেস্কে একটি ভেন্যু ({{name}}) অপেক্ষায়।"
    },
    {
      "code": "ORG_CONTRACT_ACTIVE",
      "channel": "in_app",
      "locale": "en",
      "subjectFrom": "Your esports contract is active",
      "subjectTo": "Your esports contract is active",
      "bodyFrom": "{{name}} can now run tournaments on Kriraghor. Create one in the organiser console.",
      "bodyTo": "{{name}} can now run events on Kriraghor. Create one in the organiser console."
    },
    {
      "code": "ORG_CONTRACT_ACTIVE",
      "channel": "in_app",
      "locale": "bn",
      "subjectFrom": "আপনার ইস্পোর্টস চুক্তি চালু",
      "subjectTo": "আপনার ইস্পোর্টস চুক্তি চালু",
      "bodyFrom": "{{name}} এখন ক্রীড়াঘরে টুর্নামেন্ট চালাতে পারবে। আয়োজক কনসোলে একটি তৈরি করুন।",
      "bodyTo": "{{name}} এখন ক্রীড়াঘরে ইভেন্ট চালাতে পারবে। আয়োজক কনসোলে একটি তৈরি করুন।"
    },
    {
      "code": "ORG_CONTRACT_ACTIVE",
      "channel": "email",
      "locale": "en",
      "subjectFrom": "Your esports contract is active",
      "subjectTo": "Your esports contract is active",
      "bodyFrom": "{{name}} can now run tournaments on Kriraghor. Create one in the organiser console.",
      "bodyTo": "{{name}} can now run events on Kriraghor. Create one in the organiser console."
    },
    {
      "code": "ORG_CONTRACT_ACTIVE",
      "channel": "email",
      "locale": "bn",
      "subjectFrom": "আপনার ইস্পোর্টস চুক্তি চালু",
      "subjectTo": "আপনার ইস্পোর্টস চুক্তি চালু",
      "bodyFrom": "{{name}} এখন ক্রীড়াঘরে টুর্নামেন্ট চালাতে পারবে। আয়োজক কনসোলে একটি তৈরি করুন।",
      "bodyTo": "{{name}} এখন ক্রীড়াঘরে ইভেন্ট চালাতে পারবে। আয়োজক কনসোলে একটি তৈরি করুন।"
    },
    {
      "code": "ORG_CONTRACT_SUSPENDED",
      "channel": "in_app",
      "locale": "en",
      "subjectFrom": "Your esports contract is suspended",
      "subjectTo": "Your esports contract is suspended",
      "bodyFrom": "New tournaments of {{name}} are on hold. Tournaments already open will finish.",
      "bodyTo": "New events of {{name}} are on hold. Events already open will finish."
    },
    {
      "code": "ORG_CONTRACT_SUSPENDED",
      "channel": "in_app",
      "locale": "bn",
      "subjectFrom": "আপনার ইস্পোর্টস চুক্তি স্থগিত",
      "subjectTo": "আপনার ইস্পোর্টস চুক্তি স্থগিত",
      "bodyFrom": "{{name}}-এর নতুন টুর্নামেন্ট বন্ধ। যেগুলো চলছে সেগুলো শেষ হবে।",
      "bodyTo": "{{name}}-এর নতুন ইভেন্ট বন্ধ। যেগুলো চলছে সেগুলো শেষ হবে।"
    },
    {
      "code": "ORG_CONTRACT_SUSPENDED",
      "channel": "email",
      "locale": "en",
      "subjectFrom": "Your esports contract is suspended",
      "subjectTo": "Your esports contract is suspended",
      "bodyFrom": "New tournaments of {{name}} are on hold. Tournaments already open will finish.",
      "bodyTo": "New events of {{name}} are on hold. Events already open will finish."
    },
    {
      "code": "ORG_CONTRACT_SUSPENDED",
      "channel": "email",
      "locale": "bn",
      "subjectFrom": "আপনার ইস্পোর্টস চুক্তি স্থগিত",
      "subjectTo": "আপনার ইস্পোর্টস চুক্তি স্থগিত",
      "bodyFrom": "{{name}}-এর নতুন টুর্নামেন্ট বন্ধ। যেগুলো চলছে সেগুলো শেষ হবে।",
      "bodyTo": "{{name}}-এর নতুন ইভেন্ট বন্ধ। যেগুলো চলছে সেগুলো শেষ হবে।"
    },
    {
      "code": "ORG_INVOICE_OVERDUE",
      "channel": "in_app",
      "locale": "en",
      "subjectFrom": "Invoice {{number}} is overdue",
      "subjectTo": "Invoice {{number}} is overdue",
      "bodyFrom": "Invoice {{number}} ({{total}}) is overdue. Pay it soon: new tournaments are blocked after the grace days.",
      "bodyTo": "Invoice {{number}} ({{total}}) is overdue. Pay it soon: new events are blocked after the grace days."
    },
    {
      "code": "ORG_INVOICE_OVERDUE",
      "channel": "in_app",
      "locale": "bn",
      "subjectFrom": "ইনভয়েস {{number}} বকেয়া",
      "subjectTo": "ইনভয়েস {{number}} বকেয়া",
      "bodyFrom": "ইনভয়েস {{number}} ({{total}}) বকেয়া। দ্রুত পরিশোধ করুন: সময় পার হলে নতুন টুর্নামেন্ট বন্ধ হবে।",
      "bodyTo": "ইনভয়েস {{number}} ({{total}}) বকেয়া। দ্রুত পরিশোধ করুন: সময় পার হলে নতুন ইভেন্ট বন্ধ হবে।"
    },
    {
      "code": "ORG_INVOICE_OVERDUE",
      "channel": "email",
      "locale": "en",
      "subjectFrom": "Invoice {{number}} is overdue",
      "subjectTo": "Invoice {{number}} is overdue",
      "bodyFrom": "Invoice {{number}} ({{total}}) is overdue. Pay it soon: new tournaments are blocked after the grace days.",
      "bodyTo": "Invoice {{number}} ({{total}}) is overdue. Pay it soon: new events are blocked after the grace days."
    },
    {
      "code": "ORG_INVOICE_OVERDUE",
      "channel": "email",
      "locale": "bn",
      "subjectFrom": "ইনভয়েস {{number}} বকেয়া",
      "subjectTo": "ইনভয়েস {{number}} বকেয়া",
      "bodyFrom": "ইনভয়েস {{number}} ({{total}}) বকেয়া। দ্রুত পরিশোধ করুন: সময় পার হলে নতুন টুর্নামেন্ট বন্ধ হবে।",
      "bodyTo": "ইনভয়েস {{number}} ({{total}}) বকেয়া। দ্রুত পরিশোধ করুন: সময় পার হলে নতুন ইভেন্ট বন্ধ হবে।"
    },
    {
      "code": "ORG_INVOICE_OVERDUE",
      "channel": "sms",
      "locale": "en",
      "subjectFrom": null,
      "subjectTo": null,
      "bodyFrom": "Kriraghor: invoice {{number}} ({{total}}) is overdue. Pay it to keep sending new tournaments.",
      "bodyTo": "Kriraghor: invoice {{number}} ({{total}}) is overdue. Pay it to keep sending new events."
    },
    {
      "code": "ORG_INVOICE_OVERDUE",
      "channel": "sms",
      "locale": "bn",
      "subjectFrom": null,
      "subjectTo": null,
      "bodyFrom": "ক্রীড়াঘর: ইনভয়েস {{number}} ({{total}}) বকেয়া। নতুন টুর্নামেন্ট চালাতে পরিশোধ করুন।",
      "bodyTo": "ক্রীড়াঘর: ইনভয়েস {{number}} ({{total}}) বকেয়া। নতুন ইভেন্ট চালাতে পরিশোধ করুন।"
    },
    {
      "code": "TOURNAMENT_APPROVED",
      "channel": "in_app",
      "locale": "en",
      "subjectFrom": "Tournament approved",
      "subjectTo": "Event approved",
      "bodyFrom": "{{tournament}} is approved: registration is open.",
      "bodyTo": "{{tournament}} is approved: registration is open."
    },
    {
      "code": "TOURNAMENT_APPROVED",
      "channel": "in_app",
      "locale": "bn",
      "subjectFrom": "টুর্নামেন্ট অনুমোদিত",
      "subjectTo": "ইভেন্ট অনুমোদিত",
      "bodyFrom": "{{tournament}} অনুমোদিত হয়েছে: নিবন্ধন খোলা।",
      "bodyTo": "{{tournament}} অনুমোদিত হয়েছে: নিবন্ধন খোলা।"
    },
    {
      "code": "TOURNAMENT_REJECTED",
      "channel": "in_app",
      "locale": "en",
      "subjectFrom": "Tournament not approved",
      "subjectTo": "Event not approved",
      "bodyFrom": "{{tournament}} was not approved. Open the console for the reason.",
      "bodyTo": "{{tournament}} was not approved. Open the console for the reason."
    },
    {
      "code": "TOURNAMENT_REJECTED",
      "channel": "in_app",
      "locale": "bn",
      "subjectFrom": "টুর্নামেন্ট অনুমোদিত হয়নি",
      "subjectTo": "ইভেন্ট অনুমোদিত হয়নি",
      "bodyFrom": "{{tournament}} অনুমোদন পায়নি। কারণ কনসোলে দেখুন।",
      "bodyTo": "{{tournament}} অনুমোদন পায়নি। কারণ কনসোলে দেখুন।"
    },
    {
      "code": "RESERVE_OFFERED",
      "channel": "sms",
      "locale": "en",
      "subjectFrom": null,
      "subjectTo": null,
      "bodyFrom": "Kriraghor: a place in {{tournament}} is offered to {{team}} until {{until}}. Open My tournaments.",
      "bodyTo": "Kriraghor: a place in {{tournament}} is offered to {{team}} until {{until}}. Open My events."
    },
    {
      "code": "TOURNAMENT_CANCELLED",
      "channel": "in_app",
      "locale": "en",
      "subjectFrom": "Tournament cancelled",
      "subjectTo": "Event cancelled",
      "bodyFrom": "{{tournament}} is cancelled. Refund: {{refund}}.",
      "bodyTo": "{{tournament}} is cancelled. Refund: {{refund}}."
    },
    {
      "code": "TOURNAMENT_CANCELLED",
      "channel": "in_app",
      "locale": "bn",
      "subjectFrom": "টুর্নামেন্ট বাতিল",
      "subjectTo": "ইভেন্ট বাতিল",
      "bodyFrom": "{{tournament}} বাতিল হয়েছে। ফেরত: {{refund}}।",
      "bodyTo": "{{tournament}} বাতিল হয়েছে। ফেরত: {{refund}}।"
    }
  ],
  "settings": [
    {
      "key": "fees.ground_booking_pct",
      "column": "label_en",
      "from": "Ground booking fee",
      "to": "Venue booking fee"
    },
    {
      "key": "fees.ground_booking_pct",
      "column": "label_bn",
      "from": "মাঠ বুকিং ফি",
      "to": "ভেন্যু বুকিং ফি"
    },
    {
      "key": "fees.tournament_pct",
      "column": "label_en",
      "from": "Tournament fee",
      "to": "Event fee"
    },
    {
      "key": "fees.tournament_pct",
      "column": "label_bn",
      "from": "টুর্নামেন্ট ফি",
      "to": "ইভেন্ট ফি"
    },
    {
      "key": "ground.base_price_min_poisha",
      "column": "label_en",
      "from": "Lowest hourly ground price",
      "to": "Lowest hourly venue price"
    },
    {
      "key": "ground.base_price_min_poisha",
      "column": "label_bn",
      "from": "সর্বনিম্ন ঘণ্টাপ্রতি মাঠ ভাড়া",
      "to": "সর্বনিম্ন ঘণ্টাপ্রতি ভেন্যু ভাড়া"
    },
    {
      "key": "ground.base_price_max_poisha",
      "column": "label_en",
      "from": "Highest hourly ground price",
      "to": "Highest hourly venue price"
    },
    {
      "key": "ground.base_price_max_poisha",
      "column": "label_bn",
      "from": "সর্বোচ্চ ঘণ্টাপ্রতি মাঠ ভাড়া",
      "to": "সর্বোচ্চ ঘণ্টাপ্রতি ভেন্যু ভাড়া"
    },
    {
      "key": "ground.min_photos",
      "column": "label_en",
      "from": "Photos a ground needs before review",
      "to": "Photos a venue needs before review"
    },
    {
      "key": "ground.min_photos",
      "column": "label_bn",
      "from": "রিভিউর আগে মাঠের ছবি লাগবে",
      "to": "রিভিউর আগে ভেন্যুর ছবি লাগবে"
    },
    {
      "key": "ground.max_photos",
      "column": "label_en",
      "from": "Most photos per ground",
      "to": "Most photos per venue"
    },
    {
      "key": "ground.max_photos",
      "column": "label_bn",
      "from": "মাঠপ্রতি সর্বোচ্চ ছবি",
      "to": "ভেন্যুপ্রতি সর্বোচ্চ ছবি"
    },
    {
      "key": "ground.photo_max_bytes",
      "column": "label_en",
      "from": "Largest ground photo",
      "to": "Largest venue photo"
    },
    {
      "key": "ground.photo_max_bytes",
      "column": "label_bn",
      "from": "মাঠের ছবির সর্বোচ্চ আকার",
      "to": "ভেন্যুর ছবির সর্বোচ্চ আকার"
    },
    {
      "key": "ground.photo_uploads_per_hour",
      "column": "label_en",
      "from": "Ground photo uploads per owner per hour",
      "to": "Venue photo uploads per owner per hour"
    },
    {
      "key": "ground.duplicate_radius_m",
      "column": "label_en",
      "from": "Same-name grounds closer than this are flagged",
      "to": "Same-name venues closer than this are flagged"
    },
    {
      "key": "ground.duplicate_radius_m",
      "column": "label_bn",
      "from": "এর চেয়ে কাছে একই নামের মাঠ হলে চিহ্নিত",
      "to": "এর চেয়ে কাছে একই নামের ভেন্যু হলে চিহ্নিত"
    },
    {
      "key": "esports.tier_weights",
      "column": "label_en",
      "from": "Ranking weight per tournament tier",
      "to": "Ranking weight per event tier"
    },
    {
      "key": "esports.tier_weights",
      "column": "label_bn",
      "from": "টুর্নামেন্ট স্তরভিত্তিক র‍্যাংকিং ওজন",
      "to": "ইভেন্ট স্তরভিত্তিক র‍্যাংকিং ওজন"
    },
    {
      "key": "esports.ranking_min_tournaments",
      "column": "label_en",
      "from": "Tournaments before a player is ranked",
      "to": "Events before a player is ranked"
    },
    {
      "key": "esports.ranking_min_tournaments",
      "column": "label_bn",
      "from": "র‍্যাংকিংয়ের আগে টুর্নামেন্ট",
      "to": "র‍্যাংকিংয়ের আগে ইভেন্ট"
    },
    {
      "key": "payouts.ground_weekday",
      "column": "label_en",
      "from": "Ground payout day",
      "to": "Venue payout day"
    },
    {
      "key": "payouts.ground_weekday",
      "column": "label_bn",
      "from": "মাঠের পেআউটের দিন",
      "to": "ভেন্যুর পেআউটের দিন"
    },
    {
      "key": "reviews.window_days",
      "column": "label_en",
      "from": "Time to rate a ground after playing",
      "to": "Time to rate a venue after playing"
    },
    {
      "key": "reviews.window_days",
      "column": "label_bn",
      "from": "খেলার পর মাঠকে রেটিং দেওয়ার সময়",
      "to": "খেলার পর ভেন্যুকে রেটিং দেওয়ার সময়"
    },
    {
      "key": "reviews.min_count_display",
      "column": "label_en",
      "from": "Show a ground's average from this many reviews",
      "to": "Show a venue's average from this many reviews"
    },
    {
      "key": "saas.overdue_grace_days",
      "column": "label_en",
      "from": "Days an invoice may be overdue before new tournaments are blocked",
      "to": "Days an invoice may be overdue before new events are blocked"
    },
    {
      "key": "saas.overdue_grace_days",
      "column": "label_bn",
      "from": "নতুন টুর্নামেন্ট আটকানোর আগে ইনভয়েস কত দিন বকেয়া থাকতে পারে",
      "to": "নতুন ইভেন্ট আটকানোর আগে ইনভয়েস কত দিন বকেয়া থাকতে পারে"
    },
    {
      "key": "esports_events.max_stages",
      "column": "label_en",
      "from": "Most tournaments in one event",
      "to": "Most events in one showcase"
    },
    {
      "key": "esports_events.max_stages",
      "column": "label_bn",
      "from": "একটি ইভেন্টে সর্বোচ্চ টুর্নামেন্ট",
      "to": "একটি শোকেসে সর্বোচ্চ ইভেন্ট"
    },
    {
      "key": "tournament.max_teams",
      "column": "label_en",
      "from": "Most teams in a tournament",
      "to": "Most teams in an event"
    },
    {
      "key": "tournament.max_teams",
      "column": "label_bn",
      "from": "একটি টুর্নামেন্টে সর্বোচ্চ দল",
      "to": "একটি ইভেন্টে সর্বোচ্চ দল"
    }
  ],
  "requirements": [
    {
      "role": "ground_owner",
      "docType": "trade_license",
      "derivedKey": null,
      "column": "why_en",
      "from": "Shows the business that runs the ground. It must still be valid.",
      "to": "Shows the business that runs the venue. It must still be valid."
    },
    {
      "role": "ground_owner",
      "docType": "trade_license",
      "derivedKey": null,
      "column": "why_bn",
      "from": "মাঠ যে প্রতিষ্ঠান চালায় তা দেখায়। মেয়াদ থাকতে হবে।",
      "to": "ভেন্যু যে প্রতিষ্ঠান চালায় তা দেখায়। মেয়াদ থাকতে হবে।"
    },
    {
      "role": "ground_owner",
      "docType": "deed_or_lease",
      "derivedKey": null,
      "column": "why_en",
      "from": "Shows you may run the ground on this land.",
      "to": "Shows you may run the venue on this land."
    },
    {
      "role": "ground_owner",
      "docType": "deed_or_lease",
      "derivedKey": null,
      "column": "why_bn",
      "from": "এই জমিতে মাঠ চালানোর অধিকার দেখায়।",
      "to": "এই জমিতে ভেন্যু চালানোর অধিকার দেখায়।"
    }
  ],
  "rubrics": [
    {
      "kind": "ground",
      "key": "photos_real",
      "field": "labelEn",
      "from": "Photos show this ground and match the courts",
      "to": "Photos show this venue and match the courts"
    },
    {
      "kind": "ground",
      "key": "photos_real",
      "field": "labelBn",
      "from": "ছবিগুলো এই মাঠের এবং কোর্টের সাথে মেলে",
      "to": "ছবিগুলো এই ভেন্যুর এবং কোর্টের সাথে মেলে"
    }
  ],
  "reasons": [
    {
      "code": "not_a_venue",
      "column": "label_bn",
      "from": "বুকিংযোগ্য খেলার মাঠ নয়",
      "to": "বুকিংযোগ্য খেলার ভেন্যু নয়"
    }
  ],
  "hireTiers": [
    {
      "role": "event_ops",
      "level": "national",
      "field": "labelEn",
      "from": "Tournament operations lead",
      "to": "Event operations lead"
    },
    {
      "role": "event_ops",
      "level": "national",
      "field": "labelBn",
      "from": "টুর্নামেন্ট অপারেশনস প্রধান",
      "to": "ইভেন্ট অপারেশনস প্রধান"
    }
  ]
};

async function templates(queryInterface, transaction, dir) {
  const q = (sql, replacements) => queryInterface.sequelize.query(sql, { replacements, transaction, type: queryInterface.sequelize.QueryTypes.SELECT });
  for (const p of PAIRS.templates) {
    const [fromSubject, fromBody, toSubject, toBody] = dir === 'up' ? [p.subjectFrom, p.bodyFrom, p.subjectTo, p.bodyTo] : [p.subjectTo, p.bodyTo, p.subjectFrom, p.bodyFrom];
    const [active] = await q('SELECT * FROM message_templates WHERE code = :code AND channel = :channel AND locale = :locale AND is_active', p);
    if (!active || active.body !== fromBody || (active.subject ?? null) !== (fromSubject ?? null)) continue;
    await q('UPDATE message_templates SET is_active = false WHERE id = :id', { id: active.id });
    if (dir === 'down') {
      // Back to the version that held the old words; the newer one stays as inactive history.
      const [previous] = await q('SELECT id FROM message_templates WHERE code = :code AND channel = :channel AND locale = :locale AND body = :body AND id <> :id ORDER BY version DESC LIMIT 1', { ...p, body: toBody, id: active.id });
      if (previous) {
        await q('UPDATE message_templates SET is_active = true WHERE id = :id', { id: previous.id });
        continue;
      }
    }
    const [{ next }] = await q('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM message_templates WHERE code = :code AND channel = :channel AND locale = :locale', p);
    await q(
      `INSERT INTO message_templates (id, code, channel, locale, version, subject, body, variables, is_active, max_sms_segments, created_at)
       SELECT gen_random_uuid(), code, channel, locale, :next, :subject, :body, variables, true, max_sms_segments, now() FROM message_templates WHERE id = :id`,
      { next, subject: toSubject ?? null, body: toBody, id: active.id }
    );
  }
}

async function labels(queryInterface, transaction, dir) {
  const run = (sql, replacements) => queryInterface.sequelize.query(sql, { replacements, transaction });
  const swap = (p) => (dir === 'up' ? { ...p } : { ...p, from: p.to, to: p.from });
  for (const p of PAIRS.settings.map(swap)) await run(`UPDATE platform_settings SET "${p.column}" = :to WHERE key = :key AND "${p.column}" = :from`, p);
  for (const p of PAIRS.requirements.map(swap)) {
    await run(
      `UPDATE document_requirements SET "${p.column}" = :to WHERE role = :role AND is_active AND "${p.column}" = :from AND ${p.docType ? 'doc_type = :docType' : 'derived_key = :derivedKey'}`,
      p
    );
  }
  for (const p of PAIRS.reasons.map(swap)) await run(`UPDATE rejection_reasons SET "${p.column}" = :to WHERE code = :code AND "${p.column}" = :from`, p);
  const select = (sql, replacements) => queryInterface.sequelize.query(sql, { replacements, transaction, type: queryInterface.sequelize.QueryTypes.SELECT });
  for (const p of PAIRS.rubrics.map(swap)) {
    for (const row of await select('SELECT id, items FROM review_rubrics WHERE kind = :kind AND is_active', p)) {
      const items = typeof row.items === 'string' ? JSON.parse(row.items) : row.items;
      const item = items.find((i) => i.key === p.key);
      if (!item || item[p.field] !== p.from) continue;
      item[p.field] = p.to;
      await run('UPDATE review_rubrics SET items = :items WHERE id = :id', { items: JSON.stringify(items), id: row.id });
    }
  }
  for (const p of PAIRS.hireTiers.map(swap)) {
    for (const row of await select('SELECT id, credential_tiers FROM hire_roles WHERE key = :role', p)) {
      const tiers = typeof row.credential_tiers === 'string' ? JSON.parse(row.credential_tiers) : row.credential_tiers;
      const tier = tiers.find((t) => t.level === p.level);
      if (!tier || tier[p.field] !== p.from) continue;
      tier[p.field] = p.to;
      await run('UPDATE hire_roles SET credential_tiers = :tiers WHERE id = :id', { tiers: JSON.stringify(tiers), id: row.id });
    }
  }
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await templates(queryInterface, transaction, 'up');
      await labels(queryInterface, transaction, 'up');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await templates(queryInterface, transaction, 'down');
      await labels(queryInterface, transaction, 'down');
    });
  },
};
