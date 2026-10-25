#!/usr/bin/env node
'use strict';
/* eslint-disable no-console -- a command-line tool: its output is the report */

/**
 * How many current NID documents (approved, in review or changes requested) belong to someone under
 * kyc.min_age_years today in Dhaka (M02 §6.3 age_ok; 18 and over since 25 Oct 2026). Read-only: it
 * prints the count and the minimum age only, never a name, number or date of birth, so it is safe to
 * run on the local database or in a Render shell. The listing is audited (kyc.under_min_age_listed,
 * source script) like the admin view, GET /admin/kyc/under-min-age, which staff use for the names.
 *
 *   node scripts/kyc-under-min-age.js
 */
const { sequelize } = require('../src/models');
const settings = require('../src/modules/settings/settings.service');
const kyc = require('../src/modules/kyc/kyc.service');

async function main() {
  await settings.load();
  const { count, minAgeYears } = await kyc.listUnderMinAge(null, undefined, { source: 'script' });
  console.log(`NID holders under ${minAgeYears}: ${count}`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sequelize.close();
    try {
      await require('../src/common/redis').closeAllRedis();
    } catch {
      // no Redis connection was opened
    }
  });
