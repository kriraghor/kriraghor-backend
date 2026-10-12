'use strict';

// Test environment: separate database, in-memory SMS outbox, generous per-IP OTP limit.
process.env.NODE_ENV = 'test';
process.env.SMS_DRIVER = 'memory';
process.env.OTP_SENDS_PER_IP_HOUR = '100000';
process.env.PASSWORD_BREACH_CHECK = 'false';
process.env.EMAIL_DRIVER = 'memory';
process.env.GOOGLE_CLIENT_IDS = 'test-client-id.apps.googleusercontent.com';
