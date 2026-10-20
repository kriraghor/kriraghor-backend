'use strict';

/**
 * M01 §6.4 limits, read from platform_settings through SettingsService (M03). They used to be
 * env vars and constants; a master can now change them on the Fees and rules screen with history.
 * Read at call time, never cached here, so a change applies within the settings bust window.
 */
const settings = require('../settings').settings;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

module.exports = {
  /** Customer sessions: auth.refresh_ttl_days; admin sessions (ADR-004): auth.admin_refresh_ttl_hours. */
  refreshTtlMs: (audience = 'api') => (audience === 'admin' ? settings.get('auth.admin_refresh_ttl_hours') * HOUR : settings.get('auth.refresh_ttl_days') * DAY),
  /** jsonwebtoken expiresIn, e.g. "15m". */
  accessTtl: () => `${settings.get('auth.access_ttl_min')}m`,
  stepUpTtl: () => `${settings.get('auth.step_up_ttl_min')}m`,
  staffIdleMs: () => settings.get('auth.staff_idle_timeout_min') * MIN,
  staffSessionMaxMs: () => settings.get('auth.staff_session_max_hours') * HOUR,
  loginFailLimit: () => settings.get('auth.login_fail_limit'),
  loginLockMs: () => settings.get('auth.login_lock_min') * MIN,
  otp: () => ({
    ttlSeconds: settings.get('auth.otp_ttl_sec'),
    maxAttempts: settings.get('auth.otp_max_attempts'),
    resendCooldownSeconds: settings.get('auth.otp_resend_cooldown_sec'),
    maxSendsPerWindow: settings.get('auth.otp_sends_per_10min'),
    // The 10-minute window is part of the setting's meaning (auth.otp_sends_per_10min).
    windowSeconds: 600,
    maxSendsPerIpHour: settings.get('auth.otp_sends_per_ip_hour'),
  }),
};
