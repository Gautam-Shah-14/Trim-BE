import type pg from 'pg';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Entitlements } from '../lib/entitlements.js';
import type { Permission } from '../lib/permissions.js';
import type { PasswordHasher } from '../lib/security.js';
import type { PaymentGateway } from '../lib/gateway.js';

export interface Deps {
  config: Config;
  pool: pg.Pool;
  log: Logger;
  hasher: PasswordHasher;
  gateway: PaymentGateway;
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
