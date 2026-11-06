import { describe, expect, it } from 'vitest';
import { CacheService, MemoryCache, RedisCache } from '../src/infra/cache.js';
import { MemoryLimiter, RedisLimiter } from '../src/infra/limiter.js';
import { Metrics } from '../src/infra/metrics.js';
import { MemoryQueue } from '../src/infra/queue.js';
import { CircuitBreaker, isCritical, shouldShed, withTimeout } from '../src/infra/resilience.js';
import { protectGateway } from '../src/lib/gateway.js';
import { createLogger } from '../src/logger.js';
import { FakeRedis } from './helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('rate limiter (memory and redis drivers)', () => {
  it('allows `limit` hits per window, then rejects with a retry hint; rejected hits do not count', async () => {
    const l = new MemoryLimiter();
    const rs = [];
    for (let i = 0; i < 5; i++) rs.push(await l.consume('k', 3, 60_000));
    expect(rs.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
    expect(rs[0]!.remaining).toBe(2);
    expect(rs[3]!.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect((await l.consume('other', 3, 60_000)).allowed).toBe(true); // keys are independent
    await l.close();
  });
  it('the window slides: capacity returns after the window has passed', async () => {
    const l = new MemoryLimiter();
    expect((await l.consume('k', 1, 150)).allowed).toBe(true);
    expect((await l.consume('k', 1, 150)).allowed).toBe(false);
    await sleep(330);
    expect((await l.consume('k', 1, 150)).allowed).toBe(true);
    await l.close();
  });
  it('redis driver limits identically and fails OPEN when redis is down', async () => {
    const fake = new FakeRedis();
    const l = new RedisLimiter(fake);
    const rs = [];
    for (let i = 0; i < 4; i++) rs.push((await l.consume('k', 2, 60_000)).allowed);
    expect(rs).toEqual([true, true, false, false]);
    fake.down = true;
    expect((await l.consume('k', 2, 60_000)).allowed).toBe(true);
  });
});

describe('cache service', () => {
  it('cache-aside with single-flight: 20 concurrent misses run the loader once', async () => {
    const c = new CacheService(new MemoryCache(), new Metrics());
    let calls = 0;
    const load = async () => {
      calls++;
      await sleep(30);
      return { n: 1 };
    };
    const out = await Promise.all(Array.from({ length: 20 }, () => c.getOrLoad('k', 60, load)));
    expect(out.every((o) => o.n === 1)).toBe(true);
    expect(calls).toBe(1);
    await c.getOrLoad('k', 60, load);
    expect(calls).toBe(1); // served from cache
  });
  it('ttl 0 disables caching; version keys invalidate', async () => {
    const c = new CacheService(new MemoryCache());
    let calls = 0;
    await c.getOrLoad('a', 0, async () => ++calls);
    await c.getOrLoad('a', 0, async () => ++calls);
    expect(calls).toBe(2);
    const v0 = await c.version('salon:1');
    const key = (v: number) => `pub:1:v${v}`;
    await c.getOrLoad(key(v0), 60, async () => 'old');
    await c.bump('salon:1');
    const v1 = await c.version('salon:1');
    expect(v1).toBe(v0 + 1);
    expect(await c.getOrLoad(key(v1), 60, async () => 'new')).toBe('new');
  });
  it('stale-while-revalidate returns the stale value and refreshes in the background', async () => {
    const c = new CacheService(new MemoryCache());
    let v = 'v1';
    expect(await c.getOrLoad('k', 0.05, async () => v)).toBe('v1');
    v = 'v2';
    await sleep(120); // past the fresh window (jitter +-10 %), still inside the 3x retention
    expect(await c.getOrLoad('k', 0.05, async () => v)).toBe('v1'); // stale served
    await sleep(40);
    expect(await c.getOrLoad('k', 0.05, async () => v)).toBe('v2'); // refreshed
  });
  it('a failing cache driver never fails the request', async () => {
    const fake = new FakeRedis();
    fake.down = true;
    const c = new CacheService(new RedisCache(fake));
    expect(await c.getOrLoad('k', 60, async () => 42)).toBe(42);
    expect(await c.version('x')).toBe(0);
    await c.bump('x');
    await c.del('k');
  });
  it('redis cache driver round-trips values, counters and SET NX', async () => {
    const fake = new FakeRedis();
    const c = new CacheService(new RedisCache(fake));
    expect(await c.getOrLoad('k', 60, async () => ({ a: 1 }))).toEqual({ a: 1 });
    expect(await c.getOrLoad('k', 60, async () => ({ a: 2 }))).toEqual({ a: 1 });
    expect(fake.data.has('trim:k')).toBe(true);
    const drv = new RedisCache(fake);
    expect(await drv.setNx('lock', 1000)).toBe(true);
    expect(await drv.setNx('lock', 1000)).toBe(false);
    expect(await drv.incr('ctr')).toBe(1);
  });
});

describe('queue', () => {
  it('memory queue retries failures with backoff and de-duplicates by singleton key', async () => {
    const q = new MemoryQueue(createLogger('silent', 'test'), 1);
    let attempts = 0;
    const seen: string[] = [];
    q.register('flaky', async () => {
      if (++attempts < 3) throw new Error('boom');
    });
    q.register('work', async (d: { id: string }) => {
      seen.push(d.id);
      await sleep(20);
    });
    await q.enqueue('flaky', {});
    await q.drain();
    expect(attempts).toBe(3);
    await Promise.all([q.enqueue('work', { id: 'a' }, { singletonKey: 'a' }), q.enqueue('work', { id: 'a' }, { singletonKey: 'a' }), q.enqueue('work', { id: 'b' }, { singletonKey: 'b' })]);
    await q.drain();
    expect(seen.sort()).toEqual(['a', 'b']);
    await q.stop();
  });
});

describe('resilience', () => {
  it('circuit breaker opens after N failures, rejects fast, then half-opens', async () => {
    let now = 0;
    const b = new CircuitBreaker(3, 1000, () => now);
    const fail = () => b.run(async () => { throw new Error('x'); }).catch((e: Error) => e.message);
    expect([await fail(), await fail(), await fail()]).toEqual(['x', 'x', 'x']);
    expect(b.state).toBe('open');
    expect(await fail()).toBe('circuit open');
    now = 1500;
    expect(b.state).toBe('half-open');
    expect(await b.run(async () => 'ok')).toBe('ok');
    expect(b.state).toBe('closed');
  });
  it('withTimeout rejects slow calls; the protected gateway trips on repeated failures', async () => {
    await expect(withTimeout(sleep(200), 20, 'slow')).rejects.toThrow(/timed out/);
    let calls = 0;
    const gw = protectGateway(
      { keyId: 'k', createSubscription: async () => { calls++; throw new Error('rz down'); }, cancelSubscription: async () => {} },
      { breaker: new CircuitBreaker(2, 60_000) },
    );
    await expect(gw.createSubscription({ planId: 'p', totalCount: 1, notes: {} })).rejects.toThrow('rz down');
    await expect(gw.createSubscription({ planId: 'p', totalCount: 1, notes: {} })).rejects.toThrow('rz down');
    await expect(gw.createSubscription({ planId: 'p', totalCount: 1, notes: {} })).rejects.toThrow('circuit open');
    expect(calls).toBe(2);
  });
  it('load shedding drops optional work but never bookings, check-in, auth or webhooks', () => {
    const cfg = { lagMs: 500, poolWaiting: 50, queueMaxDepth: 100 };
    const hot = { lagMs: 900, poolWaiting: 0, queueDepth: 0 };
    expect(shouldShed({ path: '/v1/discover/salons', ...hot }, cfg)).toBe(true);
    expect(shouldShed({ path: '/v1/salons/abc/analytics/summary', ...hot }, cfg)).toBe(true);
    for (const path of ['/v1/bookings/hold', '/v1/salons/abc/checkin', '/v1/salons/abc/invoices', '/v1/webhooks/razorpay', '/v1/auth/login', '/health']) {
      expect(isCritical(path)).toBe(true);
      expect(shouldShed({ path, ...hot }, cfg)).toBe(false);
    }
    expect(shouldShed({ path: '/v1/discover/salons', lagMs: 10, poolWaiting: 80, queueDepth: 0 }, cfg)).toBe(true);
    expect(shouldShed({ path: '/v1/discover/salons', lagMs: 10, poolWaiting: 1, queueDepth: 0 }, cfg)).toBe(false);
  });
});

describe('metrics', () => {
  it('renders prometheus text with counters, gauges and histograms', async () => {
    const m = new Metrics();
    m.inc('http_requests_total', { route: '/x', status: 200 });
    m.inc('http_requests_total', { route: '/x', status: 200 });
    m.observe('http_request_duration_seconds', 0.03, { route: '/x' });
    m.gauge('queue_depth', () => 7);
    const text = await m.render();
    expect(text).toContain('http_requests_total{route="/x",status="200"} 2');
    expect(text).toContain('queue_depth 7');
    expect(text).toContain('http_request_duration_seconds_bucket{route="/x",le="0.05"} 1');
    expect(text).toContain('http_request_duration_seconds_count{route="/x"} 1');
  });
});
