import { randomUUID } from 'node:crypto';
import { findOverlaps } from '../src/lib/invariants.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { call, eventResult, makeCustomer, makeOwner, openAllDay, phone, PASSWORD, slotAt, startCtx, webhook, type Ctx, type Owner } from './helpers.js';

let ctx: Ctx;
let owner: Owner;
beforeAll(async () => {
  ctx = await startCtx();
  owner = await makeOwner(ctx);
});
afterAll(() => ctx.close());

const holdBody = (o: Owner, startsAt: string) => ({ salonId: o.salonId, staffId: o.staffId, serviceIds: [o.serviceId], startsAt });
const hold = (token: string, o: Owner, startsAt: string, key?: string) =>
  call(ctx, 'POST', '/v1/bookings/hold', { token, body: holdBody(o, startsAt), headers: key ? { 'Idempotency-Key': key } : {} });

describe('double booking (spec 7.1, 7.2)', () => {
  it('50 parallel holds for the same staff and time: exactly one wins, the rest get SLOT_TAKEN', async () => {
    const customers = await Promise.all(Array.from({ length: 50 }, () => makeCustomer(ctx)));
    const startsAt = slotAt(3, '11:00');
    const results = await Promise.all(customers.map((c) => hold(c.token, owner, startsAt)));
    const ok = results.filter((r) => r.status === 201);
    expect(ok).toHaveLength(1);
    expect(results.filter((r) => r.status !== 201).map((r) => r.status + ':' + r.body?.error?.code)).toEqual(Array(49).fill('409:SLOT_TAKEN'));
    const rows = await ctx.pool.query("SELECT count(*)::int AS n FROM bookings WHERE staff_id = $1 AND starts_at = $2 AND status = 'held'", [owner.staffId, startsAt]);
    expect(rows.rows[0].n).toBe(1);
    expect(await findOverlaps(ctx.pool)).toEqual([]); // post-run invariant used after load tests
  }, 120_000);

  it('partially overlapping ranges are refused, adjacent ones are fine', async () => {
    const [a, b, c, d] = await Promise.all([makeCustomer(ctx), makeCustomer(ctx), makeCustomer(ctx), makeCustomer(ctx)]);
    expect((await hold(a.token, owner, slotAt(4, '12:00'))).status).toBe(201); // 12:00-12:30
    const overlapLate = await hold(b.token, owner, slotAt(4, '12:15')); // 12:15-12:45
    expect(overlapLate.body.error?.code).toBe('SLOT_TAKEN');
    const overlapEarly = await hold(c.token, owner, slotAt(4, '11:45')); // 11:45-12:15
    expect(overlapEarly.body.error?.code).toBe('SLOT_TAKEN');
    expect((await hold(d.token, owner, slotAt(4, '12:30'))).status).toBe(201); // adjacent
    expect((await hold(d.token, owner, slotAt(4, '11:30'))).status).toBe(201); // adjacent before
  });

  it('an expired hold frees the slot and cannot be confirmed (HOLD_EXPIRED)', async () => {
    const [a, b] = await Promise.all([makeCustomer(ctx), makeCustomer(ctx)]);
    const startsAt = slotAt(5, '15:00');
    const h = await hold(a.token, owner, startsAt);
    expect(h.status).toBe(201);
    expect((await hold(b.token, owner, startsAt)).body.error.code).toBe('SLOT_TAKEN');
    await ctx.pool.query("UPDATE bookings SET hold_expires_at = now() - interval '1 second' WHERE id = $1", [h.body.data.id]);
    const late = await call(ctx, 'POST', `/v1/bookings/${h.body.data.id}/confirm`, { token: a.token });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('HOLD_EXPIRED');
    expect((await hold(b.token, owner, startsAt)).status).toBe(201); // slot is free again
  });

  it('the sweeper function flips expired holds', async () => {
    const a = await makeCustomer(ctx);
    const h = await hold(a.token, owner, slotAt(6, '15:00'));
    await ctx.pool.query("UPDATE bookings SET hold_expires_at = now() - interval '1 minute' WHERE id = $1", [h.body.data.id]);
    const { sweepExpiredHolds } = await import('../src/lib/booking.js');
    expect(await sweepExpiredHolds(ctx.pool)).toBeGreaterThanOrEqual(1);
    const r = await ctx.pool.query('SELECT status FROM bookings WHERE id = $1', [h.body.data.id]);
    expect(r.rows[0].status).toBe('expired');
  });

  it('the database itself rejects overlapping rows (exclusion constraint, bypassing the API)', async () => {
    const a = await makeCustomer(ctx);
    const h = await hold(a.token, owner, slotAt(7, '10:00'));
    expect(h.status).toBe(201);
    await expect(
      ctx.pool.query(
        `INSERT INTO bookings (salon_id, customer_name, staff_id, source, status, starts_at, ends_at, total_duration_min, total_price_paise)
         SELECT salon_id, 'x', staff_id, 'walk_in', 'confirmed', starts_at + interval '10 minutes', ends_at + interval '10 minutes', 30, 0 FROM bookings WHERE id = $1`,
        [h.body.data.id],
      ),
    ).rejects.toMatchObject({ code: '23P01' });
  });
});

describe('idempotency (spec 7.3)', () => {
  it('same key + same body replays; different body is 422; parallel duplicates collapse', async () => {
    const c = await makeCustomer(ctx);
    const key = randomUUID();
    const first = await hold(c.token, owner, slotAt(8, '10:00'), key);
    const again = await hold(c.token, owner, slotAt(8, '10:00'), key);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    const diff = await hold(c.token, owner, slotAt(8, '11:00'), key);
    expect(diff.status).toBe(422);

    const key2 = randomUUID();
    const par = await Promise.all(Array.from({ length: 6 }, () => hold(c.token, owner, slotAt(8, '13:00'), key2)));
    expect(new Set(par.map((r) => r.body.data?.id)).size).toBe(1);
    expect(par.every((r) => r.status === 201)).toBe(true);
  });

  it('confirm is idempotent too', async () => {
    const c = await makeCustomer(ctx);
    const h = await hold(c.token, owner, slotAt(8, '16:00'));
    const key = randomUUID();
    const a = await call(ctx, 'POST', `/v1/bookings/${h.body.data.id}/confirm`, { token: c.token, headers: { 'Idempotency-Key': key } });
    const b = await call(ctx, 'POST', `/v1/bookings/${h.body.data.id}/confirm`, { token: c.token, headers: { 'Idempotency-Key': key } });
    expect(a.body.data.qrToken).toBe(b.body.data.qrToken);
  });
});

describe('check-in and versioning (spec 7.4, 7.6)', () => {
  let o2: Owner;
  beforeEach(async () => {
    o2 = await makeOwner(ctx);
    await openAllDay(ctx, o2);
  });
  const soon = () => {
    const t = Math.ceil((Date.now() + 20 * 60_000) / 300_000) * 300_000;
    return new Date(t).toISOString();
  };

  async function confirmed(startsAt = soon()) {
    const c = await makeCustomer(ctx);
    const h = await hold(c.token, o2, startsAt);
    if (h.status !== 201) throw new Error(JSON.stringify(h.body));
    const conf = await call(ctx, 'POST', `/v1/bookings/${h.body.data.id}/confirm`, { token: c.token });
    return { c, id: h.body.data.id as string, qr: conf.body.data.qrToken as string, version: conf.body.data.version as number };
  }

  it('parallel double scan: exactly one success, others ALREADY_CHECKED_IN', async () => {
    const b = await confirmed();
    const rs = await Promise.all(Array.from({ length: 10 }, () => call(ctx, 'POST', `/v1/salons/${o2.salonId}/checkin`, { token: o2.token, body: { qrToken: b.qr } })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409 && r.body.error.code === 'ALREADY_CHECKED_IN')).toHaveLength(9);
    const after = await call(ctx, 'GET', `/v1/bookings/${b.id}`, { token: b.c.token });
    expect(after.body.data.status).toBe('checked_in');
    expect(after.body.data.qrToken).toBeUndefined();
  });

  it('QR from another salon is 403, tampered QR is 422', async () => {
    const b = await confirmed();
    const wrong = await call(ctx, 'POST', `/v1/salons/${owner.salonId}/checkin`, { token: owner.token, body: { qrToken: b.qr } });
    expect(wrong.status).toBe(403);
    const [p] = b.qr.split('.');
    const bad = await call(ctx, 'POST', `/v1/salons/${o2.salonId}/checkin`, { token: o2.token, body: { qrToken: `${p}.AAAA` } });
    expect(bad.status).toBe(422);
  });

  it('a staff member without checkin.scan is refused', async () => {
    const b = await confirmed();
    const role = await call(ctx, 'POST', `/v1/salons/${o2.salonId}/staff`, {
      token: o2.token,
      body: { fullName: 'No Scan', email: `ns-${randomUUID()}@example.test`, tempPassword: PASSWORD, roleId: o2.roleIds['stylist'] },
    });
    expect(role.status).toBe(201);
    await ctx.pool.query("DELETE FROM salon_role_permissions WHERE role_id = $1 AND permission = 'checkin.scan'", [o2.roleIds['stylist']]);
    const login = await call(ctx, 'POST', '/v1/auth/login', { body: { identifier: role.body.data.email, password: PASSWORD, client: 'salon_app' } });
    const r = await call(ctx, 'POST', `/v1/salons/${o2.salonId}/checkin`, { token: login.body.data.accessToken, body: { qrToken: b.qr } });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('FORBIDDEN');
  });

  it('reschedule uses optimistic locking and rotates the QR nonce', async () => {
    const b = await confirmed(new Date(Date.now() + 3 * 3600_000 - ((Date.now() + 3 * 3600_000) % 300_000)).toISOString());
    const newTime = new Date(Date.now() + 5 * 3600_000 - ((Date.now() + 5 * 3600_000) % 300_000)).toISOString();
    const stale = await call(ctx, 'PATCH', `/v1/salons/${o2.salonId}/bookings/${b.id}`, { token: o2.token, body: { version: b.version + 7, startsAt: newTime } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_MISMATCH');

    const rs = await Promise.all([
      call(ctx, 'PATCH', `/v1/salons/${o2.salonId}/bookings/${b.id}`, { token: o2.token, body: { version: b.version, startsAt: newTime } }),
      call(ctx, 'PATCH', `/v1/salons/${o2.salonId}/bookings/${b.id}`, { token: o2.token, body: { version: b.version, startsAt: newTime } }),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(rs.find((r) => r.status === 409)!.body.error.code).toBe('VERSION_MISMATCH');
    const fresh = await call(ctx, 'GET', `/v1/bookings/${b.id}`, { token: b.c.token });
    expect(fresh.body.data.qrToken).not.toBe(b.qr);
    expect(fresh.body.data.version).toBe(b.version + 1);
  });

  it('walk-in booking is confirmed with source walk_in and blocks the slot', async () => {
    const startsAt = slotAt(9, '10:00');
    const w = await call(ctx, 'POST', `/v1/salons/${o2.salonId}/bookings`, { token: o2.token, body: { customerName: 'Walk In', customerPhone: phone(), staffId: o2.staffId, serviceIds: [o2.serviceId], startsAt } });
    expect(w.status).toBe(201);
    expect(w.body.data).toMatchObject({ status: 'confirmed', source: 'walk_in', customerId: null });
    const dup = await call(ctx, 'POST', `/v1/salons/${o2.salonId}/bookings`, { token: o2.token, body: { customerName: 'Other', staffId: o2.staffId, serviceIds: [o2.serviceId], startsAt } });
    expect(dup.body.error.code).toBe('SLOT_TAKEN');
  });
});

describe('invoice numbering (spec 7.5)', () => {
  it('30 parallel invoices get contiguous unique numbers', async () => {
    const o = await makeOwner(ctx);
    const mk = (i: number) =>
      call(ctx, 'POST', `/v1/salons/${o.salonId}/invoices`, {
        token: o.token,
        body: { customerName: `Cust ${i}`, items: [{ name: 'Cut', qty: 1, unitPricePaise: 10000 }], payments: [{ methodCode: 'cash', amountPaise: 10000 }] },
      });
    const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => mk(i)));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    const nums = rs.map((r) => Number(r.body.data.invoiceNo.split('-')[2])).sort((a, b) => a - b);
    expect(nums).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(new Set(rs.map((r) => r.body.data.invoiceNo)).size).toBe(30);
    const ctr = await ctx.pool.query('SELECT last_no FROM invoice_counters WHERE salon_id = $1', [o.salonId]);
    expect(ctr.rows[0].last_no).toBe(30);
  }, 120_000);

  it('a failed invoice (bad payment sum) does not burn a number; idempotency key replays', async () => {
    const o = await makeOwner(ctx);
    const bad = await call(ctx, 'POST', `/v1/salons/${o.salonId}/invoices`, { token: o.token, body: { customerName: 'A', items: [{ name: 'Cut', qty: 1, unitPricePaise: 100 }], payments: [{ methodCode: 'cash', amountPaise: 1 }] } });
    expect(bad.status).toBe(422);
    const key = randomUUID();
    const body = { customerName: 'A', items: [{ name: 'Cut', qty: 2, unitPricePaise: 100 }], payments: [{ methodCode: 'cash', amountPaise: 200 }] };
    const a = await call(ctx, 'POST', `/v1/salons/${o.salonId}/invoices`, { token: o.token, body, headers: { 'Idempotency-Key': key } });
    const b = await call(ctx, 'POST', `/v1/salons/${o.salonId}/invoices`, { token: o.token, body, headers: { 'Idempotency-Key': key } });
    expect(a.body.data.invoiceNo).toMatch(/-000001$/);
    expect(b.body.data.id).toBe(a.body.data.id);
    const v = await call(ctx, 'POST', `/v1/salons/${o.salonId}/invoices/${a.body.data.id}/void`, { token: o.token, body: { reason: 'test' } });
    expect(v.body.data.status).toBe('void');
  });
});

describe('plan limits (spec 7.8)', () => {
  it('10 parallel "add staff" calls on Starter (max 3 incl. owner): exactly 2 succeed, rest PLAN_LIMIT', async () => {
    const o = await makeOwner(ctx);
    await ctx.pool.query("UPDATE subscriptions SET status = 'active', plan_code = 'starter', trial_ends_at = NULL WHERE salon_id = $1", [o.salonId]);
    const mk = () =>
      call(ctx, 'POST', `/v1/salons/${o.salonId}/staff`, {
        token: o.token,
        body: { fullName: 'Stylist', email: `s-${randomUUID()}@example.test`, tempPassword: PASSWORD, roleId: o.roleIds['stylist'] },
      });
    const rs = await Promise.all(Array.from({ length: 10 }, mk));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(2);
    const limited = rs.filter((r) => r.status === 403 && r.body.error.code === 'PLAN_LIMIT');
    expect(limited).toHaveLength(8);
    expect(limited[0]!.body.error.details.limit).toBe('max_staff');
    const n = await ctx.pool.query('SELECT count(*)::int AS n FROM salon_staff WHERE salon_id = $1 AND is_active', [o.salonId]);
    expect(n.rows[0].n).toBe(3);
  }, 120_000);

  it('Pro (trial) has unlimited staff', async () => {
    const o = await makeOwner(ctx);
    const rs = await Promise.all(Array.from({ length: 5 }, () =>
      call(ctx, 'POST', `/v1/salons/${o.salonId}/staff`, { token: o.token, body: { fullName: 'S', email: `p-${randomUUID()}@example.test`, tempPassword: PASSWORD, roleId: o.roleIds['stylist'] } })));
    expect(rs.every((r) => r.status === 201)).toBe(true);
  });
});

describe('Razorpay webhook (spec 7.7)', () => {
  let o: Owner;
  let subId: string;
  const ev = (type: string, createdAt: number, extra: Record<string, any> = {}) => ({
    entity: 'event', event: type, created_at: createdAt,
    payload: {
      subscription: { entity: { id: subId, plan_id: 'plan_pro_m', current_start: createdAt, current_end: createdAt + 2_592_000, notes: { app: 'trim', salonId: o.salonId }, ...extra } },
      payment: { entity: { id: `pay_${createdAt}`, amount: 129900 } },
    },
  });
  const sub = async () => (await ctx.pool.query('SELECT * FROM subscriptions WHERE salon_id = $1', [o.salonId])).rows[0];
  const T = Math.floor(Date.now() / 1000);

  beforeAll(async () => {
    o = await makeOwner(ctx);
    await ctx.pool.query("UPDATE plans SET razorpay_plan_id_monthly = 'plan_pro_m', razorpay_plan_id_annual = 'plan_pro_a' WHERE code = 'pro'");
    const co = await call(ctx, 'POST', `/v1/salons/${o.salonId}/subscription/checkout`, { token: o.token, body: { planCode: 'pro', interval: 'monthly' }, headers: { 'Idempotency-Key': randomUUID() } });
    expect(co.status).toBe(200);
    subId = co.body.data.razorpaySubscriptionId;
    expect(co.body.data.keyId).toBe('rzp_test_fake');
    expect(ctx.gateway.created.at(-1)!.notes).toMatchObject({ app: 'trim', salonId: o.salonId });
  });

  it('checkout is idempotent per key', async () => {
    const key = randomUUID();
    const b = { planCode: 'pro', interval: 'annual' };
    const n = ctx.gateway.created.length;
    const a = await call(ctx, 'POST', `/v1/salons/${o.salonId}/subscription/checkout`, { token: o.token, body: b, headers: { 'Idempotency-Key': key } });
    const c = await call(ctx, 'POST', `/v1/salons/${o.salonId}/subscription/checkout`, { token: o.token, body: b, headers: { 'Idempotency-Key': key } });
    expect(c.body.data.razorpaySubscriptionId).toBe(a.body.data.razorpaySubscriptionId);
    expect(ctx.gateway.created.length).toBe(n + 1);
    const d = await call(ctx, 'POST', `/v1/salons/${o.salonId}/subscription/checkout`, { token: o.token, body: { planCode: 'pro', interval: 'monthly' }, headers: { 'Idempotency-Key': key } });
    expect(d.status).toBe(422);
    // restore the monthly subscription id used by the events below
    await ctx.pool.query('UPDATE subscriptions SET razorpay_subscription_id = $2 WHERE salon_id = $1', [o.salonId, subId]);
  });

  it('rejects a bad signature and a missing one', async () => {
    const r = await webhook(ctx, ev('subscription.activated', T), randomUUID(), 'deadbeef');
    expect(r.status).toBe(401);
    const none = await call(ctx, 'POST', '/v1/webhooks/razorpay', { raw: '{}', headers: { 'Content-Type': 'application/json' } });
    expect(none.status).toBe(401);
  });

  it('activated -> active; the same event id replayed (also in parallel) changes state once', async () => {
    const id = randomUUID();
    const e = ev('subscription.charged', T + 10);
    const rs = await Promise.all(Array.from({ length: 6 }, () => webhook(ctx, e, id)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(rs.filter((r) => r.body.data.result === 'queued')).toHaveLength(1);
    expect(await eventResult(ctx, id)).toBe('applied');
    expect(rs.filter((r) => r.body.data.result === 'duplicate')).toHaveLength(5);
    const s = await sub();
    expect(s.status).toBe('active');
    expect(s.plan_code).toBe('pro');
    expect(s.current_period_end.getTime()).toBe((T + 10 + 2_592_000) * 1000);
    const ev1 = await ctx.pool.query('SELECT count(*)::int AS n FROM subscription_events WHERE razorpay_event_id = $1', [id]);
    expect(ev1.rows[0].n).toBe(1);
    const rc = await ctx.pool.query('SELECT * FROM subscription_receipts WHERE salon_id = $1', [o.salonId]);
    expect(rc.rows).toHaveLength(1);
    expect(rc.rows[0].receipt_no).toMatch(/^TRM-\d{4}-\d{6}$/);
    expect(rc.rows[0].amount_paise).toBe(129900);
    // same payment under a new event id => still one receipt
    await webhook(ctx, ev('subscription.charged', T + 10), randomUUID());
    expect((await ctx.pool.query('SELECT count(*)::int AS n FROM subscription_receipts WHERE salon_id = $1', [o.salonId])).rows[0].n).toBe(1);
  });

  it('out-of-order events: an older "pending" after a newer "charged" is ignored', async () => {
    const staleId = randomUUID();
    await webhook(ctx, ev('subscription.pending', T + 5), staleId);
    expect(await eventResult(ctx, staleId)).toBe('stale');
    expect((await sub()).status).toBe('active');
    const newerId = randomUUID();
    await webhook(ctx, ev('subscription.pending', T + 100), newerId);
    expect(await eventResult(ctx, newerId)).toBe('applied');
    const s = await sub();
    expect(s.status).toBe('past_due');
    expect(s.past_due_since).toBeTruthy();
    const g = await call(ctx, 'GET', `/v1/salons/${o.salonId}/subscription`, { token: o.token });
    expect(g.body.data.entitlements.readOnly).toBe(false); // 7-day grace
  });

  it('halted -> read-only: no new bills or bookings, salon hidden, check-in/export still allowed', async () => {
    await webhook(ctx, ev('subscription.halted', T + 200), randomUUID());
    expect((await sub()).status).toBe('halted');
    const inv = await call(ctx, 'POST', `/v1/salons/${o.salonId}/invoices`, { token: o.token, body: { customerName: 'A', items: [{ name: 'x', qty: 1, unitPricePaise: 100 }], payments: [{ methodCode: 'cash', amountPaise: 100 }] } });
    expect(inv.status).toBe(403);
    expect(inv.body.error.code).toBe('SUBSCRIPTION_INACTIVE');
    const list = await call(ctx, 'GET', `/v1/salons/${o.salonId}/invoices`, { token: o.token });
    expect(list.status).toBe(200);
    const disc = await call(ctx, 'GET', `/v1/discover/salons/${o.salonId}`);
    expect(disc.status).toBe(404);
    const search = await call(ctx, 'GET', '/v1/discover/salons?limit=100');
    expect(search.body.data.some((s: any) => s.id === o.salonId)).toBe(false);
    const csv = await call(ctx, 'GET', `/v1/salons/${o.salonId}/analytics/export.csv`, { token: o.token });
    expect(csv.status).toBe(200); // exports stay available in read-only mode
  });

  it('events for another product on the shared Razorpay account are ignored', async () => {
    const e = ev('subscription.cancelled', T + 300);
    (e.payload.subscription.entity as any).notes = { app: 'other-product' };
    const otherId = randomUUID();
    await webhook(ctx, e, otherId);
    expect(await eventResult(ctx, otherId)).toBe('ignored');
    expect((await sub()).status).toBe('halted');
  });

  it('cancelled and completed events', async () => {
    await webhook(ctx, ev('subscription.cancelled', T + 400), randomUUID());
    expect((await sub()).status).toBe('cancelled');
    await webhook(ctx, ev('subscription.activated', T + 500), randomUUID());
    expect((await sub()).status).toBe('active');
    await webhook(ctx, ev('subscription.completed', T + 600), randomUUID());
    expect((await sub()).status).toBe('expired');
  });
});
