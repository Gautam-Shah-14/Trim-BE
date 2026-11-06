// Browse-heavy mix: discover -> salon profile -> availability. ~90 % of real traffic is reads (spec 11.1).
// k6 run -e BASE_URL=https://api.example.test -e SALON_ID=<uuid> -e SERVICE_ID=<uuid> -e LAT=18.52 -e LNG=73.85 loadtest/browse.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { V1, backoff } from './common.js';

export const options = {
  scenarios: {
    browse: { executor: 'ramping-arrival-rate', startRate: 10, timeUnit: '1s', preAllocatedVUs: 100, maxVUs: 400, stages: [
      { target: 60, duration: '2m' }, { target: 150, duration: '5m' }, { target: 0, duration: '1m' },
    ] },
  },
  thresholds: {
    'http_req_duration{kind:read}': ['p(95)<300'],
    http_req_failed: ['rate<0.005'],
    checks: ['rate>0.995'],
  },
};

const salon = __ENV.SALON_ID;
const service = __ENV.SERVICE_ID;

export default function () {
  const lat = __ENV.LAT || '18.52';
  const lng = __ENV.LNG || '73.85';
  const list = http.get(`${V1}/discover/salons?lat=${lat}&lng=${lng}&radiusKm=25&limit=20`, { tags: { kind: 'read', name: 'discover' } });
  check(list, { 'discover 200/304': (r) => r.status === 200 || r.status === 304 });
  backoff(list, sleep);
  sleep(1 + Math.random() * 2);

  const detail = http.get(`${V1}/discover/salons/${salon}`, { tags: { kind: 'read', name: 'salon' } });
  check(detail, { 'salon 200': (r) => r.status === 200 });
  backoff(detail, sleep);
  sleep(1 + Math.random() * 2);

  const day = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const av = http.get(`${V1}/salons/${salon}/availability?serviceIds=${service}&date=${day}`, { tags: { kind: 'read', name: 'availability' } });
  check(av, { 'availability 200': (r) => r.status === 200 });
  backoff(av, sleep);
}
