'use strict';

const { Router } = require('express');
const { validate } = require('../../common/validate');
const { authenticate, authenticateAdmin } = require('../../middlewares/auth');
const { requireCsrf, requireAdminOrigin } = require('../../middlewares/csrf');
const limits = require('../../middlewares/rateLimit');
const s = require('./auth.schemas');
const c = require('./auth.controller');

const r = Router();
r.use(limits.authGeneral);

// OTP-based sign-up / sign-in (non-enumerating). Also sends the code for the admin OTP sign-in.
r.post('/otp/send', limits.otpSend, validate(s.otpSend), c.otpSend);
r.post('/otp/verify', limits.credential, validate(s.otpVerify), c.otpVerify);
r.post('/signup', limits.credential, validate(s.signup), c.signup);

// Sign in with Google (ID token from Google Identity Services)
r.post('/google', limits.credential, validate(s.google), c.google);
r.get('/username-available', limits.credential, validate(s.usernameCheck, 'query'), c.usernameAvailable);

// Password sign-in (phone, email or username) and reset
r.post('/login', limits.credential, validate(s.login), c.login);
r.post('/password/reset', limits.credential, validate(s.passwordReset), c.passwordReset);

// Customer session lifecycle (audience "api")
r.post('/refresh', requireCsrf('api'), validate(s.refresh), c.refresh);
r.post('/logout', authenticate, c.logout);

// ---------------------------------------------------------------------------
// Admin portal (ADR-004): separate staff sign-in, audience "admin", Origin must be the admin portal.
// ---------------------------------------------------------------------------
r.post('/admin/login', requireAdminOrigin, limits.credential, validate(s.adminLogin), c.adminLogin);
r.post('/admin/refresh', requireAdminOrigin, requireCsrf('admin'), c.adminRefresh);
r.post('/admin/logout', requireAdminOrigin, authenticateAdmin, c.adminLogout);

// Staff two-factor, continuing from /admin/login with its challenge token
r.post('/2fa/totp/setup', requireAdminOrigin, limits.credential, validate(s.challenge), c.totpSetup);
r.post('/2fa/totp/activate', requireAdminOrigin, limits.credential, validate(s.challengeCode), c.totpActivate);
r.post('/2fa/totp/verify', requireAdminOrigin, limits.credential, validate(s.challengeCode), c.totpVerify);

// Step-up for sensitive admin actions (single-use, scoped)
r.post('/step-up', authenticateAdmin, limits.credential, validate(s.stepUp), c.stepUp);

module.exports = r;
