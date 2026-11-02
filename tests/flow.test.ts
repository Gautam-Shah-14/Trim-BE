import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, makeCustomer, makeOwner, slotAt, startCtx, type Ctx, type Owner, PASSWORD } from './helpers.js';

let ctx: Ctx;
let owner: Owner;
beforeAll(async () => {
  ctx = await startCtx();
  owner = await makeOwner(ctx);
});
afterAll(() => ctx.close());

describe('end-to-end booking flow', () => {
  it('health reports db up', async () => {
    const r = await call(ctx, 'GET', '/health');
    expect(r.status).toBe(200);
    expect(r.body.db).toBe('up');
    expect(r.headers.get('x-request-id')).toBeTruthy();
  });

  it('availability -> hold -> confirm -> QR check-in -> invoice -> review', async () => {
    const cust = await makeCustomer(ctx);
    const date = slotAt(2, '00:00').slice(0, 10);
    const av = await call(ctx, 'GET', `/v1/salons/${owner.salonId}/availability?serviceIds=${owner.serviceId}&date=${date}`);
    expect(av.status).toBe(200);
    expect(av.body.data.slots.length).toBeGreaterThan(10);

    const startsAt = slotAt(2, '11:00');
    const hold = await call(ctx, 'POST', '/v1/bookings/hold', { token: cust.token, body: { salonId: owner.salonId, staffId: owner.staffId, serviceIds: [owner.serviceId], startsAt } });
    expect(hold.status).toBe(201);
    expect(hold.body.data.status).toBe('held');
    expect(hold.body.data.holdExpiresAt).toBeTruthy();
    const id = hold.body.data.id;

    // slot no longer offered
    const av2 = await call(ctx, 'GET', `/v1/salons/${owner.salonId}/availability?serviceIds=${owner.serviceId}&date=${date}`);
    expect(av2.body.data.slots.some((s: any) => s.startsAt === startsAt)).toBe(false);

    const conf = await call(ctx, 'POST', `/v1/bookings/${id}/confirm`, { token: cust.token });
    expect(conf.status).toBe(200);
    expect(conf.body.data.status).toBe('confirmed');
    const qr = conf.body.data.qrToken as string;
    expect(qr.split('.')).toHaveLength(2);

    const get = await call(ctx, 'GET', `/v1/bookings/${id}`, { token: cust.token });
    expect(get.body.data.qrToken).toBe(qr);

    // 2 days ahead is outside the check-in window
    const early = await call(ctx, 'POST', `/v1/salons/${owner.salonId}/checkin`, { token: owner.token, body: { qrToken: qr } });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('OUT_OF_WINDOW');

    const inv = await call(ctx, 'POST', `/v1/salons/${owner.salonId}/invoices`, {
      token: owner.token,
      body: { bookingId: id, items: [{ serviceId: owner.serviceId, name: 'Haircut', qty: 1, unitPricePaise: 30000 }], discountPaise: 5000, payments: [{ methodCode: 'cash', amountPaise: 10000 }, { methodCode: 'upi', amountPaise: 15000 }] },
    });
    expect(inv.status).toBe(201);
    expect(inv.body.data.totalPaise).toBe(25000);
    expect(inv.body.data.invoiceNo).toMatch(/^[A-Z0-9]{2,6}-\d{4}-\d{6}$/);
    const done = await call(ctx, 'GET', `/v1/bookings/${id}`, { token: cust.token });
    expect(done.body.data.status).toBe('completed');

    const rev = await call(ctx, 'POST', `/v1/bookings/${id}/review`, { token: cust.token, body: { rating: 5, comment: 'Great' } });
    expect(rev.status).toBe(201);
    expect((await call(ctx, 'POST', `/v1/bookings/${id}/review`, { token: cust.token, body: { rating: 4 } })).status).toBe(409);
    const list = await call(ctx, 'GET', `/v1/discover/salons/${owner.salonId}/reviews`);
    expect(list.body.data).toHaveLength(1);
    const prof = await call(ctx, 'GET', `/v1/discover/salons/${owner.salonId}`);
    expect(prof.body.data.ratingCount).toBe(1);
    expect(prof.body.data.staff[0].serviceIds).toContain(owner.serviceId);
  });

  it('payment sums must equal the total and methods must be enabled', async () => {
    const bad = await call(ctx, 'POST', `/v1/salons/${owner.salonId}/invoices`, {
      token: owner.token,
      body: { customerName: 'Walk Customer', items: [{ name: 'Cut', qty: 1, unitPricePaise: 10000 }], payments: [{ methodCode: 'cash', amountPaise: 9000 }] },
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    const wallet = await call(ctx, 'POST', `/v1/salons/${owner.salonId}/invoices`, {
      token: owner.token,
      body: { customerName: 'Walk Customer', items: [{ name: 'Cut', qty: 1, unitPricePaise: 10000 }], payments: [{ methodCode: 'wallet', amountPaise: 10000 }] },
    });
    expect(wallet.status).toBe(422);
  });

  it('login returns memberships with permissions; unknown fields are rejected', async () => {
    const r = await call(ctx, 'POST', '/v1/auth/login', { body: { identifier: owner.email, password: PASSWORD, client: 'salon_app' } });
    expect(r.status).toBe(200);
    expect(r.body.data.memberships[0].roleName).toBe('owner');
    expect(r.body.data.memberships[0].permissions).toContain('billing.void');
    const extra = await call(ctx, 'POST', '/v1/auth/login', { body: { identifier: owner.email, password: PASSWORD, client: 'salon_app', admin: true } });
    expect(extra.status).toBe(422);
    expect(extra.body.error.details[0].issue).toBe('unknown field');
  });
});
