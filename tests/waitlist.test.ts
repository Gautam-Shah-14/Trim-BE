import { randomBytes, randomUUID } from 'node:crypto';
import type { Transport } from 'nodemailer';
import type { Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConfigError, loadConfig, type Config } from '../src/config.js';
import { createMailer } from '../src/lib/mailer.js';
import { makePasswordHasher } from '../src/lib/security.js';
import { applicantEmail, ownerCopyEmail, WAITLIST_CONFIRMATION, WAITLIST_CONSENT_REMINDER } from '../src/lib/waitlistMail.js';
import { SCHEMAS } from '../src/schemas.js';
import { call, makeCustomer, PASSWORD, startCtx, type Ctx } from './helpers.js';

interface Captured { to: string; from: string; subject: string; text: string; html: string; raw: string }

/** nodemailer Transport that never touches the network: builds the real MIME message and records it */
function fakeTransport() {
  const sent: Captured[] = [];
  const state = { failNext: 0 };
  const transport: Transport = {
    name: 'fake',
    version: '1.0.0',
    send(mail, cb) {
      if (state.failNext > 0) {
        state.failNext--;
        cb(new Error('simulated SMTP failure'), undefined as never);
        return;
      }
      mail.message.build((err: Error | null, raw: Buffer) => {
        if (err) return cb(err, undefined as never);
        const d = mail.data as Record<string, any>;
        sent.push({ to: String(d['to']), from: String(d['from']), subject: String(d['subject']), text: String(d['text']), html: String(d['html']), raw: raw.toString('utf8') });
        cb(null, { envelope: mail.message.getEnvelope(), messageId: mail.message.messageId() } as never);
      });
    },
  };
  return { transport, sent, state };
}

const MAIL_CFG: Config['mail'] = { enabled: true, missing: [], host: 'unused', port: 587, secure: false, user: 'unused', pass: 'unused', from: 'Trim by TokenBurners <waitlist@example.test>', waitlistNotifyTo: '' };
const silentLog = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

const uniqEmail = (p = 'w') => `${p}-${randomBytes(4).toString('hex')}@Example.test`;
const body = (over: Record<string, unknown> = {}) => ({ salonName: 'Glow Studio', ownerName: 'Asha Rao', email: uniqEmail(), phone: '98765 43210', consent: true, source: 'website', ...over });

async function adminToken(ctx: Ctx): Promise<string> {
  const hash = await makePasswordHasher(1024).hash(PASSWORD);
  const email = `adm-${randomUUID()}@example.test`;
  await ctx.pool.query("INSERT INTO users (email, password_hash, full_name, platform_role) VALUES ($1,$2,'Admin','admin')", [email, hash]);
  return (await call(ctx, 'POST', '/v1/auth/login', { body: { identifier: email, password: PASSWORD, client: 'website' } })).body.data.accessToken;
}

describe('waitlist (mailer disabled: no SMTP env)', () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await startCtx();
  });
  afterAll(() => ctx.close());

  it('status is open by default and cacheable', async () => {
    const r = await call(ctx, 'GET', '/v1/waitlist/status');
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ open: true });
    expect(r.headers.get('cache-control')).toMatch(/max-age=30/);
    expect(SCHEMAS['WaitlistStatus']!.safeParse(r.body.data).success).toBe(true);
  });

  it('happy path stores a founding row with created_at, normalised phone and lower-cased email; mailer disabled does not fail', async () => {
    expect(ctx.deps.mailer.enabled).toBe(false);
    const b = body();
    const r = await call(ctx, 'POST', '/v1/waitlist', { body: b });
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe('joined');
    expect(r.body.data.founding).toBe(true);
    expect(SCHEMAS['WaitlistJoined']!.safeParse(r.body.data).success).toBe(true);
    await ctx.deps.queue.drain();
    const row = (await ctx.pool.query('SELECT * FROM waitlist_signups WHERE email = $1', [String(b.email).toLowerCase()])).rows[0];
    expect(row).toBeTruthy();
    expect(row.email).toBe(String(b.email).toLowerCase());
    expect(row.phone).toBe('+919876543210');
    expect(row.founding).toBe(true);
    expect(row.source).toBe('website');
    expect(row.consent_at).toBeInstanceOf(Date);
    expect(new Date(r.body.data.createdAt).getTime()).toBe(row.created_at.getTime());
    expect(row.confirmation_sent_at).toBeNull(); // nothing sent while SMTP is not configured
    expect(row.owner_copy_sent_at).toBeNull();
  });

  it('phone variants normalise to +91XXXXXXXXXX; empty phone means none', async () => {
    for (const [input, want] of [['+91 98765-43210', '+919876543210'], ['919876543211', '+919876543211'], ['09876543212', '+919876543212'], ['(987) 654 3213', '+919876543213'], ['', null]] as const) {
      const b = body({ phone: input });
      const r = await call(ctx, 'POST', '/v1/waitlist', { body: b });
      expect(r.status, input).toBe(201);
      const row = (await ctx.pool.query('SELECT phone FROM waitlist_signups WHERE email = $1', [String(b.email).toLowerCase()])).rows[0];
      expect(row.phone, input).toBe(want);
    }
  });

  it('duplicate e-mail (different case) returns the original createdAt and stores nothing new', async () => {
    const b = body();
    const first = await call(ctx, 'POST', '/v1/waitlist', { body: b });
    expect(first.status).toBe(201);
    const again = await call(ctx, 'POST', '/v1/waitlist', { body: { ...b, email: String(b.email).toUpperCase(), salonName: 'Other Name' } });
    expect(again.status).toBe(201);
    expect(again.body.data).toEqual(first.body.data);
    const n = await ctx.pool.query('SELECT count(*)::int AS n, max(salon_name) AS s FROM waitlist_signups WHERE email = $1', [b.email]);
    expect(n.rows[0]).toEqual({ n: 1, s: 'Glow Studio' });
  });

  it('honeypot: 201 like a success, nothing stored', async () => {
    const b = body({ website: 'http://spam.example' });
    const r = await call(ctx, 'POST', '/v1/waitlist', { body: b });
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe('joined');
    expect((await ctx.pool.query('SELECT 1 FROM waitlist_signups WHERE email = $1', [b.email])).rowCount).toBe(0);
  });

  it('validation: consent missing/false, bad email, bad phone, short names, unknown fields, NUL -> 422', async () => {
    const bad: [string, Record<string, unknown>][] = [
      ['consent missing', { consent: undefined }],
      ['consent false', { consent: false }],
      ['consent "true"', { consent: 'true' }],
      ['bad email', { email: 'not-an-email' }],
      ['long email', { email: `${'a'.repeat(250)}@x.in` }],
      ['phone garbage', { phone: 'call me' }],
      ['phone landline-ish', { phone: '0201234567' }],
      ['phone too long', { phone: '+91987654321099' }],
      ['phone foreign', { phone: '+14155550100' }],
      ['short salon', { salonName: 'A' }],
      ['long owner', { ownerName: 'x'.repeat(81) }],
      ['newline in salon', { salonName: 'Glow\r\nBcc: x@evil.test' }],
      ['unknown field', { extra: 1 }],
      ['long source', { source: 's'.repeat(41) }],
      ['NUL', { ownerName: 'Asha\u0000Rao' }],
    ];
    for (const [label, over] of bad) {
      const b = body(over);
      const r = await call(ctx, 'POST', '/v1/waitlist', { body: b });
      expect(r.status, label).toBe(422);
      expect(r.body.error.code, label).toBe('VALIDATION_FAILED');
    }
    const n = await ctx.pool.query("SELECT count(*)::int AS n FROM waitlist_signups WHERE salon_name LIKE 'Glow%Bcc%'");
    expect(n.rows[0].n).toBe(0);
  });

  it('admin list, CSV and stats; 401 without a token, 403 for non-admins', async () => {
    const A = await adminToken(ctx);
    const c = await makeCustomer(ctx);
    for (const p of ['/v1/admin/waitlist', '/v1/admin/waitlist.csv']) {
      expect((await call(ctx, 'GET', p)).status, p).toBe(401);
      const f = await call(ctx, 'GET', p, { token: c.token });
      expect(f.status, p).toBe(403);
      expect(f.body.error.code).toBe('FORBIDDEN');
    }
    const formula = body({ salonName: '=HYPERLINK("x")', ownerName: 'Me, "quoted"' });
    await call(ctx, 'POST', '/v1/waitlist', { body: formula });

    const page1 = await call(ctx, 'GET', '/v1/admin/waitlist?limit=2', { token: A });
    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(2);
    for (const it of page1.body.data) expect(SCHEMAS['WaitlistSignup']!.safeParse(it).success).toBe(true);
    expect(page1.body.data[0].email).toBe(String(formula.email).toLowerCase()); // newest first
    expect(page1.body.meta.nextCursor).toBeTruthy();
    const page2 = await call(ctx, 'GET', `/v1/admin/waitlist?limit=2&cursor=${page1.body.meta.nextCursor}`, { token: A });
    expect(page2.status).toBe(200);
    expect(page2.body.data[0].id).not.toBe(page1.body.data[1].id);

    const csv = await call(ctx, 'GET', '/v1/admin/waitlist.csv', { token: A });
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toMatch(/text\/csv/);
    expect(csv.headers.get('content-disposition')).toMatch(/attachment; filename="trim-waitlist-\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = String(csv.body).trim().split('\r\n');
    expect(lines[0]).toBe('id,created_at,salon_name,owner_name,email,phone,founding,source,consent_at,confirmation_sent_at,owner_copy_sent_at');
    const total = (await ctx.pool.query('SELECT count(*)::int AS n FROM waitlist_signups')).rows[0].n;
    expect(lines).toHaveLength(total + 1);
    expect(lines[1]).toContain(`"'=HYPERLINK(""x"")"`); // formula neutralised + quoted
    expect(lines[1]).toContain('"Me, ""quoted"""');

    const stats = await call(ctx, 'GET', '/v1/admin/stats', { token: A });
    expect(stats.status).toBe(200);
    expect(stats.body.data.waitlist).toEqual({ total, last7Days: total });
    expect(SCHEMAS['AdminStats']!.safeParse(stats.body.data).success).toBe(true);
  });
});

describe('waitlist e-mail job (fake SMTP transport)', () => {
  let ctx: Ctx;
  const fake = fakeTransport();
  beforeAll(async () => {
    ctx = await startCtx({ WAITLIST_NOTIFY_TO: 'hello@example.test', WEBSITE_URL: 'https://trim.example.test' }, { mailer: createMailer(MAIL_CFG, silentLog, fake.transport) });
  });
  afterAll(() => ctx.close());

  it('sends the confirmation and the owner copy, then sets both timestamps', async () => {
    fake.sent.length = 0;
    const b = body({ salonName: 'Fade & <Co>' });
    const r = await call(ctx, 'POST', '/v1/waitlist', { body: b });
    expect(r.status).toBe(201);
    await ctx.deps.queue.drain();
    expect(fake.sent).toHaveLength(2);
    const [toApplicant, copy] = fake.sent as [Captured, Captured];
    expect(toApplicant.to).toBe(String(b.email).toLowerCase());
    expect(toApplicant.from).toBe('Trim by TokenBurners <waitlist@example.test>');
    expect(toApplicant.subject).toBe("You're on the Trim waitlist");
    expect(toApplicant.text).toContain('You’re on the list. You’ll get a 2-month free trial from your first login after launch. We’ll notify you when Trim is ready.');
    expect(toApplicant.text).toContain('Starter');
    expect(toApplicant.text).toContain('https://trim.example.test/waitlist#terms');
    expect(toApplicant.text).toContain('We’ll message you when Trim is ready. Nothing else.');
    expect(toApplicant.html).toContain('#FFB808');
    expect(toApplicant.html).not.toMatch(/<img/i);
    expect(toApplicant.text + toApplicant.html).not.toContain('Fade'); // no user-supplied text in the applicant e-mail
    expect(copy.to).toBe('hello@example.test');
    expect(copy.subject).toBe('New Trim waitlist signup: Fade & <Co>');
    expect(copy.html).toContain('Fade &amp; &lt;Co&gt;');
    expect(copy.html).not.toContain('<Co>');
    expect(copy.text).toContain('+919876543210');
    expect(copy.text).toMatch(/IST/);
    const row = (await ctx.pool.query('SELECT confirmation_sent_at, owner_copy_sent_at FROM waitlist_signups WHERE email = $1', [b.email])).rows[0];
    expect(row.confirmation_sent_at).toBeInstanceOf(Date);
    expect(row.owner_copy_sent_at).toBeInstanceOf(Date);

    // admin list exposes confirmationSentAt
    const A = await adminToken(ctx);
    const list = await call(ctx, 'GET', '/v1/admin/waitlist?limit=1', { token: A });
    expect(list.body.data[0].confirmationSentAt).toBeTruthy();
  });

  it('a repeat sign-up sends no second e-mail', async () => {
    const b = body();
    await call(ctx, 'POST', '/v1/waitlist', { body: b });
    await ctx.deps.queue.drain();
    fake.sent.length = 0;
    const again = await call(ctx, 'POST', '/v1/waitlist', { body: { ...b, email: String(b.email).toUpperCase() } });
    expect(again.status).toBe(201);
    await ctx.deps.queue.drain();
    expect(fake.sent).toHaveLength(0);
  });

  it('a transient SMTP failure is retried and only the unsent message is re-sent', async () => {
    fake.sent.length = 0;
    fake.state.failNext = 1; // the confirmation fails once, the owner copy goes through on the first attempt
    const b = body();
    expect((await call(ctx, 'POST', '/v1/waitlist', { body: b })).status).toBe(201);
    await ctx.deps.queue.drain();
    expect(fake.sent.map((m) => m.to).sort()).toEqual([String(b.email).toLowerCase(), 'hello@example.test'].sort());
    const row = (await ctx.pool.query('SELECT confirmation_sent_at, owner_copy_sent_at FROM waitlist_signups WHERE email = $1', [b.email])).rows[0];
    expect(row.confirmation_sent_at).toBeInstanceOf(Date);
    expect(row.owner_copy_sent_at).toBeInstanceOf(Date);
  });
});

describe('waitlist closed', () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await startCtx({ WAITLIST_OPEN: 'false' });
  });
  afterAll(() => ctx.close());

  it('status says closed and POST is 409 WAITLIST_CLOSED', async () => {
    expect((await call(ctx, 'GET', '/v1/waitlist/status')).body.data).toEqual({ open: false });
    const b = body();
    const r = await call(ctx, 'POST', '/v1/waitlist', { body: b });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('CONFLICT');
    expect(r.body.error.reason).toBe('WAITLIST_CLOSED');
    expect((await ctx.pool.query('SELECT 1 FROM waitlist_signups WHERE email = $1', [b.email])).rowCount).toBe(0);
  });
});

describe('waitlist rate limit (per client IP, BFF aware)', () => {
  let ctx: Ctx;
  const BFF = randomBytes(16).toString('hex');
  beforeAll(async () => {
    ctx = await startCtx({ RATE_LIMIT_WAITLIST_PER_HOUR: '2', BFF_SHARED_SECRET: BFF });
  });
  afterAll(() => ctx.close());

  it('third sign-up from one IP in an hour is 429 with Retry-After; another BFF client IP has its own bucket', async () => {
    const h = (ip: string) => ({ 'X-Trim-BFF-Key': BFF, 'X-Trim-Client-IP': ip });
    expect((await call(ctx, 'POST', '/v1/waitlist', { body: body(), headers: h('203.0.113.7') })).status).toBe(201);
    expect((await call(ctx, 'POST', '/v1/waitlist', { body: body(), headers: h('203.0.113.7') })).status).toBe(201);
    const third = await call(ctx, 'POST', '/v1/waitlist', { body: body(), headers: h('203.0.113.7') });
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('RATE_LIMITED');
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await call(ctx, 'POST', '/v1/waitlist', { body: body(), headers: h('198.51.100.9') })).status).toBe(201);
  });
});

describe('waitlist mail: config, templates, disabled mailer', () => {
  const base = { NODE_ENV: 'test', DATABASE_URL: 'postgres://x/y', JWT_SECRET: 'j'.repeat(32), QR_SECRET: 'q'.repeat(32) };

  it('mail is disabled unless SMTP_USER, SMTP_PASS and MAIL_FROM are set (host defaults to Brevo)', () => {
    const off = loadConfig(base);
    expect(off.mail.enabled).toBe(false);
    expect(off.mail.missing).toEqual(['SMTP_USER', 'SMTP_PASS', 'MAIL_FROM']);
    expect(off.mail.host).toBe('smtp-relay.brevo.com');
    expect(off.mail.port).toBe(587);
    expect(off.mail.secure).toBe(false);
    expect(off.waitlistOpen).toBe(true);
    expect(off.rateLimit.waitlistPerHour).toBe(10);
    const on = loadConfig({ ...base, SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_FROM: 'Trim by TokenBurners <a@example.test>', SMTP_PORT: '465', SMTP_SECURE: 'true', WAITLIST_OPEN: 'false' });
    expect(on.mail.enabled).toBe(true);
    expect(on.mail.port).toBe(465);
    expect(on.mail.secure).toBe(true);
    expect(on.waitlistOpen).toBe(false);
    expect(() => loadConfig({ ...base, WAITLIST_NOTIFY_TO: 'not an email' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, MAIL_FROM: 'a@b.c\r\nBcc: x@y.z' })).toThrow(ConfigError);
  });

  it('a disabled mailer warns once with key names only and never throws', async () => {
    const warn = vi.fn();
    const m = createMailer({ ...MAIL_CFG, enabled: false, missing: ['SMTP_PASS'], pass: '', user: 'secret-user-value' }, { warn } as unknown as Logger);
    expect(m.enabled).toBe(false);
    await expect(m.send(applicantEmail('a@example.test', 'http://localhost:3000'))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-user-value');
    m.close();
  });

  it('templates: exact copy, escaped input, header-safe subject', async () => {
    const a = applicantEmail('a@example.test', 'https://trim.example.test');
    expect(a.text).toContain(WAITLIST_CONFIRMATION);
    expect(a.text).toContain(WAITLIST_CONSENT_REMINDER);
    expect(a.html).toContain('Trim by TokenBurners');
    expect(a.html).toContain('A TokenBurners product');
    expect(a.html).toContain('https://trim.example.test/waitlist#terms');
    const row = { id: 'x', salon_name: 'Evil\r\nBcc: victim@example.test', owner_name: '<script>alert(1)</script>', email: 'e@example.test', phone: null, founding: true, source: null, consent_at: new Date(), created_at: new Date('2026-11-13T06:30:00Z') };
    const c = ownerCopyEmail('hello@example.test', row);
    expect(c.subject).toBe('New Trim waitlist signup: Evil Bcc: victim@example.test');
    expect(c.subject).not.toMatch(/[\r\n]/);
    expect(c.html).not.toContain('<script>');
    expect(c.html).toContain('&lt;script&gt;');
    expect(c.text).toContain('13 Nov 2026, 12:00 IST');

    // the real nodemailer pipeline: no injected header in the built MIME message
    const fake = fakeTransport();
    const m = createMailer(MAIL_CFG, silentLog, fake.transport);
    await m.send(c);
    const headers = fake.sent[0]!.raw.split('\r\n\r\n')[0]!;
    expect(headers).not.toMatch(/^Bcc:/im);
    expect(headers).toMatch(/^Subject: /m);
    m.close();
  });
});
