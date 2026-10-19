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
};

const definitionsFor = (keys, locale = 'en') => Object.fromEntries(keys.map((k) => [k, KPIS[k][locale === 'bn' ? 'bn' : 'en']]));
const definition = (key, locale = 'en') => (KPIS[key] ? { key, text: KPIS[key][locale === 'bn' ? 'bn' : 'en'] } : null);

module.exports = { KPIS, definitionsFor, definition };
