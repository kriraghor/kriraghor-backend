'use strict';

// Test environment: separate database, in-memory SMS outbox, generous per-IP OTP limit.
process.env.NODE_ENV = 'test';
process.env.SMS_DRIVER = 'memory';
process.env.OTP_SENDS_PER_IP_HOUR = '100000';
process.env.PASSWORD_BREACH_CHECK = 'false';
process.env.EMAIL_DRIVER = 'memory';
process.env.GOOGLE_CLIENT_IDS = 'test-client-id.apps.googleusercontent.com';
process.env.CSRF_SECRET = process.env.CSRF_SECRET || 'test-csrf-secret-that-is-at-least-32-chars';
process.env.CORS_ORIGINS = 'http://localhost:3000,http://localhost:3001,http://*.kriraghor.localhost';
process.env.ADMIN_ORIGINS = 'http://localhost:3002';
