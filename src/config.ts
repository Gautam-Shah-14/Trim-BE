import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: bool.default(false),
  DATABASE_SSL_CA_FILE: z.string().default(''),
  DB_POOLER: bool.default(false),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).optional(),
  STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).default(5000),
  LOCK_TIMEOUT_MS: z.coerce.number().int().min(0).default(2000),
  IDLE_TX_TIMEOUT_MS: z.coerce.number().int().min(0).default(10000),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15000),
  BODY_LIMIT_KB: z.coerce.number().int().min(1).default(100),
  MEDIA_BODY_LIMIT_KB: z.coerce.number().int().min(1).default(400),
  REDIS_URL: z.string().default(''),
  CACHE_DRIVER: z.enum(['memory', 'redis']).default('memory'),
  RATE_LIMIT_DRIVER: z.enum(['memory', 'redis']).default('memory'),
  CACHE_TTL_PLANS_S: z.coerce.number().int().min(0).default(3600),
  CACHE_TTL_CATALOG_S: z.coerce.number().int().min(0).default(86400),
  CACHE_TTL_SALON_PUBLIC_S: z.coerce.number().int().min(0).default(120),
  CACHE_TTL_DISCOVER_S: z.coerce.number().int().min(0).default(45),
  CACHE_TTL_AVAILABILITY_S: z.coerce.number().int().min(0).default(8),
  CACHE_TTL_ENTITLEMENTS_S: z.coerce.number().int().min(0).default(30),
  CACHE_TTL_SESSION_S: z.coerce.number().int().min(0).default(30),
  QUEUE_ENABLED: bool.default(true),
  QUEUE_DATABASE_URL: z.string().default(''),
  QUEUE_DRIVER: z.enum(['pgboss', 'memory']).default('pgboss'),
  QUEUE_MAX_DEPTH: z.coerce.number().int().min(1).default(5000),
  WORKER_MODE: z.enum(['api', 'worker', 'both']).default('both'),
  METRICS_ENABLED: bool.default(true),
  METRICS_TOKEN: z.string().default(''),
  BFF_SHARED_SECRET: z.string().default('').refine((v) => v === '' || v.length >= 24, 'BFF_SHARED_SECRET must be at least 24 characters when set'),
  LOAD_SHED_LAG_MS: z.coerce.number().int().min(0).default(500),
  LOAD_SHED_POOL_WAITING: z.coerce.number().int().min(0).default(50),
  RATE_LIMIT_REGISTER_PER_HOUR: z.coerce.number().int().min(1).default(5),
  RATE_LIMIT_AVAILABILITY_PER_MIN: z.coerce.number().int().min(1).default(60),
  RATE_LIMIT_HOLD_PER_MIN: z.coerce.number().int().min(1).default(10),
  RATE_LIMIT_CHECKIN_PER_MIN: z.coerce.number().int().min(1).default(120),
  MAX_HELD_PER_CUSTOMER: z.coerce.number().int().min(1).default(3),
  MAX_UPCOMING_PER_CUSTOMER: z.coerce.number().int().min(1).default(10),
  MAX_BOOKINGS_PER_DAY: z.coerce.number().int().min(1).default(5),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  QR_SECRET: z.string().min(32, 'QR_SECRET must be at least 32 characters'),
  RAZORPAY_KEY_ID: z.string().default(''),
  RAZORPAY_KEY_SECRET: z.string().default(''),
  RAZORPAY_WEBHOOK_SECRET: z.string().default(''),
  CORS_ORIGINS: z.string().default(''),
  WEBSITE_URL: z.string().default('http://localhost:3000'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),
  RATE_LIMIT_GENERAL_PER_MIN: z.coerce.number().int().min(1).default(300),
  RATE_LIMIT_LOGIN_PER_15MIN: z.coerce.number().int().min(1).default(10),
  RATE_LIMIT_CONTACT_PER_HOUR: z.coerce.number().int().min(1).default(5),
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(1024).default(19456),
  WAITLIST_OPEN: bool.default(true),
  RATE_LIMIT_WAITLIST_PER_HOUR: z.coerce.number().int().min(1).default(10),
  SMTP_HOST: z.string().trim().default('smtp-relay.brevo.com'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: bool.default(false),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  MAIL_FROM: z.string().trim().default('').refine((v) => !/[\r\n]/.test(v), 'MAIL_FROM must be a single line'),
  WAITLIST_NOTIFY_TO: z
    .string()
    .trim()
    .default('')
    .refine((v) => v === '' || z.email().safeParse(v).success, 'WAITLIST_NOTIFY_TO must be one e-mail address'),
});

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  logLevel: string;
  databaseUrl: string;
  databaseSsl: boolean;
  databaseSslCaFile: string;
  dbPooler: boolean;
  databasePoolMax: number;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  idleTxTimeoutMs: number;
  requestTimeoutMs: number;
  bodyLimitKb: number;
  mediaBodyLimitKb: number;
  redisUrl: string;
  queueDatabaseUrl: string;
  cacheDriver: 'memory' | 'redis';
  rateLimitDriver: 'memory' | 'redis';
  cacheTtl: { plans: number; catalog: number; salonPublic: number; discover: number; availability: number; entitlements: number; session: number };
  queue: { enabled: boolean; driver: 'pgboss' | 'memory'; maxDepth: number };
  workerMode: 'api' | 'worker' | 'both';
  metrics: { enabled: boolean; token: string };
  bffSharedSecret: string;
  loadShed: { lagMs: number; poolWaiting: number };
  caps: { maxHeld: number; maxUpcoming: number; maxPerDay: number };
  jwtSecret: string;
  qrSecret: string;
  razorpay: { keyId: string; keySecret: string; webhookSecret: string };
  corsOrigins: string[];
  websiteUrl: string;
  trustProxy: number;
  rateLimit: { generalPerMin: number; loginPer15Min: number; contactPerHour: number; registerPerHour: number; availabilityPerMin: number; holdPerMin: number; checkinPerMin: number; waitlistPerHour: number };
  argon2MemoryKib: number;
  waitlistOpen: boolean;
  /** SMTP (Brevo). `enabled` is false when SMTP_HOST, SMTP_USER, SMTP_PASS or MAIL_FROM is empty: mail is then skipped, never fatal. */
  mail: { enabled: boolean; missing: string[]; host: string; port: number; secure: boolean; user: string; pass: string; from: string; waitlistNotifyTo: string };
}

export class ConfigError extends Error {}

/** Parse + validate environment variables. Throws ConfigError with a readable message. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid environment configuration:\n${lines.join('\n')}\nSee .env.example.`);
  }
  const e = parsed.data;
  if (e.NODE_ENV === 'production') {
    const missing = (['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'CORS_ORIGINS'] as const).filter(
      (k) => !e[k],
    );
    if (missing.length) {
      throw new ConfigError(`Invalid environment configuration: missing in production: ${missing.join(', ')}. See .env.example.`);
    }
    if (e.METRICS_ENABLED && !e.METRICS_TOKEN) {
      throw new ConfigError('Invalid environment configuration: METRICS_TOKEN is required in production while METRICS_ENABLED=true (or set METRICS_ENABLED=false). See .env.example.');
    }
  }
  if ((e.CACHE_DRIVER === 'redis' || e.RATE_LIMIT_DRIVER === 'redis') && !e.REDIS_URL) {
    throw new ConfigError(['Invalid environment configuration:', '  - REDIS_URL: required when CACHE_DRIVER or RATE_LIMIT_DRIVER is redis. See .env.example.'].join('\n'));
  }
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    databaseSsl: e.DATABASE_SSL,
    databaseSslCaFile: e.DATABASE_SSL_CA_FILE,
    dbPooler: e.DB_POOLER,
    databasePoolMax: e.DB_POOL_MAX ?? e.DATABASE_POOL_MAX ?? 10,
    statementTimeoutMs: e.STATEMENT_TIMEOUT_MS,
    lockTimeoutMs: e.LOCK_TIMEOUT_MS,
    idleTxTimeoutMs: e.IDLE_TX_TIMEOUT_MS,
    requestTimeoutMs: e.REQUEST_TIMEOUT_MS,
    bodyLimitKb: e.BODY_LIMIT_KB,
    mediaBodyLimitKb: e.MEDIA_BODY_LIMIT_KB,
    redisUrl: e.REDIS_URL,
    queueDatabaseUrl: e.QUEUE_DATABASE_URL,
    cacheDriver: e.CACHE_DRIVER,
    rateLimitDriver: e.RATE_LIMIT_DRIVER,
    cacheTtl: { plans: e.CACHE_TTL_PLANS_S, catalog: e.CACHE_TTL_CATALOG_S, salonPublic: e.CACHE_TTL_SALON_PUBLIC_S, discover: e.CACHE_TTL_DISCOVER_S, availability: e.CACHE_TTL_AVAILABILITY_S, entitlements: e.CACHE_TTL_ENTITLEMENTS_S, session: e.CACHE_TTL_SESSION_S },
    queue: { enabled: e.QUEUE_ENABLED, driver: e.QUEUE_DRIVER, maxDepth: e.QUEUE_MAX_DEPTH },
    workerMode: e.WORKER_MODE,
    metrics: { enabled: e.METRICS_ENABLED, token: e.METRICS_TOKEN },
    bffSharedSecret: e.BFF_SHARED_SECRET,
    loadShed: { lagMs: e.LOAD_SHED_LAG_MS, poolWaiting: e.LOAD_SHED_POOL_WAITING },
    caps: { maxHeld: e.MAX_HELD_PER_CUSTOMER, maxUpcoming: e.MAX_UPCOMING_PER_CUSTOMER, maxPerDay: e.MAX_BOOKINGS_PER_DAY },
    jwtSecret: e.JWT_SECRET,
    qrSecret: e.QR_SECRET,
    razorpay: { keyId: e.RAZORPAY_KEY_ID, keySecret: e.RAZORPAY_KEY_SECRET, webhookSecret: e.RAZORPAY_WEBHOOK_SECRET },
    corsOrigins: e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    websiteUrl: e.WEBSITE_URL.replace(/\/+$/, ''),
    trustProxy: e.TRUST_PROXY,
    rateLimit: {
      generalPerMin: e.RATE_LIMIT_GENERAL_PER_MIN,
      loginPer15Min: e.RATE_LIMIT_LOGIN_PER_15MIN,
      contactPerHour: e.RATE_LIMIT_CONTACT_PER_HOUR,
      registerPerHour: e.RATE_LIMIT_REGISTER_PER_HOUR,
      availabilityPerMin: e.RATE_LIMIT_AVAILABILITY_PER_MIN,
      holdPerMin: e.RATE_LIMIT_HOLD_PER_MIN,
      checkinPerMin: e.RATE_LIMIT_CHECKIN_PER_MIN,
      waitlistPerHour: e.RATE_LIMIT_WAITLIST_PER_HOUR,
    },
    argon2MemoryKib: e.ARGON2_MEMORY_KIB,
    waitlistOpen: e.WAITLIST_OPEN,
    mail: (() => {
      const missing = (['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'] as const).filter((k) => !e[k]);
      return {
        enabled: missing.length === 0, missing, host: e.SMTP_HOST, port: e.SMTP_PORT, secure: e.SMTP_SECURE,
        user: e.SMTP_USER, pass: e.SMTP_PASS, from: e.MAIL_FROM, waitlistNotifyTo: e.WAITLIST_NOTIFY_TO,
      };
    })(),
  };
}
