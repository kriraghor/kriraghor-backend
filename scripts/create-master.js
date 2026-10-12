'use strict';

/**
 * Bootstrap the FIRST master admin (M01-FR-12). Only works while no master exists;
 * every later master is promoted in-app by an existing master with step-up.
 *
 *   npm run create:master -- --phone 01712345678 --name "Ayesha Siddiqua" --employee-id KG-0001
 *
 * The master signs in with an OTP to that phone, then must enrol TOTP before any access.
 */
const { parseArgs } = require('node:util');
const { sequelize, User, UserRole, StaffMember } = require('../src/models');
const { normalizePhone } = require('../src/common/identifiers');
const audit = require('../src/modules/audit/audit.service');

async function main() {
  const { values } = parseArgs({
    options: { phone: { type: 'string' }, name: { type: 'string' }, 'employee-id': { type: 'string' } },
  });
  const phone = normalizePhone(values.phone || '');
  if (!phone || !values.name || !values['employee-id']) {
    throw new Error('Usage: npm run create:master -- --phone 01XXXXXXXXX --name "Full Name" --employee-id KG-0001');
  }

  await sequelize.transaction(async (transaction) => {
    const masters = await StaffMember.count({ where: { isMaster: true }, transaction });
    if (masters > 0) throw new Error('A master admin already exists. Promote new masters from the admin panel.');

    let user = await User.findOne({ where: { phone }, transaction });
    if (!user) user = await User.create({ phone, phoneVerifiedAt: new Date(), displayName: values.name }, { transaction });

    for (const role of ['member', 'staff', 'master_admin']) {
      const row = await UserRole.findOne({ where: { userId: user.id, role }, transaction });
      if (row) await row.update({ status: 'active', activatedAt: new Date() }, { transaction });
      else await UserRole.create({ userId: user.id, role, status: 'active', activatedAt: new Date() }, { transaction });
    }
    await StaffMember.create({ userId: user.id, employeeId: values['employee-id'], team: 'Platform', isMaster: true, status: 'invited' }, { transaction });
    await user.increment('authzVersion', { transaction });
    await audit.record({ action: 'staff.master_bootstrapped', actor: { id: null, role: 'cli' }, entityType: 'user', entityId: user.id }, { transaction });
    // eslint-disable-next-line no-console
    console.log(`Master admin created for ${phone}. Sign in with an OTP and enrol two-factor authentication.`);
  });
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
