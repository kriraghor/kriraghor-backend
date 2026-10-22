'use strict';

const { maskPhone, maskEmail } = require('../../common/identifiers');
const storage = require('../../common/storage');

/** The signed-in user's own view (full own identifiers, never hashes/NID). */
function serializePrincipal(principal) {
  if (!principal) return null;
  const { user } = principal;
  return {
    ...user.toPublic({
      roles: user.roles
        .map((r) => r.toPublic())
        .sort((a, b) => a.role.localeCompare(b.role)),
      permissions: [...principal.permissions].sort(),
    }),
    avatarUrl: user.avatarKey ? storage.publicUrl(user.avatarKey) : null,
    signInMethods: {
      phoneOtp: Boolean(user.phone),
      emailOtp: Boolean(user.email && user.emailVerifiedAt),
      password: Boolean(user.passwordHash),
      google: (user.identities || []).some((i) => i.provider === 'google'),
    },
    identities: (user.identities || []).map((i) => i.toPublic()),
    isStaff: principal.isStaff,
    isMaster: principal.isMaster,
    twoFactor: principal.staff ? { required: true, enabled: Boolean(principal.staff.totpEnabledAt) } : { required: false, enabled: false },
  };
}

/** Admin projection: masked identifiers only (M01-FR-19). */
function serializeUserForAdmin(user, { roles = [], sanctions = [], staff = null } = {}) {
  return {
    id: user.id,
    displayName: user.displayName,
    phone: maskPhone(user.phone),
    email: maskEmail(user.email),
    username: user.username ?? null,
    status: user.status,
    kycStatus: user.kycStatus,
    nidLast4: user.nidLast4 ?? null,
    gender: user.gender ?? null,
    genderSource: user.genderSource ?? null,
    locale: user.locale,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    roles: roles.map((r) => r.toPublic()),
    sanctions: sanctions.map((s) => ({
      id: s.id,
      kind: s.kind,
      role: s.role,
      reasonCode: s.reasonCode,
      note: s.note,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      liftedAt: s.liftedAt,
    })),
    staff: staff
      ? { employeeId: staff.employeeId, team: staff.team, status: staff.status, isMaster: staff.isMaster, twoFactorEnabled: Boolean(staff.totpEnabledAt) }
      : null,
  };
}

module.exports = { serializePrincipal, serializeUserForAdmin };
