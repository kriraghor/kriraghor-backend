'use strict';

/**
 * M26 rules, pure so they can be tested without a database. A post only describes a tournament someone
 * runs elsewhere: Kriraghor holds no money and organises nothing.
 */
const { hasContact } = require('../../common/contact');
const { slugify } = require('../../common/identifiers');

const FORMATS = ['league', 'knockout', 'group_knockout', 'round_robin', 'other'];
const GENDERS = ['open', 'men', 'women'];
const SKILLS = ['any', 'beginner', 'intermediate', 'advanced'];
const STATUSES = ['open', 'closed', 'expired', 'removed'];
const SORTS = ['newest', 'starts_soon', 'deadline_soon', 'most_discussed'];

/** Public text a post is refused for when it holds a phone, email or link (M26-FR-04). */
const PUBLIC_TEXT = ['title', 'venueName', 'address', 'prizeDetails', 'ageGroup', 'organiserName', 'description', 'rules'];

const DHAKA_MS = 6 * 3600000;
const dhakaDate = (at) => new Date(new Date(at).getTime() + DHAKA_MS).toISOString().slice(0, 10);
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** Why these dates can't stand, or null. `isNew` also refuses a start in the past (an edit may keep one). */
function datesBlock({ startDate, endDate = null, registrationDeadline }, today, { isNew = false, startChanged = false } = {}) {
  if ((isNew || startChanged) && startDate < today) return 'TOURNAMENT_POST_DATE_PAST';
  if (registrationDeadline > startDate) return 'TOURNAMENT_POST_DEADLINE_AFTER_START';
  if (endDate && endDate < startDate) return 'TOURNAMENT_POST_END_BEFORE_START';
  return null;
}

/** The first public field holding contact details, or null. */
const contactField = (fields) => PUBLIC_TEXT.find((k) => typeof fields[k] === 'string' && hasContact(fields[k])) ?? null;

/** A map link must be a Google Maps address; everything else stays off the post. */
function mapLinkOk(link) {
  if (!link) return true;
  try {
    const u = new URL(link);
    if (u.protocol !== 'https:') return false;
    return u.hostname === 'maps.app.goo.gl' || u.hostname === 'goo.gl' || ((u.hostname === 'www.google.com' || u.hostname === 'google.com') && u.pathname.startsWith('/maps'));
  } catch {
    return false;
  }
}

const canEdit = (status) => status === 'open';
const canComment = (status) => status === 'open';
const canClose = (status) => status === 'open';
const canRemove = (status) => status !== 'removed';
const canRestore = (status) => status === 'removed';
/** Anyone may see a post unless staff removed it; its author and staff still can. */
const isVisible = (status) => status !== 'removed';
/** A new thread needs an open post; an existing thread keeps going until staff remove the post. */
const canOpenThread = (status) => status === 'open';
const canMessage = (status) => status !== 'removed';

/** Registration is open while the post is open and the deadline hasn't passed (Dhaka dates). */
const registrationOpen = ({ status, registrationDeadline }, today) => status === 'open' && registrationDeadline >= today;

/** An open post expires this many days after its last day (the end date, else the start date). */
const expiryDue = ({ status, startDate, endDate }, today, days) => status === 'open' && addDays(endDate ?? startDate, days) < today;

/** Where a removed post goes back to: its old status, or open when none was kept. */
const restoredStatus = ({ statusBeforeRemoval }) => (STATUSES.includes(statusBeforeRemoval) && statusBeforeRemoval !== 'removed' ? statusBeforeRemoval : 'open');

/** The thread's other person. */
const otherParty = (thread, userId) => (thread.organiserId === userId ? thread.playerId : thread.organiserId);
const isParty = (thread, userId) => thread.organiserId === userId || thread.playerId === userId;

/** A Bangla title has no Latin letters: the slug falls back to a word, and the id's tail keeps it unique. */
const slugOf = (title, id) => `${slugify(title, 'tournament')}-${id.replace(/-/g, '').slice(-8)}`;

/** Free or paid, for the filter. */
const feeWhere = (fee) => (fee === 'free' ? { eq: 0 } : fee === 'paid' ? { gt: 0 } : null);

module.exports = {
  FORMATS,
  GENDERS,
  SKILLS,
  STATUSES,
  SORTS,
  PUBLIC_TEXT,
  hasContact,
  dhakaDate,
  addDays,
  datesBlock,
  contactField,
  mapLinkOk,
  canEdit,
  canComment,
  canClose,
  canRemove,
  canRestore,
  isVisible,
  canOpenThread,
  canMessage,
  registrationOpen,
  expiryDue,
  restoredStatus,
  otherParty,
  isParty,
  slugOf,
  feeWhere,
};
