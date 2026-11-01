import type { Request } from 'express';
import type { Queryable } from '../db.js';

export interface AuditInput {
  actorUserId?: string | null;
  salonId?: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  meta?: Record<string, unknown>;
  ip?: string | null;
}

/** Best-effort write: an audit failure must never fail the business request. */
export async function audit(db: Queryable, a: AuditInput): Promise<void> {
  try {
    await db.query(
      'INSERT INTO audit_log (actor_user_id, salon_id, action, entity, entity_id, meta, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [a.actorUserId ?? null, a.salonId ?? null, a.action, a.entity ?? null, a.entityId ?? null, JSON.stringify(a.meta ?? {}), a.ip ?? null],
    );
  } catch {
    /* swallow */
  }
}

export function auditReq(req: Request, a: Omit<AuditInput, 'actorUserId' | 'ip' | 'salonId'> & { salonId?: string | null }) {
  return audit(req.deps.pool, {
    ...a,
    actorUserId: req.auth?.userId ?? null,
    salonId: a.salonId ?? req.salonCtx?.salonId ?? null,
    ip: req.ip ?? null,
  });
}
