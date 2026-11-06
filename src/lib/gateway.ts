import Razorpay from 'razorpay';
import type { Config } from '../config.js';
import { CircuitBreaker, withTimeout } from '../infra/resilience.js';

export interface CreateSubscriptionInput {
  planId: string;
  totalCount: number;
  /** unix seconds; used to delay the first charge until a trial ends */
  startAt?: number;
  notes: Record<string, string>;
}

/** Narrow interface over Razorpay so tests can inject a fake and nothing else touches the SDK. */
export interface PaymentGateway {
  keyId: string;
  createSubscription(input: CreateSubscriptionInput): Promise<{ id: string }>;
  cancelSubscription(subscriptionId: string, atCycleEnd: boolean): Promise<void>;
}

/** Wraps any gateway with a timeout and a circuit breaker (5 consecutive failures open it for 30 s). Cancel is retried (idempotent), create is not. */
export function protectGateway(inner: PaymentGateway, o: { timeoutMs?: number; breaker?: CircuitBreaker } = {}): PaymentGateway {
  const breaker = o.breaker ?? new CircuitBreaker(5, 30_000);
  const timeout = o.timeoutMs ?? 10_000;
  const call = <T>(fn: () => Promise<T>, what: string) => breaker.run(() => withTimeout(fn(), timeout, what));
  return {
    keyId: inner.keyId,
    createSubscription: (input) => call(() => inner.createSubscription(input), 'razorpay create subscription'),
    async cancelSubscription(id, atCycleEnd) {
      let last: unknown;
      for (let i = 0; i < 3; i++) {
        try {
          return await call(() => inner.cancelSubscription(id, atCycleEnd), 'razorpay cancel subscription');
        } catch (err) {
          last = err;
          await new Promise((r) => setTimeout(r, 200 * (i + 1)));
        }
      }
      throw last;
    },
  };
}

export function createRazorpayGateway(cfg: Config['razorpay']): PaymentGateway {
  let client: Razorpay | null = null;
  const get = () => {
    if (!cfg.keyId || !cfg.keySecret) {
      throw new Error('Razorpay is not configured (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET)');
    }
    client ??= new Razorpay({ key_id: cfg.keyId, key_secret: cfg.keySecret });
    return client;
  };
  return protectGateway({
    keyId: cfg.keyId,
    async createSubscription(input) {
      const sub = await get().subscriptions.create({
        plan_id: input.planId,
        total_count: input.totalCount,
        customer_notify: 1,
        ...(input.startAt ? { start_at: input.startAt } : {}),
        notes: input.notes,
      });
      return { id: sub.id };
    },
    async cancelSubscription(subscriptionId, atCycleEnd) {
      await get().subscriptions.cancel(subscriptionId, atCycleEnd);
    },
  });
}
