import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, SYSTEM_ROLE_NAMES } from './permissions.js';

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'salon';
}

export function invoicePrefixFor(name: string): string {
  const letters = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
  return letters.length >= 2 ? letters : 'INV';
}

export interface NewSalonInput {
  name: string;
  city?: string | null;
  state?: string | null;
  addressLine?: string | null;
  pincode?: string | null;
  phone?: string | null;
  lat?: number | null;
  lng?: number | null;
  timezone?: string | null;
  description?: string | null;
  createdBy: string;
  ownerUserId: string;
  ownerDisplayName: string;
}

export const DEFAULT_PAYMENT_METHODS = [
  { code: 'cash', label: 'Cash', enabled: true },
  { code: 'upi', label: 'UPI', enabled: true },
  { code: 'card', label: 'Card', enabled: true },
  { code: 'wallet', label: 'Wallet', enabled: false },
  { code: 'bank_transfer', label: 'Bank transfer', enabled: false },
  { code: 'other', label: 'Other', enabled: false },
] as const;

/**
 * Creates a salon with: system roles + default permissions, owner staff row, default hours (10:00-20:00, all days),
 * default payment methods, invoice counter, 14-day Pro trial subscription. Must run inside a transaction.
 */
export async function createSalonWithDefaults(c: pg.PoolClient, input: NewSalonInput): Promise<{ salonId: string; roleIds: Record<string, string>; staffId: string }> {
  const slug = `${slugify(input.name)}-${randomBytes(3).toString('hex')}`;
  const s = await c.query<{ id: string }>(
    `INSERT INTO salons (name, slug, description, phone, address_line, city, state, pincode, lat, lng, timezone, invoice_prefix, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11,'Asia/Kolkata'),$12,$13) RETURNING id`,
    [
      input.name, slug, input.description ?? null, input.phone ?? null, input.addressLine ?? null, input.city ?? null, input.state ?? null,
      input.pincode ?? null, input.lat ?? null, input.lng ?? null, input.timezone ?? null, invoicePrefixFor(input.name), input.createdBy,
    ],
  );
  const salonId = s.rows[0]!.id;

  const roleIds: Record<string, string> = {};
  for (const name of SYSTEM_ROLE_NAMES) {
    const r = await c.query<{ id: string }>('INSERT INTO salon_roles (salon_id, name, is_system) VALUES ($1,$2,true) RETURNING id', [salonId, name]);
    const roleId = r.rows[0]!.id;
    roleIds[name] = roleId;
    const perms = DEFAULT_ROLE_PERMISSIONS[name];
    await c.query('INSERT INTO salon_role_permissions (role_id, permission) SELECT $1, unnest($2::text[])', [roleId, perms]);
  }
  const st = await c.query<{ id: string }>(
    'INSERT INTO salon_staff (salon_id, user_id, role_id, display_name) VALUES ($1,$2,$3,$4) RETURNING id',
    [salonId, input.ownerUserId, roleIds['owner'], input.ownerDisplayName],
  );
  await c.query(
    `INSERT INTO salon_hours (salon_id, weekday, opens, closes, is_closed)
     SELECT $1, d, '10:00', '20:00', false FROM generate_series(0,6) d`,
    [salonId],
  );
  for (const [i, m] of DEFAULT_PAYMENT_METHODS.entries()) {
    await c.query('INSERT INTO salon_payment_methods (salon_id, code, label, is_enabled, sort) VALUES ($1,$2,$3,$4,$5)', [salonId, m.code, m.label, m.enabled, i]);
  }
  await c.query('INSERT INTO invoice_counters (salon_id, last_no) VALUES ($1, 0)', [salonId]);
  await c.query(
    `INSERT INTO subscriptions (salon_id, plan_code, interval, status, trial_ends_at)
     VALUES ($1, 'pro', 'monthly', 'trialing', now() + interval '14 days')`,
    [salonId],
  );
  return { salonId, roleIds, staffId: st.rows[0]!.id };
}

export { ALL_PERMISSIONS };
