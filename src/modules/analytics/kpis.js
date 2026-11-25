'use strict';

/**
 * M19 KPI definitions (§6, GET /kpis/:key/definition): what each tile counts, in EN and BN, so the
 * "i" on every tile explains it in plain words. The formulas live in analytics.rules.
 */
const KPIS = {
  revenue: {
    en: 'Earned from bookings that started in the period, before the Kriraghor fee (Q105): the full price of played bookings, and the kept advance of no-shows and member cancellations. Your payouts show the amount after the fee.',
    bn: 'এই সময়ে শুরু হওয়া বুকিং থেকে আয়, ক্রীড়াঘর ফির আগে: খেলা বুকিংয়ের পুরো দাম, এবং নো-শো ও সদস্যের বাতিলে রাখা অগ্রিম। পেআউটে ফি বাদে পরিমাণ দেখায়।',
  },
  occupancy: {
    en: 'Booked half-hours divided by open half-hours. Open time is your court hours minus closures; booked time counts online bookings, walk-ins and series.',
    bn: 'বুক করা আধ-ঘণ্টা ÷ খোলা আধ-ঘণ্টা। খোলা সময় = কোর্টের সময় বাদ বন্ধ; বুক করা সময়ে অনলাইন বুকিং, ওয়াক-ইন ও সিরিজ ধরা হয়।',
  },
  bookings: {
    en: 'Bookings that started in the period and were confirmed, played or marked no-show. Cancelled and expired holds are not counted.',
    bn: 'এই সময়ে শুরু হওয়া নিশ্চিত, খেলা বা নো-শো বুকিং। বাতিল ও মেয়াদ শেষ হোল্ড ধরা হয় না।',
  },
  repeat_teams: {
    en: 'Share of teams that booked at least twice in the last 90 days. A team is the member who booked, the weekly series, or the walk-in.',
    bn: 'গত ৯০ দিনে অন্তত দুবার বুক করা দলের অংশ। দল মানে বুক করা সদস্য, সাপ্তাহিক সিরিজ বা ওয়াক-ইন।',
  },
  spent: {
    en: 'What you paid online in the period, minus refunds. Money paid at the venue is not included.',
    bn: 'এই সময়ে অনলাইনে দেওয়া টাকা, ফেরত বাদে। ভেন্যুতে দেওয়া টাকা ধরা হয় না।',
  },
  member_bookings: {
    en: 'Your bookings that started in the period (confirmed, played or no-show).',
    bn: 'এই সময়ে শুরু হওয়া আপনার বুকিং (নিশ্চিত, খেলা বা নো-শো)।',
  },
  gtv: {
    en: 'Gross transaction value: money paid online (minus refunds) plus money owners recorded at the venue (Q106). Payouts are not counted.',
    bn: 'মোট লেনদেন: অনলাইনে দেওয়া টাকা (ফেরত বাদে) ও মালিকদের রেকর্ড করা ভেন্যুর টাকা। পেআউট ধরা হয় না।',
  },
  fee_revenue: {
    en: 'Kriraghor fees credited in the ledger (booking fees, venue fees owed, the esports pool remainder) minus reversals. Payment provider costs are not deducted yet.',
    bn: 'লেজারে জমা ক্রীড়াঘর ফি (বুকিং ফি, ভেন্যু ফি, এস্পোর্টস পুলের বাকি) বাদ ফেরত। পেমেন্ট প্রদানকারীর খরচ এখনও বাদ দেওয়া হয়নি।',
  },
  take_rate: { en: 'Fee revenue divided by GTV.', bn: 'ফি আয় ÷ মোট লেনদেন।' },
  esports_entries: { en: 'Esports entries confirmed in the period.', bn: 'এই সময়ে নিশ্চিত এস্পোর্টস এন্ট্রি।' },
  prizes_paid: { en: 'Prize money credited to winners when events were finalised.', bn: 'ইভেন্ট চূড়ান্ত হলে বিজয়ীদের দেওয়া পুরস্কারের টাকা।' },
  // Round B2 (§6.3): shops, gyms and sports organisers.
  sales: {
    en: 'The price of the items in orders placed in the period, before the Kriraghor commission and without delivery. Rejected, expired, cancelled and refunded orders are not counted. Your payouts show the amount after the commission.',
    bn: 'এই সময়ে দেওয়া অর্ডারের পণ্যের দাম, ক্রীড়াঘর কমিশনের আগে ও ডেলিভারি ছাড়া। বাতিল, প্রত্যাখ্যাত, মেয়াদোত্তীর্ণ ও ফেরত অর্ডার ধরা হয় না। পেআউটে কমিশন বাদে পরিমাণ দেখায়।',
  },
  orders: { en: 'Orders placed with your shop in the period (the same orders as Sales).', bn: 'এই সময়ে আপনার দোকানে দেওয়া অর্ডার (বিক্রির একই অর্ডার)।' },
  average_order: { en: 'Sales divided by orders, so the three tiles always agree.', bn: 'বিক্রি ÷ অর্ডার, তাই তিনটি টাইল সবসময় মেলে।' },
  repeat_buyers: { en: 'Share of buyers who ordered from you at least twice in the last 90 days.', bn: 'গত ৯০ দিনে অন্তত দুবার অর্ডার করা ক্রেতার অংশ।' },
  conversion: {
    en: 'Coming later: conversion and the shopper funnel need product-view counts, which Kriraghor does not collect yet.',
    bn: 'পরে আসছে: কনভার্সন ও ক্রেতার ধাপের জন্য পণ্য দেখার হিসাব লাগে, যা ক্রীড়াঘর এখনও রাখে না।',
  },
  pass_sales: {
    en: 'The price of passes bought in the period, before the Kriraghor fee. Cancelled and refunded passes are not counted.',
    bn: 'এই সময়ে কেনা পাসের দাম, ক্রীড়াঘর ফির আগে। বাতিল ও ফেরত পাস ধরা হয় না।',
  },
  passes_sold: { en: 'Passes bought in the period, split into day, monthly and quarterly passes.', bn: 'এই সময়ে কেনা পাস: দিনের, মাসিক ও তিন মাসের।' },
  admissions: { en: 'Front-desk admissions in the period (one per member per day on a monthly or quarterly pass).', bn: 'এই সময়ে ফ্রন্ট ডেস্কে প্রবেশ (মাসিক বা তিন মাসের পাসে দিনে একবার)।' },
  unused_share: {
    en: 'Of the passes whose last day was in the period, the share never used at the front desk.',
    bn: 'যে পাসের শেষ দিন এই সময়ে, তার মধ্যে ফ্রন্ট ডেস্কে কখনও ব্যবহার না হওয়ার অংশ।',
  },
  teams: {
    en: 'Approved teams of the places in your running events. Waiting: registrations for you to approve; unpaid: entry fees not paid yet.',
    bn: 'চলমান ইভেন্টে জায়গার মধ্যে অনুমোদিত দল। অপেক্ষায়: আপনার অনুমোদনের নিবন্ধন; বাকি: এখনও না দেওয়া এন্ট্রি ফি।',
  },
  entry_fees: {
    en: 'Entry fees paid in the period, from the escrow holds. The note shows what Kriraghor still holds, what was released to you and what was refunded, for all your events.',
    bn: 'এই সময়ে দেওয়া এন্ট্রি ফি, এসক্রো থেকে। নোটে আপনার সব ইভেন্টের জন্য ক্রীড়াঘরে রাখা, আপনাকে ছাড়া ও ফেরত দেওয়া টাকা।',
  },
  matches_played: { en: 'Matches with a result, of all matches not cancelled.', bn: 'ফল হওয়া ম্যাচ, বাতিল নয় এমন সব ম্যাচের মধ্যে।' },
  // M19 §6.4 staff review figures (M19-FR-33).
  review_waiting: {
    en: 'Submissions waiting for a decision in the kinds you may review, right now. The note counts those already past the review time limit.',
    bn: 'আপনি যে ধরন পর্যালোচনা করতে পারেন, তাতে এখন সিদ্ধান্তের অপেক্ষায় থাকা জমা। নোটে পর্যালোচনার সময়সীমা পেরোনোগুলো গোনা হয়।',
  },
  reviewed_today: {
    en: 'Decisions made today (Dhaka time): approved, changes asked or rejected. Compared with the same weekday last week, up to the same time of day.',
    bn: 'আজ (ঢাকার সময়) নেওয়া সিদ্ধান্ত: অনুমোদন, পরিবর্তন চাওয়া বা প্রত্যাখ্যান। গত সপ্তাহের একই বারের একই সময় পর্যন্ত তুলনা।',
  },
  median_decision: {
    en: 'The middle time from submission to decision for decisions in the period: half were quicker, half slower. Compared with the same number of days before; lower is better.',
    bn: 'এই সময়ের সিদ্ধান্তে জমা থেকে সিদ্ধান্ত পর্যন্ত মাঝামাঝি সময়: অর্ধেক দ্রুত, অর্ধেক ধীর। আগের সমান দিনের সঙ্গে তুলনা; কম হলে ভালো।',
  },
  approval_rate: {
    en: 'Approved of all decisions in the period (approved, changes asked, rejected). The change is in points against the same number of days before.',
    bn: 'এই সময়ের সব সিদ্ধান্তের (অনুমোদন, পরিবর্তন চাওয়া, প্রত্যাখ্যান) মধ্যে অনুমোদন। পরিবর্তন আগের সমান দিনের তুলনায় পয়েন্টে।',
  },
  decisions_per_day: {
    en: 'Decisions on each Dhaka day of the period, split into approved, changes asked and rejected.',
    bn: 'এই সময়ের প্রতিটি দিনের (ঢাকা) সিদ্ধান্ত, অনুমোদন, পরিবর্তন চাওয়া ও প্রত্যাখ্যানে ভাগ করা।',
  },
  why_no: {
    en: 'The reasons given when changes were asked or a submission was rejected in the period, most used first.',
    bn: 'এই সময়ে পরিবর্তন চাওয়া বা প্রত্যাখ্যানের সময় দেওয়া কারণ, বেশি ব্যবহৃতগুলো আগে।',
  },
};

const definitionsFor = (keys, locale = 'en') => Object.fromEntries(keys.map((k) => [k, KPIS[k][locale === 'bn' ? 'bn' : 'en']]));
const definition = (key, locale = 'en') => (KPIS[key] ? { key, text: KPIS[key][locale === 'bn' ? 'bn' : 'en'] } : null);

module.exports = { KPIS, definitionsFor, definition };
