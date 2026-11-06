// Shared helpers for the k6 scripts. Configuration comes from environment variables (-e NAME=value); nothing is hard-coded.
import http from 'k6/http';
import { check } from 'k6';

export const BASE = __ENV.BASE_URL || 'http://localhost:8080';
export const V1 = `${BASE}/v1`;
export const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function uuid() {
  // good enough for idempotency keys in a load test
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function authHeaders(token, extra = {}) {
  return { headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}`, ...extra } };
}

/** register a customer; returns {token, id} or null. Needs RATE_LIMIT_REGISTER_PER_HOUR raised on the target server. */
export function registerCustomer(tag) {
  const res = http.post(
    `${V1}/auth/register`,
    JSON.stringify({ fullName: `Load ${tag}`, email: `load-${tag}-${uuid().slice(0, 8)}@example.test`, password: 'LoadTest1234' }),
    { headers: JSON_HEADERS, tags: { name: 'register' } },
  );
  if (!check(res, { 'registered': (r) => r.status === 201 })) return null;
  return { token: res.json('data.accessToken'), refresh: res.json('data.refreshToken') };
}

/** Honour Retry-After on 429/503 (clients must back off with jitter; the load test does the same). */
export function backoff(res, sleep) {
  if (res.status === 429 || res.status === 503) {
    const ra = Number(res.headers['Retry-After'] || 1);
    sleep(ra + Math.random());
  }
}

/** ISO start time `days` from now at a whole 5 minute mark, `hour`:`minute` UTC (keep inside the target salon's opening hours) */
export function startAt(days, hour, minute) {
  const d = new Date(Date.now() + days * 86400000);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
}
