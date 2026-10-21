'use strict';

/**
 * Make the FIRST master admin (M01-FR-12, M01-FR-40): an account that already exists with this
 * phone or email verified (sign up on kriraghor.com first). It refuses while a master who can sign
 * in exists; every later master is promoted in-app by an existing master with step-up. On hosts
 * without a shell, set BOOTSTRAP_MASTER instead (src/server.js).
 *
 *   npm run create:master -- --email you@example.com
 *   npm run create:master -- --phone 01712345678 --name "Ayesha Siddiqua" --employee-id KG-0001
 *
 * The master signs in at the admin portal with a code to that phone or email, then must enrol TOTP.
 */
const { parseArgs } = require('node:util');
const { sequelize } = require('../src/models');
const { masterBootstrap } = require('../src/modules/admin');

const MESSAGES = {
  IDENTIFIER_INVALID: 'Give --email or --phone (a Bangladesh mobile number).',
  MASTER_EXISTS: 'A master admin who can sign in already exists. Promote new masters from the admin panel.',
  ACCOUNT_NOT_FOUND: 'No account has that phone or email verified. Sign up on kriraghor.com with it first.',
  ACCOUNT_NOT_ACTIVE: 'That account is suspended, banned or closed.',
};

async function main() {
  const { values } = parseArgs({
    options: { phone: { type: 'string' }, email: { type: 'string' }, name: { type: 'string' }, 'employee-id': { type: 'string' } },
  });
  const result = await masterBootstrap.bootstrapMaster({ identifier: values.email || values.phone, name: values.name, employeeId: values['employee-id'] });
  if (!result.created) throw new Error(MESSAGES[result.reason] ?? result.reason);
  // eslint-disable-next-line no-console
  console.log(`Master admin set for ${result.target}. Sign in at the admin portal with a code and enrol two-factor authentication.`);
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
