import { applyBump } from '../http/api.js';
import type { Deps } from '../http/types.js';
import { invoicesCsv } from '../lib/csv.js';
import { sweepExpiredHolds } from '../lib/booking.js';
import { rollupRecent } from '../lib/rollup.js';
import { processWebhookEvent } from '../modules/webhooks.js';

/** Register every job handler. Handlers are idempotent: queues may deliver a job more than once. */
export function registerJobs(deps: Deps) {
  const { queue, pool, log } = deps;

  queue.register('razorpay.event', async ({ eventId }: { eventId: string }) => {
    await processWebhookEvent(deps, eventId);
  });

  // safety net: events that were stored but never processed (queue was down, worker crashed)
  queue.register('webhook.retry', async () => {
    const r = await pool.query<{ razorpay_event_id: string }>(
      "SELECT razorpay_event_id FROM subscription_events WHERE processed_at IS NULL AND received_at < now() - interval '30 seconds' ORDER BY received_at LIMIT 50",
    );
    for (const e of r.rows) await queue.enqueue('razorpay.event', { eventId: e.razorpay_event_id }, { singletonKey: e.razorpay_event_id });
  });

  // FOR UPDATE SKIP LOCKED inside; correctness never depends on this (expiry is also predicate based)
  queue.register('booking.sweep', async () => {
    const n = await sweepExpiredHolds(pool);
    if (n) log.info({ expired: n }, 'expired booking holds');
  });

  queue.register('stats.rollup', async () => {
    await rollupRecent(pool);
  });

  queue.register('audit.retention', async () => {
    await pool.query("DELETE FROM audit_log WHERE created_at < now() - interval '400 days'");
    await pool.query("DELETE FROM idempotency_keys WHERE created_at < now() - interval '48 hours'");
    await pool.query("DELETE FROM export_jobs WHERE created_at < now() - interval '14 days'");
    await pool.query("DELETE FROM user_activity_days WHERE day < current_date - 400");
  });

  queue.register('export.run', async ({ jobId }: { jobId: string }) => {
    const j = await pool.query<{ salon_id: string; params: { start: string; end: string }; status: string }>(
      "UPDATE export_jobs SET status = 'running' WHERE id = $1 AND status IN ('queued','running') RETURNING salon_id, params, status",
      [jobId],
    );
    const job = j.rows[0];
    if (!job) return;
    try {
      const csv = await invoicesCsv(pool, job.salon_id, new Date(job.params.start), new Date(job.params.end));
      await pool.query("UPDATE export_jobs SET status = 'done', result_csv = $2, finished_at = now() WHERE id = $1", [jobId, csv]);
    } catch (err) {
      await pool.query("UPDATE export_jobs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [jobId, (err as Error).message.slice(0, 300)]);
      throw err;
    }
  });
}

/** Recurring work; call only in processes that consume jobs (WORKER_MODE=worker|both). */
export function scheduleRecurring(deps: Deps) {
  const q = deps.queue;
  q.every('booking.sweep', 30_000);
  q.every('webhook.retry', 60_000);
  q.every('stats.rollup', 3_600_000);
  q.every('audit.retention', 86_400_000);
}

export { applyBump };
