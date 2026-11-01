import type pg from 'pg';
import type { Queryable } from '../db.js';
import { AppError, E } from '../errors.js';
import { entitlements, type Entitlements, type PlanRow, type SubscriptionRow } from './entitlements.js';
import { signQr } from './qr.js';
import { contains, localDateOf, totalDuration, effectiveDuration, weekdayOf, workingWindows } from './slots.js';

export const HOLD_MINUTES = 5;
export const MAX_DAYS_AHEAD = 60;
export const FIVE_MIN_MS = 5 * 60_000;

/** Flip expired holds to `expired`, freeing the slot (the exclusion constraint only ignores non-active statuses). */
export async function sweepExpiredHolds(db: Queryable, staffId?: string): Promise<number> {
  // SKIP LOCKED + ordered lock acquisition: concurrent sweeps never deadlock or block each other
  const r = await db.query(
    `UPDATE bookings SET status = 'expired', version = version + 1, updated_at = now()
      WHERE id IN (SELECT id FROM bookings WHERE status = 'held' AND hold_expires_at < now()
                     AND ($1::uuid IS NULL OR staff_id = $1) ORDER BY id FOR UPDATE SKIP LOCKED)`,
    [staffId ?? null],
  );
  return r.rowCount ?? 0;
}

export interface SalonEnt {
  id: string;
  name: string;
  status: 'pending' | 'approved' | 'suspended';
  timezone: string;
  cancelCutoffMin: number;
  ent: Entitlements;
}

export async function loadSalonEnt(db: Queryable, salonId: string): Promise<SalonEnt | null> {
  const s = await db.query<{ id: string; name: string; status: SalonEnt['status']; timezone: string; cancel_cutoff_min: number } & SubscriptionRow>(
    `SELECT s.id, s.name, s.status, s.timezone, s.cancel_cutoff_min, sub.plan_code, sub.status AS status_sub,
            sub.trial_ends_at, sub.current_period_end, sub.comp_until, sub.past_due_since
       FROM salons s JOIN subscriptions sub ON sub.salon_id = s.id WHERE s.id = $1`,
    [salonId],
  );
  const row = s.rows[0] as unknown as Record<string, any> | undefined;
  if (!row) return null;
  const plans = await db.query<PlanRow>('SELECT * FROM plans');
  const ent = entitlements(
    { plan_code: row.plan_code, status: row.status_sub, trial_ends_at: row.trial_ends_at, current_period_end: row.current_period_end, comp_until: row.comp_until, past_due_since: row.past_due_since },
    Object.fromEntries(plans.rows.map((p) => [p.code, p])),
  );
  if (row.status === 'suspended') {
    ent.readOnly = true;
    ent.discoverable = false;
  }
  return { id: row.id, name: row.name, status: row.status, timezone: row.timezone, cancelCutoffMin: row.cancel_cutoff_min, ent };
}

export interface PlannedItem {
  serviceId: string;
  name: string;
  durationMin: number; // effective (staff speed applied)
  bufferMin: number;
  pricePaise: number;
}

export interface Plan {
  items: PlannedItem[];
  totalDurationMin: number;
  totalPricePaise: number;
  staffName: string;
}

/** Validate staff/services belong to the salon, staff can do them, compute duration + price. */
export async function planBooking(db: Queryable, salonId: string, staffId: string, serviceIds: string[]): Promise<Plan> {
  if (new Set(serviceIds).size !== serviceIds.length) throw E.validation('Duplicate service', [{ field: 'serviceIds', issue: 'service listed twice' }]);
  const st = await db.query<{ display_name: string; speed_multiplier: number; is_bookable: boolean; is_active: boolean }>(
    'SELECT display_name, speed_multiplier, is_bookable, is_active FROM salon_staff WHERE id = $1 AND salon_id = $2',
    [staffId, salonId],
  );
  const staff = st.rows[0];
  if (!staff) throw E.validation('Unknown staffId for this salon', [{ field: 'staffId', issue: 'not found' }]);
  if (!staff.is_active || !staff.is_bookable) throw E.validation('This staff member cannot take bookings', [{ field: 'staffId', issue: 'not bookable' }]);
  const sv = await db.query<{ id: string; name: string; duration_min: number; buffer_min: number; price_paise: number }>(
    'SELECT id, name, duration_min, buffer_min, price_paise FROM salon_services WHERE salon_id = $1 AND is_active AND id = ANY($2::uuid[])',
    [salonId, serviceIds],
  );
  if (sv.rows.length !== serviceIds.length) throw E.validation('Unknown or inactive service', [{ field: 'serviceIds', issue: 'one or more services not found' }]);
  const perf = await db.query<{ service_id: string }>('SELECT service_id FROM staff_services WHERE staff_id = $1', [staffId]);
  if (perf.rows.length > 0) {
    const allowed = new Set(perf.rows.map((p) => p.service_id));
    if (serviceIds.some((id) => !allowed.has(id))) throw E.validation('This staff member does not perform all selected services', [{ field: 'staffId', issue: 'service not offered by staff' }]);
  }
  const byId = new Map(sv.rows.map((s) => [s.id, s]));
  const speed = Number(staff.speed_multiplier);
  const items: PlannedItem[] = serviceIds.map((id) => {
    const s = byId.get(id)!;
    return { serviceId: id, name: s.name, durationMin: effectiveDuration(s.duration_min, speed), bufferMin: s.buffer_min, pricePaise: s.price_paise };
  });
  const total = totalDuration(serviceIds.map((id) => ({ durationMin: byId.get(id)!.duration_min, bufferMin: byId.get(id)!.buffer_min })), speed);
  return { items, totalDurationMin: total, totalPricePaise: items.reduce((a, i) => a + i.pricePaise, 0), staffName: staff.display_name };
}

/** Throws when [start,end) is outside the staff's working window for that day or hits time off. */
export async function assertWithinWorkingTime(db: Queryable, salonId: string, tz: string, staffId: string, startMs: number, endMs: number): Promise<void> {
  const date = localDateOf(startMs, tz);
  const wd = weekdayOf(date);
  const [h, closure, sh] = await Promise.all([
    db.query<{ opens: string; closes: string; is_closed: boolean }>('SELECT opens, closes, is_closed FROM salon_hours WHERE salon_id = $1 AND weekday = $2', [salonId, wd]),
    db.query('SELECT 1 FROM salon_closures WHERE salon_id = $1 AND date = $2::date', [salonId, date]),
    db.query<{ start_time: string; end_time: string }>('SELECT start_time, end_time FROM staff_hours WHERE staff_id = $1 AND weekday = $2', [staffId, wd]),
  ]);
  const hr = h.rows[0];
  const windows = workingWindows({
    date,
    tz,
    salonHours: hr ? { opens: hr.opens, closes: hr.closes, isClosed: hr.is_closed } : null,
    closed: (closure.rowCount ?? 0) > 0,
    staffHours: sh.rows[0] ? { start: sh.rows[0].start_time, end: sh.rows[0].end_time } : null,
  });
  if (!contains(windows, { start: startMs, end: endMs })) {
    throw E.validation('The requested time is outside working hours', [{ field: 'startsAt', issue: 'outside salon/staff working hours or on a closure day' }]);
  }
  const off = await db.query('SELECT 1 FROM staff_time_off WHERE staff_id = $1 AND during && tstzrange($2, $3, \'[)\')', [staffId, new Date(startMs), new Date(endMs)]);
  if (off.rowCount) throw new AppError('SLOT_TAKEN', 'The staff member is not available at that time');
}

export const BOOKING_SELECT = `
  SELECT b.*, st.display_name AS staff_name, s.name AS salon_name, s.timezone AS salon_timezone,
         (SELECT COALESCE(json_agg(json_build_object('serviceId', i.service_id, 'name', i.name_snapshot, 'durationMin', i.duration_min, 'pricePaise', i.price_paise_snapshot) ORDER BY i.position), '[]'::json)
            FROM booking_items i WHERE i.booking_id = b.id) AS items,
         EXISTS (SELECT 1 FROM reviews r WHERE r.booking_id = b.id) AS has_review
    FROM bookings b JOIN salon_staff st ON st.id = b.staff_id JOIN salons s ON s.id = b.salon_id`;

export function bookingDto(b: Record<string, any>, qrSecret: string, includeQr: boolean) {
  return {
    id: b.id,
    salonId: b.salon_id,
    salonName: b.salon_name,
    customerId: b.customer_id,
    customerName: b.customer_name,
    customerPhone: b.customer_phone,
    staffId: b.staff_id,
    staffName: b.staff_name,
    source: b.source,
    status: b.status,
    startsAt: b.starts_at,
    endsAt: b.ends_at,
    totalDurationMin: b.total_duration_min,
    totalPricePaise: b.total_price_paise,
    holdExpiresAt: b.hold_expires_at,
    version: b.version,
    cancelledReason: b.cancelled_reason,
    items: b.items,
    hasReview: b.has_review,
    createdAt: b.created_at,
    ...(includeQr && b.status === 'confirmed' && b.qr_nonce
      ? { qrToken: signQr(qrSecret, { bookingId: b.id, salonId: b.salon_id, nonce: b.qr_nonce, endsAt: b.ends_at }) }
      : {}),
  };
}

export async function insertItems(c: pg.PoolClient, bookingId: string, items: PlannedItem[]) {
  for (const [i, it] of items.entries()) {
    await c.query(
      'INSERT INTO booking_items (booking_id, service_id, name_snapshot, duration_min, price_paise_snapshot, position) VALUES ($1,$2,$3,$4,$5,$6)',
      [bookingId, it.serviceId, it.name, it.durationMin, it.pricePaise, i],
    );
  }
}

export async function recomputeRating(db: Queryable, salonId: string) {
  await db.query(
    `UPDATE salons SET rating_count = a.n, rating_avg = a.avg
       FROM (SELECT count(*)::int AS n, COALESCE(round(avg(rating)::numeric, 2), 0) AS avg FROM reviews WHERE salon_id = $1 AND status IN ('visible','reported')) a
      WHERE id = $1`,
    [salonId],
  );
}
