// Mixed "day in the life": 150 req/s for 10 minutes. ~85 % browse, ~10 % holds+confirms, ~3 % salon-side reads, ~2 % check-in attempts.
//   k6 run -e BASE_URL=... -e SALON_ID=.. -e STAFF_ID=.. -e SERVICE_ID=.. -e OWNER_EMAIL=.. -e OWNER_PASSWORD=.. loadtest/day-in-life.js
// Targets to confirm (not promises): read p95 < 300 ms, hold p95 < 500 ms, error rate < 0.5 %, no 5xx from contention.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { V1, JSON_HEADERS, authHeaders, backoff, registerCustomer, startAt, uuid } from './common.js';

export const options = {
  scenarios: { day: { executor: 'constant-arrival-rate', rate: 150, timeUnit: '1s', duration: '10m', preAllocatedVUs: 200, maxVUs: 800 } },
  thresholds: {
    'http_req_duration{kind:read}': ['p(95)<300'],
    'http_req_duration{kind:hold}': ['p(95)<500'],
    'http_req_failed{kind:read}': ['rate<0.005'],
    checks: ['rate>0.99'],
  },
  setupTimeout: '10m',
};

export function setup() {
  const customers = [];
  for (let i = 0; i < Number(__ENV.CUSTOMERS || 50); i++) {
    const c = registerCustomer(`day${i}`);
    if (c) customers.push(c.token);
  }
  const owner = http.post(`${V1}/auth/login`, JSON.stringify({ identifier: __ENV.OWNER_EMAIL, password: __ENV.OWNER_PASSWORD, client: 'salon_app' }), { headers: JSON_HEADERS });
  return { customers, owner: owner.json('data.accessToken') };
}

export default function (data) {
  const r = Math.random();
  const salon = __ENV.SALON_ID;
  if (r < 0.85) {
    const res = http.get(r < 0.4 ? `${V1}/discover/salons?lat=18.52&lng=73.85&radiusKm=25` : r < 0.7 ? `${V1}/discover/salons/${salon}` : `${V1}/salons/${salon}/availability?serviceIds=${__ENV.SERVICE_ID}&date=${new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10)}`, { tags: { kind: 'read' } });
    check(res, { 'read ok': (x) => x.status === 200 || x.status === 304 || x.status === 429 });
    backoff(res, sleep);
  } else if (r < 0.95) {
    const token = data.customers[Math.floor(Math.random() * data.customers.length)];
    const when = startAt(2 + Math.floor(Math.random() * 20), 4 + Math.floor(Math.random() * 6), Math.floor(Math.random() * 12) * 5);
    const hold = http.post(`${V1}/bookings/hold`, JSON.stringify({ salonId: salon, staffId: __ENV.STAFF_ID, serviceIds: [__ENV.SERVICE_ID], startsAt: when }), { ...authHeaders(token, { 'Idempotency-Key': uuid() }), tags: { kind: 'hold' } });
    check(hold, { 'hold 201/409/422/429': (x) => [201, 409, 422, 429].includes(x.status) });
    if (hold.status === 201) {
      http.post(`${V1}/bookings/${hold.json('data.id')}/confirm`, null, { ...authHeaders(token), tags: { kind: 'hold', name: 'confirm' } });
    }
    backoff(hold, sleep);
  } else if (r < 0.98) {
    const res = http.get(`${V1}/salons/${salon}/bookings?limit=20`, { ...authHeaders(data.owner), tags: { kind: 'read', name: 'salon-bookings' } });
    check(res, { 'salon read ok': (x) => x.status === 200 || x.status === 429 });
  } else {
    const res = http.post(`${V1}/salons/${salon}/checkin`, JSON.stringify({ qrToken: 'invalid.token' }), { ...authHeaders(data.owner), tags: { kind: 'read', name: 'checkin' } });
    check(res, { 'checkin handled': (x) => x.status === 422 || x.status === 429 });
  }
}
