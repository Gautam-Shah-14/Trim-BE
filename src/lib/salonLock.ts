import type pg from 'pg';
import { E } from '../errors.js';
import { entitlements, type Entitlements, type PlanRow, type SubscriptionRow } from './entitlements.js';

/**
 * Take a row lock on the salon (serialises limit checks, spec §7.8) and return fresh entitlements
 * computed inside the same transaction. Must be called inside BEGIN..COMMIT.
 */
export async function lockSalon(c: pg.PoolClient, salonId: string): Promise<{ ent: Entitlements; status: string }> {
  const s = await c.query<{ status: string }>('SELECT status FROM salons WHERE id = $1 FOR UPDATE', [salonId]);
  if (!s.rows[0]) throw E.notFound('Salon');
  const sub = await c.query<SubscriptionRow>('SELECT plan_code, status, trial_ends_at, current_period_end, comp_until, past_due_since FROM subscriptions WHERE salon_id = $1', [salonId]);
  const plans = await c.query<PlanRow>('SELECT * FROM plans');
  const ent = entitlements(sub.rows[0]!, Object.fromEntries(plans.rows.map((p) => [p.code, p])));
  if (s.rows[0].status === 'suspended') ent.readOnly = true;
  return { ent, status: s.rows[0].status };
}
