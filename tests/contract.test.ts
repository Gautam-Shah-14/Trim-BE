import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SCHEMAS } from '../src/schemas.js';
import { call, makeCustomer, makeOwner, openAllDay, PASSWORD, phone, slotAt, startCtx, type Ctx } from './helpers.js';

let ctx: Ctx;
beforeAll(async () => {
  ctx = await startCtx();
});
afterAll(() => ctx.close());

const problems: string[] = [];
/** validate one response payload against the documented schema (strict: unknown or missing keys fail) */
function check(name: string, res: { status: number; body: any }, where: string) {
  const list = name.endsWith('[]');
  const schema = SCHEMAS[list ? name.slice(0, -2) : name];
  if (!schema) {
    problems.push(`${where}: unknown schema ${name}`);
    return;
  }
  if (res.status >= 400) {
    problems.push(`${where}: HTTP ${res.status} ${JSON.stringify(res.body)}`);
    return;
  }
  const data = res.body?.data;
  const items = list ? data : [data];
  if (list && !Array.isArray(data)) {
    problems.push(`${where}: expected an array`);
    return;
  }
  for (const item of items) {
    const r = schema.safeParse(item);
    if (!r.success) problems.push(`${where} -> ${name}: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  if (list && items.length === 0) problems.push(`${where}: empty list, cannot verify ${name}`);
}

describe('responses match the documented schemas (src/schemas.ts -> openapi.yaml)', () => {
  it('customer, salon, billing, subscription, admin and sales payloads', async () => {
    const o = await makeOwner(ctx, { name: 'Contract Salon' });
    const tz = await openAllDay(ctx, o);
    void tz;
    const c = await makeCustomer(ctx);
    const T = o.token;
    const sid = o.salonId;

    // auth + profile
    const reg = await call(ctx, 'POST', '/v1/auth/register', { body: { fullName: 'Reg', email: `r-${randomUUID()}@example.test`, password: PASSWORD } });
    check('AuthResult', reg, 'POST /auth/register');
    const regOwner = await call(ctx, 'POST', '/v1/auth/register-owner', { body: { fullName: 'O', phone: phone(), email: `o-${randomUUID()}@example.test`, password: PASSWORD, salon: { name: 'Another Salon' } } });
    check('AuthResult', regOwner, 'POST /auth/register-owner');
    expect(regOwner.body.data.salon).toBeTruthy();
    const login = await call(ctx, 'POST', '/v1/auth/login', { body: { identifier: o.email, password: PASSWORD, client: 'salon_app' } });
    check('AuthResult', login, 'POST /auth/login');
    check('AuthTokens', await call(ctx, 'POST', '/v1/auth/refresh', { body: { refreshToken: login.body.data.refreshToken } }), 'POST /auth/refresh');
    const me = await call(ctx, 'GET', '/v1/me', { token: T });
    check('MeResult', me, 'GET /me');
    expect(Object.keys(me.body.data.memberships[0])).toEqual(expect.arrayContaining(['salonId', 'salonName', 'roleName', 'permissions']));
    check('User', await call(ctx, 'PATCH', '/v1/me', { token: T, body: { fullName: 'Olivia O' } }), 'PATCH /me');
    check('MediaId', await call(ctx, 'POST', '/v1/media', { token: c.token, body: { kind: 'avatar', mime: 'image/png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' } }), 'POST /media');

    // public catalog
    check('Plan[]', await call(ctx, 'GET', '/v1/plans'), 'GET /plans');
    const hs = await call(ctx, 'GET', '/v1/hairstyles');
    check('Hairstyle[]', hs, 'GET /hairstyles');
    check('Hairstyle', await call(ctx, 'GET', `/v1/hairstyles/${hs.body.data[0].id}`), 'GET /hairstyles/:id');
    check('ServiceTemplate[]', await call(ctx, 'GET', '/v1/service-templates', { token: T }), 'GET /service-templates');
    check('Permission[]', await call(ctx, 'GET', '/v1/permissions', { token: T }), 'GET /permissions');
    check('SalonSummary[]', await call(ctx, 'GET', '/v1/discover/salons?lat=18.52&lng=73.85&radiusKm=50'), 'GET /discover/salons');
    check('SalonDetail', await call(ctx, 'GET', `/v1/discover/salons/${sid}`), 'GET /discover/salons/:id');

    // booking lifecycle
    const date = slotAt(2, '12:00').slice(0, 10);
    check('Availability', await call(ctx, 'GET', `/v1/salons/${sid}/availability?serviceIds=${o.serviceId}&date=${date}`), 'GET availability');
    const hold = await call(ctx, 'POST', '/v1/bookings/hold', { token: c.token, body: { salonId: sid, staffId: o.staffId, serviceIds: [o.serviceId], startsAt: slotAt(2, '12:00') } });
    check('Booking', hold, 'POST /bookings/hold');
    const conf = await call(ctx, 'POST', `/v1/bookings/${hold.body.data.id}/confirm`, { token: c.token });
    check('Booking', conf, 'POST /bookings/:id/confirm');
    expect(conf.body.data.qrToken).toBeTruthy();
    check('Booking', await call(ctx, 'GET', `/v1/bookings/${hold.body.data.id}`, { token: c.token }), 'GET /bookings/:id');
    check('Booking[]', await call(ctx, 'GET', '/v1/bookings', { token: c.token }), 'GET /bookings');
    check('Booking[]', await call(ctx, 'GET', `/v1/salons/${sid}/bookings`, { token: T }), 'GET salon bookings');
    check('Booking', await call(ctx, 'GET', `/v1/salons/${sid}/bookings/${hold.body.data.id}`, { token: T }), 'GET salon booking');
    const walk = await call(ctx, 'POST', `/v1/salons/${sid}/bookings`, { token: T, body: { customerName: 'Walk', staffId: o.staffId, serviceIds: [o.serviceId], startsAt: slotAt(3, '10:00') } });
    check('Booking', walk, 'POST salon walk-in');
    check('Booking', await call(ctx, 'PATCH', `/v1/salons/${sid}/bookings/${walk.body.data.id}`, { token: T, body: { version: walk.body.data.version, startsAt: slotAt(3, '11:00') } }), 'PATCH reschedule');

    // billing
    const inv = await call(ctx, 'POST', `/v1/salons/${sid}/invoices`, { token: T, body: { bookingId: hold.body.data.id, items: [{ serviceId: o.serviceId, name: 'Haircut', qty: 1, unitPricePaise: 30000 }], payments: [{ methodCode: 'cash', amountPaise: 30000 }] } });
    check('Invoice', inv, 'POST invoices');
    check('Invoice[]', await call(ctx, 'GET', `/v1/salons/${sid}/invoices`, { token: T }), 'GET invoices');
    check('Invoice', await call(ctx, 'GET', `/v1/salons/${sid}/invoices/${inv.body.data.id}`, { token: T }), 'GET invoice');
    check('PaymentMethod[]', await call(ctx, 'GET', `/v1/salons/${sid}/payment-methods`, { token: T }), 'GET payment-methods');

    // reviews
    check('NewReview', await call(ctx, 'POST', `/v1/bookings/${hold.body.data.id}/review`, { token: c.token, body: { rating: 5, comment: 'ok' } }), 'POST booking review');
    const sr = await call(ctx, 'GET', `/v1/salons/${sid}/reviews`, { token: T });
    check('SalonReview[]', sr, 'GET salon reviews');
    check('SalonReview', await call(ctx, 'POST', `/v1/salons/${sid}/reviews/${sr.body.data[0].id}/reply`, { token: T, body: { replyText: 'Thanks!' } }), 'POST reply');
    check('PublicReview[]', await call(ctx, 'GET', `/v1/discover/salons/${sid}/reviews`), 'GET public reviews');

    // salon admin
    check('SalonFull', await call(ctx, 'GET', `/v1/salons/${sid}`, { token: T }), 'GET /salons/:id');
    check('Salon', await call(ctx, 'PATCH', `/v1/salons/${sid}`, { token: T, body: { description: 'Nice place' } }), 'PATCH /salons/:id');
    check('Hours[]', await call(ctx, 'GET', `/v1/salons/${sid}/hours`, { token: T }), 'GET hours');
    const cl = await call(ctx, 'POST', `/v1/salons/${sid}/closures`, { token: T, body: { date: slotAt(20, '12:00').slice(0, 10), reason: 'x' } });
    check('Closure', cl, 'POST closure');
    check('Closure[]', await call(ctx, 'GET', `/v1/salons/${sid}/closures`, { token: T }), 'GET closures');
    check('Service[]', await call(ctx, 'GET', `/v1/salons/${sid}/services`, { token: T }), 'GET services');
    const st = await call(ctx, 'POST', `/v1/salons/${sid}/staff`, { token: T, body: { fullName: 'Sty', email: `s-${randomUUID()}@example.test`, tempPassword: PASSWORD, roleId: o.roleIds['stylist'] } });
    check('Staff', st, 'POST staff');
    check('Staff[]', await call(ctx, 'GET', `/v1/salons/${sid}/staff`, { token: T }), 'GET staff');
    check('ServiceIds', await call(ctx, 'PUT', `/v1/salons/${sid}/staff/${st.body.data.id}/services`, { token: T, body: { serviceIds: [o.serviceId] } }), 'PUT staff services');
    check('StaffHours[]', await call(ctx, 'PUT', `/v1/salons/${sid}/staff/${st.body.data.id}/hours`, { token: T, body: { hours: [{ weekday: 1, start: '10:00', end: '14:00' }] } }), 'PUT staff hours');
    const to = await call(ctx, 'POST', `/v1/salons/${sid}/staff/${st.body.data.id}/time-off`, { token: T, body: { from: slotAt(30, '10:00'), to: slotAt(30, '12:00') } });
    check('TimeOff', to, 'POST time-off');
    check('TimeOff[]', await call(ctx, 'GET', `/v1/salons/${sid}/staff/${st.body.data.id}/time-off`, { token: T }), 'GET time-off');
    check('Role[]', await call(ctx, 'GET', `/v1/salons/${sid}/roles`, { token: T }), 'GET roles');
    check('Role', await call(ctx, 'POST', `/v1/salons/${sid}/roles`, { token: T, body: { name: 'Junior', permissions: ['booking.view'] } }), 'POST role');

    // analytics + customers
    const an = await call(ctx, 'GET', `/v1/salons/${sid}/analytics/summary`, { token: T });
    check('AnalyticsSummary', an, 'GET analytics (full)');
    expect(an.body.data.hourlyHeatMap).toBeDefined();
    expect(typeof an.body.data.repeatCustomerRate).toBe('number');
    const cs = await call(ctx, 'GET', `/v1/salons/${sid}/customers`, { token: T });
    check('Customer[]', cs, 'GET customers');
    check('CustomerDetail', await call(ctx, 'GET', `/v1/salons/${sid}/customers/${encodeURIComponent(cs.body.data[0].id)}`, { token: T }), 'GET customer detail');

    // subscription
    await ctx.pool.query("UPDATE plans SET razorpay_plan_id_monthly = 'plan_pro_m' WHERE code = 'pro'");
    check('SubscriptionView', await call(ctx, 'GET', `/v1/salons/${sid}/subscription`, { token: T }), 'GET subscription');
    check('CheckoutResult', await call(ctx, 'POST', `/v1/salons/${sid}/subscription/checkout`, { token: T, body: { planCode: 'pro', interval: 'monthly' } }), 'POST checkout');
    await ctx.pool.query("INSERT INTO subscription_receipts (salon_id, razorpay_payment_id, amount_paise, receipt_no) VALUES ($1,'pay_contract',129900,'TRM-2026-900001')", [sid]);
    check('Receipt[]', await call(ctx, 'GET', `/v1/salons/${sid}/subscription/receipts`, { token: T }), 'GET receipts');
    check('SubscriptionView', await call(ctx, 'POST', `/v1/salons/${sid}/subscription/cancel`, { token: T }), 'POST subscription cancel');

    // exports
    check('ExportStarted', await call(ctx, 'POST', `/v1/salons/${sid}/analytics/export`, { token: T, body: {} }), 'POST export');

    // admin + sales
    const hash = await (await import('../src/lib/security.js')).makePasswordHasher(1024).hash(PASSWORD);
    const aEmail = `adm-${randomUUID()}@example.test`;
    await ctx.pool.query("INSERT INTO users (email, password_hash, full_name, platform_role) VALUES ($1,$2,'Admin','admin')", [aEmail, hash]);
    const A = (await call(ctx, 'POST', '/v1/auth/login', { body: { identifier: aEmail, password: PASSWORD, client: 'website' } })).body.data.accessToken;
    await call(ctx, 'POST', '/v1/contact', { body: { name: 'N', email: 'n@example.test', message: 'hello there' } });
    const salons = await call(ctx, 'GET', '/v1/admin/salons?limit=5', { token: A });
    check('AdminSalon[]', salons, 'GET /admin/salons');
    check('AdminSalonDetail', await call(ctx, 'GET', `/v1/admin/salons/${sid}`, { token: A }), 'GET /admin/salons/:id');
    check('Salon', await call(ctx, 'PATCH', `/v1/admin/salons/${sid}`, { token: A, body: { status: 'approved' } }), 'PATCH /admin/salons/:id');
    check('CompResult', await call(ctx, 'POST', `/v1/admin/salons/${sid}/comp`, { token: A, body: { until: new Date(Date.now() + 86400_000).toISOString() } }), 'POST comp');
    check('AdminPlan[]', await call(ctx, 'GET', '/v1/admin/plans', { token: A }), 'GET /admin/plans');
    check('AdminStats', await call(ctx, 'GET', '/v1/admin/stats', { token: A }), 'GET /admin/stats');
    check('AdminUser[]', await call(ctx, 'GET', '/v1/admin/users', { token: A }), 'GET /admin/users');
    check('AuditEntry[]', await call(ctx, 'GET', '/v1/admin/audit', { token: A }), 'GET /admin/audit');
    check('ContactMessage[]', await call(ctx, 'GET', '/v1/admin/contact-messages', { token: A }), 'GET contact messages');
    check('QueueHealth', await call(ctx, 'GET', '/v1/admin/queue', { token: A }), 'GET /admin/queue');
    const lead = await call(ctx, 'POST', '/v1/sales/leads', { token: A, body: { salonName: 'Lead Co', city: 'Pune' } });
    check('Lead', lead, 'POST lead');
    check('Lead[]', await call(ctx, 'GET', '/v1/sales/leads', { token: A }), 'GET leads');
    const invite = await call(ctx, 'POST', `/v1/sales/leads/${lead.body.data.id}/invite`, { token: A });
    check('Invite', invite, 'POST invite');
    check('InvitePrefill', await call(ctx, 'GET', `/v1/invites/${invite.body.data.code}`), 'GET /invites/:code');
    check('Pipeline', await call(ctx, 'GET', '/v1/sales/pipeline', { token: A }), 'GET pipeline');

    // founding-salon waitlist
    check('WaitlistStatus', await call(ctx, 'GET', '/v1/waitlist/status'), 'GET /waitlist/status');
    check('WaitlistJoined', await call(ctx, 'POST', '/v1/waitlist', { body: { salonName: 'Wait Salon', ownerName: 'Wendy', email: `wl-${randomUUID()}@example.test`, consent: true } }), 'POST /waitlist');
    check('WaitlistSignup[]', await call(ctx, 'GET', '/v1/admin/waitlist', { token: A }), 'GET /admin/waitlist');

    // webhook ack shape
    expect(problems).toEqual([]);
  }, 120_000);
});
