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
  // ADR-004: exact origins and anchored wildcard patterns ("http://*.kriraghor.localhost"), comma-separated.
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:3001,http://localhost:3002'),
  ADMIN_ORIGINS: z.string().default('http://localhost:3002'),
  // false, true (one hop) or a hop count behind the ingress.
  TRUST_PROXY: z
    .union([z.boolean(), z.string()])
    .transform((v) => (v === true || v === 'true' ? 1 : v === false || v === 'false' || v === '' ? 0 : Number(v)))
    .pipe(z.number().int().min(0).max(5))
    .default(0),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  OPS_PORT: z.coerce.number().int().positive().default(9464),
  REALTIME_PORT: z.coerce.number().int().positive().default(4001),
  SHUTDOWN_DRAIN_MS: z.coerce.number().int().min(0).default(5000),

  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  REDIS_KEY_PREFIX: z.string().default('kg'),

  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().default(3306),
  DB_NAME: z.string().default('kriraghor'),
  DB_USER: z.string().default('kriraghor'),
  DB_PASSWORD: z.string().default(''),
  DB_LOGGING: bool.default(false),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_SPECIAL_SECRET: z.string().min(32, 'JWT_SPECIAL_SECRET must be at least 32 characters'),
  COOKIE_SECURE: bool.default(false),
  // Cookie names are "<prefix>_rt", "<prefix>_si", ... so staging ("kgstg") never collides with prod ("kg").
  COOKIE_PREFIX: z.string().regex(/^[a-z]{2,8}$/).default('kg'),
  // Domain for the readable hint and CSRF cookies, e.g. ".kriraghor.com". Empty = host-only (plain localhost ports).
  COOKIE_HINT_DOMAIN: z.string().default(''),
  CSRF_SECRET: z.string().min(32, 'CSRF_SECRET must be at least 32 characters'),
  DATA_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded'),
  OTP_HASH_SECRET: z.string().min(16),

  SMS_DRIVER: z.enum(['console', 'memory']).default('console'),
  PASSWORD_BREACH_CHECK: bool.default(false),

  EMAIL_DRIVER: z.enum(['console', 'memory', 'smtp']).default('console'),
  EMAIL_FROM: z.string().default('Kriraghor <no-reply@kriraghor.local>'),
  SMTP_HOST: z.string().default('127.0.0.1'),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_SECURE: bool.default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),

  // Comma-separated OAuth client IDs allowed as the ID-token audience (web, Android, iOS).
  GOOGLE_CLIENT_IDS: z.string().default(''),

  // S3-compatible object storage (MinIO locally, R2 or S3 in production). Used from M02/M05 on.
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_BUCKET_PRIVATE: z.string().default('kriraghor-private'),
  S3_FORCE_PATH_STYLE: bool.default(true),
  // Create missing buckets on first use (local and k3d only; production buckets are provisioned).
  S3_CREATE_BUCKETS: bool.default(false),
  STORAGE_DRIVER: z.enum(['s3', 'memory']).default('s3'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

const env = parsed.data;
const list = (v) => v.split(',').map((x) => x.trim()).filter(Boolean);

if (env.NODE_ENV === 'production' && /change-me/.test(env.JWT_ACCESS_SECRET + env.JWT_SPECIAL_SECRET + env.OTP_HASH_SECRET + env.CSRF_SECRET)) {
  throw new Error('Refusing to start in production with placeholder secrets.');
}

module.exports = {
  env: env.NODE_ENV,
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  port: env.PORT,
  apiPrefix: env.API_PREFIX,
  corsOrigins: list(env.CORS_ORIGINS),
  adminOrigins: list(env.ADMIN_ORIGINS),
  trustProxy: env.TRUST_PROXY,
  logLevel: env.LOG_LEVEL,
  opsPort: env.OPS_PORT,
  realtimePort: env.REALTIME_PORT,
  shutdownDrainMs: env.NODE_ENV === 'test' ? 0 : env.SHUTDOWN_DRAIN_MS,
  redis: { url: env.REDIS_URL, prefix: env.REDIS_KEY_PREFIX },
  db: {
    host: env.DB_HOST,
    port: env.DB_PORT,
    name: env.NODE_ENV === 'test' && !/_test$/.test(env.DB_NAME) ? `${env.DB_NAME}_test` : env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    logging: env.DB_LOGGING,
    poolMax: env.DB_POOL_MAX,
  },
  auth: {
    accessSecret: env.JWT_ACCESS_SECRET,
    specialSecret: env.JWT_SPECIAL_SECRET,
    cookieSecure: env.COOKIE_SECURE,
    cookies: {
      refresh: `${env.COOKIE_PREFIX}_rt`,
      adminRefresh: `${env.COOKIE_PREFIX}_art`,
      signedIn: `${env.COOKIE_PREFIX}_si`,
      adminSignedIn: `${env.COOKIE_PREFIX}_asi`,
      csrf: `${env.COOKIE_PREFIX}_csrf`,
      adminCsrf: `${env.COOKIE_PREFIX}_acsrf`,
    },
    hintDomain: env.COOKIE_HINT_DOMAIN || undefined,
    csrfSecret: env.CSRF_SECRET,
    issuer: 'kriraghor-api',
  },
  // OTP, login, session and staff limits live in platform_settings (M03 auth.*), read via modules/auth/limits.js.
  otp: { hashSecret: env.OTP_HASH_SECRET, length: 6 },
  passwordBreachCheck: env.PASSWORD_BREACH_CHECK,
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
  s3: {
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    accessKey: env.S3_ACCESS_KEY,
    secretKey: env.S3_SECRET_KEY,
    privateBucket: env.S3_BUCKET_PRIVATE,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    createBuckets: env.S3_CREATE_BUCKETS,
  },
  storage: { driver: env.NODE_ENV === 'test' ? 'memory' : env.STORAGE_DRIVER },
  google: {
    clientIds: env.GOOGLE_CLIENT_IDS.split(',').map((s) => s.trim()).filter(Boolean),
  },
};
