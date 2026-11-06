import type { Response } from 'express';
import { Api, getPlans, send } from '../http/api.js';
import { withIdempotency } from '../http/idempotency.js';
import { parse, z, pageQuery, keysetFrom, pageOf } from '../http/validate.js';
import { AppError, E } from '../errors.js';
import { withTx } from '../db.js';
import { auditReq } from '../lib/audit.js';
import { entitlements } from '../lib/entitlements.js';
import { entDto } from './salon.js';

const checkoutSchema = z.strictObject({ planCode: z.enum(['starter', 'pro']), interval: z.enum(['monthly', 'annual']) });

export const receiptDto = (r: Record<string, any>) => ({
  id: r.id,
  receiptNo: r.receipt_no,
  amountPaise: r.amount_paise,
  periodStart: r.period_start,
  periodEnd: r.period_end,
  razorpayPaymentId: r.razorpay_payment_id,
  issuedAt: r.issued_at,
  kind: 'receipt',
});

export function register(api: Api) {
  const { deps } = api;

  async function view(salonId: string) {
    const sub = (await deps.pool.query('SELECT * FROM subscriptions WHERE salon_id = $1', [salonId])).rows[0]!;
    const plans = await getPlans(deps.pool);
    const ent = entitlements(sub, plans);
    const usage = await deps.pool.query<{ staff: number; roles: number }>(
      `SELECT (SELECT count(*)::int FROM salon_staff WHERE salon_id = $1 AND is_active) AS staff,
              (SELECT count(*)::int FROM salon_roles WHERE salon_id = $1 AND NOT is_system) AS roles`,
      [salonId],
    );
    const receipts = await deps.pool.query('SELECT * FROM subscription_receipts WHERE salon_id = $1 ORDER BY issued_at DESC LIMIT 5', [salonId]);
    return {
      planCode: sub.plan_code,
      interval: sub.interval,
      status: sub.status,
      trialEndsAt: sub.trial_ends_at,
      currentPeriodEnd: sub.current_period_end,
      compUntil: sub.comp_until,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      razorpaySubscriptionId: sub.razorpay_subscription_id,
      paymentMethodAuthorized: !!sub.payment_authorized_at && ['trialing', 'active', 'past_due'].includes(sub.status),
      nextChargeAt: sub.next_charge_at,
      entitlements: entDto(ent),
      limits: ent.limits,
      usage: { activeStaff: usage.rows[0]!.staff, customRoles: usage.rows[0]!.roles },
      recentReceipts: receipts.rows.map(receiptDto),
    };
  }

  api.get('/salons/:salonId/subscription', { summary: 'Subscription status, limits, usage', tag: 'Subscription', auth: 'salon', perm: 'settings.edit', ownerOnly: true, returns: 'SubscriptionView' }, async (req, res) => {
    send(res, await view(req.salonCtx!.salonId));
  });

  api.post('/salons/:salonId/subscription/checkout', { summary: 'Create a Razorpay subscription for Checkout', tag: 'Subscription', auth: 'salon', perm: 'settings.edit', ownerOnly: true, body: checkoutSchema, returns: 'CheckoutResult', idempotent: true, note: 'The client opens Razorpay Checkout with the returned id/key, then polls GET subscription. The webhook is the source of truth.' }, async (req, res: Response) => {
    const ctx = req.salonCtx!;
    const b = parse(checkoutSchema, req.body);
    const out = await withIdempotency(req, 'subscription.checkout', `${req.auth!.userId}:${ctx.salonId}`, b, async () => {
      const plan = (await deps.pool.query('SELECT * FROM plans WHERE code = $1 AND is_active', [b.planCode])).rows[0];
      if (!plan) throw E.notFound('Plan');
      const planId: string | null = b.interval === 'monthly' ? plan.razorpay_plan_id_monthly : plan.razorpay_plan_id_annual;
      if (!planId) throw E.conflict('This plan is not yet available for online purchase', 'PLAN_NOT_CONFIGURED');
      const cur = (await deps.pool.query('SELECT * FROM subscriptions WHERE salon_id = $1', [ctx.salonId])).rows[0]!;
      if (cur.status === 'active' && !cur.cancel_at_period_end) {
        throw E.conflict('You already have an active subscription. Cancel it first to change plan.', 'ALREADY_SUBSCRIBED');
      }
      const trialEnds: Date | null = cur.status === 'trialing' ? cur.trial_ends_at : null;
      const startAt = trialEnds && trialEnds.getTime() > Date.now() + 15 * 60_000 ? Math.floor(trialEnds.getTime() / 1000) : undefined;
      let sub: { id: string };
      try {
        sub = await deps.gateway.createSubscription({
          planId,
          totalCount: b.interval === 'monthly' ? 120 : 10,
          startAt,
          notes: { app: 'trim', salonId: ctx.salonId, planCode: b.planCode, interval: b.interval },
        });
      } catch (err) {
        deps.log.error({ err }, 'razorpay createSubscription failed');
        throw new AppError('INTERNAL', 'The payment provider could not create the subscription, please try again');
      }
      await deps.pool.query('UPDATE subscriptions SET razorpay_subscription_id = $2, plan_code = $3, interval = $4, payment_authorized_at = NULL, next_charge_at = NULL, updated_at = now() WHERE salon_id = $1', [ctx.salonId, sub.id, b.planCode, b.interval]);
      await auditReq(req, { action: 'subscription.checkout', entity: 'subscription', entityId: sub.id, meta: { planCode: b.planCode, interval: b.interval } });
      return { status: 200, body: { data: { razorpaySubscriptionId: sub.id, keyId: deps.gateway.keyId } } };
    });
    if (out.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(out.status).json(out.body);
  });

  api.post('/salons/:salonId/subscription/cancel', { summary: 'Cancel at period end', tag: 'Subscription', auth: 'salon', perm: 'settings.edit', ownerOnly: true, returns: 'SubscriptionView' }, async (req, res) => {
    const ctx = req.salonCtx!;
    await withTx(deps.pool, async (c) => {
      const cur = (await c.query('SELECT * FROM subscriptions WHERE salon_id = $1 FOR UPDATE', [ctx.salonId])).rows[0]!;
      if (!['active', 'trialing', 'past_due'].includes(cur.status)) throw E.conflict(`A ${cur.status} subscription cannot be cancelled`, 'INVALID_STATE');
      if (cur.razorpay_subscription_id && cur.status !== 'trialing') {
        try {
          await deps.gateway.cancelSubscription(cur.razorpay_subscription_id, true);
        } catch (err) {
          deps.log.error({ err }, 'razorpay cancel failed');
          throw new AppError('INTERNAL', 'The payment provider could not cancel the subscription, please try again');
        }
      }
      await c.query('UPDATE subscriptions SET cancel_at_period_end = true, updated_at = now() WHERE salon_id = $1', [ctx.salonId]);
    });
    await auditReq(req, { action: 'subscription.cancel_requested', entity: 'salon', entityId: ctx.salonId });
    send(res, await view(ctx.salonId));
  });

  api.get('/salons/:salonId/subscription/receipts', { summary: 'Subscription receipts (plain receipts, not tax invoices)', tag: 'Subscription', auth: 'salon', perm: 'settings.edit', ownerOnly: true, query: pageQuery, returns: 'Receipt[]' }, async (req, res) => {
    const q = parse(pageQuery, req.query);
    const ks = keysetFrom(q.cursor);
    const params: unknown[] = [req.salonCtx!.salonId, q.limit + 1];
    if (ks) params.push(ks.t, ks.id);
    const r = await deps.pool.query(
      `SELECT *, issued_at::text AS _ck FROM subscription_receipts WHERE salon_id = $1 ${ks ? 'AND (issued_at, id) < ($3::timestamptz, $4::uuid)' : ''} ORDER BY issued_at DESC, id DESC LIMIT $2`,
      params,
    );
    const { items, nextCursor } = pageOf(r.rows as { id: string; _ck: string }[], q.limit);
    send(res, items.map(receiptDto), { limit: q.limit, nextCursor });
  });
}
