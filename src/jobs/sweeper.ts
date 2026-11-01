import type { Logger } from 'pino';
import type pg from 'pg';
import { sweepExpiredHolds } from '../lib/booking.js';

/** Flips expired holds to `expired` every 30 s (availability + hold also sweep lazily). Returns a stop function. */
export function startHoldSweeper(pool: pg.Pool, log: Logger, intervalMs = 30_000): () => void {
  let ticks = 0;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const n = await sweepExpiredHolds(pool);
      if (n) log.info({ expired: n }, 'expired booking holds');
      if (++ticks % 120 === 0) {
        await pool.query("DELETE FROM idempotency_keys WHERE created_at < now() - interval '48 hours'");
      }
    } catch (err) {
      log.warn({ err }, 'hold sweeper failed');
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
