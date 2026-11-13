import type pg from 'pg';
import type { Logger } from 'pino';
import { addDays, localDateOf } from './slots.js';

export const ACTIVITY_TZ = 'Asia/Kolkata';
export const istDay = (ms: number) => localDateOf(ms, ACTIVITY_TZ);

// once per user per IST day per process; cleared when the day changes
let memoDay = '';
const memo = new Set<string>();

/**
 * Record that `userId` was active today (IST). Fire-and-forget: never awaited by the request, never throws.
 * The memo keeps it to one INSERT per user per day per process; ON CONFLICT makes repeats across processes harmless.
 */
export function recordActivity(pool: pg.Pool, log: Logger, userId: string, role: string, nowMs = Date.now()): void {
  const day = istDay(nowMs);
  if (day !== memoDay) {
    memo.clear();
    memoDay = day;
  }
  const key = `${userId}:${day}`;
  if (memo.has(key)) return;
  memo.add(key);
  pool
    .query('INSERT INTO user_activity_days (user_id, day, role) VALUES ($1, $2::date, $3) ON CONFLICT DO NOTHING', [userId, day, role])
    .catch((err: Error) => {
      memo.delete(key); // try again on the next request
      log.debug({ err: err.message }, 'activity record failed');
    });
}

type Counts = { dau: number; wau: number; mau: number };
export interface ActiveUsers {
  asOf: string;
  dau: number;
  wau: number;
  mau: number;
  byRole: { customer: Counts; salon_user: Counts };
  series: { day: string; dau: number }[];
}

/** DAU = asOf, WAU = last 7 IST days incl. asOf, MAU = last 30; series = 30 days ending asOf, gaps filled with 0 */
export async function activeUsers(pool: pg.Pool, asOf: string): Promise<ActiveUsers> {
  const from = addDays(asOf, -29);
  const r = await pool.query(
    `SELECT
       count(DISTINCT user_id) FILTER (WHERE day = $2::date)::int AS dau,
       count(DISTINCT user_id) FILTER (WHERE day > $2::date - 7)::int AS wau,
       count(DISTINCT user_id)::int AS mau,
       count(DISTINCT user_id) FILTER (WHERE role = 'customer' AND day = $2::date)::int AS c_dau,
       count(DISTINCT user_id) FILTER (WHERE role = 'customer' AND day > $2::date - 7)::int AS c_wau,
       count(DISTINCT user_id) FILTER (WHERE role = 'customer')::int AS c_mau,
       count(DISTINCT user_id) FILTER (WHERE role = 'salon_user' AND day = $2::date)::int AS s_dau,
       count(DISTINCT user_id) FILTER (WHERE role = 'salon_user' AND day > $2::date - 7)::int AS s_wau,
       count(DISTINCT user_id) FILTER (WHERE role = 'salon_user')::int AS s_mau
     FROM user_activity_days WHERE day BETWEEN $1::date AND $2::date`,
    [from, asOf],
  );
  const s = await pool.query<{ day: string; dau: number }>(
    `SELECT g::date::text AS day, count(a.user_id)::int AS dau
       FROM generate_series($1::date, $2::date, interval '1 day') g
       LEFT JOIN user_activity_days a ON a.day = g::date
      GROUP BY g ORDER BY g`,
    [from, asOf],
  );
  const x = r.rows[0];
  return {
    asOf,
    dau: x.dau,
    wau: x.wau,
    mau: x.mau,
    byRole: { customer: { dau: x.c_dau, wau: x.c_wau, mau: x.c_mau }, salon_user: { dau: x.s_dau, wau: x.s_wau, mau: x.s_mau } },
    series: s.rows,
  };
}
