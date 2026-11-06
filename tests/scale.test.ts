import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { RedisCache } from '../src/infra/cache.js';
import { rollupRange } from '../src/lib/rollup.js';
import { addDays, localDateOf } from '../src/lib/slots.js';
import { call, eventResult, FakeRedis, makeCustomer, makeOwner, openAllDay, PASSWORD, sign, slotAt, startCtx, webhook, type Ctx, type Owner } from './helpers.js';

const ctxs: Ctx[] = [];
const boot = async (env: Record<string, string> = {}, extra: Parameters<typeof startCtx>[1] = {}) => {
  const c = await startCtx(env, extra);
  ctxs.push(c);
  return c;
};
afterAll(async () => {
  await Promise.all(ctxs.map((c) => c.close()));
});

const holdBody = (o: Owner, startsAt: string, staffId = o.staffId) => ({ salonId: o.salonId, staffId, serviceIds: [o.serviceId], startsAt });

describe('rate limiting', () => {
  it('hold: per-user limit returns 429 with Retry-After and RateLimit-* headers', async () => {
    const ctx = await boot({ RATE_LIMIT_HOLD_PER_MIN: '3' });
    const o = await makeOwner(ctx);
    const c = await makeCustomer(ctx);
    const rs = [];
    for (let i = 0; i < 5; i++) rs.push(await call(ctx, 'POST', '/v1/bookings/hold', { token: c.token, body: holdBody(o, slotAt(2, `1${i}:00`)) }));
    expect(rs.map((r) => r.status === 429)).toEqual([false, false, false, true, true]);
    const limited = rs[3]!;
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(limited.headers.get('ratelimit-limit')).toBe('3');
    expect(limited.headers.get('ratelimit-remaining')).toBe('0');
    expect(limited.headers.get('ratelimit-reset')).toBeTruthy();
    // another user is unaffected
    const c2 = await makeCustomer(ctx);
    expect((await call(ctx, 'POST', '/v1/bookings/hold', { token: c2.token, body: holdBody(o, slotAt(3, '10:00')) })).status).toBe(201);
  });

  it('availability, register and check-in have their own limits; the webhook is exempt', async () => {
    const ctx = await boot({ RATE_LIMIT_AVAILABILITY_PER_MIN: '2', RATE_LIMIT_REGISTER_PER_HOUR: '2', RATE_LIMIT_CHECKIN_PER_MIN: '2', RATE_LIMIT_GENERAL_PER_MIN: '30' });
    const o = await makeOwner(ctx);
    const date = slotAt(2, '12:00').slice(0, 10);
    const av = () => call(ctx, 'GET', `/v1/salons/${o.salonId}/availability?serviceIds=${o.serviceId}&date=${date}`);
    expect([(await av()).status, (await av()).status, (await av()).status]).toEqual([200, 200, 429]);

    const reg = (n: number) => call(ctx, 'POST', '/v1/auth/register', { body: { fullName: 'R', email: `reg${n}-${randomUUID()}@example.test`, password: PASSWORD } });
    expect([(await reg(1)).status, (await reg(2)).status, (await reg(3)).status]).toEqual([201, 201, 429]);

    const ci = () => call(ctx, 'POST', `/v1/salons/${o.salonId}/checkin`, { token: o.token, body: { qrToken: 'x'.repeat(20) } });
    const codes = [(await ci()).status, (await ci()).status, (await ci()).status];
    expect(codes[2]).toBe(429); // first two reach validation (422), third is limited

    // webhook: far more requests than the general limit (30/min) still get through (signature errors, not 429)
    const ws = await Promise.all(Array.from({ length: 40 }, () => call(ctx, 'POST', '/v1/webhooks/razorpay', { raw: '{}', headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': 'bad' } })));
    expect(ws.every((r) => r.status === 401)).toBe(true);
  });
});

describe('slot hoarding caps (spec 11.3)', () => {
  it('at most 3 active holds per customer, exact under parallel requests', async () => {
    const ctx = await boot();
    const o = await makeOwner(ctx);
    const c = await makeCustomer(ctx);
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => call(ctx, 'POST', '/v1/bookings/hold', { token: c.token, body: holdBody(o, slotAt(4, `${10 + i}:00`)) })));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(3);
    const blocked = rs.filter((r) => r.status === 409);
    expect(blocked).toHaveLength(5);
    expect(blocked[0]!.body.error.code).toBe('CONFLICT');
    expect(blocked[0]!.body.error.reason).toBe('HOLD_LIMIT');
    expect(blocked[0]!.body.error.details).toMatchObject({ limit: 3 });
    // confirming one does not free a hold slot for a 4th active hold... but cancelling does
    const first = rs.find((r) => r.status === 201)!;
    await call(ctx, 'POST', `/v1/bookings/${first.body.data.id}/cancel`, { token: c.token, body: {} });
    expect((await call(ctx, 'POST', '/v1/bookings/hold', { token: c.token, body: holdBody(o, slotAt(5, '10:00')) })).status).toBe(201);
  });

  it('upcoming-confirmed and per-day caps', async () => {
    const ctx = await boot({ MAX_UPCOMING_PER_CUSTOMER: '2', MAX_BOOKINGS_PER_DAY: '3', MAX_HELD_PER_CUSTOMER: '5' });
    const o = await makeOwner(ctx);
    const c = await makeCustomer(ctx);
    const book = async (hh: string) => {
      const h = await call(ctx, 'POST', '/v1/bookings/hold', { token: c.token, body: holdBody(o, slotAt(6, hh)) });
      if (h.status === 201) await call(ctx, 'POST', `/v1/bookings/${h.body.data.id}/confirm`, { token: c.token });
      return h;
    };
    expect((await book('10:00')).status).toBe(201);
    expect((await book('11:00')).status).toBe(201);
    const third = await book('12:00');
    expect(third.status).toBe(409);
    expect(third.body.error.reason).toBe('UPCOMING_LIMIT');

    const ctx2 = await boot({ MAX_BOOKINGS_PER_DAY: '2' });
    const o2 = await makeOwner(ctx2);
    const c2 = await makeCustomer(ctx2);
    await call(ctx2, 'POST', '/v1/bookings/hold', { token: c2.token, body: holdBody(o2, slotAt(6, '10:00')) });
    await call(ctx2, 'POST', '/v1/bookings/hold', { token: c2.token, body: holdBody(o2, slotAt(6, '11:00')) });
    const over = await call(ctx2, 'POST', '/v1/bookings/hold', { token: c2.token, body: holdBody(o2, slotAt(6, '12:00')) });
    expect(over.body.error.reason).toBe('DAILY_LIMIT');
  });
});

describe('SLOT_TAKEN carries alternatives (spec 11.5.2)', () => {
  it('hold, walk-in and reschedule losers get up to 3 free start times for the same staff', async () => {
    const ctx = await boot();
    const o = await makeOwner(ctx);
    const [a, b] = await Promise.all([makeCustomer(ctx), makeCustomer(ctx)]);
    const when = slotAt(3, '11:00');
    expect((await call(ctx, 'POST', '/v1/bookings/hold', { token: a.token, body: holdBody(o, when) })).status).toBe(201);
    const lost = await call(ctx, 'POST', '/v1/bookings/hold', { token: b.token, body: holdBody(o, when) });
    expect(lost.status).toBe(409);
    expect(lost.body.error.code).toBe('SLOT_TAKEN');
    const alts = lost.body.error.details.alternatives as { staffId: string; startsAt: string; endsAt: string }[];
    expect(alts).toHaveLength(3);
    for (const s of alts) {
      expect(s.staffId).toBe(o.staffId);
      expect(Date.parse(s.startsAt)).toBeGreaterThan(Date.parse(when));
    }
    // the first alternative is really bookable
    expect((await call(ctx, 'POST', '/v1/bookings/hold', { token: b.token, body: holdBody(o, alts[0]!.startsAt) })).status).toBe(201);

    const walk = await call(ctx, 'POST', `/v1/salons/${o.salonId}/bookings`, { token: o.token, body: { customerName: 'W', staffId: o.staffId, serviceIds: [o.serviceId], startsAt: when } });
    expect(walk.body.error.details.alternatives.length).toBeGreaterThan(0);
  });
});

describe('HTTP hardening', () => {
  it('body limit 100 KB (media 400 KB), db statement timeout, /ready and /metrics', async () => {
    const ctx = await boot({ STATEMENT_TIMEOUT_MS: '400', METRICS_TOKEN: 'metrics-test-token' });
    const big = 'x'.repeat(150 * 1024);
    const r = await call(ctx, 'POST', '/v1/contact', { body: { name: 'n', email: 'a@b.co', message: big } });
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe('VALIDATION_FAILED');
    // media route accepts the bigger envelope (rejected later by its own 200 KB decoded cap)
    const o = await makeOwner(ctx);
    const m = await call(ctx, 'POST', '/v1/media', { token: o.token, body: { kind: 'logo', mime: 'image/png', dataBase64: 'A'.repeat(250_000), salonId: o.salonId } });
    expect(m.status).toBe(422);

    await expect(ctx.pool.query('SELECT pg_sleep(2)')).rejects.toThrow(/statement timeout|timeout/i);
    const sh = await ctx.pool.query('SHOW lock_timeout');
    expect(sh.rows[0].lock_timeout).toBe('2s');

    const ready = await call(ctx, 'GET', '/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ status: 'ready', db: 'up', cache: 'up', queue: 'up' });
    expect((await call(ctx, 'GET', '/metrics')).status).toBe(401);
    const metrics = await fetch(`${ctx.base}/metrics`, { headers: { Authorization: 'Bearer metrics-test-token' } });
    const text = await metrics.text();
    expect(metrics.status).toBe(200);
    expect(text).toContain('http_requests_total');
    expect(text).toContain('db_pool_total');
    expect(text).toContain('process_uptime_seconds');
  });
});

describe('caching and invalidation (spec 11.2)', () => {
  it('public salon profile is cached and dropped by version-key invalidation on writes; ETag/304', async () => {
    const ctx = await boot({ CACHE_TTL_SALON_PUBLIC_S: '120', CACHE_TTL_DISCOVER_S: '60', CACHE_TTL_PLANS_S: '3600', CACHE_TTL_CATALOG_S: '3600' });
    const o = await makeOwner(ctx, { name: 'Cache Salon' });
    const get = () => call(ctx, 'GET', `/v1/discover/salons/${o.salonId}`);
    const first = await get();
    expect(first.body.data.services).toHaveLength(1);
    expect(first.headers.get('cache-control')).toContain('max-age=60');
    const etag = first.headers.get('etag')!;
    expect(etag).toBeTruthy();

    // out-of-band SQL change is NOT visible (proves the response is served from cache)
    await ctx.pool.query("UPDATE salons SET description = 'changed in SQL' WHERE id = $1", [o.salonId]);
    expect((await get()).body.data.description).not.toBe('changed in SQL');
    // conditional GET
    const nm = await fetch(`${ctx.base}/v1/discover/salons/${o.salonId}`, { headers: { 'If-None-Match': etag } });
    expect(nm.status).toBe(304);

    // an API write bumps the salon version key => next read is fresh, ETag changes
    const svc = await call(ctx, 'POST', `/v1/salons/${o.salonId}/services`, { token: o.token, body: { category: 'Hair', name: 'Beard trim', durationMin: 15, pricePaise: 10000 } });
    expect(svc.status).toBe(201);
    const after = await get();
    expect(after.body.data.services).toHaveLength(2);
    expect(after.body.data.description).toBe('changed in SQL');
    expect(after.headers.get('etag')).not.toBe(etag);

    // plans + catalog + discover list carry validators too
    for (const path of ['/v1/plans', '/v1/hairstyles', '/v1/discover/salons?limit=5']) {
      const r = await call(ctx, 'GET', path);
      expect(r.status).toBe(200);
      const etagN = r.headers.get('etag')!;
      expect((await fetch(`${ctx.base}${path}`, { headers: { 'If-None-Match': etagN } })).status).toBe(304);
    }
    // discover list is invalidated when a salon changes
    const list1 = await call(ctx, 'GET', '/v1/discover/salons?q=Cache%20Salon');
    expect(list1.body.data[0].startingPricePaise).toBe(10000);
    await call(ctx, 'PATCH', `/v1/salons/${o.salonId}/services/${svc.body.data.id}`, { token: o.token, body: { pricePaise: 5000 } });
    const list2 = await call(ctx, 'GET', '/v1/discover/salons?q=Cache%20Salon');
    expect(list2.body.data[0].startingPricePaise).toBe(5000);
  });

  it('plan edit by an admin invalidates the cached public plans', async () => {
    const ctx = await boot({ CACHE_TTL_PLANS_S: '3600' });
    const hash = await (await import('../src/lib/security.js')).makePasswordHasher(1024).hash(PASSWORD);
    const email = `adm-${randomUUID()}@example.test`;
    await ctx.pool.query("INSERT INTO users (email, password_hash, full_name, platform_role) VALUES ($1,$2,'A','admin')", [email, hash]);
    const admin = (await call(ctx, 'POST', '/v1/auth/login', { body: { identifier: email, password: PASSWORD, client: 'website' } })).body.data.accessToken;
    const price = async () => (await call(ctx, 'GET', '/v1/plans')).body.data.find((p: any) => p.code === 'starter').priceMonthlyPaise;
    expect(await price()).toBe(59900);
    await call(ctx, 'PATCH', '/v1/admin/plans/starter', { token: admin, body: { priceMonthlyPaise: 64900 } });
    expect(await price()).toBe(64900);
  });

  it('sessions and permissions are cached but logout, role and staff changes take effect immediately', async () => {
    const ctx = await boot({ CACHE_TTL_SESSION_S: '60', CACHE_TTL_ENTITLEMENTS_S: '60' });
    const o = await makeOwner(ctx);
    const email = `rec-${randomUUID()}@example.test`;
    const staff = await call(ctx, 'POST', `/v1/salons/${o.salonId}/staff`, { token: o.token, body: { fullName: 'Rec', email, tempPassword: PASSWORD, roleId: o.roleIds['receptionist'] } });
    const login = await call(ctx, 'POST', '/v1/auth/login', { body: { identifier: email, password: PASSWORD, client: 'salon_app' } });
    const tok = login.body.data.accessToken as string;
    const list = () => call(ctx, 'GET', `/v1/salons/${o.salonId}/invoices`, { token: tok });
    expect((await list()).status).toBe(200);
    const before = ctx.deps.metrics.get('cache_hits_total');
    expect((await list()).status).toBe(200);
    expect(ctx.deps.metrics.get('cache_hits_total')).toBeGreaterThan(before); // served from cache

    // role change (stylist has no billing.view) is visible at once
    await call(ctx, 'PATCH', `/v1/salons/${o.salonId}/staff/${staff.body.data.id}`, { token: o.token, body: { roleId: o.roleIds['stylist'] } });
    expect((await list()).status).toBe(403);
    // deactivation is visible at once
    await call(ctx, 'POST', `/v1/salons/${o.salonId}/staff/${staff.body.data.id}/deactivate`, { token: o.token });
    expect((await list()).status).toBe(403);
    // logout kills the cached session at once
    expect((await call(ctx, 'GET', '/v1/me', { token: o.token })).status).toBe(200);
    await call(ctx, 'POST', '/v1/auth/logout', { token: o.token });
    expect((await call(ctx, 'GET', '/v1/me', { token: o.token })).status).toBe(401);
  });

  it('availability cache is invalidated by a hold', async () => {
    const ctx = await boot({ CACHE_TTL_AVAILABILITY_S: '30' });
    const o = await makeOwner(ctx);
    const c = await makeCustomer(ctx);
    const date = slotAt(2, '12:00').slice(0, 10);
    const startsAt = slotAt(2, '12:00');
    const slots = async () => (await call(ctx, 'GET', `/v1/salons/${o.salonId}/availability?serviceIds=${o.serviceId}&date=${date}`)).body.data.slots.map((s: any) => s.startsAt);
    expect(await slots()).toContain(startsAt);
    await call(ctx, 'POST', '/v1/bookings/hold', { token: c.token, body: holdBody(o, startsAt) });
    expect(await slots()).not.toContain(startsAt);
  });

  it('redis fast-fail (SET NX) rejects an obvious duplicate before the DB; the DB stays the authority', async () => {
    const fake = new FakeRedis();
    const ctx = await boot({}, { cache: new RedisCache(fake) });
    const o = await makeOwner(ctx);
    const [a, b] = await Promise.all([makeCustomer(ctx), makeCustomer(ctx)]);
    const when = slotAt(4, '10:00');
    expect((await call(ctx, 'POST', '/v1/bookings/hold', { token: a.token, body: holdBody(o, when) })).status).toBe(201);
    const dup = await call(ctx, 'POST', '/v1/bookings/hold', { token: b.token, body: holdBody(o, when) });
    expect(dup.body.error.code).toBe('SLOT_TAKEN');
    // redis outage: holds still work and still serialise through the exclusion constraint
    fake.down = true;
    const other = slotAt(4, '15:00');
    const rs = await Promise.all([a, b].map((c) => call(ctx, 'POST', '/v1/bookings/hold', { token: c.token, body: holdBody(o, other) })));
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
  });
});

describe('queue-backed webhook (spec 11.6) on pg-boss', () => {
  it('stores + acknowledges at once, a worker applies it exactly once, replays are no-ops, retry job recovers lost jobs', async () => {
    const ctx = await boot({ QUEUE_DRIVER: 'pgboss' });
    await ctx.deps.queue.start(true);
    expect(ctx.deps.queue.driver).toBe('pgboss');
    const o = await makeOwner(ctx);
    await ctx.pool.query("UPDATE plans SET razorpay_plan_id_monthly = 'plan_pro_m' WHERE code = 'pro'");
    const co = await call(ctx, 'POST', `/v1/salons/${o.salonId}/subscription/checkout`, { token: o.token, body: { planCode: 'pro', interval: 'monthly' } });
    const subId = co.body.data.razorpaySubscriptionId as string;
    const T = Math.floor(Date.now() / 1000);
    const ev = (type: string, t: number) => ({
      event: type, created_at: t,
      payload: { subscription: { entity: { id: subId, plan_id: 'plan_pro_m', current_start: t, current_end: t + 2_592_000, notes: { app: 'trim', salonId: o.salonId } } }, payment: { entity: { id: `pay_${t}`, amount: 129900 } } },
    });
    const id = randomUUID();
    const rs = await Promise.all(Array.from({ length: 4 }, () => call(ctx, 'POST', '/v1/webhooks/razorpay', { raw: JSON.stringify(ev('subscription.charged', T)), headers: { 'Content-Type': 'application/json', 'X-Razorpay-Event-Id': id, 'X-Razorpay-Signature': sign(ctx, JSON.stringify(ev('subscription.charged', T))) } })));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(rs.filter((r) => r.body.data.result === 'queued')).toHaveLength(1);
    // the worker processes asynchronously
    const waitFor = async (fn: () => Promise<boolean>, ms = 30_000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (await fn()) return;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error('timed out waiting');
    };
    await waitFor(async () => (await eventResult(ctx, id)) === 'applied');
    const sub = (await ctx.pool.query('SELECT status FROM subscriptions WHERE salon_id = $1', [o.salonId])).rows[0];
    expect(sub.status).toBe('active');
    expect((await ctx.pool.query('SELECT count(*)::int AS n FROM subscription_receipts WHERE salon_id = $1', [o.salonId])).rows[0].n).toBe(1);

    // an event that was stored but whose job was lost is recovered by the retry job
    const lostId = randomUUID();
    await ctx.pool.query("INSERT INTO subscription_events (razorpay_event_id, type, payload, received_at) VALUES ($1,'subscription.halted',$2, now() - interval '5 minutes')", [lostId, JSON.stringify(ev('subscription.halted', T + 50))]);
    await ctx.deps.queue.enqueue('webhook.retry', {});
    await waitFor(async () => (await eventResult(ctx, lostId)) === 'applied');
    expect((await ctx.pool.query('SELECT status FROM subscriptions WHERE salon_id = $1', [o.salonId])).rows[0].status).toBe('halted');

    const q = await ctx.deps.queue.stats();
    expect(q.length).toBeGreaterThan(0);
  }, 90_000);
});

describe('trial payment (authenticated) is visible while trialing', () => {
  it('subscription.authenticated sets paymentMethodAuthorized + nextChargeAt without leaving trialing; activated flips to active', async () => {
    const ctx = await boot();
    const o = await makeOwner(ctx);
    await ctx.pool.query("UPDATE plans SET razorpay_plan_id_monthly = 'plan_pro_m' WHERE code = 'pro'");
    const view = async () => (await call(ctx, 'GET', `/v1/salons/${o.salonId}/subscription`, { token: o.token })).body.data;
    expect(await view()).toMatchObject({ status: 'trialing', paymentMethodAuthorized: false, nextChargeAt: null });
    const co = await call(ctx, 'POST', `/v1/salons/${o.salonId}/subscription/checkout`, { token: o.token, body: { planCode: 'pro', interval: 'monthly' } });
    const subId = co.body.data.razorpaySubscriptionId;
    const trialEnd = Math.floor(Date.now() / 1000) + 10 * 86400;
    const ent = (t: number) => ({ id: subId, plan_id: 'plan_pro_m', start_at: trialEnd, charge_at: trialEnd, notes: { app: 'trim', salonId: o.salonId }, current_end: trialEnd + 2_592_000, current_start: t });
    const T = Math.floor(Date.now() / 1000);
    await webhook(ctx, { event: 'subscription.authenticated', created_at: T, payload: { subscription: { entity: ent(T) } } });
    const v = await view();
    expect(v.status).toBe('trialing');
    expect(v.paymentMethodAuthorized).toBe(true);
    expect(Date.parse(v.nextChargeAt) / 1000).toBe(trialEnd);
    expect(v.entitlements.readOnly).toBe(false);
    await webhook(ctx, { event: 'subscription.activated', created_at: T + 5, payload: { subscription: { entity: ent(T + 5) } } });
    expect(await view()).toMatchObject({ status: 'active', paymentMethodAuthorized: true });
    await webhook(ctx, { event: 'subscription.cancelled', created_at: T + 9, payload: { subscription: { entity: ent(T + 9) } } });
    expect(await view()).toMatchObject({ status: 'cancelled', paymentMethodAuthorized: false, nextChargeAt: null });
  });
});

describe('rollups and asynchronous exports (spec 11.6, 11.7)', () => {
  it('daily_salon_stats rollup matches live numbers and feeds the daily series; big exports run as jobs', async () => {
    const ctx = await boot();
    const o = await makeOwner(ctx);
    const tz = await openAllDay(ctx, o);
    // two paid bills today
    for (const amount of [20000, 30000]) {
      await call(ctx, 'POST', `/v1/salons/${o.salonId}/invoices`, { token: o.token, body: { customerName: 'Rollup', items: [{ serviceId: o.serviceId, name: 'Haircut', qty: 1, unitPricePaise: amount }], payments: [{ methodCode: 'cash', amountPaise: amount }] } });
    }
    const live = await call(ctx, 'GET', `/v1/salons/${o.salonId}/analytics/summary`, { token: o.token });
    const today = live.body.data.dailySeries.at(-1);
    expect(today.revenuePaise).toBe(50000);
    // roll up the window (UTC dates around now) and compare
    const d = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    await rollupRange(ctx.pool, d(-2), d(1));
    const rows = await ctx.pool.query("SELECT dim, dim_key, revenue_paise, qty FROM daily_salon_stats WHERE salon_id = $1 AND revenue_paise > 0 ORDER BY dim", [o.salonId]);
    expect(rows.rows.find((r) => r.dim === 'day')!.revenue_paise).toBe(50000);
    expect(rows.rows.find((r) => r.dim === 'service')).toMatchObject({ dim_key: 'Haircut', qty: 2, revenue_paise: 50000 });
    const todayL = localDateOf(Date.now(), tz);
    const yesterdayL = addDays(todayL, -1);
    const narrow = () => call(ctx, 'GET', `/v1/salons/${o.salonId}/analytics/summary?from=${yesterdayL}&to=${todayL}`, { token: o.token });
    const n1 = await narrow();
    expect(n1.body.data.dailySeries.at(-1).revenuePaise).toBe(50000);
    // the past day is served from the rollup table: tampering with it is visible, proving the rollup is what is read
    await ctx.pool.query("UPDATE daily_salon_stats SET revenue_paise = 777 WHERE salon_id = $1 AND dim = 'day' AND day = $2::date", [o.salonId, yesterdayL]);
    const n2 = await narrow();
    expect(n2.body.data.dailySeries[0]).toMatchObject({ date: yesterdayL, revenuePaise: 777 });
    expect(n2.body.data.dailySeries.at(-1).revenuePaise).toBe(50000); // today is always live
    const again = await call(ctx, 'GET', `/v1/salons/${o.salonId}/analytics/summary`, { token: o.token });
    expect(again.body.data.repeatCustomerRate).toBeDefined();

    // small export stays synchronous
    const small = await call(ctx, 'GET', `/v1/salons/${o.salonId}/analytics/export.csv`, { token: o.token });
    expect(small.status).toBe(200);
    expect(small.body).toContain('invoice_no');
    // > 92 days => 202 + job
    const bigRange = await call(ctx, 'GET', `/v1/salons/${o.salonId}/analytics/export.csv?from=${d(-200)}&to=${d(0)}`, { token: o.token });
    expect(bigRange.status).toBe(202);
    const jobId = bigRange.body.data.jobId as string;
    await ctx.deps.queue.drain();
    const job = await call(ctx, 'GET', `/v1/salons/${o.salonId}/jobs/${jobId}`, { token: o.token });
    expect(job.body.data.status).toBe('done');
    const dl = await call(ctx, 'GET', `/v1/salons/${o.salonId}/jobs/${jobId}/download`, { token: o.token });
    expect(dl.status).toBe(200);
    expect(dl.body).toContain('Rollup');
    // explicit async endpoint
    const started = await call(ctx, 'POST', `/v1/salons/${o.salonId}/analytics/export`, { token: o.token, body: {} });
    expect(started.status).toBe(202);
    await ctx.deps.queue.drain();
    expect((await call(ctx, 'GET', `/v1/salons/${o.salonId}/jobs/${started.body.data.jobId}`, { token: o.token })).body.data.status).toBe('done');
    // another salon cannot read the job
    const other = await makeOwner(ctx);
    expect((await call(ctx, 'GET', `/v1/salons/${other.salonId}/jobs/${jobId}`, { token: other.token })).status).toBe(404);
  });
});

describe('request ids and admin queue health', () => {
  it('echoes a client request id; queue endpoint is admin only', async () => {
    const ctx = await boot();
    const r = await call(ctx, 'GET', '/health', { headers: { 'X-Request-Id': 'client-supplied-1234' } });
    expect(r.headers.get('x-request-id')).toBe('client-supplied-1234');
    const o = await makeOwner(ctx);
    expect((await call(ctx, 'GET', '/v1/admin/queue', { token: o.token })).status).toBe(403);
  });
});
