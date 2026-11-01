import Razorpay from 'razorpay';
import type { Config } from '../config.js';

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

export function createRazorpayGateway(cfg: Config['razorpay']): PaymentGateway {
  let client: Razorpay | null = null;
  const get = () => {
    if (!cfg.keyId || !cfg.keySecret) {
      throw new Error('Razorpay is not configured (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET)');
    }
    client ??= new Razorpay({ key_id: cfg.keyId, key_secret: cfg.keySecret });
    return client;
  };
  return {
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
  };
}
