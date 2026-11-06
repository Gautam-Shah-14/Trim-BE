import type pg from 'pg';

/**
 * Post-load-test invariant (spec 11.9): no two ACTIVE bookings of one staff member may overlap.
 * The exclusion constraint makes this impossible; the query proves it independently of the constraint's own machinery.
 */
export async function findOverlaps(pool: pg.Pool): Promise<{ staff_id: string; a: string; b: string }[]> {
  const r = await pool.query(
    `SELECT a.staff_id, a.id AS a, b.id AS b
       FROM bookings a JOIN bookings b ON a.staff_id = b.staff_id AND a.id < b.id AND a.during && b.during
      WHERE a.status IN ('held','confirmed','checked_in') AND b.status IN ('held','confirmed','checked_in')
        AND NOT (a.status = 'held' AND a.hold_expires_at < now()) AND NOT (b.status = 'held' AND b.hold_expires_at < now())
      LIMIT 50`,
  );
  return r.rows;
}

/** how many active bookings exist per (staff, start) - a hot-slot test expects 1 */
export async function winnersPerSlot(pool: pg.Pool): Promise<{ staff_id: string; starts_at: Date; n: number }[]> {
  const r = await pool.query(
    `SELECT staff_id, starts_at, count(*)::int AS n FROM bookings WHERE status IN ('held','confirmed','checked_in')
      GROUP BY 1, 2 HAVING count(*) > 0 ORDER BY n DESC, starts_at LIMIT 20`,
  );
  return r.rows;
}
