'use strict';

/**
 * Shared bits of M24 §25 (gym-whatsapp): settings read per call, access to a gym through the gym-manage
 * facade, a member's number at rest (common/crypto), the keyed hash M01 and gym-manage use for phones, and
 * audit.
 */
const { E } = require('../../common/errors');
const crypto = require('../../common/crypto');
const { normalizePhone } = require('../../common/identifiers');
const settings = require('../settings').settings;
const audit = require('../audit').audit;

const gymManage = () => require('../gym-manage').ops;

/** Every number from M03, read per call (CLAUDE.md: no magic numbers). */
const cfg = () => ({
  apiEnabled: Boolean(settings.get('gym_whatsapp.api_enabled')),
  consentVersion: settings.get('gym_whatsapp.consent_version'),
});

/** A Bangladesh mobile normalised to +8801… (422 on `field` otherwise). */
function phoneOf(input, field = 'number') {
  const p = normalizePhone(String(input ?? ''));
  if (!p) throw E.validation([{ field, message: 'Enter a Bangladesh mobile number' }]);
  return p;
}

const enc = (v) => crypto.encrypt(String(v));
const dec = (v) => (v ? crypto.decrypt(v) : null);
/** The same keyed hash as M01, sms_log and gym-manage, so a reply from a number finds its member. */
const phoneHash = (e164) => crypto.hmac(`phone:${e164}`);
const iso = (d) => (d ? new Date(d).toISOString() : null);

const record = (entry, transaction) => audit.record(entry, { transaction });

module.exports = { gymManage, cfg, phoneOf, enc, dec, phoneHash, iso, record };
