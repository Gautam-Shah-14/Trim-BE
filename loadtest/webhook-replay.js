// Webhook replay: the same signed event delivered many times in parallel must change state once and always answer 200 quickly.
// Use a TEST server whose RAZORPAY_WEBHOOK_SECRET you export to this shell; point SALON_ID/SUB_ID at a test subscription (notes.app=trim).
//   k6 run -e BASE_URL=... -e WEBHOOK_SECRET=... -e SALON_ID=.. -e SUB_ID=sub_test loadtest/webhook-replay.js
// Afterwards: SELECT count(*) FROM subscription_events WHERE razorpay_event_id LIKE 'load-%'  => equals the number of distinct ids.
import http from 'k6/http';
import crypto from 'k6/crypto';
import { check } from 'k6';
import { V1 } from './common.js';

export const options = {
  scenarios: { replay: { executor: 'constant-arrival-rate', rate: 100, timeUnit: '1s', duration: '1m', preAllocatedVUs: 100, maxVUs: 200 } },
  thresholds: { http_req_failed: ['rate==0'], 'http_req_duration': ['p(95)<200'] }, // 200 fast: the endpoint only verifies + stores
};

export default function () {
  const n = Math.floor(__ITER / 10); // every event id is delivered ~10 times
  const t = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    event: 'subscription.charged', created_at: t,
    payload: {
      subscription: { entity: { id: __ENV.SUB_ID, plan_id: 'plan_load', current_start: t, current_end: t + 2592000, notes: { app: 'trim', salonId: __ENV.SALON_ID } } },
      payment: { entity: { id: `pay_load_${n}`, amount: 129900 } },
    },
  });
  const res = http.post(`${V1}/webhooks/razorpay`, body, {
    headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': crypto.hmac('sha256', __ENV.WEBHOOK_SECRET, body, 'hex'), 'X-Razorpay-Event-Id': `load-${__VU}-${n}` },
  });
  check(res, { '200': (r) => r.status === 200 });
}
