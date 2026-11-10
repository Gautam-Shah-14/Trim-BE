import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { call, makeCustomer, makeOwner, PASSWORD, phone, sign, startCtx, type Ctx } from './helpers.js';

const ctxs: Ctx[] = [];
const boot = async (env: Record<string, string> = {}) => {
  const c = await startCtx(env);
  ctxs.push(c);
  return c;
};
afterAll(async () => {
  await Promise.all(ctxs.map((c) => c.close()));
});

describe('D-01 authenticated BFF client IP', () => {
  const secret = randomBytes(18).toString('hex'); // 36 chars, throwaway
  const contact = (ctx: Ctx, headers: Record<string, string>) =>
    call(ctx, 'POST', '/v1/contact', { body: { name: 'Visitor', email: 'v@example.test', message: 'hello there' }, headers });

  it('a valid key makes the header IP the rate-limit identity; wrong keys and missing keys are ignored', async () => {
    const ctx = await boot({ BFF_SHARED_SECRET: secret, RATE_LIMIT_CONTACT_PER_HOUR: '2' });
    const asVisitor = (ip: string) => ({ 'X-Trim-BFF-Key': secret, 'X-Trim-Client-IP': ip });

    // two visitors behind the same BFF have separate buckets
    const a = [(await contact(ctx, asVisitor('203.0.113.10'))).status, (await contact(ctx, asVisitor('203.0.113.10'))).status, (await contact(ctx, asVisitor('203.0.113.10'))).status];
    expect(a).toEqual([201, 201, 429]);
    const b = [(await contact(ctx, asVisitor('203.0.113.11'))).status, (await contact(ctx, asVisitor('2001:db8::5'))).status];
    expect(b).toEqual([201, 201]);
    expect((await contact(ctx, asVisitor('203.0.113.10'))).headers.get('retry-after')).toBeTruthy();

    // wrong key: the spoofed address is ignored, everything lands in the real socket IP's bucket
    const wrong = [];
    for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) wrong.push((await contact(ctx, { 'X-Trim-BFF-Key': `${secret}x`, 'X-Trim-Client-IP': ip })).status);
    expect(wrong).toEqual([201, 201, 429]);
  });

  it('headers without the key are ignored; an invalid IP with a valid key falls back to the real address', async () => {
    const ctx = await boot({ BFF_SHARED_SECRET: secret, RATE_LIMIT_CONTACT_PER_HOUR: '2' });
    const spoof = [];
    for (const ip of ['192.0.2.1', '192.0.2.2', '192.0.2.3']) spoof.push((await contact(ctx, { 'X-Trim-Client-IP': ip })).status);
    expect(spoof).toEqual([201, 201, 429]);

    const ctx2 = await boot({ BFF_SHARED_SECRET: secret, RATE_LIMIT_CONTACT_PER_HOUR: '2' });
    const bad = [];
    for (const ip of ['not-an-ip', '1.2.3.4, 5.6.7.8', '1.2.3.4:80']) bad.push((await contact(ctx2, { 'X-Trim-BFF-Key': secret, 'X-Trim-Client-IP': ip })).status);
    expect(bad).toEqual([201, 201, 429]);
  });

  it('without BFF_SHARED_SECRET configured the headers never count; the audit log records the BFF client IP', async () => {
    const ctx = await boot({ RATE_LIMIT_CONTACT_PER_HOUR: '2' });
    const r = [];
    for (const ip of ['192.0.2.1', '192.0.2.2', '192.0.2.3']) r.push((await contact(ctx, { 'X-Trim-BFF-Key': secret, 'X-Trim-Client-IP': ip })).status);
    expect(r).toEqual([201, 201, 429]);

    const ctx2 = await boot({ BFF_SHARED_SECRET: secret });
    const reg = await call(ctx2, 'POST', '/v1/auth/register-owner', {
      headers: { 'X-Trim-BFF-Key': secret, 'X-Trim-Client-IP': '203.0.113.77' },
      body: { fullName: 'Bff Owner', phone: phone(), email: `bff-${randomUUID()}@example.test`, password: PASSWORD, salon: { name: 'Bff Salon' } },
    });
    expect(reg.status).toBe(201);
    const audit = await ctx2.pool.query("SELECT ip FROM audit_log WHERE action = 'salon.registered' ORDER BY id DESC LIMIT 1");
    expect(audit.rows[0].ip).toBe('203.0.113.77');
  });

  it('config: secret must be >= 24 chars when set', () => {
    const base = { DATABASE_URL: 'x', JWT_SECRET: 'j'.repeat(32), QR_SECRET: 'q'.repeat(32) };
    expect(() => loadConfig({ ...base, BFF_SHARED_SECRET: 'short' })).toThrow(/BFF_SHARED_SECRET/);
    expect(loadConfig({ ...base, BFF_SHARED_SECRET: secret }).bffSharedSecret).toBe(secret);
    expect(loadConfig(base).bffSharedSecret).toBe('');
  });
});

describe('D-02 NUL bytes are a validation error, never a 500', () => {
  it('in path, query and JSON bodies', async () => {
    const ctx = await boot();
    const o = await makeOwner(ctx);
    const checks: [string, string, string, unknown?, string?][] = [
      ['GET', '/v1/invites/%00', '', undefined],
      ['GET', '/v1/discover/salons?q=%00', '', undefined],
      ['GET', `/v1/salons/${o.salonId}/invoices?q=%00`, o.token, undefined],
      ['GET', '/v1/hairstyles/%00', '', undefined],
      ['POST', '/v1/auth/register', '', { fullName: 'a\u0000b', email: `n-${randomUUID()}@example.test`, password: PASSWORD }],
      ['POST', '/v1/auth/login', '', { identifier: 'x\u0000y', password: 'whatever1', client: 'website' }],
      ['POST', '/v1/contact', '', { name: 'n', email: 'a@b.co', message: 'hi\u0000there' }],
      ['POST', `/v1/salons/${o.salonId}/services`, o.token, { category: 'Hair', name: 'Cut\u0000', durationMin: 30, pricePaise: 100 }],
      ['POST', `/v1/salons/${o.salonId}/services`, o.token, { category: 'Hair', name: 'ok', durationMin: 30, pricePaise: 100, description: { nested: ['x\u0000'] } }],
    ];
    for (const [method, path, token, body] of checks) {
      const r = await call(ctx, method, path, { token: token || undefined, body });
      expect(r.status, `${method} ${path}`).toBe(422);
      expect(r.body.error.code).toBe('VALIDATION_FAILED');
    }
    // double-encoded text is just text
    expect((await call(ctx, 'GET', '/v1/discover/salons?q=%2500')).status).toBe(200);
  });
});

describe('D-03 account lockout carries Retry-After', () => {
  it('429 has the header and details.retryAfterSec', async () => {
    const ctx = await boot();
    const c = await makeCustomer(ctx);
    for (let i = 0; i < 5; i++) await call(ctx, 'POST', '/v1/auth/login', { body: { identifier: c.email, password: 'Wrong1234', client: 'customer_app' } });
    const r = await call(ctx, 'POST', '/v1/auth/login', { body: { identifier: c.email, password: PASSWORD, client: 'customer_app' } });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('RATE_LIMITED');
    const ra = Number(r.headers.get('retry-after'));
    expect(ra).toBeGreaterThan(800);
    expect(ra).toBeLessThanOrEqual(900);
    expect(r.body.error.details.retryAfterSec).toBe(ra);
    expect(r.body.error.details.lockedUntil).toBeTruthy();
  });
});

describe('D-04 webhook worker throughput', () => {
  it('20 queued events drain in a few seconds, each applied exactly once', async () => {
    const ctx = await boot({ QUEUE_DRIVER: 'pgboss' });
    await ctx.deps.queue.start(true);
    const o = await makeOwner(ctx);
    await ctx.pool.query("UPDATE plans SET razorpay_plan_id_monthly = 'plan_pro_m' WHERE code = 'pro'");
    const co = await call(ctx, 'POST', `/v1/salons/${o.salonId}/subscription/checkout`, { token: o.token, body: { planCode: 'pro', interval: 'monthly' } });
    const subId = co.body.data.razorpaySubscriptionId as string;
    const T = Math.floor(Date.now() / 1000);
    const ids = Array.from({ length: 20 }, () => randomUUID());
    const post = (id: string, i: number) => {
      const raw = JSON.stringify({
        event: 'subscription.authenticated', created_at: T + i,
        payload: { subscription: { entity: { id: subId, plan_id: 'plan_pro_m', charge_at: T + 86400, notes: { app: 'trim', salonId: o.salonId } } } },
      });
      return call(ctx, 'POST', '/v1/webhooks/razorpay', { raw, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': sign(ctx, raw), 'X-Razorpay-Event-Id': id } });
    };
    const t0 = Date.now();
    const acks = await Promise.all(ids.map((id, i) => post(id, i)));
    expect(acks.every((a) => a.status === 200 && a.body.data.result === 'queued')).toBe(true);
    // replays of the same ids while they are in flight must not create second applications
    await Promise.all(ids.slice(0, 5).map((id, i) => post(id, i)));
    let done = 0;
    while (Date.now() - t0 < 15_000) {
      done = (await ctx.pool.query('SELECT count(*)::int AS n FROM subscription_events WHERE processed_at IS NOT NULL AND razorpay_event_id = ANY($1)', [ids])).rows[0].n;
      if (done === 20) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const elapsed = (Date.now() - t0) / 1000;
    expect(done).toBe(20);
    expect(elapsed).toBeLessThan(10); // was ~40 s with one job per 2 s poll
    const rows = await ctx.pool.query('SELECT attempts, result FROM subscription_events WHERE razorpay_event_id = ANY($1)', [ids]);
    expect(rows.rows.every((r) => r.attempts === 1)).toBe(true);
    const sub = (await ctx.pool.query('SELECT payment_authorized_at FROM subscriptions WHERE salon_id = $1', [o.salonId])).rows[0];
    expect(sub.payment_authorized_at).toBeTruthy();
  }, 60_000);
});

describe('D-05 /metrics', () => {
  it('production config requires METRICS_TOKEN (or metrics off); token via Bearer or X-Metrics-Token', async () => {
    const base = { NODE_ENV: 'production', DATABASE_URL: 'x', JWT_SECRET: 'j'.repeat(32), QR_SECRET: 'q'.repeat(32), RAZORPAY_KEY_ID: 'a', RAZORPAY_KEY_SECRET: 'b', RAZORPAY_WEBHOOK_SECRET: 'c', CORS_ORIGINS: 'https://x.test' };
    expect(() => loadConfig(base)).toThrow(/METRICS_TOKEN/);
    expect(() => loadConfig({ ...base, METRICS_ENABLED: 'false' })).not.toThrow();
    expect(() => loadConfig({ ...base, METRICS_TOKEN: 'm'.repeat(20) })).not.toThrow();

    const token = randomBytes(12).toString('hex');
    const ctx = await boot({ METRICS_TOKEN: token });
    expect((await call(ctx, 'GET', '/metrics')).status).toBe(401);
    expect((await fetch(`${ctx.base}/metrics`, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await fetch(`${ctx.base}/metrics`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await fetch(`${ctx.base}/metrics`, { headers: { 'X-Metrics-Token': token } })).status).toBe(200);
    const open = await boot(); // dev/test default: open
    expect((await fetch(`${open.base}/metrics`)).status).toBe(200);
  });
});

describe('provider failures and routing niceties', () => {
  it('checkout/cancel provider failure is a 502 UPSTREAM_ERROR without internals', async () => {
    const ctx = await boot();
    const o = await makeOwner(ctx);
    await ctx.pool.query("UPDATE plans SET razorpay_plan_id_monthly = 'plan_pro_m' WHERE code = 'pro'");
    ctx.gateway.createSubscription = async () => {
      throw new Error('secret-internal-detail rzp_test_key');
    };
    const r = await call(ctx, 'POST', `/v1/salons/${o.salonId}/subscription/checkout`, { token: o.token, body: { planCode: 'pro', interval: 'monthly' } });
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('UPSTREAM_ERROR');
    expect(r.body.error.reason).toBe('PAYMENT_PROVIDER');
    expect(JSON.stringify(r.body)).not.toContain('secret-internal-detail');
  });

  it('wrong method on a known path is 405 with Allow', async () => {
    const ctx = await boot();
    const r = await call(ctx, 'DELETE', '/v1/plans');
    expect(r.status).toBe(405);
    expect(r.body.error.code).toBe('METHOD_NOT_ALLOWED');
    expect(r.headers.get('allow')).toContain('GET');
    expect((await call(ctx, 'GET', '/v1/nope')).status).toBe(404);
  });
});

describe('UTF-8 end to end (embedded Postgres is initialised with UTF8)', () => {
  it('stores and finds Hindi, accented and emoji text', async () => {
    const ctx = await boot();
    const enc = await ctx.pool.query('SHOW server_encoding');
    expect(enc.rows[0].server_encoding).toBe('UTF8');
    const name = 'राहुल 😀 Ünï';
    const reg = await call(ctx, 'POST', '/v1/auth/register', { body: { fullName: name, email: `u-${randomUUID()}@example.test`, password: PASSWORD } });
    expect(reg.status).toBe(201);
    expect(reg.body.data.user.fullName).toBe(name);
    const me = await call(ctx, 'GET', '/v1/me', { token: reg.body.data.accessToken });
    expect(me.body.data.user.fullName).toBe(name);

    const o = await makeOwner(ctx, { name: 'सलून Café 💈' });
    const found = await call(ctx, 'GET', `/v1/discover/salons?q=${encodeURIComponent('सलून')}`);
    expect(found.body.data.map((s: any) => s.id)).toContain(o.salonId);
    const found2 = await call(ctx, 'GET', `/v1/discover/salons?q=${encodeURIComponent('Café')}`);
    expect(found2.body.data.map((s: any) => s.id)).toContain(o.salonId);

    const msg = 'नमस्ते, मुझे मदद चाहिए 🙏 — مرحبا';
    expect((await call(ctx, 'POST', '/v1/contact', { body: { name: 'ग्राहक', email: 'u@example.test', message: msg } })).status).toBe(201);
    const row = await ctx.pool.query("SELECT message FROM contact_messages WHERE name = 'ग्राहक'");
    expect(row.rows[0].message).toBe(msg);
    const svc = await call(ctx, 'POST', `/v1/salons/${o.salonId}/services`, { token: o.token, body: { category: 'बाल', name: 'दाढ़ी ट्रिम ✂️', durationMin: 15, pricePaise: 5000 } });
    expect(svc.body.data.name).toBe('दाढ़ी ट्रिम ✂️');
  });
});

describe('round 4: hot slot with a tiny pool, and DB saturation is a 503', () => {
  it('30 parallel holds on one slot with a pool of 3: one 201, 29 x 409 SLOT_TAKEN with alternatives, no 5xx', async () => {
    const ctx = await boot({ DB_POOL_MAX: '3' });
    const o = await makeOwner(ctx);
    const customers = await Promise.all(Array.from({ length: 30 }, () => makeCustomer(ctx)));
    const startsAt = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 11) + '05:00:00.000Z'; // 10:30 IST, inside default hours
    const t0 = Date.now();
    const rs = await Promise.all(customers.map((c) => call(ctx, 'POST', '/v1/bookings/hold', { token: c.token, body: { salonId: o.salonId, staffId: o.staffId, serviceIds: [o.serviceId], startsAt } })));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    const losers = rs.filter((r) => r.status !== 201);
    expect(losers.every((r) => r.status === 409 && r.body.error.code === 'SLOT_TAKEN')).toBe(true);
    expect(losers[0]!.body.error.details.alternatives.length).toBeGreaterThan(0);
    expect(Date.now() - t0).toBeLessThan(10_000);
    const { findOverlaps } = await import('../src/lib/invariants.js');
    expect(await findOverlaps(ctx.pool)).toEqual([]);
  }, 60_000);

  it('a pool-acquire / statement timeout surfaces as 503 OVERLOADED with Retry-After, never 500', async () => {
    const ctx = await boot();
    const orig = ctx.pool.query.bind(ctx.pool);
    (ctx.pool as any).query = async () => {
      throw new Error('timeout exceeded when trying to connect');
    };
    const r = await call(ctx, 'GET', '/v1/plans');
    (ctx.pool as any).query = orig;
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('OVERLOADED');
    expect(r.headers.get('retry-after')).toBeTruthy();
  });
});
