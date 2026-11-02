import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/logger.js';
import { call, makeCustomer, makeOwner, PASSWORD, phone, slotAt, startCtx, type Ctx, type Owner } from './helpers.js';

let ctx: Ctx;
let owner: Owner;
beforeAll(async () => {
  ctx = await startCtx();
  owner = await makeOwner(ctx);
});
afterAll(() => ctx.close());

// 1x1 transparent PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('auth', () => {
  it('lockout after 5 failures, then even the right password is refused', async () => {
    const o = await makeOwner(ctx);
    for (let i = 0; i < 5; i++) {
      const r = await call(ctx, 'POST', '/v1/auth/login', { body: { identifier: o.email, password: 'Wrong1234', client: 'website' } });
      expect(r.status).toBe(401);
    }
    const locked = await call(ctx, 'POST', '/v1/auth/login', { body: { identifier: o.email, password: PASSWORD, client: 'website' } });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('RATE_LIMITED');
  });

  it('refresh rotates; reusing an old refresh token revokes the whole family', async () => {
    const o = await makeOwner(ctx);
    const l = await call(ctx, 'POST', '/v1/auth/login', { body: { identifier: o.email, password: PASSWORD, client: 'website' } });
    const r1 = l.body.data.refreshToken;
    const a = await call(ctx, 'POST', '/v1/auth/refresh', { body: { refreshToken: r1 } });
    expect(a.status).toBe(200);
    expect(a.body.data.refreshToken).not.toBe(r1);
    const reuse = await call(ctx, 'POST', '/v1/auth/refresh', { body: { refreshToken: r1 } });
    expect(reuse.status).toBe(401);
    const afterFamilyKill = await call(ctx, 'POST', '/v1/auth/refresh', { body: { refreshToken: a.body.data.refreshToken } });
    expect(afterFamilyKill.status).toBe(401);
    const me = await call(ctx, 'GET', '/v1/me', { token: a.body.data.accessToken });
    expect(me.status).toBe(401);
  });

  it('logout revokes the session immediately; change-password works', async () => {
    const c = await makeCustomer(ctx);
    expect((await call(ctx, 'GET', '/v1/me', { token: c.token })).status).toBe(200);
    const bad = await call(ctx, 'POST', '/v1/auth/change-password', { token: c.token, body: { currentPassword: 'nope1234', newPassword: 'Another123' } });
    expect(bad.status).toBe(401);
    const weak = await call(ctx, 'POST', '/v1/auth/change-password', { token: c.token, body: { currentPassword: PASSWORD, newPassword: 'short' } });
    expect(weak.status).toBe(422);
    expect((await call(ctx, 'POST', '/v1/auth/change-password', { token: c.token, body: { currentPassword: PASSWORD, newPassword: 'Another123' } })).status).toBe(200);
    expect((await call(ctx, 'POST', '/v1/auth/logout', { token: c.token })).status).toBe(200);
    expect((await call(ctx, 'GET', '/v1/me', { token: c.token })).status).toBe(401);
    expect((await call(ctx, 'POST', '/v1/auth/login', { body: { identifier: c.email, password: 'Another123', client: 'customer_app' } })).status).toBe(200);
  });

  it('registration validation: duplicate email, bad phone, weak password, missing contact', async () => {
    const c = await makeCustomer(ctx);
    const dup = await call(ctx, 'POST', '/v1/auth/register', { body: { fullName: 'X', email: c.email, password: PASSWORD } });
    expect(dup.status).toBe(409);
    expect((await call(ctx, 'POST', '/v1/auth/register', { body: { fullName: 'X', phone: '12345', password: PASSWORD } })).status).toBe(422);
    expect((await call(ctx, 'POST', '/v1/auth/register', { body: { fullName: 'X', email: 'a@b.co', password: 'abcdefgh' } })).status).toBe(422);
    expect((await call(ctx, 'POST', '/v1/auth/register', { body: { fullName: 'X', password: PASSWORD } })).status).toBe(422);
    const byPhone = phone();
    expect((await call(ctx, 'POST', '/v1/auth/register', { body: { fullName: 'P', phone: byPhone, password: PASSWORD } })).status).toBe(201);
    expect((await call(ctx, 'POST', '/v1/auth/login', { body: { identifier: byPhone.slice(3), password: PASSWORD, client: 'customer_app' } })).status).toBe(200);
  });

  it('desktop login needs the desktop_access entitlement (Pro)', async () => {
    const o = await makeOwner(ctx);
    const ok = await call(ctx, 'POST', '/v1/auth/login', { body: { identifier: o.email, password: PASSWORD, client: 'desktop' } });
    expect(ok.status).toBe(200); // trial = Pro level
    await ctx.pool.query("UPDATE subscriptions SET status = 'active', plan_code = 'starter', trial_ends_at = NULL WHERE salon_id = $1", [o.salonId]);
    const no = await call(ctx, 'POST', '/v1/auth/login', { body: { identifier: o.email, password: PASSWORD, client: 'desktop' } });
    expect(no.status).toBe(403);
    expect(no.body.error.code).toBe('PLAN_LIMIT');
    expect(no.body.error.details.limit).toBe('desktop_access');
  });

  it('login rate limit: 429 RATE_LIMITED per IP+identifier', async () => {
    const limited = await startCtx({ RATE_LIMIT_LOGIN_PER_15MIN: '3' });
    try {
      let last = 0;
      for (let i = 0; i < 5; i++) {
        last = (await call(limited, 'POST', '/v1/auth/login', { body: { identifier: 'nobody@example.test', password: 'Whatever1', client: 'website' } })).status;
      }
      expect(last).toBe(429);
    } finally {
      await limited.close();
    }
  });

  it('DELETE /me anonymises a customer', async () => {
    const c = await makeCustomer(ctx);
    expect((await call(ctx, 'DELETE', '/v1/me', { token: c.token })).status).toBe(200);
    expect((await call(ctx, 'GET', '/v1/me', { token: c.token })).status).toBe(401);
    const u = await ctx.pool.query('SELECT full_name, phone_e164, is_active FROM users WHERE id = $1', [c.userId]);
    expect(u.rows[0]).toMatchObject({ full_name: 'Deleted user', phone_e164: null, is_active: false });
  });
});

describe('RBAC and roles', () => {
  it('customers cannot reach salon routes; members of other salons get 403', async () => {
    const c = await makeCustomer(ctx);
    expect((await call(ctx, 'GET', `/v1/salons/${owner.salonId}/staff`, { token: c.token })).status).toBe(403);
    const other = await makeOwner(ctx);
    expect((await call(ctx, 'GET', `/v1/salons/${owner.salonId}/staff`, { token: other.token })).status).toBe(403);
    expect((await call(ctx, 'GET', `/v1/salons/${owner.salonId}/staff`)).status).toBe(401);
    expect((await call(ctx, 'GET', '/v1/admin/stats', { token: owner.token })).status).toBe(403);
    expect((await call(ctx, 'POST', '/v1/bookings/hold', { token: owner.token, body: {} })).status).toBe(403); // customer-only
  });

  it('receptionist can bill but not void; stylist cannot view invoices', async () => {
    const mk = async (role: string) => {
      const email = `${role}-${randomUUID()}@example.test`;
      const r = await call(ctx, 'POST', `/v1/salons/${owner.salonId}/staff`, { token: owner.token, body: { fullName: role, email, tempPassword: PASSWORD, roleId: owner.roleIds[role] } });
      expect(r.status).toBe(201);
      const l = await call(ctx, 'POST', '/v1/auth/login', { body: { identifier: email, password: PASSWORD, client: 'salon_app' } });
      expect(l.body.data.user.mustChangePassword).toBe(true);
      return l.body.data.accessToken as string;
    };
    const rec = await mk('receptionist');
    const sty = await mk('stylist');
    const bill = await call(ctx, 'POST', `/v1/salons/${owner.salonId}/invoices`, { token: rec, body: { customerName: 'A', items: [{ name: 'x', qty: 1, unitPricePaise: 500 }], payments: [{ methodCode: 'cash', amountPaise: 500 }] } });
    expect(bill.status).toBe(201);
    expect((await call(ctx, 'POST', `/v1/salons/${owner.salonId}/invoices/${bill.body.data.id}/void`, { token: rec, body: { reason: 'x' } })).status).toBe(403);
    expect((await call(ctx, 'GET', `/v1/salons/${owner.salonId}/invoices`, { token: sty })).status).toBe(403);
    expect((await call(ctx, 'GET', `/v1/salons/${owner.salonId}/bookings`, { token: sty })).status).toBe(200);
    expect((await call(ctx, 'POST', `/v1/salons/${owner.salonId}/staff`, { token: rec, body: {} })).status).toBe(403);
  });

  it('the last active owner cannot be deactivated or demoted', async () => {
    const o = await makeOwner(ctx);
    const d = await call(ctx, 'POST', `/v1/salons/${o.salonId}/staff/${o.staffId}/deactivate`, { token: o.token });
    expect(d.status).toBe(409);
    expect(d.body.error.reason).toBe('LAST_OWNER');
    const demote = await call(ctx, 'PATCH', `/v1/salons/${o.salonId}/staff/${o.staffId}`, { token: o.token, body: { roleId: o.roleIds['manager'] } });
    expect(demote.status).toBe(409);
  });

  it('custom roles: Pro can create, Starter gets PLAN_LIMIT', async () => {
    const o = await makeOwner(ctx);
    const created = await call(ctx, 'POST', `/v1/salons/${o.salonId}/roles`, { token: o.token, body: { name: 'Junior', permissions: ['booking.view'] } });
    expect(created.status).toBe(201);
    expect(created.body.data.permissions).toEqual(['booking.view']);
    const bad = await call(ctx, 'POST', `/v1/salons/${o.salonId}/roles`, { token: o.token, body: { name: 'X', permissions: ['not.a.permission'] } });
    expect(bad.status).toBe(422);
    await ctx.pool.query("UPDATE subscriptions SET status = 'active', plan_code = 'starter', trial_ends_at = NULL WHERE salon_id = $1", [o.salonId]);
    const starter = await call(ctx, 'POST', `/v1/salons/${o.salonId}/roles`, { token: o.token, body: { name: 'Other', permissions: [] } });
    expect(starter.status).toBe(403);
    expect(starter.body.error.code).toBe('PLAN_LIMIT');
    const edit = await call(ctx, 'PATCH', `/v1/salons/${o.salonId}/roles/${o.roleIds['manager']}`, { token: o.token, body: { permissions: ['booking.view'] } });
    expect(edit.body.error.code).toBe('PLAN_LIMIT');
    const delSys = await call(ctx, 'DELETE', `/v1/salons/${o.salonId}/roles/${o.roleIds['manager']}`, { token: o.token });
    expect(delSys.status).toBe(403);
  });

  it('subscription endpoints are owner-only', async () => {
    const email = `mgr-${randomUUID()}@example.test`;
    await call(ctx, 'POST', `/v1/salons/${owner.salonId}/staff`, { token: owner.token, body: { fullName: 'Mgr', email, tempPassword: PASSWORD, roleId: owner.roleIds['manager'] } });
    const l = await call(ctx, 'POST', '/v1/auth/login', { body: { identifier: email, password: PASSWORD, client: 'salon_app' } });
    expect((await call(ctx, 'GET', `/v1/salons/${owner.salonId}/subscription`, { token: l.body.data.accessToken })).status).toBe(403);
    const mine = await call(ctx, 'GET', `/v1/salons/${owner.salonId}/subscription`, { token: owner.token });
    expect(mine.status).toBe(200);
    expect(mine.body.data.status).toBe('trialing');
    expect(mine.body.data.usage.activeStaff).toBeGreaterThanOrEqual(1);
  });
});

describe('media', () => {
  it('accepts a real PNG, serves it with ETag/304, enforces magic bytes, mime match and size', async () => {
    const up = await call(ctx, 'POST', '/v1/media', { token: owner.token, body: { kind: 'logo', mime: 'image/png', dataBase64: PNG, salonId: owner.salonId } });
    expect(up.status).toBe(201);
    const id = up.body.data.id;
    const get = await fetch(`${ctx.base}/v1/media/${id}`);
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('image/png');
    expect(get.headers.get('cache-control')).toContain('public');
    const etag = get.headers.get('etag')!;
    expect(etag).toBeTruthy();
    expect((await get.arrayBuffer()).byteLength).toBe(Buffer.from(PNG, 'base64').length);
    const nm = await fetch(`${ctx.base}/v1/media/${id}`, { headers: { 'If-None-Match': etag } });
    expect(nm.status).toBe(304);

    const fake = await call(ctx, 'POST', '/v1/media', { token: owner.token, body: { kind: 'logo', mime: 'image/png', dataBase64: Buffer.from('<svg></svg> not an image').toString('base64'), salonId: owner.salonId } });
    expect(fake.status).toBe(422);
    const wrongMime = await call(ctx, 'POST', '/v1/media', { token: owner.token, body: { kind: 'logo', mime: 'image/jpeg', dataBase64: PNG, salonId: owner.salonId } });
    expect(wrongMime.status).toBe(422);
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(205_000, 1)]).toString('base64');
    const tooBig = await call(ctx, 'POST', '/v1/media', { token: owner.token, body: { kind: 'logo', mime: 'image/jpeg', dataBase64: big, salonId: owner.salonId } });
    expect(tooBig.status).toBe(422);

    const c = await makeCustomer(ctx);
    expect((await call(ctx, 'POST', '/v1/media', { token: c.token, body: { kind: 'logo', mime: 'image/png', dataBase64: PNG, salonId: owner.salonId } })).status).toBe(403);
    const av = await call(ctx, 'POST', '/v1/media', { token: c.token, body: { kind: 'avatar', mime: 'image/png', dataBase64: PNG } });
    expect(av.status).toBe(201);
    expect((await fetch(`${ctx.base}/v1/media/${av.body.data.id}`)).status).toBe(401); // avatars need auth
    const withAuth = await fetch(`${ctx.base}/v1/media/${av.body.data.id}`, { headers: { Authorization: `Bearer ${c.token}` } });
    expect(withAuth.status).toBe(200);
    const patch = await call(ctx, 'PATCH', '/v1/me', { token: c.token, body: { avatarMediaId: av.body.data.id } });
    expect(patch.body.data.avatarMediaId).toBe(av.body.data.id);
    // list endpoints never leak base64
    const sal = await call(ctx, 'PATCH', `/v1/salons/${owner.salonId}`, { token: owner.token, body: { logoMediaId: id } });
    expect(JSON.stringify(sal.body)).not.toContain(PNG);
  });
});

describe('public endpoints', () => {
  it('plans are public with the seeded prices', async () => {
    const r = await call(ctx, 'GET', '/v1/plans');
    expect(r.status).toBe(200);
    const byCode = Object.fromEntries(r.body.data.map((p: any) => [p.code, p]));
    expect(byCode.starter).toMatchObject({ priceMonthlyPaise: 59900, priceAnnualPaise: 599900, maxStaff: 3, analyticsLevel: 'basic', desktopAccess: false });
    expect(byCode.pro).toMatchObject({ priceMonthlyPaise: 129900, priceAnnualPaise: 1299900, maxStaff: null, analyticsLevel: 'full', csvExport: true });
  });

  it('contact form stores real messages and silently drops honeypot hits', async () => {
    const ok = await call(ctx, 'POST', '/v1/contact', { body: { name: 'Real Person', email: 'real@example.test', message: 'Hello Trim team' } });
    expect(ok.status).toBe(201);
    const bot = await call(ctx, 'POST', '/v1/contact', { body: { name: 'Bot', email: 'bot@example.test', message: 'buy pills now', website: 'http://spam.test' } });
    expect(bot.status).toBe(201);
    const rows = await ctx.pool.query("SELECT name FROM contact_messages WHERE email IN ('real@example.test','bot@example.test')");
    expect(rows.rows.map((r) => r.name)).toEqual(['Real Person']);
    expect((await call(ctx, 'POST', '/v1/contact', { body: { name: 'x', email: 'bad', message: 'hi there' } })).status).toBe(422);
  });

  it('hairstyle catalog is seeded: >= 60 styles covering all shapes and audiences, filterable', async () => {
    const all = await call(ctx, 'GET', '/v1/hairstyles');
    expect(all.body.data.length).toBeGreaterThanOrEqual(60);
    const shapes = new Set(all.body.data.flatMap((h: any) => h.faceShapes));
    expect([...shapes].sort()).toEqual(['Heart', 'Oblong', 'Oval', 'Round', 'Square']);
    expect(new Set(all.body.data.map((h: any) => h.audience))).toEqual(new Set(['men', 'women', 'unisex']));
    const men = await call(ctx, 'GET', '/v1/hairstyles?faceShape=round&audience=men');
    expect(men.body.data.length).toBeGreaterThan(3);
    expect(men.body.data.every((h: any) => h.faceShapes.includes('Round') && h.audience !== 'women')).toBe(true);
    expect((await call(ctx, 'GET', '/v1/hairstyles?faceShape=Triangle')).status).toBe(422);
    const one = await call(ctx, 'GET', `/v1/hairstyles/${all.body.data[0].id}`);
    expect(one.body.data.serviceTemplateIds.length).toBeGreaterThan(0);
    const t = await call(ctx, 'GET', '/v1/service-templates', { token: owner.token });
    expect(t.body.data.length).toBeGreaterThanOrEqual(30);
    expect((await call(ctx, 'GET', '/v1/service-templates')).status).toBe(401);
  });

  it('discover: haversine distance sorting, radius filter, unapproved salons hidden', async () => {
    const pune = await makeOwner(ctx, { lat: 18.5204, lng: 73.8567, name: 'Near Pune Salon' });
    const mumbai = await makeOwner(ctx, { lat: 19.076, lng: 72.8777, name: 'Mumbai Salon' });
    const hidden = await makeOwner(ctx, { lat: 18.52, lng: 73.85, approve: false, name: 'Hidden Pending' });
    const r = await call(ctx, 'GET', '/v1/discover/salons?lat=18.5204&lng=73.8567&radiusKm=200&limit=100');
    const ids = r.body.data.map((s: any) => s.id);
    expect(ids).not.toContain(hidden.salonId);
    expect(ids.indexOf(pune.salonId)).toBeLessThan(ids.indexOf(mumbai.salonId));
    const p = r.body.data.find((s: any) => s.id === pune.salonId);
    const m = r.body.data.find((s: any) => s.id === mumbai.salonId);
    expect(p.distanceKm).toBeLessThan(0.2);
    expect(m.distanceKm).toBeGreaterThan(115);
    expect(m.distanceKm).toBeLessThan(125); // Pune-Mumbai ~120 km great-circle
    const near = await call(ctx, 'GET', '/v1/discover/salons?lat=18.5204&lng=73.8567&radiusKm=20&limit=100');
    expect(near.body.data.map((s: any) => s.id)).not.toContain(mumbai.salonId);
    const q = await call(ctx, 'GET', '/v1/discover/salons?q=Mumbai%20Salon');
    expect(q.body.data.map((s: any) => s.id)).toContain(mumbai.salonId);
    expect((await call(ctx, 'GET', '/v1/discover/salons?lat=18')).status).toBe(422);
    expect((await call(ctx, 'GET', `/v1/discover/salons/${hidden.salonId}`)).status).toBe(404);
    const page1 = await call(ctx, 'GET', '/v1/discover/salons?sort=rating&limit=1');
    expect(page1.body.meta.nextCursor).toBeTruthy();
    const page2 = await call(ctx, 'GET', `/v1/discover/salons?sort=rating&limit=1&cursor=${page1.body.meta.nextCursor}`);
    expect(page2.body.data[0].id).not.toBe(page1.body.data[0].id);
  });
});

describe('analytics and CSV', () => {
  it('basic vs full by plan; CSV only on Pro and formula-safe', async () => {
    const o = await makeOwner(ctx);
    await call(ctx, 'POST', `/v1/salons/${o.salonId}/invoices`, {
      token: o.token,
      body: { customerName: '=HYPERLINK("x")', items: [{ name: 'Cut', qty: 1, unitPricePaise: 25000 }], payments: [{ methodCode: 'upi', amountPaise: 25000 }] },
    });
    const full = await call(ctx, 'GET', `/v1/salons/${o.salonId}/analytics/summary`, { token: o.token });
    expect(full.body.data.level).toBe('full');
    expect(full.body.data.totals.revenuePaise).toBe(25000);
    expect(full.body.data.byService[0]).toMatchObject({ name: 'Cut', qty: 1, revenuePaise: 25000 });
    expect(full.body.data.dailySeries.length).toBe(30);
    expect(full.body.data).toHaveProperty('hourlyHeatMap');
    expect(full.body.data).toHaveProperty('repeatCustomers');

    const csv = await call(ctx, 'GET', `/v1/salons/${o.salonId}/analytics/export.csv`, { token: o.token });
    expect(csv.status).toBe(200);
    expect(csv.body).toContain("'=HYPERLINK");
    expect(csv.body.split('\r\n')[0]).toContain('invoice_no');

    await ctx.pool.query("UPDATE subscriptions SET status = 'active', plan_code = 'starter', trial_ends_at = NULL WHERE salon_id = $1", [o.salonId]);
    const basic = await call(ctx, 'GET', `/v1/salons/${o.salonId}/analytics/summary`, { token: o.token });
    expect(basic.body.data.level).toBe('basic');
    expect(basic.body.data.totals.revenuePaise).toBe(25000);
    expect(basic.body.data.byService).toBeUndefined();
    const noCsv = await call(ctx, 'GET', `/v1/salons/${o.salonId}/analytics/export.csv`, { token: o.token });
    expect(noCsv.status).toBe(403);
    expect(noCsv.body.error.code).toBe('PLAN_LIMIT');
    expect((await call(ctx, 'GET', `/v1/salons/${o.salonId}/analytics/summary?from=2026-02-01&to=2025-01-01`, { token: o.token })).status).toBe(422);
  });
});

describe('closures, time off and availability', () => {
  it('closure days and staff time off remove slots; holds on them are refused', async () => {
    const o = await makeOwner(ctx);
    const day = slotAt(4, '00:00').slice(0, 10);
    const dateLocal = (iso: string) => new Date(new Date(iso).getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
    const date = dateLocal(slotAt(4, '11:00'));
    const avail = () => call(ctx, 'GET', `/v1/salons/${o.salonId}/availability?serviceIds=${o.serviceId}&date=${date}`);
    expect((await avail()).body.data.slots.length).toBeGreaterThan(0);
    const off = await call(ctx, 'POST', `/v1/salons/${o.salonId}/staff/${o.staffId}/time-off`, { token: o.token, body: { from: slotAt(4, '10:00'), to: slotAt(4, '20:00') } });
    expect(off.status).toBe(201);
    expect((await avail()).body.data.slots).toEqual([]);
    const c = await makeCustomer(ctx);
    const h = await call(ctx, 'POST', '/v1/bookings/hold', { token: c.token, body: { salonId: o.salonId, staffId: o.staffId, serviceIds: [o.serviceId], startsAt: slotAt(4, '11:00') } });
    expect(h.status).toBe(409);
    await call(ctx, 'DELETE', `/v1/salons/${o.salonId}/staff/${o.staffId}/time-off/${off.body.data.id}`, { token: o.token });
    expect((await avail()).body.data.slots.length).toBeGreaterThan(0);
    expect((await call(ctx, 'POST', `/v1/salons/${o.salonId}/closures`, { token: o.token, body: { date, reason: 'Holiday' } })).status).toBe(201);
    expect((await avail()).body.data.slots).toEqual([]);
    const out = await call(ctx, 'POST', '/v1/bookings/hold', { token: c.token, body: { salonId: o.salonId, staffId: o.staffId, serviceIds: [o.serviceId], startsAt: slotAt(4, '11:00') } });
    expect(out.status).toBe(422);
    void day;
  });

  it('rejects past dates, >60 days ahead, bad ranges and unknown services', async () => {
    const c = await makeCustomer(ctx);
    const b = { salonId: owner.salonId, staffId: owner.staffId, serviceIds: [owner.serviceId] };
    expect((await call(ctx, 'POST', '/v1/bookings/hold', { token: c.token, body: { ...b, startsAt: new Date(Date.now() - 3600_000).toISOString() } })).status).toBe(422);
    expect((await call(ctx, 'POST', '/v1/bookings/hold', { token: c.token, body: { ...b, startsAt: slotAt(61, '11:00') } })).status).toBe(422);
    expect((await call(ctx, 'POST', '/v1/bookings/hold', { token: c.token, body: { ...b, startsAt: slotAt(2, '11:00'), serviceIds: [randomUUID()] } })).status).toBe(422);
    expect((await call(ctx, 'GET', `/v1/salons/${owner.salonId}/availability?serviceIds=${owner.serviceId}&date=2020-01-01`)).status).toBe(422);
    expect((await call(ctx, 'GET', `/v1/salons/${owner.salonId}/availability?serviceIds=x&date=2030-01-01`)).status).toBe(422);
  });

  it('customer cancel respects the cutoff (default 120 min)', async () => {
    const o = await makeOwner(ctx);
    await call(ctx, 'PUT', `/v1/salons/${o.salonId}/hours`, { token: o.token, body: { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '00:00', closes: '23:59' })) } });
    const c = await makeCustomer(ctx);
    const soon = new Date(Math.ceil((Date.now() + 40 * 60_000) / 300_000) * 300_000).toISOString();
    const h = await call(ctx, 'POST', '/v1/bookings/hold', { token: c.token, body: { salonId: o.salonId, staffId: o.staffId, serviceIds: [o.serviceId], startsAt: soon } });
    await call(ctx, 'POST', `/v1/bookings/${h.body.data.id}/confirm`, { token: c.token });
    const cancel = await call(ctx, 'POST', `/v1/bookings/${h.body.data.id}/cancel`, { token: c.token, body: {} });
    expect(cancel.status).toBe(409);
    expect(cancel.body.error.reason).toBe('CANCEL_CUTOFF');
    const later = await call(ctx, 'POST', '/v1/bookings/hold', { token: c.token, body: { salonId: o.salonId, staffId: o.staffId, serviceIds: [o.serviceId], startsAt: slotAt(3, '14:00') } });
    await call(ctx, 'POST', `/v1/bookings/${later.body.data.id}/confirm`, { token: c.token });
    const ok = await call(ctx, 'POST', `/v1/bookings/${later.body.data.id}/cancel`, { token: c.token, body: {} });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('cancelled');
    // cancelled slot is free again
    const again = await call(ctx, 'POST', '/v1/bookings/hold', { token: c.token, body: { salonId: o.salonId, staffId: o.staffId, serviceIds: [o.serviceId], startsAt: slotAt(3, '14:00') } });
    expect(again.status).toBe(201);
    const mine = await call(ctx, 'GET', '/v1/bookings?limit=10', { token: c.token });
    expect(mine.status).toBe(200);
    expect(mine.body.data.every((b: any) => !['held', 'expired'].includes(b.status))).toBe(true);
  });
});

describe('admin, sales and misc', () => {
  it('admin approves salons, edits plans; sales agents see only their leads', async () => {
    const adminEmail = `admin-${randomUUID()}@example.test`;
    const hash = await (await import('../src/lib/security.js')).makePasswordHasher(1024).hash(PASSWORD);
    await ctx.pool.query("INSERT INTO users (email, password_hash, full_name, platform_role) VALUES ($1,$2,'Admin','admin')", [adminEmail, hash]);
    const login = await call(ctx, 'POST', '/v1/auth/login', { body: { identifier: adminEmail, password: PASSWORD, client: 'website' } });
    const admin = login.body.data.accessToken as string;

    const pending = await makeOwner(ctx, { approve: false });
    const queue = await call(ctx, 'GET', '/v1/admin/salons?status=pending&limit=100', { token: admin });
    expect(queue.body.data.map((s: any) => s.id)).toContain(pending.salonId);
    const ap = await call(ctx, 'PATCH', `/v1/admin/salons/${pending.salonId}`, { token: admin, body: { status: 'approved' } });
    expect(ap.body.data.status).toBe('approved');
    expect((await call(ctx, 'GET', `/v1/admin/salons/${pending.salonId}`, { token: admin })).body.data.staff).toHaveLength(1);
    const comp = await call(ctx, 'POST', `/v1/admin/salons/${pending.salonId}/comp`, { token: admin, body: { until: new Date(Date.now() + 86400_000 * 30).toISOString() } });
    expect(comp.status).toBe(200);
    const plan = await call(ctx, 'PATCH', '/v1/admin/plans/starter', { token: admin, body: { priceMonthlyPaise: 69900 } });
    expect(plan.body.data.priceMonthlyPaise).toBe(69900);
    await call(ctx, 'PATCH', '/v1/admin/plans/starter', { token: admin, body: { priceMonthlyPaise: 59900 } });
    expect((await call(ctx, 'GET', '/v1/admin/stats', { token: admin })).body.data.salons.total).toBeGreaterThan(0);
    expect((await call(ctx, 'GET', '/v1/admin/audit?limit=5', { token: admin })).body.data.length).toBeGreaterThan(0);
    expect((await call(ctx, 'GET', '/v1/admin/contact-messages', { token: admin })).status).toBe(200);
    expect((await call(ctx, 'GET', '/v1/admin/users?role=admin', { token: admin })).status).toBe(200);

    const agentEmail = `agent-${randomUUID()}@example.test`;
    expect((await call(ctx, 'POST', '/v1/admin/sales-agents', { token: admin, body: { fullName: 'Agent A', email: agentEmail, password: PASSWORD } })).status).toBe(201);
    const agent = (await call(ctx, 'POST', '/v1/auth/login', { body: { identifier: agentEmail, password: PASSWORD, client: 'website' } })).body.data.accessToken;
    const lead = await call(ctx, 'POST', '/v1/sales/leads', { token: agent, body: { salonName: 'Lead Salon', city: 'Pune' } });
    expect(lead.status).toBe(201);
    const adminLead = await call(ctx, 'POST', '/v1/sales/leads', { token: admin, body: { salonName: 'Admin Lead' } });
    expect((await call(ctx, 'GET', '/v1/sales/leads', { token: agent })).body.data.map((l: any) => l.id)).toEqual([lead.body.data.id]);
    expect((await call(ctx, 'GET', `/v1/sales/leads/${adminLead.body.data.id}`, { token: agent })).status).toBe(404);
    const inv = await call(ctx, 'POST', `/v1/sales/leads/${lead.body.data.id}/invite`, { token: agent });
    expect(inv.body.data.url).toContain('/register?invite=');
    expect((await call(ctx, 'GET', `/v1/invites/${inv.body.data.code}`)).body.data.salonName).toBe('Lead Salon');
    expect((await call(ctx, 'GET', '/v1/sales/pipeline', { token: agent })).body.data.total).toBe(1);
    expect((await call(ctx, 'GET', '/v1/admin/stats', { token: agent })).status).toBe(403);
    expect((await call(ctx, 'GET', '/v1/sales/leads', { token: owner.token })).status).toBe(403);
    const reg = await call(ctx, 'POST', '/v1/auth/register-owner', { body: { fullName: 'Invited', phone: phone(), email: `inv-${randomUUID()}@example.test`, password: PASSWORD, inviteCode: inv.body.data.code, salon: { name: 'Lead Salon' } } });
    expect(reg.status).toBe(201);
    expect((await call(ctx, 'GET', `/v1/sales/leads/${lead.body.data.id}`, { token: agent })).body.data.stage).toBe('trial');
    expect((await call(ctx, 'GET', `/v1/invites/${inv.body.data.code}`)).status).toBe(404); // used
  });

  it('unknown routes and malformed JSON use the error envelope', async () => {
    const nf = await call(ctx, 'GET', '/v1/nope');
    expect(nf.status).toBe(404);
    expect(nf.body.error.code).toBe('NOT_FOUND');
    const bad = await call(ctx, 'POST', '/v1/auth/login', { raw: '{oops', headers: { 'Content-Type': 'application/json' } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    const badId = await call(ctx, 'GET', '/v1/hairstyles/not-a-uuid');
    expect(badId.status).toBe(422);
  });

  it('payment methods: any member reads, payments.configure writes, one must stay enabled', async () => {
    const get = await call(ctx, 'GET', `/v1/salons/${owner.salonId}/payment-methods`, { token: owner.token });
    expect(get.body.data.filter((m: any) => m.isEnabled).map((m: any) => m.code).sort()).toEqual(['card', 'cash', 'upi']);
    const put = await call(ctx, 'PUT', `/v1/salons/${owner.salonId}/payment-methods`, { token: owner.token, body: { methods: [{ code: 'wallet', isEnabled: true }, { code: 'upi', isEnabled: true, upiId: 'shop@okaxis' }] } });
    expect(put.status).toBe(200);
    expect(put.body.data.find((m: any) => m.code === 'upi').upiId).toBe('shop@okaxis');
    const none = await call(ctx, 'PUT', `/v1/salons/${owner.salonId}/payment-methods`, { token: owner.token, body: { methods: ['cash', 'card', 'upi', 'wallet'].map((code) => ({ code, isEnabled: false })) } });
    expect(none.status).toBe(422);
  });
});

describe('openapi.yaml', () => {
  it('documents exactly the routes the app registers (and is up to date)', async () => {
    const { api } = createApp({ config: ctx.config, pool: ctx.pool, log: createLogger('silent', 'test') });
    const doc = parseYaml(readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8'));
    expect(doc.openapi).toBe('3.1.0');
    const documented = new Set<string>();
    for (const [p, ops] of Object.entries<any>(doc.paths)) for (const m of Object.keys(ops)) documented.add(`${m} ${p}`);
    documented.delete('get /health');
    const registered = new Set(api.routes.map((r) => `${r.method} ${r.path.replace(/:(\w+)/g, '{$1}')}`));
    expect([...registered].filter((r) => !documented.has(r))).toEqual([]);
    expect([...documented].filter((r) => !registered.has(r))).toEqual([]);
    expect(registered.size).toBeGreaterThanOrEqual(100);
  });
});
