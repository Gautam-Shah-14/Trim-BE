import type pg from 'pg';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Entitlements } from '../lib/entitlements.js';
import type { Permission } from '../lib/permissions.js';
import type { PasswordHasher } from '../lib/security.js';
import type { PaymentGateway } from '../lib/gateway.js';
import type { CacheService } from '../infra/cache.js';
import type { RateLimiter } from '../infra/limiter.js';
import type { JobQueue } from '../infra/queue.js';
import type { Metrics } from '../infra/metrics.js';
import type { Mailer } from '../lib/mailer.js';

export interface Deps {
  config: Config;
  pool: pg.Pool;
  log: Logger;
  hasher: PasswordHasher;
  gateway: PaymentGateway;
  cache: CacheService;
  limiter: RateLimiter;
  queue: JobQueue;
  metrics: Metrics;
  /** outgoing e-mail (disabled when SMTP is not configured) */
  mailer: Mailer;
  /** error-tracking hook (Sentry compatible): called for unexpected 5xx errors */
  captureException: (err: unknown, ctx?: Record<string, unknown>) => void;
}

export interface AuthInfo {
  userId: string;
  role: 'customer' | 'salon_user' | 'admin' | 'sales_agent';
  sessionId: string;
}

export interface SalonCtx {
  salonId: string;
  salon: {
    id: string;
    name: string;
    status: 'pending' | 'approved' | 'suspended';
    timezone: string;
    gstEnabled: boolean;
    gstin: string | null;
    invoicePrefix: string;
    cancelCutoffMin: number;
  };
  staffId: string | null;
  roleName: string | null;
  isOwner: boolean;
  permissions: Set<Permission>;
  ent: Entitlements;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      deps: Deps;
      auth?: AuthInfo;
      salonCtx?: SalonCtx;
      rawBody?: Buffer;
      id: string;
    }
  }
}
