import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import type pg from 'pg';
import type { ZodType } from 'zod';
import { E } from '../errors.js';
import { entitlements, type PlanRow, type SubscriptionRow } from '../lib/entitlements.js';
import { ALL_PERMISSIONS, type Permission } from '../lib/permissions.js';
import { verifyAccess } from '../lib/security.js';
import type { AuthInfo, Deps, SalonCtx } from './types.js';

export type AuthKind = 'none' | 'user' | 'customer' | 'admin' | 'sales' | 'salon';

export interface RouteMeta {
  summary: string;
  tag: string;
  auth: AuthKind;
  /** salon-scoped permission required */
  perm?: Permission;
  /** reject with SUBSCRIPTION_INACTIVE when the salon is read-only */
  writable?: boolean;
  /** only the salon owner role (or nothing else) */
  ownerOnly?: boolean;
  /** extra requirement description for the docs, e.g. entitlement name */
  note?: string;
  body?: ZodType;
  query?: ZodType;
  /** OpenAPI component name (suffix [] for arrays) of the `data` payload */
  returns?: string;
  status?: number;
  idempotent?: boolean;
  /** response is not JSON (media bytes, csv) */
  raw?: string;
}

export interface RouteDef {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  meta: RouteMeta;
}

// ---------------------------------------------------------------- plan cache
const planCache = new WeakMap<pg.Pool, { at: number; plans: Record<string, PlanRow> }>();
export function invalidatePlanCache(pool: pg.Pool) {
  planCache.delete(pool);
}
export async function getPlans(pool: pg.Pool): Promise<Record<string, PlanRow>> {
  const c = planCache.get(pool);
  if (c && Date.now() - c.at < 10_000) return c.plans;
  const r = await pool.query<PlanRow>('SELECT * FROM plans');
  const plans = Object.fromEntries(r.rows.map((p) => [p.code, p]));
  planCache.set(pool, { at: Date.now(), plans });
  return plans;
}

// ---------------------------------------------------------------- middleware
export const authenticate: RequestHandler = async (req, _res, next) => {
  const h = req.header('authorization');
  if (!h || !/^Bearer /i.test(h)) throw E.unauth();
  const claims = verifyAccess(req.deps.config.jwtSecret, h.slice(7).trim());
  if (!claims) throw E.unauth('Invalid or expired access token');
  const r = await req.deps.pool.query<{ platform_role: AuthInfo['role']; is_active: boolean }>(
    `SELECT u.platform_role, u.is_active FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND u.id = $2 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [claims.sid, claims.sub],
  );
  const row = r.rows[0];
  if (!row || !row.is_active) throw E.unauth('Session is no longer valid');
  req.auth = { userId: claims.sub, role: row.platform_role, sessionId: claims.sid };
  next();
};

export function requireRoles(...roles: AuthInfo['role'][]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) throw E.forbidden();
    next();
  };
}

export const loadSalon: RequestHandler = async (req, _res, next) => {
  const salonId = String(req.params['salonId']);
  if (!/^[0-9a-f-]{36}$/i.test(salonId)) throw E.notFound('Salon');
  const pool = req.deps.pool;
  const auth = req.auth!;
  const s = await pool.query<{
    id: string; name: string; status: SalonCtx['salon']['status']; timezone: string; gst_enabled: boolean; gstin: string | null;
    invoice_prefix: string; cancel_cutoff_min: number;
    plan_code: string; sub_status: SubscriptionRow['status']; trial_ends_at: Date | null; current_period_end: Date | null;
    comp_until: Date | null; past_due_since: Date | null;
  }>(
    `SELECT s.id, s.name, s.status, s.timezone, s.gst_enabled, s.gstin, s.invoice_prefix, s.cancel_cutoff_min,
            sub.plan_code, sub.status AS sub_status, sub.trial_ends_at, sub.current_period_end, sub.comp_until, sub.past_due_since
       FROM salons s JOIN subscriptions sub ON sub.salon_id = s.id WHERE s.id = $1`,
    [salonId],
  );
  const row = s.rows[0];
  if (!row) throw E.notFound('Salon');

  let staffId: string | null = null;
  let roleName: string | null = null;
  let permissions: Set<Permission>;
  let isOwner = false;
  if (auth.role === 'admin') {
    permissions = new Set(ALL_PERMISSIONS);
  } else {
    const m = await pool.query<{ id: string; role_name: string; is_system: boolean; perms: Permission[] }>(
      `SELECT st.id, r.name AS role_name, r.is_system,
              COALESCE(array_agg(p.permission) FILTER (WHERE p.permission IS NOT NULL), '{}') AS perms
         FROM salon_staff st JOIN salon_roles r ON r.id = st.role_id
         LEFT JOIN salon_role_permissions p ON p.role_id = r.id
        WHERE st.salon_id = $1 AND st.user_id = $2 AND st.is_active
        GROUP BY st.id, r.name, r.is_system`,
      [salonId, auth.userId],
    );
    const mem = m.rows[0];
    if (!mem) throw E.forbidden('You are not a member of this salon');
    staffId = mem.id;
    roleName = mem.role_name;
    isOwner = mem.role_name === 'owner' && mem.is_system;
    permissions = new Set(mem.perms);
  }
  const plans = await getPlans(pool);
  const ent = entitlements(
    {
      plan_code: row.plan_code, status: row.sub_status, trial_ends_at: row.trial_ends_at,
      current_period_end: row.current_period_end, comp_until: row.comp_until, past_due_since: row.past_due_since,
    },
    plans,
  );
  if (row.status === 'suspended') {
    ent.readOnly = true;
    ent.discoverable = false;
  }
  req.salonCtx = {
    salonId,
    salon: {
      id: row.id, name: row.name, status: row.status, timezone: row.timezone, gstEnabled: row.gst_enabled, gstin: row.gstin,
      invoicePrefix: row.invoice_prefix, cancelCutoffMin: row.cancel_cutoff_min,
    },
    staffId, roleName, isOwner, permissions, ent,
  };
  next();
};

export function requirePerm(perm: Permission): RequestHandler {
  return (req, _res, next) => {
    if (!req.salonCtx?.permissions.has(perm)) throw E.forbidden(`Missing permission: ${perm}`, perm);
    next();
  };
}

export const requireWritable: RequestHandler = (req, _res, next) => {
  if (req.salonCtx?.ent.readOnly) throw E.inactive();
  next();
};

export const requireOwner: RequestHandler = (req, _res, next) => {
  if (!req.salonCtx?.isOwner) throw E.forbidden('Only the salon owner can do this');
  next();
};

// ---------------------------------------------------------------- registry
export class Api {
  readonly routes: RouteDef[] = [];
  constructor(
    readonly router: Router,
    readonly deps: Deps,
  ) {}

  private add(method: RouteDef['method'], path: string, meta: RouteMeta, handler: (req: Request, res: Response, next: NextFunction) => unknown, pre: RequestHandler[] = []) {
    this.routes.push({ method, path, meta });
    const chain: RequestHandler[] = [...pre];
    switch (meta.auth) {
      case 'none':
        break;
      case 'user':
        chain.push(authenticate);
        break;
      case 'customer':
        chain.push(authenticate, requireRoles('customer'));
        break;
      case 'admin':
        chain.push(authenticate, requireRoles('admin'));
        break;
      case 'sales':
        chain.push(authenticate, requireRoles('sales_agent', 'admin'));
        break;
      case 'salon':
        chain.push(authenticate, loadSalon);
        if (meta.ownerOnly) chain.push(requireOwner);
        if (meta.perm) chain.push(requirePerm(meta.perm));
        if (meta.writable) chain.push(requireWritable);
        break;
    }
    this.router[method](path, ...chain, handler as RequestHandler);
  }
  get(path: string, meta: RouteMeta, h: (req: Request, res: Response) => unknown, pre?: RequestHandler[]) { this.add('get', path, meta, h, pre); }
  post(path: string, meta: RouteMeta, h: (req: Request, res: Response) => unknown, pre?: RequestHandler[]) { this.add('post', path, meta, h, pre); }
  put(path: string, meta: RouteMeta, h: (req: Request, res: Response) => unknown, pre?: RequestHandler[]) { this.add('put', path, meta, h, pre); }
  patch(path: string, meta: RouteMeta, h: (req: Request, res: Response) => unknown, pre?: RequestHandler[]) { this.add('patch', path, meta, h, pre); }
  delete(path: string, meta: RouteMeta, h: (req: Request, res: Response) => unknown, pre?: RequestHandler[]) { this.add('delete', path, meta, h, pre); }
}

export function send(res: Response, data: unknown, meta?: Record<string, unknown>, status = 200) {
  res.status(status).json(meta ? { data, meta } : { data });
}
