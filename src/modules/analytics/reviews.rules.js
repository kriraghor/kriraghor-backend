'use strict';

/**
 * M19 §6.4 staff review figures, pure (M19-FR-33): the windows on the Asia/Dhaka calendar, the approval
 * rate, the decisions per day with gaps filled, and the reasons with their labels. 100% branch coverage.
 * Days are 'YYYY-MM-DD' Dhaka days; times are Date instants.
 */
const { DHAKA_MS, addDays, dhakaDate, daysOf, delta } = require('./analytics.rules');

const DAY_MS = 24 * 60 * 60 * 1000;
const DECISIONS = ['approved', 'changes_requested', 'rejected'];

/** The instant a Dhaka day starts. */
const dayStart = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - DHAKA_MS);

/**
 * The windows the figures are counted in, at `now`:
 *  - today: Dhaka midnight to now, and the same weekday last week up to the same time of day;
 *  - window: the last `days` Dhaka days (today the last, partial one), and the same number of days just before.
 */
function windows(now, days) {
  const today = dhakaDate(now);
  const first = addDays(today, -(days - 1));
  return {
    today: { from: dayStart(today), to: now },
    lastWeek: { from: dayStart(addDays(today, -7)), to: new Date(now.getTime() - 7 * DAY_MS) },
    window: { from: dayStart(first), to: now, firstDay: first, lastDay: today },
    before: { from: dayStart(addDays(first, -days)), to: dayStart(first) },
  };
}

/** approved ÷ (approved + changes requested + rejected), to three places; null with no decisions. */
function approvalRate({ approved = 0, changes_requested: changes = 0, rejected = 0 } = {}) {
  const all = approved + changes + rejected;
  return all > 0 ? Math.round((approved / all) * 1000) / 1000 : null;
}

/** Every day of the window, oldest first, with each decision counted (0 where nothing was decided). */
function fillDecisionDays(rows, firstDay, lastDay) {
  const by = new Map(rows.map((r) => [r.day, r]));
  return daysOf({ from: firstDay, to: addDays(lastDay, 1) }).map((day) => {
    const r = by.get(day);
    return { day, approved: r?.approved ?? 0, changesRequested: r?.changes_requested ?? 0, rejected: r?.rejected ?? 0 };
  });
}

/** Reason counts with labels in the page's language (the code itself when M05 has no label), most first. */
function reasonsWithLabels(counts, labels, locale) {
  const byCode = new Map(labels.map((l) => [l.code, l]));
  return counts
    .map(({ code, count }) => {
      const l = byCode.get(code);
      return { code, label: l ? (locale === 'bn' ? l.labelBn : l.labelEn) : code, count };
    })
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

/** The figure tiles: today against the same weekday last week; median and rate against the window before. */
function tiles({ waiting, today, lastWeek, median, medianBefore, rate, rateBefore }) {
  return {
    waiting: { value: waiting.inQueue, delta: null, note: { overdue: waiting.overdue } },
    reviewedToday: { value: today, delta: delta(today, lastWeek), note: { lastWeek } },
    medianMinutes: { value: median, delta: median === null || medianBefore === null ? null : delta(median, medianBefore) },
    approvalRate: { value: rate, delta: delta(rate, rateBefore, 'rate') },
  };
}

module.exports = { DECISIONS, dayStart, windows, approvalRate, fillDecisionDays, reasonsWithLabels, tiles };
