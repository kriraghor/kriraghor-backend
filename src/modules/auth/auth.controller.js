'use strict';

const service = require('./auth.service');
const cookies = require('./cookies');
const { User } = require('../../models');
const { serializePrincipal } = require('../users/users.serializer');

const isMobileClient = (req) => req.get('x-client-type') === 'mobile';

/**
 * Shape the response for any flow that may end signed in.
 * Web: the refresh token goes only in an httpOnly cookie, plus the hint and CSRF cookies (ADR-004).
 * Mobile (X-Client-Type: mobile): the refresh token is also in the body; no cookies are needed.
 */
function sendAuthResult(req, res, result, status = 200) {
  if (result.status !== 'signed_in') return res.status(status).json(result);
  if (!isMobileClient(req)) cookies.setSessionCookies(res, result);
  const body = {
    status: 'signed_in',
    accessToken: result.accessToken,
    accessTokenExpiresAt: result.accessTokenExpiresAt,
    user: serializePrincipal(result.principal),
  };
  if (isMobileClient(req)) body.refreshToken = result.refreshToken;
  return res.status(status).json(body);
}

/** Refresh for one audience: customer ("api") or admin. */
function refreshFor(audience) {
  const { refresh: cookieName } = cookies.names(audience);
  return async (req, res) => {
    const fromBody = audience === 'api' && isMobileClient(req) ? req.body?.refreshToken : undefined;
    const token = req.cookies?.[cookieName] || fromBody;
    try {
      const result = await service.refresh(token, req, audience);
      if (!isMobileClient(req)) cookies.setSessionCookies(res, result);
      const body = { accessToken: result.accessToken, accessTokenExpiresAt: result.accessTokenExpiresAt };
      if (isMobileClient(req)) body.refreshToken = result.refreshToken;
      res.json(body);
    } catch (err) {
      cookies.clearSessionCookies(res, audience);
      throw err;
    }
  };
}

function logoutFor(audience) {
  return async (req, res) => {
    await service.logout(req.user, req.auth.sessionId, req, { all: req.query.all === 'true' });
    cookies.clearSessionCookies(res, audience);
    res.status(204).end();
  };
}

module.exports = {
  async otpSend(req, res) {
    res.status(202).json(await service.sendOtp(req.body, req));
  },
  async otpVerify(req, res) {
    sendAuthResult(req, res, await service.verifyOtp(req.body, req));
  },
  async signup(req, res) {
    sendAuthResult(req, res, await service.signup(req.body, req), 201);
  },
  async google(req, res) {
    sendAuthResult(req, res, await service.signInWithGoogle(req.body, req));
  },
  async usernameAvailable(req, res) {
    const { username } = req.validQuery;
    const taken = await User.count({ where: { username } });
    res.json({ username, available: taken === 0 });
  },
  async login(req, res) {
    sendAuthResult(req, res, await service.loginWithPassword(req.body, req));
  },
  async adminLogin(req, res) {
    sendAuthResult(req, res, await service.adminLogin(req.body, req));
  },
  async passwordReset(req, res) {
    cookies.clearSessionCookies(res, 'api');
    res.json(await service.resetPassword(req.body, req));
  },
  async totpSetup(req, res) {
    res.json(await service.totpSetup(req.body, req));
  },
  async totpActivate(req, res) {
    sendAuthResult(req, res, await service.totpActivate(req.body, req));
  },
  async totpVerify(req, res) {
    sendAuthResult(req, res, await service.totpVerify(req.body, req));
  },
  async stepUp(req, res) {
    res.json(await service.stepUp(req.user, req.auth.sessionId, req.body, req));
  },
  refresh: refreshFor('api'),
  adminRefresh: refreshFor('admin'),
  logout: logoutFor('api'),
  adminLogout: logoutFor('admin'),
};
