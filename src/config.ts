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
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  QR_SECRET: z.string().min(32, 'QR_SECRET must be at least 32 characters'),
  RAZORPAY_KEY_ID: z.string().default(''),
  RAZORPAY_KEY_SECRET: z.string().default(''),
  RAZORPAY_WEBHOOK_SECRET: z.string().default(''),
  CORS_ORIGINS: z.string().default(''),
  WEBSITE_URL: z.string().default('http://localhost:3000'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),
  HOLD_SWEEPER_ENABLED: bool.default(true),
  RATE_LIMIT_GENERAL_PER_MIN: z.coerce.number().int().min(1).default(300),
  RATE_LIMIT_LOGIN_PER_15MIN: z.coerce.number().int().min(1).default(10),
  RATE_LIMIT_CONTACT_PER_HOUR: z.coerce.number().int().min(1).default(5),
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(1024).default(19456),
});

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  logLevel: string;
  databaseUrl: string;
  databaseSsl: boolean;
  databasePoolMax: number;
  jwtSecret: string;
  qrSecret: string;
  razorpay: { keyId: string; keySecret: string; webhookSecret: string };
  corsOrigins: string[];
  websiteUrl: string;
  trustProxy: number;
  holdSweeperEnabled: boolean;
  rateLimit: { generalPerMin: number; loginPer15Min: number; contactPerHour: number };
  argon2MemoryKib: number;
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
  }
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    databaseSsl: e.DATABASE_SSL,
    databasePoolMax: e.DATABASE_POOL_MAX,
    jwtSecret: e.JWT_SECRET,
    qrSecret: e.QR_SECRET,
    razorpay: { keyId: e.RAZORPAY_KEY_ID, keySecret: e.RAZORPAY_KEY_SECRET, webhookSecret: e.RAZORPAY_WEBHOOK_SECRET },
    corsOrigins: e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    websiteUrl: e.WEBSITE_URL.replace(/\/+$/, ''),
    trustProxy: e.TRUST_PROXY,
    holdSweeperEnabled: e.HOLD_SWEEPER_ENABLED,
    rateLimit: {
      generalPerMin: e.RATE_LIMIT_GENERAL_PER_MIN,
      loginPer15Min: e.RATE_LIMIT_LOGIN_PER_15MIN,
      contactPerHour: e.RATE_LIMIT_CONTACT_PER_HOUR,
    },
    argon2MemoryKib: e.ARGON2_MEMORY_KIB,
  };
}
