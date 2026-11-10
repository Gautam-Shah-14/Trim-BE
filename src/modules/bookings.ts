import type { Request, Response } from 'express';
import type pg from 'pg';
import { Api, bumpSalon, send } from '../http/api.js';
import { salonLimiter, userLimiter } from '../http/rateLimit.js';
import { findAlternatives } from '../lib/availability.js';
import { withIdempotency } from '../http/idempotency.js';
import { parse, z, str, uuid, idList, isoInstant, dateStr, pageQuery, phoneE164, encodeCursor, decodeCursor } from '../http/validate.js';
import { AppError, E } from '../errors.js';
import { isPgError, withTx } from '../db.js';
import { auditReq } from '../lib/audit.js';
import { newNonce } from '../lib/security.js';
import { verifyQr } from '../lib/qr.js';
import { isValidDateString, localDayRange } from '../lib/slots.js';
import {
  BOOKING_SELECT, FIVE_MIN_MS, HOLD_MINUTES, MAX_DAYS_AHEAD, assertWithinWorkingTime, bookingDto, insertItems, loadSalonEnt,
  planBooking, recomputeRating, sweepExpiredHolds,
} from '../lib/booking.js';

const holdSchema = z.strictObject({ salonId: uuid, staffId: uuid, serviceIds: idList(), startsAt: isoInstant });
const walkInSchema = z.strictObject({ customerName: str(120), customerPhone: phoneE164.optional(), staffId: uuid, serviceIds: idList(), startsAt: isoInstant });
const rescheduleSchema = z.strictObject({ version: z.number().int().min(0), startsAt: isoInstant, staffId: uuid.optional() });
const reasonSchema = z.strictObject({ reason: z.string().trim().max(300).optional() });
const checkinSchema = z.strictObject({ qrToken: z.string().min(10).max(1024) });
const reviewSchema = z.strictObject({ rating: z.number().int().min(1).max(5), comment: z.string().trim().max(1000).optional() });

const STATUSES = ['held', 'confirmed', 'checked_in', 'completed', 'cancelled', 'no_show', 'expired'] as const;
const myQuery = pageQuery.extend({
  status: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});
const salonQuery = pageQuery.extend({
  date: dateStr.optional(),
  staffId: uuid.optional(),
  status: z.string().optional(),
});

function statusList(raw: string | undefined, dflt: readonly string[]): string[] {
  if (!raw) return [...dflt];
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = list.find((s) => !(STATUSES as readonly string[]).includes(s));
  if (bad) throw E.validation('Unknown status', [{ field: 'status', issue: `unknown status ${bad}` }]);
  return list;
}

function checkStart(startMs: number, opts: { allowPastMin: number }) {
  const now = Date.now();
  if (startMs < now - opts.allowPastMin * 60_000) throw E.validation('startsAt is in the past', [{ field: 'startsAt', issue: 'cannot be in the past' }]);
  if (startMs > now + MAX_DAYS_AHEAD * 86_400_000) throw E.validation(`Bookings can be made at most ${MAX_DAYS_AHEAD} days ahead`, [{ field: 'startsAt', issue: `more than ${MAX_DAYS_AHEAD} days ahead` }]);
  if (startMs % FIVE_MIN_MS !== 0) throw E.validation('startsAt must be on a 5-minute boundary', [{ field: 'startsAt', issue: 'not on a 5-minute boundary' }]);
}

async function fetchBooking(db: pg.Pool | pg.PoolClient, id: string) {
  const r = await db.query(`${BOOKING_SELECT} WHERE b.id = $1`, [id]);
  return r.rows[0] as Record<string, any> | undefined;
}

const RETRYABLE = (err: unknown) => isPgError(err, '40P01') || isPgError(err, '40001') || isPgError(err, '55P03');

/**
 * Queue contenders for one staff member/day behind a cheap transaction-scoped advisory lock. This is only an optimisation:
 * without it, concurrent inserts into the exclusion constraint can deadlock and stall for deadlock_timeout (1 s).
 * The constraint stays the sole authority.
 */
async function lockStaffDay(c: pg.PoolClient, staffId: string, startMs: number) {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`slot:${staffId}:${new Date(startMs).toISOString().slice(0, 10)}`]);
}
const jitter = (ms: number) => new Promise((r) => setTimeout(r, ms + Math.random() * ms));

/** Retry a whole transaction on deadlock/serialization failures (spec 11.5.3), at most 2 retries, then report the slot as taken. */
async function retryTx<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!RETRYABLE(err)) throw err;
      if (attempt >= 2) {
        if (isPgError(err, '55P03')) throw new AppError('OVERLOADED', 'The service is busy, please retry shortly');
        throw new AppError('SLOT_TAKEN', 'That time was just taken, please pick another slot');
      }
      await jitter(15 * (attempt + 1));
    }
  }
}

const inflightHolds = new Map<string, Promise<boolean>>();

export function register(api: Api) {
  const { deps } = api;
  const qrSecret = deps.config.qrSecret;
  const reply = (res: Response, out: { status: number; body: unknown; replayed: boolean }) => {
    if (out.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(out.status).json(out.body);
  };

  // ------------------------------------------------------------ customer side
  /** SLOT_TAKEN gets details.alternatives (next <= 3 free starts for the same staff and services) so apps can offer one-tap re-booking */
  async function withAlternatives<T>(salonId: string, staffId: string, serviceIds: string[], startMs: number, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AppError && err.code === 'SLOT_TAKEN' && !err.details) {
        const tz = (await deps.pool.query<{ timezone: string }>('SELECT timezone FROM salons WHERE id = $1', [salonId])).rows[0]?.timezone ?? 'Asia/Kolkata';
        const alternatives = await findAlternatives(deps.pool, { id: salonId, timezone: tz }, staffId, serviceIds, startMs);
        throw new AppError('SLOT_TAKEN', err.message, { alternatives });
      }
      throw err;
    }
  }

  api.post('/bookings/hold', { summary: 'Hold a slot for 5 minutes', tag: 'Bookings', auth: 'customer', body: holdSchema, returns: 'Booking', status: 201, idempotent: true, note: '409 SLOT_TAKEN when the staff member is already booked/held (details.alternatives lists the next free starts). Caps: max 3 active holds, 10 upcoming confirmed bookings, 5 bookings created per 24 h per customer (409 CONFLICT, reason HOLD_LIMIT / UPCOMING_LIMIT / DAILY_LIMIT). Rate limited per user.', limit: [userLimiter('hold', deps.config.rateLimit.holdPerMin)] }, async (req, res) => {
    const b = parse(holdSchema, req.body);
    const userId = req.auth!.userId;
    bumpSalon(res, b.salonId);
    const out = await withIdempotency(req, 'bookings.hold', userId, b, async () => {
      checkStart(b.startsAt.getTime(), { allowPastMin: 0 });
      const key = req.header('idempotency-key') ?? null;
      const fastKey = `hold:${b.staffId}:${b.startsAt.getTime()}`;
      let proceed = true;
      // optional Redis fast-fail (11.5.4): rejects obvious duplicates before the DB; never trusted for correctness
      if (deps.cache.driver.driver === 'redis') proceed = await deps.cache.driver.setNx(fastKey, 5000).catch(() => true);
      let ok = false;
      try {
        const startMs = b.startsAt.getTime();
        const id = await withAlternatives(b.salonId, b.staffId, b.serviceIds, startMs, async () => {
          if (!proceed) throw new AppError('SLOT_TAKEN', 'That time was just taken, please pick another slot');
          // Identical staff+start requests in this process: one leader does the work, the others wait for its outcome (no DB use).
          // If the leader won, the followers get SLOT_TAKEN at once; if it failed, the next follower takes over. Purely an optimisation.
          const flightKey = `${b.staffId}:${startMs}`;
          for (;;) {
            const peer = inflightHolds.get(flightKey);
            if (!peer) break;
            if (await peer) throw new AppError('SLOT_TAKEN', 'That time was just taken, please pick another slot');
          }
          let settle!: (won: boolean) => void;
          const flight = new Promise<boolean>((r) => (settle = r));
          inflightHolds.set(flightKey, flight);
          let won = false;
          try {
            // 1. cheap fail-fast: is the requested start already inside an active booking of this staff member? (1 round trip, no transaction)
            // (the same statement also flips this staff member's expired holds, FOR UPDATE SKIP LOCKED, so they cannot trip the constraint)
            const busy = await deps.pool.query<{ busy: boolean }>(
              `WITH swept AS (
                 UPDATE bookings SET status = 'expired', version = version + 1, updated_at = now()
                  WHERE id IN (SELECT id FROM bookings WHERE status = 'held' AND hold_expires_at < now() AND staff_id = $1 ORDER BY id FOR UPDATE SKIP LOCKED)
                  RETURNING id)
               SELECT EXISTS (SELECT 1 FROM bookings WHERE staff_id = $1 AND status IN ('held','confirmed','checked_in') AND during @> $2::timestamptz
                                AND NOT (status = 'held' AND hold_expires_at < now())) AS busy`,
              [b.staffId, new Date(startMs)],
            );
            if (busy.rows[0]!.busy) throw new AppError('SLOT_TAKEN', 'That time was just taken, please pick another slot');
            // 2. everything that does not need a lock or a transaction, on short-lived pooled connections
            const salon = await loadSalonEnt(deps.pool, b.salonId);
            if (!salon || salon.status !== 'approved' || !salon.ent.discoverable) throw E.notFound('Salon');
            if (salon.ent.readOnly) throw E.inactive('This salon is not accepting bookings right now');
            const plan = await planBooking(deps.pool, b.salonId, b.staffId, b.serviceIds);
            const endMs = startMs + plan.totalDurationMin * 60_000;
            await assertWithinWorkingTime(deps.pool, b.salonId, salon.timezone, b.staffId, startMs, endMs);
            // 3. critical section: only the caps check and ONE statement that inserts the booking and its items.
            //    The exclusion constraint is the authority; no pooled connection waits on an advisory lock for the slot.
            const created = await retryTx(() =>
              withTx(deps.pool, async (c) => {
                // serialise this customer's holds so the hoarding caps are exact under parallel requests
                await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`cust:${userId}`]);
                const caps = deps.config.caps;
                const cnt = await c.query<{ held: number; upcoming: number; today: number; full_name: string; phone: string | null }>(
                  `SELECT count(*) FILTER (WHERE status = 'held' AND hold_expires_at > now())::int AS held,
                          count(*) FILTER (WHERE status = 'confirmed' AND starts_at > now())::int AS upcoming,
                          count(*) FILTER (WHERE created_at > now() - interval '24 hours' AND status <> 'expired')::int AS today,
                          (SELECT full_name FROM users WHERE id = $1) AS full_name, (SELECT phone_e164 FROM users WHERE id = $1) AS phone
                     FROM bookings WHERE customer_id = $1`,
                  [userId],
                );
                const n = cnt.rows[0]!;
                if (n.held >= caps.maxHeld) throw new AppError('CONFLICT', `You can hold at most ${caps.maxHeld} slots at a time; confirm or cancel one first`, { limit: caps.maxHeld, current: n.held }, 'HOLD_LIMIT');
                if (n.upcoming >= caps.maxUpcoming) throw new AppError('CONFLICT', `You can have at most ${caps.maxUpcoming} upcoming bookings`, { limit: caps.maxUpcoming, current: n.upcoming }, 'UPCOMING_LIMIT');
                if (n.today >= caps.maxPerDay) throw new AppError('CONFLICT', `You can create at most ${caps.maxPerDay} bookings per day`, { limit: caps.maxPerDay, current: n.today }, 'DAILY_LIMIT');
                try {
                  const ins = await c.query<{ booking_id: string }>(
                    `WITH b AS (
                       INSERT INTO bookings (salon_id, customer_id, customer_name, customer_phone, staff_id, source, status, starts_at, ends_at,
                                             total_duration_min, total_price_paise, hold_expires_at, idempotency_key)
                       VALUES ($1,$2,$3,$4,$5,'app','held',$6,$7,$8,$9, now() + make_interval(mins => $10), $11) RETURNING id)
                     INSERT INTO booking_items (booking_id, service_id, name_snapshot, duration_min, price_paise_snapshot, position)
                     SELECT b.id, i.sid, i.nm, i.dur, i.price, (i.pos - 1)::int
                       FROM b, unnest($12::uuid[], $13::text[], $14::int[], $15::int[]) WITH ORDINALITY AS i(sid, nm, dur, price, pos)
                     RETURNING booking_id`,
                    [
                      b.salonId, userId, n.full_name, n.phone, b.staffId, new Date(startMs), new Date(endMs), plan.totalDurationMin, plan.totalPricePaise,
                      HOLD_MINUTES, key, plan.items.map((i) => i.serviceId), plan.items.map((i) => i.name), plan.items.map((i) => i.durationMin), plan.items.map((i) => i.pricePaise),
                    ],
                  );
                  return ins.rows[0]!.booking_id;
                } catch (err) {
                  if (isPgError(err, '23P01')) throw new AppError('SLOT_TAKEN', 'That time was just taken, please pick another slot');
                  throw err;
                }
              }),
            );
            won = true;
            return created;
          } finally {
            settle(won);
            if (inflightHolds.get(flightKey) === flight) inflightHolds.delete(flightKey);
          }
        });
        ok = true;
        const row = (await fetchBooking(deps.pool, id))!;
        return { status: 201, body: { data: bookingDto(row, qrSecret, false) } };
      } finally {
        if (!ok && deps.cache.driver.driver === 'redis' && proceed) await deps.cache.driver.del(fastKey).catch(() => {});
      }
    });
    reply(res, out);
  });

  api.post('/bookings/:id/confirm', { summary: 'Confirm a held booking; returns qrToken', tag: 'Bookings', auth: 'customer', returns: 'Booking', idempotent: true, note: '409 HOLD_EXPIRED when the hold lapsed' }, async (req, res) => {
    const id = parse(uuid, req.params['id']);
    const userId = req.auth!.userId;
    const out = await withIdempotency(req, 'bookings.confirm', userId, { id }, async () => {
      const upd = await deps.pool.query(
        `UPDATE bookings SET status = 'confirmed', qr_nonce = $3, hold_expires_at = NULL, version = version + 1, updated_at = now()
          WHERE id = $1 AND customer_id = $2 AND status = 'held' AND hold_expires_at > now() RETURNING id`,
        [id, userId, newNonce()],
      );
      if (!upd.rowCount) {
        const cur = await deps.pool.query<{ status: string; hold_expires_at: Date | null }>('SELECT status, hold_expires_at FROM bookings WHERE id = $1 AND customer_id = $2', [id, userId]);
        const row = cur.rows[0];
        if (!row) throw E.notFound('Booking');
        if (row.status === 'confirmed') {
          return { status: 200, body: { data: bookingDto((await fetchBooking(deps.pool, id))!, qrSecret, true) } };
        }
        if (row.status === 'expired' || row.status === 'held') {
          if (row.status === 'held') await sweepExpiredHolds(deps.pool);
          throw new AppError('HOLD_EXPIRED', 'The hold expired; please pick the slot again');
        }
        throw E.conflict(`Booking is ${row.status} and cannot be confirmed`, 'INVALID_STATE');
      }
      const fresh = (await fetchBooking(deps.pool, id))!;
      bumpSalon(res, fresh.salon_id);
      return { status: 200, body: { data: bookingDto(fresh, qrSecret, true) } };
    });
    reply(res, out);
  });

  api.post('/bookings/:id/cancel', { summary: 'Customer cancels (≥ cancel_cutoff_min before start)', tag: 'Bookings', auth: 'customer', body: reasonSchema, returns: 'Booking' }, async (req, res) => {
    const id = parse(uuid, req.params['id']);
    const b = parse(reasonSchema, req.body);
    const row = await withTx(deps.pool, async (c) => {
      const cur = await c.query<{ status: string; starts_at: Date; cutoff: number }>(
        `SELECT b.status, b.starts_at, s.cancel_cutoff_min AS cutoff FROM bookings b JOIN salons s ON s.id = b.salon_id
          WHERE b.id = $1 AND b.customer_id = $2 FOR UPDATE OF b`,
        [id, req.auth!.userId],
      );
      const r = cur.rows[0];
      if (!r) throw E.notFound('Booking');
      if (r.status !== 'held' && r.status !== 'confirmed') throw E.conflict(`Booking is ${r.status} and cannot be cancelled`, 'INVALID_STATE');
      if (r.status === 'confirmed' && r.starts_at.getTime() - Date.now() < r.cutoff * 60_000) {
        throw new AppError('CONFLICT', `Bookings can only be cancelled at least ${r.cutoff} minutes before the start`, { cutoffMin: r.cutoff }, 'CANCEL_CUTOFF');
      }
      await c.query("UPDATE bookings SET status = 'cancelled', cancelled_reason = $2, qr_nonce = NULL, version = version + 1, updated_at = now() WHERE id = $1", [id, b.reason ?? 'cancelled by customer']);
      const fresh = await fetchBooking(c, id);
      bumpSalon(res, fresh?.salon_id);
      return fresh;
    });
    send(res, bookingDto(row!, qrSecret, false));
  });

  api.get('/bookings', { summary: 'My bookings', tag: 'Bookings', auth: 'customer', query: myQuery, returns: 'Booking[]', note: 'held/expired are hidden unless requested via ?status' }, async (req, res) => {
    const q = parse(myQuery, req.query);
    const statuses = statusList(q.status, ['confirmed', 'checked_in', 'completed', 'cancelled', 'no_show']);
    const cur = decodeCursor<{ t: string; id: string }>(q.cursor);
    const asc = q.order === 'asc';
    const params: unknown[] = [req.auth!.userId, statuses, q.limit + 1];
    let keyset = '';
    if (cur) {
      params.push(cur.t, cur.id);
      keyset = `AND (b.starts_at, b.id) ${asc ? '>' : '<'} ($4::timestamptz, $5::uuid)`;
    }
    const r = await deps.pool.query(
      `${BOOKING_SELECT.replace('SELECT b.*,', 'SELECT b.*, b.starts_at::text AS _ck,')}
        WHERE b.customer_id = $1 AND b.status = ANY($2::booking_status[]) ${keyset}
        ORDER BY b.starts_at ${asc ? 'ASC' : 'DESC'}, b.id ${asc ? 'ASC' : 'DESC'} LIMIT $3`,
      params,
    );
    const hasMore = r.rows.length > q.limit;
    const rows = hasMore ? r.rows.slice(0, q.limit) : r.rows;
    const last = rows[rows.length - 1];
    send(res, rows.map((b) => bookingDto(b, qrSecret, true)), { limit: q.limit, nextCursor: hasMore && last ? encodeCursor({ t: last._ck, id: last.id }) : null });
  });

  api.get('/bookings/:id', { summary: 'One of my bookings (qrToken while confirmed)', tag: 'Bookings', auth: 'customer', returns: 'Booking' }, async (req, res) => {
    const row = await fetchBooking(deps.pool, parse(uuid, req.params['id']));
    if (!row || row.customer_id !== req.auth!.userId) throw E.notFound('Booking');
    send(res, bookingDto(row, qrSecret, true));
  });

  api.post('/bookings/:id/review', { summary: 'Review a completed booking', tag: 'Reviews', auth: 'customer', body: reviewSchema, returns: 'NewReview', status: 201 }, async (req, res) => {
    const id = parse(uuid, req.params['id']);
    const b = parse(reviewSchema, req.body);
    const review = await withTx(deps.pool, async (c) => {
      const cur = await c.query<{ status: string; salon_id: string }>('SELECT status, salon_id FROM bookings WHERE id = $1 AND customer_id = $2', [id, req.auth!.userId]);
      const r = cur.rows[0];
      if (!r) throw E.notFound('Booking');
      if (r.status !== 'completed') throw E.conflict('Only completed bookings can be reviewed', 'NOT_COMPLETED');
      try {
        const ins = await c.query(
          'INSERT INTO reviews (booking_id, salon_id, customer_id, rating, comment) VALUES ($1,$2,$3,$4,$5) RETURNING id, rating, comment, status, created_at',
          [id, r.salon_id, req.auth!.userId, b.rating, b.comment ?? null],
        );
        await recomputeRating(c, r.salon_id);
        bumpSalon(res, r.salon_id);
        return ins.rows[0];
      } catch (err) {
        if (isPgError(err, '23505')) throw E.conflict('This booking already has a review', 'REVIEW_EXISTS');
        throw err;
      }
    });
    send(res, { id: review.id, bookingId: id, rating: review.rating, comment: review.comment, status: review.status, createdAt: review.created_at }, undefined, 201);
  });

  // ------------------------------------------------------------ salon side
  api.get('/salons/:salonId/bookings', { summary: 'Bookings of the salon', tag: 'Salon bookings', auth: 'salon', perm: 'booking.view', query: salonQuery, returns: 'Booking[]' }, async (req, res) => {
    const ctx = req.salonCtx!;
    const q = parse(salonQuery, req.query);
    const statuses = statusList(q.status, ['confirmed', 'checked_in', 'completed', 'cancelled', 'no_show']);
    const params: unknown[] = [ctx.salonId, statuses, q.limit + 1];
    const where: string[] = [];
    if (q.date) {
      if (!isValidDateString(q.date)) throw E.validation('Invalid date', [{ field: 'date', issue: 'not a calendar date' }]);
      const day = localDayRange(q.date, ctx.salon.timezone);
      params.push(new Date(day.start), new Date(day.end));
      where.push(`AND b.starts_at >= $${params.length - 1} AND b.starts_at < $${params.length}`);
    }
    if (q.staffId) {
      params.push(q.staffId);
      where.push(`AND b.staff_id = $${params.length}`);
    }
    const cur = decodeCursor<{ t: string; id: string }>(q.cursor);
    if (cur) {
      params.push(cur.t, cur.id);
      where.push(`AND (b.starts_at, b.id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    const r = await deps.pool.query(
      `${BOOKING_SELECT.replace('SELECT b.*,', 'SELECT b.*, b.starts_at::text AS _ck,')}
        WHERE b.salon_id = $1 AND b.status = ANY($2::booking_status[]) ${where.join(' ')}
        ORDER BY b.starts_at, b.id LIMIT $3`,
      params,
    );
    const hasMore = r.rows.length > q.limit;
    const rows = hasMore ? r.rows.slice(0, q.limit) : r.rows;
    const last = rows[rows.length - 1];
    send(res, rows.map((b) => bookingDto(b, qrSecret, false)), { limit: q.limit, nextCursor: hasMore && last ? encodeCursor({ t: last._ck, id: last.id }) : null });
  });

  api.post('/salons/:salonId/bookings', { summary: 'Create a walk-in booking (confirmed)', tag: 'Salon bookings', auth: 'salon', perm: 'booking.create', writable: true, body: walkInSchema, returns: 'Booking', status: 201, idempotent: true }, async (req, res) => {
    const ctx = req.salonCtx!;
    const b = parse(walkInSchema, req.body);
    const out = await withIdempotency(req, 'salon.walkin', `${req.auth!.userId}:${ctx.salonId}`, b, async () => {
      checkStart(b.startsAt.getTime(), { allowPastMin: 30 });
      const id = await withAlternatives(ctx.salonId, b.staffId, b.serviceIds, b.startsAt.getTime(), () => retryTx(() => withTx(deps.pool, async (c) => {
        await lockStaffDay(c, b.staffId, b.startsAt.getTime());
        await sweepExpiredHolds(c, b.staffId);
        const plan = await planBooking(c, ctx.salonId, b.staffId, b.serviceIds);
        const startMs = b.startsAt.getTime();
        const endMs = startMs + plan.totalDurationMin * 60_000;
        await assertWithinWorkingTime(c, ctx.salonId, ctx.salon.timezone, b.staffId, startMs, endMs);
        try {
          const ins = await c.query<{ id: string }>(
            `INSERT INTO bookings (salon_id, customer_id, customer_name, customer_phone, staff_id, source, status, starts_at, ends_at,
                                   total_duration_min, total_price_paise, qr_nonce)
             VALUES ($1,NULL,$2,$3,$4,'walk_in','confirmed',$5,$6,$7,$8,$9) RETURNING id`,
            [ctx.salonId, b.customerName, b.customerPhone ?? null, b.staffId, new Date(startMs), new Date(endMs), plan.totalDurationMin, plan.totalPricePaise, newNonce()],
          );
          await insertItems(c, ins.rows[0]!.id, plan.items);
          return ins.rows[0]!.id;
        } catch (err) {
          if (isPgError(err, '23P01')) throw new AppError('SLOT_TAKEN', 'That staff member is already booked at that time');
          throw err;
        }
      })));
      await auditReq(req, { action: 'booking.walk_in', entity: 'booking', entityId: id });
      return { status: 201, body: { data: bookingDto((await fetchBooking(deps.pool, id))!, qrSecret, false) } };
    });
    reply(res, out);
  });

  api.get('/salons/:salonId/bookings/:bookingId', { summary: 'One booking of the salon', tag: 'Salon bookings', auth: 'salon', perm: 'booking.view', returns: 'Booking' }, async (req, res) => {
    const row = await fetchBooking(deps.pool, parse(uuid, req.params['bookingId']));
    if (!row || row.salon_id !== req.salonCtx!.salonId) throw E.notFound('Booking');
    send(res, bookingDto(row, qrSecret, false));
  });

  api.patch('/salons/:salonId/bookings/:bookingId', { summary: 'Reschedule (optimistic lock via version)', tag: 'Salon bookings', auth: 'salon', perm: 'booking.update', writable: true, body: rescheduleSchema, returns: 'Booking', note: '409 VERSION_MISMATCH when version is stale; rotates the QR nonce' }, async (req, res) => {
    const ctx = req.salonCtx!;
    const b = parse(rescheduleSchema, req.body);
    const id = parse(uuid, req.params['bookingId']);
    checkStart(b.startsAt.getTime(), { allowPastMin: 0 });
    const before = await deps.pool.query<{ staff_id: string; ids: string[] }>(
      'SELECT b.staff_id, COALESCE((SELECT array_agg(service_id ORDER BY position) FROM booking_items WHERE booking_id = b.id AND service_id IS NOT NULL), \'{}\') AS ids FROM bookings b WHERE b.id = $1 AND b.salon_id = $2',
      [id, ctx.salonId],
    );
    await withAlternatives(ctx.salonId, b.staffId ?? before.rows[0]?.staff_id ?? '', before.rows[0]?.ids ?? [], b.startsAt.getTime(), () => retryTx(() => withTx(deps.pool, async (c) => {
      const cur = await c.query<{ status: string; version: number; staff_id: string }>('SELECT status, version, staff_id FROM bookings WHERE id = $1 AND salon_id = $2 FOR UPDATE', [id, ctx.salonId]);
      const row = cur.rows[0];
      if (!row) throw E.notFound('Booking');
      if (row.version !== b.version) throw new AppError('VERSION_MISMATCH', 'The booking was changed by someone else; reload and retry', { currentVersion: row.version });
      if (row.status !== 'confirmed') throw E.conflict(`A ${row.status} booking cannot be rescheduled`, 'INVALID_STATE');
      const staffId = b.staffId ?? row.staff_id;
      await lockStaffDay(c, staffId, b.startsAt.getTime());
      const svc = await c.query<{ service_id: string }>('SELECT service_id FROM booking_items WHERE booking_id = $1 AND service_id IS NOT NULL ORDER BY position', [id]);
      if (!svc.rows.length) throw E.conflict('Booking has no reschedulable services', 'INVALID_STATE');
      const plan = await planBooking(c, ctx.salonId, staffId, svc.rows.map((s) => s.service_id));
      const startMs = b.startsAt.getTime();
      const endMs = startMs + plan.totalDurationMin * 60_000;
      await assertWithinWorkingTime(c, ctx.salonId, ctx.salon.timezone, staffId, startMs, endMs);
      try {
        const u = await c.query(
          `UPDATE bookings SET starts_at = $3, ends_at = $4, staff_id = $5, total_duration_min = $6, total_price_paise = $7,
                 qr_nonce = $8, version = version + 1, updated_at = now()
           WHERE id = $1 AND version = $2 RETURNING id`,
          [id, b.version, new Date(startMs), new Date(endMs), staffId, plan.totalDurationMin, plan.totalPricePaise, newNonce()],
        );
        if (!u.rowCount) throw new AppError('VERSION_MISMATCH', 'The booking was changed by someone else; reload and retry');
        await c.query('DELETE FROM booking_items WHERE booking_id = $1', [id]);
        await insertItems(c, id, plan.items);
      } catch (err) {
        if (isPgError(err, '23P01')) throw new AppError('SLOT_TAKEN', 'That staff member is already booked at that time');
        throw err;
      }
    })));
    await auditReq(req, { action: 'booking.rescheduled', entity: 'booking', entityId: id });
    send(res, bookingDto((await fetchBooking(deps.pool, id))!, qrSecret, false));
  });

  api.post('/salons/:salonId/bookings/:bookingId/cancel', { summary: 'Salon cancels a booking', tag: 'Salon bookings', auth: 'salon', perm: 'booking.cancel', body: reasonSchema, returns: 'Booking' }, async (req, res) => {
    const b = parse(reasonSchema, req.body);
    const id = parse(uuid, req.params['bookingId']);
    const u = await deps.pool.query(
      `UPDATE bookings SET status = 'cancelled', cancelled_reason = $3, qr_nonce = NULL, version = version + 1, updated_at = now()
        WHERE id = $1 AND salon_id = $2 AND status IN ('held','confirmed') RETURNING id`,
      [id, req.salonCtx!.salonId, b.reason ?? 'cancelled by salon'],
    );
    if (!u.rowCount) await explainNoTransition(deps.pool, id, req.salonCtx!.salonId);
    await auditReq(req, { action: 'booking.cancelled', entity: 'booking', entityId: id });
    send(res, bookingDto((await fetchBooking(deps.pool, id))!, qrSecret, false));
  });

  api.post('/salons/:salonId/bookings/:bookingId/no-show', { summary: 'Mark a confirmed booking as no-show (after its start time)', tag: 'Salon bookings', auth: 'salon', perm: 'booking.update', returns: 'Booking' }, async (req, res) => {
    const id = parse(uuid, req.params['bookingId']);
    const u = await deps.pool.query(
      `UPDATE bookings SET status = 'no_show', qr_nonce = NULL, version = version + 1, updated_at = now()
        WHERE id = $1 AND salon_id = $2 AND status = 'confirmed' AND starts_at <= now() RETURNING id`,
      [id, req.salonCtx!.salonId],
    );
    if (!u.rowCount) {
      const cur = await deps.pool.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1 AND salon_id = $2', [id, req.salonCtx!.salonId]);
      if (cur.rows[0]?.status === 'confirmed') throw E.conflict('A booking can only be marked no-show after its start time', 'TOO_EARLY');
      await explainNoTransition(deps.pool, id, req.salonCtx!.salonId);
    }
    send(res, bookingDto((await fetchBooking(deps.pool, id))!, qrSecret, false));
  });

  api.post('/salons/:salonId/bookings/:bookingId/complete', { summary: 'Mark a booking completed', tag: 'Salon bookings', auth: 'salon', perm: 'booking.update', returns: 'Booking' }, async (req, res) => {
    const id = parse(uuid, req.params['bookingId']);
    const u = await deps.pool.query(
      `UPDATE bookings SET status = 'completed', qr_nonce = NULL, version = version + 1, updated_at = now()
        WHERE id = $1 AND salon_id = $2 AND status IN ('confirmed','checked_in') RETURNING id`,
      [id, req.salonCtx!.salonId],
    );
    if (!u.rowCount) await explainNoTransition(deps.pool, id, req.salonCtx!.salonId);
    send(res, bookingDto((await fetchBooking(deps.pool, id))!, qrSecret, false));
  });

  api.post('/salons/:salonId/checkin', { summary: 'Check a customer in by QR token (atomic)', tag: 'Salon bookings', auth: 'salon', perm: 'checkin.scan', body: checkinSchema, returns: 'Booking', note: '409 ALREADY_CHECKED_IN on a second scan; 403 for another salon\'s QR; 409 OUT_OF_WINDOW outside [start-30m, end+60m]. Works in read-only mode. Rate limited per salon.', limit: [salonLimiter('checkin', deps.config.rateLimit.checkinPerMin)] }, async (req, res) => {
    const ctx = req.salonCtx!;
    const b = parse(checkinSchema, req.body);
    const v = verifyQr(qrSecret, b.qrToken);
    if (!v.ok) {
      if (v.reason === 'expired') throw new AppError('OUT_OF_WINDOW', 'This QR code has expired');
      throw E.validation('Invalid QR code', [{ field: 'qrToken', issue: v.reason === 'bad_signature' ? 'signature mismatch' : 'malformed' }]);
    }
    if (v.payload.s !== ctx.salonId) throw E.forbidden('This QR code belongs to a different salon', 'WRONG_SALON');
    const u = await deps.pool.query(
      `UPDATE bookings SET status = 'checked_in', version = version + 1, updated_at = now()
        WHERE id = $1 AND salon_id = $2 AND qr_nonce = $3 AND status = 'confirmed'
          AND now() >= starts_at - interval '30 minutes' AND now() <= ends_at + interval '60 minutes' RETURNING id`,
      [v.payload.b, ctx.salonId, v.payload.n],
    );
    if (!u.rowCount) {
      const cur = await deps.pool.query<{ status: string; qr_nonce: string | null }>('SELECT status, qr_nonce FROM bookings WHERE id = $1 AND salon_id = $2', [v.payload.b, ctx.salonId]);
      const row = cur.rows[0];
      if (!row) throw E.notFound('Booking');
      if (row.status === 'checked_in') throw new AppError('ALREADY_CHECKED_IN', 'This booking is already checked in');
      if (row.status === 'confirmed' && row.qr_nonce !== v.payload.n) throw E.conflict('This QR code is outdated (booking was rescheduled)', 'QR_OUTDATED');
      if (row.status === 'confirmed') throw new AppError('OUT_OF_WINDOW', 'Check-in is only possible from 30 minutes before the start until 60 minutes after the end');
      throw E.conflict(`Booking is ${row.status} and cannot be checked in`, 'INVALID_STATE');
    }
    await auditReq(req, { action: 'booking.checked_in', entity: 'booking', entityId: v.payload.b });
    send(res, bookingDto((await fetchBooking(deps.pool, v.payload.b))!, qrSecret, false));
  });
}

async function explainNoTransition(pool: pg.Pool, id: string, salonId: string): Promise<never> {
  const cur = await pool.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1 AND salon_id = $2', [id, salonId]);
  if (!cur.rows[0]) throw E.notFound('Booking');
  throw E.conflict(`Booking is ${cur.rows[0].status}; this action is not allowed`, 'INVALID_STATE');
}

export type { Request };
