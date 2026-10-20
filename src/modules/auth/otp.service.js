'use strict';

const { Op } = require('sequelize');
const config = require('../../config');
const { OtpCode, sequelize } = require('../../models');
const { hmac, randomDigits, timingSafeEqualHex } = require('../../common/crypto');
const { E } = require('../../common/errors');
// M08-FR-08: OTPs go out through the notification service's priority route (logged, code redacted).
const notifications = require('../notifications').notify;
const limits = require('./limits');

// Limits come from platform_settings (auth.otp_*), read per call so a change applies at once.
const CODE_LENGTH = config.otp.length;

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const bnNumber = (n) => String(n).replace(/\d/g, (d) => BN_DIGITS[Number(d)]);
const minutes = (seconds) => Math.max(1, Math.round(seconds / 60));

const MESSAGES = {
  en: (code, ttl) => `Your Kriraghor code is ${code}. It expires in ${minutes(ttl)} minutes. Never share it with anyone.`,
  bn: (code, ttl) => `আপনার ক্রীড়াঘর কোড ${code}। ${bnNumber(minutes(ttl))} মিনিটের মধ্যে মেয়াদ শেষ হবে। কাউকে কোডটি দেবেন না।`,
};

const EMAIL_SUBJECT = { en: 'Your Kriraghor code', bn: 'আপনার ক্রীড়াঘর কোড' };

function emailBody(code, locale, ttl) {
  const text = (MESSAGES[locale] || MESSAGES.en)(code, ttl);
  const html = `<!doctype html><html><body style="margin:0;background:#F4F3EF;font-family:Arial,Helvetica,sans-serif;color:#201E1D">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
    <table role="presentation" width="100%" style="max-width:480px;background:#ffffff;border-radius:8px" cellpadding="0" cellspacing="0">
      <tr><td style="background:#0B7A4B;color:#ffffff;padding:16px 24px;font-size:18px;font-weight:bold;border-radius:8px 8px 0 0">ক্রীড়াঘর Kriraghor</td></tr>
      <tr><td style="padding:24px">
        <p style="margin:0 0 12px">${locale === 'bn' ? 'আপনার যাচাই কোড' : 'Your verification code'}</p>
        <p style="margin:0 0 16px;font-size:32px;letter-spacing:6px;font-weight:bold">${code}</p>
        <p style="margin:0;color:#5F5E5A;font-size:14px">${locale === 'bn' ? `${bnNumber(minutes(ttl))} মিনিটের মধ্যে মেয়াদ শেষ হবে। কাউকে কোডটি দেবেন না।` : `It expires in ${minutes(ttl)} minutes. Never share it with anyone, including Kriraghor staff.`}</p>
      </td></tr>
    </table>
    <p style="color:#888780;font-size:12px;margin:16px 0 0">${locale === 'bn' ? 'আপনি অনুরোধ না করলে এই ইমেলটি উপেক্ষা করুন।' : "If you didn't ask for this code, you can ignore this email."}</p>
  </td></tr></table></body></html>`;
  return { subject: EMAIL_SUBJECT[locale] || EMAIL_SUBJECT.en, text, html };
}

const codeHash = (target, purpose, code) => hmac(`${purpose}:${target}:${code}`);

function rateLimited(retryAfterSeconds) {
  return E.tooMany('OTP_RATE_LIMITED', 'Too many codes requested', `Try again in ${retryAfterSeconds} seconds.`, {
    retryAfter: retryAfterSeconds,
  });
}

/**
 * Issue an OTP (M01-FR-02). Enforces resend cooldown, per-target window cap and per-IP cap.
 * `deliver=false` records the attempt without sending (used when the target has no account
 * for a reset, so the response stays identical and nothing leaks).
 */
async function issue({ target, purpose, ip, locale = 'en', deliver = true }) {
  const now = Date.now();
  const cfg = limits.otp();

  const recent = await OtpCode.findAll({
    where: { target: target.value, purpose, createdAt: { [Op.gt]: new Date(now - cfg.windowSeconds * 1000) } },
    order: [['createdAt', 'DESC']],
  });
  if (recent.length) {
    const sinceLast = (now - recent[0].createdAt.getTime()) / 1000;
    if (sinceLast < cfg.resendCooldownSeconds) throw rateLimited(Math.ceil(cfg.resendCooldownSeconds - sinceLast));
    if (recent.length >= cfg.maxSendsPerWindow) {
      const oldest = recent[recent.length - 1].createdAt.getTime();
      throw rateLimited(Math.ceil((oldest + cfg.windowSeconds * 1000 - now) / 1000));
    }
  }
  if (ip) {
    const perIp = await OtpCode.count({ where: { ip, createdAt: { [Op.gt]: new Date(now - 3600 * 1000) } } });
    if (perIp >= cfg.maxSendsPerIpHour) throw rateLimited(3600);
  }

  const code = randomDigits(CODE_LENGTH);
  await sequelize.transaction(async (transaction) => {
    // Only the newest code for a target/purpose is valid.
    await OtpCode.update(
      { consumedAt: new Date() },
      { where: { target: target.value, purpose, consumedAt: null }, transaction }
    );
    await OtpCode.create(
      {
        target: target.value,
        purpose,
        codeHash: codeHash(target.value, purpose, code),
        expiresAt: new Date(now + cfg.ttlSeconds * 1000),
        ip,
      },
      { transaction }
    );
  });

  if (deliver) {
    await notifications.sendOtp({
      target,
      text: (MESSAGES[locale] || MESSAGES.en)(code, cfg.ttlSeconds),
      email: emailBody(code, locale, cfg.ttlSeconds),
    });
  }
  return { expiresInSeconds: cfg.ttlSeconds, resendInSeconds: cfg.resendCooldownSeconds };
}

/**
 * Verify and consume the latest OTP. Wrong codes count towards maxAttempts;
 * the code is burned when the limit is reached.
 */
async function consume({ target, purpose, code }) {
  const { maxAttempts } = limits.otp();
  // The transaction must COMMIT the attempt counter / expiry before we report failure;
  // throwing inside it would roll the counter back and allow unlimited guesses.
  const outcome = await sequelize.transaction(async (transaction) => {
    const otp = await OtpCode.findOne({
      where: { target: target.value, purpose, consumedAt: null },
      order: [['createdAt', 'DESC']],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!otp) return { ok: false, code: 'OTP_INVALID' };
    if (otp.expiresAt < new Date()) {
      await otp.update({ consumedAt: new Date() }, { transaction });
      return { ok: false, code: 'OTP_EXPIRED' };
    }
    if (!timingSafeEqualHex(otp.codeHash, codeHash(target.value, purpose, String(code)))) {
      const attempts = otp.attempts + 1;
      await otp.update({ attempts, consumedAt: attempts >= maxAttempts ? new Date() : null }, { transaction });
      return { ok: false, code: 'OTP_INVALID', left: Math.max(0, maxAttempts - attempts) };
    }
    await otp.update({ consumedAt: new Date() }, { transaction });
    return { ok: true };
  });

  if (outcome.ok) return true;
  if (outcome.code === 'OTP_EXPIRED') throw E.badRequest('OTP_EXPIRED', 'That code has expired. Request a new one.');
  if (outcome.left === undefined) throw E.badRequest('OTP_INVALID', 'That code is not right. Check it or request a new one.');
  throw E.badRequest(
    'OTP_INVALID',
    outcome.left
      ? `That code is not right. ${outcome.left} attempt${outcome.left === 1 ? '' : 's'} left.`
      : 'Too many wrong codes. Request a new one.'
  );
}

module.exports = { issue, consume };
