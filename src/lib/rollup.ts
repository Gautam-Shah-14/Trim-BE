import type pg from 'pg';
import { withTx } from '../db.js';

const ROLLUP_SQL = {
  day: `
    INSERT INTO daily_salon_stats (salon_id, day, dim, dim_key, bookings, completed, no_shows, cancelled, revenue_paise, qty)
    SELECT s.id, d.day, 'day', '',
           COALESCE(b.bookings, 0), COALESCE(b.completed, 0), COALESCE(b.no_shows, 0), COALESCE(b.cancelled, 0), COALESCE(i.rev, 0), COALESCE(i.cnt, 0)
      FROM salons s
      CROSS JOIN (SELECT g::date AS day FROM generate_series($1::date, $2::date, interval '1 day') g) d
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE bk.status NOT IN ('held','expired'))::int AS bookings,
               count(*) FILTER (WHERE bk.status = 'completed')::int AS completed,
               count(*) FILTER (WHERE bk.status = 'no_show')::int AS no_shows,
               count(*) FILTER (WHERE bk.status = 'cancelled')::int AS cancelled
          FROM bookings bk
         WHERE bk.salon_id = s.id AND bk.starts_at >= d.day - 1 AND bk.starts_at < d.day + 2
           AND (bk.starts_at AT TIME ZONE s.timezone)::date = d.day) b ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(sum(iv.total_paise), 0)::bigint AS rev, count(*)::int AS cnt
          FROM invoices iv
         WHERE iv.salon_id = s.id AND iv.status = 'paid' AND iv.created_at >= d.day - 1 AND iv.created_at < d.day + 2
           AND (iv.created_at AT TIME ZONE s.timezone)::date = d.day) i ON true`,
  staff: `
    INSERT INTO daily_salon_stats (salon_id, day, dim, dim_key, bookings, completed, no_shows, cancelled, revenue_paise)
    SELECT s.id, (bk.starts_at AT TIME ZONE s.timezone)::date, 'staff', bk.staff_id::text,
           count(*) FILTER (WHERE bk.status NOT IN ('held','expired'))::int, count(*) FILTER (WHERE bk.status = 'completed')::int,
           count(*) FILTER (WHERE bk.status = 'no_show')::int, count(*) FILTER (WHERE bk.status = 'cancelled')::int,
           COALESCE(sum(iv.total_paise) FILTER (WHERE iv.status = 'paid'), 0)::bigint
      FROM bookings bk JOIN salons s ON s.id = bk.salon_id LEFT JOIN invoices iv ON iv.booking_id = bk.id
     WHERE bk.starts_at >= $1::date - 1 AND bk.starts_at < $2::date + 2
       AND (bk.starts_at AT TIME ZONE s.timezone)::date BETWEEN $1::date AND $2::date
     GROUP BY 1, 2, 4`,
  service: `
    INSERT INTO daily_salon_stats (salon_id, day, dim, dim_key, qty, revenue_paise)
    SELECT s.id, (iv.created_at AT TIME ZONE s.timezone)::date, 'service', it.name, sum(it.qty)::int, sum(it.line_total_paise)::bigint
      FROM invoice_items it JOIN invoices iv ON iv.id = it.invoice_id JOIN salons s ON s.id = iv.salon_id
     WHERE iv.status = 'paid' AND iv.created_at >= $1::date - 1 AND iv.created_at < $2::date + 2
       AND (iv.created_at AT TIME ZONE s.timezone)::date BETWEEN $1::date AND $2::date
     GROUP BY 1, 2, 4`,
} as const;

/** Recompute rollup rows for [from, to] (UTC dates, inclusive; salon-local days inside). Idempotent. */
export async function rollupRange(pool: pg.Pool, from: string, to: string): Promise<void> {
  await withTx(pool, async (c) => {
    await c.query('DELETE FROM daily_salon_stats WHERE day BETWEEN $1::date AND $2::date', [from, to]);
    for (const sql of Object.values(ROLLUP_SQL)) await c.query(sql, [from, to]);
  });
}

/** the last 3 days (covers late invoices and timezones) */
export async function rollupRecent(pool: pg.Pool): Promise<void> {
  const r = await pool.query<{ f: string; t: string }>("SELECT (current_date - 3)::text AS f, (current_date + 1)::text AS t");
  await rollupRange(pool, r.rows[0]!.f, r.rows[0]!.t);
}
