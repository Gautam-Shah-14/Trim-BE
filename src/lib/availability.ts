import type { Queryable } from '../db.js';
import { planBooking } from './booking.js';
import { MAX_DAYS_AHEAD } from './booking.js';
import { addDays, computeSlots, localDateOf, localDayRange, weekdayOf, workingWindows, type Interval } from './slots.js';

export interface Slot {
  staffId: string;
  startsAt: string;
  endsAt: string;
}

/**
 * Free start times for one local date. Advisory only: the exclusion constraint decides at hold time.
 * Expired-but-unswept holds are ignored (predicate expiry, spec 11.5.5).
 */
export async function computeAvailability(
  db: Queryable,
  salon: { id: string; timezone: string },
  serviceIds: string[],
  staffId: string | undefined,
  date: string,
  nowMs = Date.now(),
): Promise<Slot[]> {
  const tz = salon.timezone;
  const staffRows = staffId
    ? [{ id: staffId }]
    : (await db.query<{ id: string }>('SELECT id FROM salon_staff WHERE salon_id = $1 AND is_active AND is_bookable ORDER BY created_at', [salon.id])).rows;
  if (!staffRows.length) return [];
  const day = localDayRange(date, tz);
  const wd = weekdayOf(date);
  const hours = await db.query<{ opens: string; closes: string; is_closed: boolean }>('SELECT opens, closes, is_closed FROM salon_hours WHERE salon_id = $1 AND weekday = $2', [salon.id, wd]);
  const closure = await db.query('SELECT 1 FROM salon_closures WHERE salon_id = $1 AND date = $2::date', [salon.id, date]);
  const ids = staffRows.map((s) => s.id);
  const sh = await db.query<{ staff_id: string; start_time: string; end_time: string }>('SELECT staff_id, start_time, end_time FROM staff_hours WHERE staff_id = ANY($1::uuid[]) AND weekday = $2', [ids, wd]);
  const off = await db.query<{ staff_id: string; s: Date; e: Date }>(
    "SELECT staff_id, lower(during) AS s, upper(during) AS e FROM staff_time_off WHERE staff_id = ANY($1::uuid[]) AND during && tstzrange($2, $3, '[)')",
    [ids, new Date(day.start), new Date(day.end)],
  );
  const busy = await db.query<{ staff_id: string; s: Date; e: Date }>(
    `SELECT staff_id, starts_at AS s, ends_at AS e FROM bookings
      WHERE staff_id = ANY($1::uuid[]) AND status IN ('held','confirmed','checked_in') AND during && tstzrange($2, $3, '[)')
        AND NOT (status = 'held' AND hold_expires_at < now())`,
    [ids, new Date(day.start), new Date(day.end)],
  );
  const hr = hours.rows[0];
  const closed = (closure.rowCount ?? 0) > 0;
  const out: Slot[] = [];
  for (const st of staffRows) {
    let plan;
    try {
      plan = await planBooking(db, salon.id, st.id, serviceIds);
    } catch (err) {
      if (staffId) throw err;
      continue;
    }
    const own = sh.rows.find((x) => x.staff_id === st.id);
    const windows = workingWindows({
      date, tz,
      salonHours: hr ? { opens: hr.opens, closes: hr.closes, isClosed: hr.is_closed } : null,
      closed,
      staffHours: own ? { start: own.start_time, end: own.end_time } : null,
    });
    const blocked: Interval[] = [
      ...off.rows.filter((x) => x.staff_id === st.id).map((x) => ({ start: x.s.getTime(), end: x.e.getTime() })),
      ...busy.rows.filter((x) => x.staff_id === st.id).map((x) => ({ start: x.s.getTime(), end: x.e.getTime() })),
    ];
    for (const sl of computeSlots({ windows, blocked, durationMin: plan.totalDurationMin, now: nowMs })) {
      out.push({ staffId: st.id, startsAt: new Date(sl.start).toISOString(), endsAt: new Date(sl.end).toISOString() });
    }
  }
  return out.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.staffId.localeCompare(b.staffId));
}

/** Next free start times for the same staff + services after `afterMs` (spec 11.5.2: details.alternatives). */
export async function findAlternatives(
  db: Queryable,
  salon: { id: string; timezone: string },
  staffId: string,
  serviceIds: string[],
  afterMs: number,
  max = 3,
): Promise<Slot[]> {
  try {
    const today = localDateOf(Date.now(), salon.timezone);
    const last = addDays(today, MAX_DAYS_AHEAD);
    let date = localDateOf(afterMs, salon.timezone);
    const found: Slot[] = [];
    for (let i = 0; i < 4 && date <= last && found.length < max; i++, date = addDays(date, 1)) {
      const slots = await computeAvailability(db, salon, serviceIds, staffId, date);
      for (const s of slots) if (Date.parse(s.startsAt) > afterMs && found.length < max) found.push(s);
    }
    return found;
  } catch {
    return []; // alternatives are a convenience; never fail the 409 because of them
  }
}
