'use strict';

/**
 * M16 teams and players: pure rules (100% branch coverage). Codes are returned, never thrown.
 */
const URLISH = /(https?:\/\/|www\.|\.(com|net|org|bd|xyz|io|me|link)\b)/i;
const LONG_DIGITS = /\d{7,}/;

/** A team name: 2–40 characters, no links and no phone numbers (it is shown to invitees). */
function nameBlock(name) {
  const n = String(name ?? '').trim();
  if (n.length < 2 || n.length > 40 || URLISH.test(n) || LONG_DIGITS.test(n)) return 'TEAM_NAME_INVALID';
  return null;
}

/** The short code, upper-cased: 2–4 letters or digits, or none. */
function shortCode(input) {
  if (input === undefined || input === null || input === '') return { value: null };
  const v = String(input).trim().toUpperCase();
  return /^[A-Z0-9]{2,4}$/.test(v) ? { value: v } : { error: 'TEAM_SHORT_CODE_INVALID' };
}

const MANAGERS = ['captain', 'vice_captain'];
/** Captains and vice-captains invite and remove; only the captain changes roles, hands over, archives. */
const canManage = (role) => MANAGERS.includes(role);
const isCaptain = (role) => role === 'captain';

/** Can this phone be invited? (The answer to the inviter never says whether it has an account.) */
function inviteBlock({ teamStatus, selfInvite, alreadyMember, activeCount, maxMembers }) {
  if (teamStatus !== 'active') return 'TEAM_ARCHIVED';
  if (selfInvite) return 'INVITE_SELF';
  if (alreadyMember) return 'ALREADY_MEMBER';
  if (activeCount >= maxMembers) return 'TEAM_FULL';
  return null;
}

/** A pending invite may be resent after the cooldown. */
function resendBlock(invite, now, minutes) {
  if (invite.status !== 'pending') return 'INVITE_STATE';
  const last = new Date(invite.resentAt ?? invite.createdAt).getTime();
  return now.getTime() - last < minutes * 60000 ? 'INVITE_RESEND_TOO_SOON' : null;
}

/** Everything an accept re-checks under the team lock (the expiry even before the job runs). */
function acceptBlock({ invite, now, teamStatus, accountActive, alreadyMember, activeCount, maxMembers, memberships, maxMemberships }) {
  if (invite.status !== 'pending') return 'INVITE_STATE';
  if (now >= new Date(invite.expiresAt)) return 'INVITE_EXPIRED';
  if (!accountActive) return 'ACCOUNT_INACTIVE';
  if (teamStatus !== 'active') return 'TEAM_ARCHIVED';
  if (alreadyMember) return 'ALREADY_MEMBER';
  if (activeCount >= maxMembers) return 'TEAM_FULL';
  if (memberships >= maxMemberships) return 'TOO_MANY_TEAMS';
  return null;
}

/**
 * Who takes over a captaincy (a banned captain, or the captain leaving): the vice-captain, else the
 * longest-serving member, else nobody (the team is archived). `members` are active, without the leaver.
 */
function successor(members) {
  const vice = members.find((m) => m.role === 'vice_captain');
  if (vice) return vice.userId;
  const sorted = [...members].sort((a, b) => new Date(a.joinedAt) - new Date(b.joinedAt) || String(a.userId).localeCompare(String(b.userId)));
  return sorted[0]?.userId ?? null;
}

/** Whole years between a YYYY-MM-DD date of birth and a YYYY-MM-DD date (29 February is safe). */
function ageOnDate(dob, onDate) {
  const [by, bm, bd] = String(dob).slice(0, 10).split('-').map(Number);
  const [y, m, d] = String(onDate).slice(0, 10).split('-').map(Number);
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age -= 1;
  return age;
}

const GENDER_FOR = { men: 'male', women: 'female' };

/**
 * Eligibility for one player under a competition's rules (M14 sends the config; M16-FR-08):
 *   identity  { kycStatus, memberActive, dob, gender }   (internal, from M01's directory)
 *   config    { ageMin?, ageMax?, ageCutoff? (YYYY-MM-DD), gender?: open | men | women | mixed }
 * Returns { eligible, checks: [{ key, status: pass | fail | pending | missing | n_a, fix }] }.
 */
function evaluate(identity, config = {}, onDate) {
  const checks = [];
  const verified = identity.kycStatus === 'verified' && identity.memberActive;
  const pending = identity.kycStatus === 'pending';
  checks.push({ key: 'nid_verified', status: verified ? 'pass' : pending ? 'pending' : 'fail', fix: verified || pending ? null : 'verify_nid' });

  const aged = config.ageMin !== undefined || config.ageMax !== undefined;
  if (!aged) checks.push({ key: 'age', status: 'n_a', fix: null });
  else if (!identity.dob) checks.push({ key: 'age', status: pending ? 'pending' : 'missing', fix: pending ? null : 'verify_nid' });
  else {
    const age = ageOnDate(identity.dob, config.ageCutoff ?? onDate);
    const ok = (config.ageMin === undefined || age >= config.ageMin) && (config.ageMax === undefined || age <= config.ageMax);
    checks.push({ key: 'age', status: ok ? 'pass' : 'fail', fix: null });
  }

  const wanted = GENDER_FOR[config.gender];
  if (!wanted) checks.push({ key: 'gender', status: 'n_a', fix: null });
  else if (!identity.gender) checks.push({ key: 'gender', status: 'missing', fix: 'set_gender' });
  else checks.push({ key: 'gender', status: identity.gender === wanted ? 'pass' : 'fail', fix: null });

  return { eligible: checks.every((c) => c.status === 'pass' || c.status === 'n_a'), checks };
}

/** A player's sports list: known sports, positions from that sport's list, no sport twice. */
function sportsBlock(list, positionsBySport) {
  const seen = new Set();
  for (const s of list) {
    const known = positionsBySport.get(s.sportKey);
    if (!known || seen.has(s.sportKey)) return 'PROFILE_SPORTS_INVALID';
    seen.add(s.sportKey);
    if ((s.positions ?? []).some((p) => !known.includes(p))) return 'PROFILE_SPORTS_INVALID';
  }
  return null;
}

/**
 * Round B1: a player profile's completeness for its owner: sports with positions, a bio, a team, a
 * verified esports game UID (M21) and the NID (M02 member role). facts: { team, esportsUid, nid }.
 */
function playerCompleteness({ sports, bio }, f) {
  const steps = [
    { key: 'sports', done: sports.length > 0 && sports.every((s) => (s.positions ?? []).length > 0) },
    { key: 'bio', done: Boolean(bio?.trim()) },
    { key: 'team', done: Boolean(f.team) },
    { key: 'esportsUid', done: Boolean(f.esportsUid) },
    { key: 'nid', done: Boolean(f.nid) },
  ];
  return { score: Math.round((steps.filter((s) => s.done).length / steps.length) * 100), steps };
}

module.exports = { nameBlock, shortCode, canManage, isCaptain, inviteBlock, resendBlock, acceptBlock, successor, ageOnDate, evaluate, sportsBlock, playerCompleteness };
