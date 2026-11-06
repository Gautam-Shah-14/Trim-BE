// Hot-slot stampede (spec 11.5): 500 virtual users hold the SAME staff/time at once. Exactly one may win.
// Prepare: a salon with one bookable staff member and service, opening hours covering START_HOUR_UTC.
// The target server needs RATE_LIMIT_REGISTER_PER_HOUR >= USERS and RATE_LIMIT_HOLD_PER_MIN high enough (it is per user, default is fine).
//   k6 run -e BASE_URL=... -e SALON_ID=.. -e STAFF_ID=.. -e SERVICE_ID=.. -e START_HOUR_UTC=6 loadtest/hot-slot.js
// AFTER the run: npm run loadtest:check   (asserts zero overlapping active bookings and reports winners per slot)
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { V1, JSON_HEADERS, authHeaders, registerCustomer, startAt, uuid } from './common.js';

const USERS = Number(__ENV.USERS || 500);
const won = new Counter('slot_won');
const taken = new Counter('slot_taken');
const unexpected = new Counter('hold_unexpected');

export const options = {
  scenarios: { stampede: { executor: 'per-vu-iterations', vus: USERS, iterations: 1, maxDuration: '2m' } },
  thresholds: {
    slot_won: ['count==1'],                 // exactly one winner
    hold_unexpected: ['count==0'],          // no 5xx, no surprise statuses from contention
    'http_req_duration{name:hold}': ['p(95)<500'],
  },
  setupTimeout: '10m',
};

export function setup() {
  const tokens = [];
  for (let i = 0; i < USERS; i++) {
    const c = registerCustomer(`hot${i}`);
    if (c) tokens.push(c.token);
  }
  return { tokens, startsAt: startAt(Number(__ENV.DAYS_AHEAD || 3), Number(__ENV.START_HOUR_UTC || 6), 0) };
}

export default function (data) {
  const token = data.tokens[(__VU - 1) % data.tokens.length];
  const res = http.post(
    `${V1}/bookings/hold`,
    JSON.stringify({ salonId: __ENV.SALON_ID, staffId: __ENV.STAFF_ID, serviceIds: [__ENV.SERVICE_ID], startsAt: data.startsAt }),
    { ...authHeaders(token, { 'Idempotency-Key': uuid() }), tags: { name: 'hold' } },
  );
  if (res.status === 201) won.add(1);
  else if (res.status === 409 && res.json('error.code') === 'SLOT_TAKEN') {
    taken.add(1);
    check(res, { 'alternatives offered': (r) => Array.isArray(r.json('error.details.alternatives')) });
  } else {
    unexpected.add(1);
    console.error(`unexpected ${res.status} ${res.body}`);
  }
}

export { JSON_HEADERS };
