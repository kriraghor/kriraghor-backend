'use strict';

const config = require('../../config');
const service = require('./auth.service');
const { User } = require('../../models');
const { serializePrincipal } = require('../users/users.serializer');

const COOKIE = config.auth.refreshCookieName;
const cookiePath = `${config.apiPrefix}/auth`;

const isMobileClient = (req) => req.get('x-client-type') === 'mobile';

function setRefreshCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: config.auth.cookieSecure,
    sameSite: 'strict',
    path: cookiePath,
    maxAge: config.auth.refreshTtlDays * 24 * 3600 * 1000,
  });
}

function clearRefreshCookie(res) {
  res.clearCookie(COOKIE, { httpOnly: true, secure: config.auth.cookieSecure, sameSite: 'strict', path: cookiePath });
}

/**
 * Shape the response for any flow that may end signed in.
 * Web: refresh token only in an httpOnly cookie. Mobile (X-Client-Type: mobile): also in the body.
 */
function sendAuthResult(req, res, result, status = 200) {
  if (result.status !== 'signed_in') return res.status(status).json(result);
  setRefreshCookie(res, result.refreshToken);
  const body = {
    status: 'signed_in',
    accessToken: result.accessToken,
    accessTokenExpiresAt: result.accessTokenExpiresAt,
    user: serializePrincipal(result.principal),
  };
  if (isMobileClient(req)) body.refreshToken = result.refreshToken;
  return res.status(status).json(body);
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
  async passwordReset(req, res) {
    clearRefreshCookie(res);
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
  async refresh(req, res) {
    const token = req.cookies?.[COOKIE] || (isMobileClient(req) ? req.body?.refreshToken : undefined);
    try {
      const result = await service.refresh(token, req);
      setRefreshCookie(res, result.refreshToken);
      const body = { accessToken: result.accessToken, accessTokenExpiresAt: result.accessTokenExpiresAt };
      if (isMobileClient(req)) body.refreshToken = result.refreshToken;
      res.json(body);
    } catch (err) {
      clearRefreshCookie(res);
      throw err;
    }
  },
  async logout(req, res) {
    await service.logout(req.user, req.auth.sessionId, req, { all: req.query.all === 'true' });
    clearRefreshCookie(res);
    res.status(204).end();
  },
};
