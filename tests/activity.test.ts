import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activeUsers, istDay, recordActivity } from '../src/lib/activity.js';
import { addDays } from '../src/lib/slots.js';
import { createLogger } from '../src/logger.js';
import { makePasswordHasher } from '../src/lib/security.js';
import { call, makeCustomer, makeOwner, PASSWORD, startCtx, type Ctx } from './helpers.js';

let ctx: Ctx;
beforeAll(async () => {
  ctx = await startCtx();
});
afterAll(() => ctx.close());

const log = createLogger('silent', 'test');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rows = async (userId: string) => (await ctx.pool.query('SELECT day::text AS day, role FROM user_activity_days WHERE user_id = $1 ORDER BY day', [userId])).rows;
async function waitRows(userId: string, n: number) {
  for (let i = 0; i < 50; i++) {
    const r = await rows(userId);
    if (r.length >= n) return r;
    await sleep(50);
  }
  return rows(userId);
}

async function newUser(role: 'customer' | 'salon_user' | 'sales_agent'): Promise<string> {
  const r = await ctx.pool.query("INSERT INTO users (email, password_hash, full_name, platform_role) VALUES ($1, 'x', 'U', $2) RETURNING id", [`a-${randomUUID()}@example.test`, role]);
  return r.rows[0].id;
}

describe('activity recording', () => {
  it('100 authenticated requests in one day -> exactly one row, role recorded', async () => {
    const c = await makeCustomer(ctx);
    await Promise.all(Array.from({ length: 50 }, () => call(ctx, 'GET', '/v1/me', { token: c.token })));
    for (let i = 0; i < 50; i++) await call(ctx, 'GET', '/v1/me', { token: c.token });
    await sleep(200);
    const r = await waitRows(c.userId, 1);
    expect(r).toEqual([{ day: istDay(Date.now()), role: 'customer' }]);
  });

  it('IST day boundary: 23:59 and 00:01 IST are two different days', async () => {
    const id = await newUser('salon_user');
    recordActivity(ctx.pool, log, id, 'salon_user', Date.parse('2026-11-12T18:29:00Z')); // 23:59 IST on the 12th
    recordActivity(ctx.pool, log, id, 'salon_user', Date.parse('2026-11-12T18:29:30Z')); // same IST day: memo, no write
    recordActivity(ctx.pool, log, id, 'salon_user', Date.parse('2026-11-12T18:31:00Z')); // 00:01 IST on the 13th
    const r = await waitRows(id, 2);
    expect(r).toEqual([{ day: '2026-11-12', role: 'salon_user' }, { day: '2026-11-13', role: 'salon_user' }]);
    expect(istDay(Date.parse('2026-11-12T18:29:59Z'))).toBe('2026-11-12');
    expect(istDay(Date.parse('2026-11-12T18:30:00Z'))).toBe('2026-11-13');
  });

  it('a recording failure never fails or slows the request', async () => {
    const other = await startCtx();
    try {
      const c = await makeCustomer(other);
      await other.pool.query('DROP TABLE user_activity_days');
      const t0 = Date.now();
      const r = await call(other, 'GET', '/v1/me', { token: c.token });
      expect(r.status).toBe(200);
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally {
      await other.close();
    }
  });
});

describe('DAU / WAU / MAU', () => {
  it('math, byRole and gap-filled series', async () => {
    const m = await startCtx();
    try {
      const asOf = '2026-06-30';
      const ins = async (role: string, days: number[]) => {
        const r = await m.pool.query("INSERT INTO users (email, password_hash, full_name, platform_role) VALUES ($1, 'x', 'U', $2::platform_role) RETURNING id", [`m-${randomUUID()}@example.test`, role]);
        for (const d of days) await m.pool.query('INSERT INTO user_activity_days (user_id, day, role) VALUES ($1, $2::date, $3)', [r.rows[0].id, addDays(asOf, -d), role]);
      };
      await ins('customer', [0, 1, 2]); // active today, also in week/month
      await ins('customer', [6]); // edge of the 7-day window (counts in wau)
      await ins('customer', [7]); // just outside wau, inside mau
      await ins('salon_user', [0, 29]); // today + edge of the 30-day window
      await ins('salon_user', [30]); // outside mau
      await ins('sales_agent', [0]); // totals only
      await ins('customer', [-1]); // after asOf: ignored
      const a = await activeUsers(m.pool, asOf);
      expect(a).toMatchObject({ asOf, dau: 3, wau: 4, mau: 5 });
      expect(a.byRole).toEqual({ customer: { dau: 1, wau: 2, mau: 3 }, salon_user: { dau: 1, wau: 1, mau: 1 } });
      expect(a.series).toHaveLength(30);
      expect(a.series[0]).toEqual({ day: '2026-06-01', dau: 1 });
      expect(a.series[29]).toEqual({ day: asOf, dau: 3 });
      expect(a.series.find((x) => x.day === '2026-06-10')).toEqual({ day: '2026-06-10', dau: 0 }); // gap filled
      expect(a.series.reduce((s, x) => s + x.dau, 0)).toBe(8); // rows inside the window: 3 + 1 + 1 + 2 + 1
    } finally {
      await m.close();
    }
  });

  it('GET /admin/stats exposes activeUsers for admins only', async () => {
    const hash = await makePasswordHasher(1024).hash(PASSWORD);
    const email = `adm-${randomUUID()}@example.test`;
    await ctx.pool.query("INSERT INTO users (email, password_hash, full_name, platform_role) VALUES ($1,$2,'A','admin')", [email, hash]);
    const admin = (await call(ctx, 'POST', '/v1/auth/login', { body: { identifier: email, password: PASSWORD, client: 'website' } })).body.data.accessToken;
    const r = await call(ctx, 'GET', '/v1/admin/stats', { token: admin });
    expect(r.status).toBe(200);
    const au = r.body.data.activeUsers;
    expect(au.asOf).toBe(istDay(Date.now()));
    expect(au.series).toHaveLength(30);
    expect(au.dau).toBeGreaterThanOrEqual(1);
    expect(Object.keys(au.byRole).sort()).toEqual(['customer', 'salon_user']);
    const o = await makeOwner(ctx);
    const c = await makeCustomer(ctx);
    expect((await call(ctx, 'GET', '/v1/admin/stats', { token: o.token })).status).toBe(403);
    expect((await call(ctx, 'GET', '/v1/admin/stats', { token: c.token })).status).toBe(403);
    expect((await call(ctx, 'GET', '/v1/admin/stats')).status).toBe(401);
  });
});
