'use strict';

const { Router } = require('express');
const { validate } = require('../../common/validate');
const { authenticate, requireStaff } = require('../../middlewares/auth');
const limits = require('../../middlewares/rateLimit');
const s = require('./auth.schemas');
const c = require('./auth.controller');

const r = Router();
r.use(limits.authGeneral);

// OTP-based sign-up / sign-in (non-enumerating)
r.post('/otp/send', limits.otpSend, validate(s.otpSend), c.otpSend);
r.post('/otp/verify', limits.credential, validate(s.otpVerify), c.otpVerify);
r.post('/signup', limits.credential, validate(s.signup), c.signup);

// Sign in with Google (ID token from Google Identity Services)
r.post('/google', limits.credential, validate(s.google), c.google);
r.get('/username-available', limits.credential, validate(s.usernameCheck, 'query'), c.usernameAvailable);

// Password sign-in (phone, email or username) and reset
r.post('/login', limits.credential, validate(s.login), c.login);
r.post('/password/reset', limits.credential, validate(s.passwordReset), c.passwordReset);

// Staff two-factor (challenge token from login)
r.post('/2fa/totp/setup', limits.credential, validate(s.challenge), c.totpSetup);
r.post('/2fa/totp/activate', limits.credential, validate(s.challengeCode), c.totpActivate);
r.post('/2fa/totp/verify', limits.credential, validate(s.challengeCode), c.totpVerify);

// Step-up for sensitive admin actions (single-use, scoped)
r.post('/step-up', authenticate, requireStaff, limits.credential, validate(s.stepUp), c.stepUp);

// Session lifecycle
r.post('/refresh', validate(s.refresh), c.refresh);
r.post('/logout', authenticate, c.logout);

module.exports = r;
