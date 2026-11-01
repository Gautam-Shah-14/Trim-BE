import { createHmac, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { Api, send } from '../http/api.js';
import { AppError, E } from '../errors.js';
import { withTx } from '../db.js';
import { audit } from '../lib/audit.js';
import { sha256Hex } from '../lib/security.js';

export function verifyRazorpaySignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.trim());
  return a.length === b.length && timingSafeEqual(a, b);
}

interface RzpEvent {
  event: string;
  created_at?: number;
  payload?: {
    subscription?: { entity?: Record<string, any> };
    payment?: { entity?: Record<string, any> };
  };
}

export type ApplyResult = 'applied' | 'stale' | 'ignored';

/** Apply one verified event inside an open transaction. Exported for unit tests. */
export async function applyRazorpayEvent(c: pg.PoolClient, ev: RzpEvent): Promise<ApplyResult> {
  const sub = ev.payload?.subscription?.entity;
  const pay = ev.payload?.payment?.entity;
  const notes: Record<string, any> = (sub?.notes && !Array.isArray(sub.notes) ? sub.notes : null) ?? (pay?.notes && !Array.isArray(pay.notes) ? pay.notes : {});
  // The Razorpay account is shared with another product: only touch our own subscriptions
  if (notes['app'] !== 'trim') return 'ignored';

  let row: Record<string, any> | undefined;
  if (sub?.id) row = (await c.query('SELECT * FROM subscriptions WHERE razorpay_subscription_id = $1 FOR UPDATE', [sub.id])).rows[0];
  if (!row && typeof notes['salonId'] === 'string' && /^[0-9a-f-]{36}$/i.test(notes['salonId'])) {
    row = (await c.query('SELECT * FROM subscriptions WHERE salon_id = $1 FOR UPDATE', [notes['salonId']])).rows[0];
  }
  if (!row) return 'ignored';

  const eventAt = new Date((ev.created_at ?? Math.floor(Date.now() / 1000)) * 1000);
  const stale = !!row.last_event_at && eventAt.getTime() < row.last_event_at.getTime();
  const type = ev.event;

  // receipts are facts about money received: record them even when the event is out of order
  if (type === 'subscription.charged' && pay?.id) {
    await c.query(
      `INSERT INTO subscription_receipts (salon_id, razorpay_payment_id, amount_paise, period_start, period_end, receipt_no)
       VALUES ($1,$2,$3,$4,$5, 'TRM-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('receipt_seq')::text, 6, '0'))
       ON CONFLICT (razorpay_payment_id) DO NOTHING`,
      [row['salon_id'], pay.id, Number(pay.amount ?? 0), sub?.current_start ? new Date(sub.current_start * 1000) : null, sub?.current_end ? new Date(sub.current_end * 1000) : null],
    );
  }
  if (stale) return 'stale';

  let planCode: string | null = null;
  let interval: string | null = null;
  if (sub?.plan_id) {
    const p = (await c.query('SELECT code, razorpay_plan_id_monthly AS m FROM plans WHERE razorpay_plan_id_monthly = $1 OR razorpay_plan_id_annual = $1', [sub.plan_id])).rows[0];
    if (p) {
      planCode = p.code;
      interval = p.m === sub.plan_id ? 'monthly' : 'annual';
    }
  }
  const periodEnd = sub?.current_end ? new Date(sub.current_end * 1000) : null;

  switch (type) {
    case 'subscription.authenticated':
      await c.query('UPDATE subscriptions SET razorpay_subscription_id = COALESCE(razorpay_subscription_id, $2), last_event_at = $3, updated_at = now() WHERE id = $1', [row['id'], sub?.id ?? null, eventAt]);
      break;
    case 'subscription.activated':
    case 'subscription.charged':
      await c.query(
        `UPDATE subscriptions SET status = 'active', past_due_since = NULL, current_period_end = COALESCE($2, current_period_end),
                plan_code = COALESCE($3, plan_code), interval = COALESCE($4::sub_interval, interval),
                razorpay_subscription_id = COALESCE(razorpay_subscription_id, $5), last_event_at = $6, updated_at = now()
          WHERE id = $1`,
        [row['id'], periodEnd, planCode, interval, sub?.id ?? null, eventAt],
      );
      break;
    case 'subscription.pending':
      await c.query("UPDATE subscriptions SET status = 'past_due', past_due_since = COALESCE(past_due_since, now()), last_event_at = $2, updated_at = now() WHERE id = $1", [row['id'], eventAt]);
      break;
    case 'payment.failed':
      await c.query(
        `UPDATE subscriptions SET status = CASE WHEN status = 'active' THEN 'past_due'::sub_status ELSE status END,
                past_due_since = CASE WHEN status = 'active' THEN COALESCE(past_due_since, now()) ELSE past_due_since END,
                last_event_at = $2, updated_at = now() WHERE id = $1`,
        [row['id'], eventAt],
      );
      break;
    case 'subscription.halted':
      await c.query("UPDATE subscriptions SET status = 'halted', last_event_at = $2, updated_at = now() WHERE id = $1", [row['id'], eventAt]);
      break;
    case 'subscription.cancelled':
      await c.query("UPDATE subscriptions SET status = 'cancelled', cancel_at_period_end = false, last_event_at = $2, updated_at = now() WHERE id = $1", [row['id'], eventAt]);
      break;
    case 'subscription.completed':
      await c.query("UPDATE subscriptions SET status = 'expired', last_event_at = $2, updated_at = now() WHERE id = $1", [row['id'], eventAt]);
      break;
    default:
      return 'ignored';
  }
  await audit(c, { salonId: row['salon_id'], action: `razorpay.${type}`, entity: 'subscription', entityId: row['id'] });
  return 'applied';
}

export function register(api: Api) {
  const { deps } = api;

  // NOTE: app.ts mounts express.raw() on this path *before* express.json(), so req.body is a Buffer here.
  api.post('/webhooks/razorpay', { summary: 'Razorpay webhook (signature verified, idempotent)', tag: 'Webhooks', auth: 'none', note: 'Header X-Razorpay-Signature = HMAC-SHA256(raw body, RAZORPAY_WEBHOOK_SECRET); X-Razorpay-Event-Id dedupes replays' }, async (req, res) => {
    const raw = req.body;
    if (!Buffer.isBuffer(raw)) throw E.validation('Expected a raw JSON body');
    if (!deps.config.razorpay.webhookSecret) throw new AppError('INTERNAL', 'Webhook secret is not configured');
    if (!verifyRazorpaySignature(raw, req.header('x-razorpay-signature'), deps.config.razorpay.webhookSecret)) {
      throw E.unauth('Invalid webhook signature');
    }
    let ev: RzpEvent;
    try {
      ev = JSON.parse(raw.toString('utf8')) as RzpEvent;
    } catch {
      throw E.validation('Body is not valid JSON');
    }
    if (typeof ev.event !== 'string') throw E.validation('Missing event type');
    const eventId = req.header('x-razorpay-event-id') || `sha256:${sha256Hex(raw)}`;

    const result = await withTx(deps.pool, async (c) => {
      const ins = await c.query('INSERT INTO subscription_events (razorpay_event_id, type, payload) VALUES ($1,$2,$3) ON CONFLICT (razorpay_event_id) DO NOTHING RETURNING id', [eventId, ev.event, JSON.stringify(ev)]);
      if (!ins.rowCount) return 'duplicate' as const;
      return applyRazorpayEvent(c, ev);
    });
    send(res, { received: true, result });
  });
}
