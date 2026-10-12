'use strict';

const { OAuth2Client } = require('google-auth-library');
const config = require('../../config');
const { E } = require('../../common/errors');

const client = new OAuth2Client();

/**
 * Verify a Google ID token from "Sign in with Google" (Google Identity Services).
 * Checks signature (Google certs), issuer, expiry and that the audience is one of our client IDs.
 * Returns a normalised profile.
 */
async function verifyIdToken(idToken) {
  if (!config.google.clientIds.length) {
    throw E.badRequest('GOOGLE_NOT_CONFIGURED', 'Google sign-in is not configured on this server');
  }
  let payload;
  try {
    const ticket = await client.verifyIdToken({ idToken, audience: config.google.clientIds });
    payload = ticket.getPayload();
  } catch {
    throw E.unauthorized('GOOGLE_TOKEN_INVALID', 'Google sign-in failed. Try again.');
  }
  if (!payload?.sub || !['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) {
    throw E.unauthorized('GOOGLE_TOKEN_INVALID', 'Google sign-in failed. Try again.');
  }
  return {
    subject: payload.sub,
    email: payload.email ? payload.email.toLowerCase() : null,
    emailVerified: payload.email_verified === true,
    name: payload.name || [payload.given_name, payload.family_name].filter(Boolean).join(' ') || null,
    picture: payload.picture || null,
    locale: payload.locale || null,
  };
}

module.exports = { verifyIdToken };
