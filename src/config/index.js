'use strict';

require('dotenv').config({ quiet: true });
const { z } = require('zod');

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => v === true || v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  API_PREFIX: z.string().default('/api/v1'),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  TRUST_PROXY: bool.default(false),

  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().default(3306),
  DB_NAME: z.string().default('kriraghor'),
  DB_USER: z.string().default('kriraghor'),
  DB_PASSWORD: z.string().default(''),
  DB_LOGGING: bool.default(false),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_SPECIAL_SECRET: z.string().min(32, 'JWT_SPECIAL_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_SECURE: bool.default(false),
  DATA_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded'),
  OTP_HASH_SECRET: z.string().min(16),

  SMS_DRIVER: z.enum(['console', 'memory']).default('console'),
  PASSWORD_BREACH_CHECK: bool.default(false),
  OTP_SENDS_PER_IP_HOUR: z.coerce.number().int().positive().default(10),
  STAFF_IDLE_TIMEOUT_MIN: z.coerce.number().int().positive().default(30),
  STAFF_SESSION_MAX_HOURS: z.coerce.number().int().positive().default(12),

  EMAIL_DRIVER: z.enum(['console', 'memory', 'smtp']).default('console'),
  EMAIL_FROM: z.string().default('Kriraghor <no-reply@kriraghor.local>'),
  SMTP_HOST: z.string().default('127.0.0.1'),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_SECURE: bool.default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),

  // Comma-separated OAuth client IDs allowed as the ID-token audience (web, Android, iOS).
  GOOGLE_CLIENT_IDS: z.string().default(''),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

const env = parsed.data;

if (env.NODE_ENV === 'production' && /change-me/.test(env.JWT_ACCESS_SECRET + env.JWT_SPECIAL_SECRET + env.OTP_HASH_SECRET)) {
  throw new Error('Refusing to start in production with placeholder secrets.');
}

module.exports = {
  env: env.NODE_ENV,
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  port: env.PORT,
  apiPrefix: env.API_PREFIX,
  webOrigin: env.WEB_ORIGIN.split(',').map((s) => s.trim()),
  trustProxy: env.TRUST_PROXY,
  db: {
    host: env.DB_HOST,
    port: env.DB_PORT,
    name: env.NODE_ENV === 'test' && !/_test$/.test(env.DB_NAME) ? `${env.DB_NAME}_test` : env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    logging: env.DB_LOGGING,
  },
  auth: {
    accessSecret: env.JWT_ACCESS_SECRET,
    specialSecret: env.JWT_SPECIAL_SECRET,
    accessTtl: env.ACCESS_TOKEN_TTL,
    refreshTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
    cookieSecure: env.COOKIE_SECURE,
    refreshCookieName: 'kg_rt',
    issuer: 'kriraghor-api',
  },
  otp: {
    hashSecret: env.OTP_HASH_SECRET,
    length: 6,
    ttlSeconds: 300,
    maxAttempts: 5,
    resendCooldownSeconds: 60,
    maxSendsPerWindow: 3,
    windowSeconds: 600,
    maxSendsPerIpHour: env.OTP_SENDS_PER_IP_HOUR,
  },
  passwordBreachCheck: env.PASSWORD_BREACH_CHECK,
  staff: {
    idleTimeoutMs: env.STAFF_IDLE_TIMEOUT_MIN * 60 * 1000,
    sessionMaxMs: env.STAFF_SESSION_MAX_HOURS * 3600 * 1000,
  },
  login: { failLimit: 5, lockMinutes: 15 },
  crypto: {
    dataKey: Buffer.from(env.DATA_ENCRYPTION_KEY, 'base64'),
  },
  sms: { driver: env.SMS_DRIVER },
  email: {
    driver: env.EMAIL_DRIVER,
    from: env.EMAIL_FROM,
    smtp: {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    },
  },
  google: {
    clientIds: env.GOOGLE_CLIENT_IDS.split(',').map((s) => s.trim()).filter(Boolean),
  },
};
