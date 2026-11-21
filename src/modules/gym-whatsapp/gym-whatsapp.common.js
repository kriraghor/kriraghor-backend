'use strict';

/**
 * Shared bits of M24 §25 (gym-whatsapp): settings read per call, access to a gym through the gym-manage
 * facade, a member's number at rest (common/crypto), the keyed hash M01 and gym-manage use for phones, and
 * audit.
 */
const { AppError, E } = require('../../common/errors');
const crypto = require('../../common/crypto');
const { normalizePhone } = require('../../common/identifiers');
const settings = require('../settings').settings;
const audit = require('../audit').audit;

const gymManage = () => require('../gym-manage').ops;
const units = () => require('../gym-manage').whatsappUnits;

/** M24 §25 error codes (problem+json `code`). */
const ERRORS = {
  GYM_WHATSAPP_API_OFF: [409, 'Sending WhatsApp messages from the panel is not switched on yet'],
  GYM_WHATSAPP_UNAVAILABLE: [409, 'WhatsApp messages are not available on this plan right now'],
  GYM_WHATSAPP_NUMBER_TAKEN: [409, 'This WhatsApp number is already connected to another Kriraghor account'],
  GYM_WHATSAPP_META_FAILED: [502, 'WhatsApp did not accept the request. Try again'],
  GYM_WHATSAPP_NO_SENDER: [409, 'Connect a WhatsApp Business number for this gym first'],
  GYM_WHATSAPP_SENDER_STATE: [409, 'This WhatsApp number cannot do that now'],
  GYM_WHATSAPP_BLOCKED: [409, 'This message cannot be sent now'],
  GYM_WHATSAPP_CAP: [429, 'This gym has sent its bulk WhatsApp messages for today'],
  GYM_WHATSAPP_RECEIPT: [409, 'This payment has no receipt to send'],
};
const fail = (code, meta) => new AppError(ERRORS[code][0], code, ERRORS[code][1], meta ? { meta } : {});

/** Every number from M03, read per call (CLAUDE.md: no magic numbers). */
const cfg = () => ({
  apiEnabled: Boolean(settings.get('gym_whatsapp.api_enabled')),
  consentVersion: settings.get('gym_whatsapp.consent_version'),
  bulkDailyCap: settings.get('gym_whatsapp.bulk_daily_cap'),
  sendPerMinute: settings.get('gym_whatsapp.send_per_minute'),
  quietStart: settings.get('notify.quiet_hours_start'),
  quietEnd: settings.get('notify.quiet_hours_end'),
  noticeDaysMax: settings.get('gym_ops.notice_days_max'),
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

module.exports = { gymManage, units, ERRORS, fail, cfg, phoneOf, enc, dec, phoneHash, iso, record };
