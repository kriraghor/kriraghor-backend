'use strict';

/**
 * Audit action registry (M04-FR-09, §6.2). Every action the code records is listed with its module,
 * severity and an EN/BN summary template, rendered at read time from the row:
 *   {entityId} {entityCode} {reason} {before.x} {after.x} {meta.x}
 * critical (★ in §6.2) actions also publish audit.critical_recorded, which M08 turns into an alert for
 * every master. An action missing here renders as its key plus the changed fields.
 */
const A = (module, severity, en, bn) => ({ module, severity, en, bn });

const ACTIONS = {
  // ---------------- M01 Identity ----------------
  'user.registered': A('M01', 'info', 'Account created', 'অ্যাকাউন্ট তৈরি'),
  'user.profile_updated': A('M01', 'info', 'Profile updated', 'প্রোফাইল হালনাগাদ'),
  'user.username_changed': A('M01', 'info', 'Username changed to {after.username}', 'ইউজারনেম বদলে {after.username}'),
  'user.email_changed': A('M01', 'notice', 'Email changed', 'ইমেল বদলানো হয়েছে'),
  'user.password_changed': A('M01', 'notice', 'Password changed', 'পাসওয়ার্ড বদলানো হয়েছে'),
  'user.password_reset': A('M01', 'notice', 'Password reset with a code', 'কোড দিয়ে পাসওয়ার্ড রিসেট'),
  'user.identity_linked': A('M01', 'notice', 'Linked a {meta.provider} sign-in', '{meta.provider} সাইন-ইন যুক্ত'),
  'user.identity_unlinked': A('M01', 'notice', 'Unlinked a {meta.provider} sign-in', '{meta.provider} সাইন-ইন বিচ্ছিন্ন'),
  'user.searched': A('M01', 'info', 'Searched users', 'ব্যবহারকারী খোঁজা হয়েছে'),
  'user.suspended': A('M01', 'notice', 'Suspended the account ({meta.reasonCode})', 'অ্যাকাউন্ট স্থগিত ({meta.reasonCode})'),
  'user.banned': A('M01', 'critical', 'Banned the account ({meta.reasonCode})', 'অ্যাকাউন্ট নিষিদ্ধ ({meta.reasonCode})'),
  'user.restored': A('M01', 'notice', 'Restored the account', 'অ্যাকাউন্ট পুনরুদ্ধার'),
  'user.signed_out_by_admin': A('M01', 'notice', 'Signed the user out everywhere', 'সব ডিভাইস থেকে সাইন আউট করানো হয়েছে'),
  'user_role.applied': A('M01', 'info', 'Applied for the {after.role} role', '{after.role} ভূমিকার জন্য আবেদন'),
  'user_role.withdrawn': A('M01', 'info', 'Withdrew the {meta.role} application', '{meta.role} আবেদন প্রত্যাহার'),
  'user_role.in_review': A('M01', 'info', 'Role moved to review', 'ভূমিকা পর্যালোচনায়'),
  'user_role.active': A('M01', 'notice', 'Role activated ({meta.role})', 'ভূমিকা সক্রিয় ({meta.role})'),
  'user_role.changes_requested': A('M01', 'info', 'Changes requested on the {meta.role} role', '{meta.role} ভূমিকায় পরিবর্তন চাওয়া হয়েছে'),
  'user_role.rejected': A('M01', 'notice', 'Role rejected ({meta.role})', 'ভূমিকা প্রত্যাখ্যাত ({meta.role})'),
  'user_role.suspended': A('M01', 'notice', 'Role suspended ({meta.role})', 'ভূমিকা স্থগিত ({meta.role})'),
  'auth.signed_in': A('M01', 'info', 'Signed in', 'সাইন ইন'),
  'auth.signed_out': A('M01', 'info', 'Signed out', 'সাইন আউট'),
  'auth.signed_out_everywhere': A('M01', 'info', 'Signed out on every device', 'সব ডিভাইস থেকে সাইন আউট'),
  'auth.sign_in_failed': A('M01', 'notice', 'Wrong password', 'ভুল পাসওয়ার্ড'),
  'auth.locked': A('M01', 'notice', 'Locked after too many wrong passwords', 'অনেক ভুল পাসওয়ার্ডে লক'),
  'auth.totp_failed': A('M01', 'notice', 'Wrong authenticator code', 'ভুল অথেন্টিকেটর কোড'),
  'auth.step_up_granted': A('M01', 'info', 'Confirmed with the authenticator ({meta.scope})', 'অথেন্টিকেটরে নিশ্চিত ({meta.scope})'),
  'auth.step_up_failed': A('M01', 'notice', 'Failed security confirmation ({meta.scope})', 'নিরাপত্তা নিশ্চিতকরণ ব্যর্থ ({meta.scope})'),
  'session.revoked': A('M01', 'info', 'Ended a session', 'একটি সেশন শেষ'),
  'session.reuse_detected': A('M01', 'critical', 'Refresh token reuse detected; sessions ended', 'রিফ্রেশ টোকেন পুনর্ব্যবহার ধরা পড়েছে; সেশন শেষ'),
  'staff.invited': A('M01', 'critical', 'Invited as staff', 'স্টাফ হিসেবে আমন্ত্রিত'),
  'staff.permission_granted': A('M01', 'critical', 'Granted {meta.permission}', '{meta.permission} অনুমতি দেওয়া হয়েছে'),
  'staff.permission_revoked': A('M01', 'critical', 'Revoked {meta.permission}', '{meta.permission} অনুমতি বাতিল'),
  'staff.offboarded': A('M01', 'critical', 'Offboarded', 'স্টাফ থেকে বাদ'),
  'staff.promoted_to_master': A('M01', 'critical', 'Promoted to master admin', 'মাস্টার অ্যাডমিন করা হয়েছে'),
  'staff.totp_setup_started': A('M01', 'info', 'Started authenticator setup', 'অথেন্টিকেটর সেটআপ শুরু'),
  'staff.totp_enabled': A('M01', 'notice', 'Authenticator turned on', 'অথেন্টিকেটর চালু'),
  'staff.totp_reset': A('M01', 'critical', 'Two-factor reset', 'টু-ফ্যাক্টর রিসেট'),

  // ---------------- M03 Settings and catalogue ----------------
  'setting.change_proposed': A('M03', 'notice', 'Proposed a settings change', 'সেটিংস পরিবর্তনের প্রস্তাব'),
  'setting.change_approved': A('M03', 'notice', 'Approved a settings change', 'সেটিংস পরিবর্তন অনুমোদিত'),
  'setting.change_rejected': A('M03', 'notice', 'Rejected a settings change', 'সেটিংস পরিবর্তন প্রত্যাখ্যাত'),
  'setting.change_withdrawn': A('M03', 'info', 'Withdrew a settings change', 'সেটিংস পরিবর্তন প্রত্যাহার'),
  'setting.change_superseded': A('M03', 'info', 'Settings change superseded', 'সেটিংস পরিবর্তন বাতিল (নতুন পরিবর্তনে)'),
  'setting.changed': A('M03', 'critical', 'Changed {entityId} from {before.value} to {after.value}', '{entityId} {before.value} থেকে {after.value} করা হয়েছে'),
  'catalog_item.created': A('M03', 'info', 'Added {after.key} to the catalogue', 'ক্যাটালগে {after.key} যোগ'),
  'catalog_item.updated': A('M03', 'info', 'Edited {after.key}', '{after.key} সম্পাদনা'),
  'catalog_item.deactivated': A('M03', 'notice', 'Hid a catalogue item', 'ক্যাটালগের আইটেম লুকানো'),
  'catalog_item.reactivated': A('M03', 'info', 'Showed a catalogue item again', 'ক্যাটালগের আইটেম আবার দেখানো'),

  // ---------------- M04 Audit and events ----------------
  'audit_log.exported': A('M04', 'critical', 'Exported {after.rowCount} audit rows', '{after.rowCount}টি অডিট সারি এক্সপোর্ট'),
  'outbox.event_replayed': A('M04', 'notice', 'Replayed {meta.name} for {meta.consumer}', '{meta.consumer}-এর জন্য {meta.name} আবার চালানো'),
};

const get = (action) => ACTIONS[action];

function lookup(row, path) {
  const [head, ...rest] = path.split('.');
  let v = row[head];
  for (const k of rest) v = v == null ? undefined : v[k];
  if (v == null) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** Human summary for a row (M04-FR-09). Unknown actions: the key plus the changed fields. */
function summarize(row, locale = 'en') {
  const def = ACTIONS[row.action];
  if (!def) {
    const fields = [...new Set([...Object.keys(row.before || {}), ...Object.keys(row.after || {})])];
    return fields.length ? `${row.action} (${fields.join(', ')})` : row.action;
  }
  const template = locale === 'bn' ? def.bn : def.en;
  return template.replace(/\{([a-zA-Z.]+)\}/g, (_m, path) => lookup(row, path)).replace(/\s+\(\)/g, '').trim();
}

module.exports = { ACTIONS, get, summarize };
