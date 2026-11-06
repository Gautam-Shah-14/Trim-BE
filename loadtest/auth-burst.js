// Login / register burst. Expect 429 RATE_LIMITED with Retry-After once per-IP/identifier limits bite; never 5xx.
//   k6 run -e BASE_URL=... -e LOGIN_EMAIL=<existing account> -e LOGIN_PASSWORD=<its password> loadtest/auth-burst.js
// (the credentials come from your shell, never from the repo)
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { V1, JSON_HEADERS, uuid } from './common.js';

const limited = new Counter('rate_limited');

export const options = {
  scenarios: {
    login: { executor: 'constant-arrival-rate', rate: 50, timeUnit: '1s', duration: '1m', preAllocatedVUs: 100, maxVUs: 300, exec: 'login' },
    register: { executor: 'constant-arrival-rate', rate: 10, timeUnit: '1s', duration: '1m', preAllocatedVUs: 50, maxVUs: 100, exec: 'register' },
  },
  thresholds: { 'http_req_failed{status:500}': ['rate==0'], 'http_req_duration{name:login}': ['p(95)<800'] },
};

export function login() {
  const res = http.post(`${V1}/auth/login`, JSON.stringify({ identifier: __ENV.LOGIN_EMAIL, password: __ENV.LOGIN_PASSWORD, client: 'website' }), { headers: JSON_HEADERS, tags: { name: 'login' } });
  if (res.status === 429) {
    limited.add(1);
    check(res, { 'Retry-After present': (r) => !!r.headers['Retry-After'] });
  }
  check(res, { 'no 5xx': (r) => r.status < 500 });
}

export function register() {
  const res = http.post(`${V1}/auth/register`, JSON.stringify({ fullName: 'Burst', email: `burst-${uuid()}@example.test`, password: 'BurstTest1234' }), { headers: JSON_HEADERS, tags: { name: 'register' } });
  if (res.status === 429) limited.add(1);
  check(res, { 'no 5xx': (r) => r.status < 500 });
}
