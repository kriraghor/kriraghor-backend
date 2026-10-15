'use strict';

// Test environment: separate database, in-memory SMS outbox. The per-IP OTP limit is raised in resetDb (a setting now).
process.env.NODE_ENV = 'test';
process.env.SMS_DRIVER = 'memory';
process.env.PASSWORD_BREACH_CHECK = 'false';
process.env.EMAIL_DRIVER = 'memory';
process.env.GOOGLE_CLIENT_IDS = 'test-client-id.apps.googleusercontent.com';
process.env.CSRF_SECRET = process.env.CSRF_SECRET || 'test-csrf-secret-that-is-at-least-32-chars';
process.env.CORS_ORIGINS = 'http://localhost:3000,http://localhost:3001,http://*.kriraghor.localhost';
process.env.ADMIN_ORIGINS = 'http://localhost:3002';
// M06: the built-in SSLCommerz simulator and master test charges.
process.env.PAYMENTS_SIMULATOR = 'true';
process.env.PAYMENTS_TEST_CHARGES = 'true';
process.env.API_PUBLIC_URL = 'http://api.test';
process.env.WEB_APP_URL = 'http://localhost:3000';
