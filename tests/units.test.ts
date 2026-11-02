import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { entitlements, type PlanRow, type SubscriptionRow } from '../src/lib/entitlements.js';
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, isPermission } from '../src/lib/permissions.js';
import { signQr, verifyQr } from '../src/lib/qr.js';
import { PASSWORD_RE, signAccess, verifyAccess } from '../src/lib/security.js';
import { parse, z, phoneE164, paise, durationMin, email, password } from '../src/http/validate.js';
import { detectMime } from '../src/modules/media.js';
import { normalizeIdentifier } from '../src/modules/auth.js';
import { verifyRazorpaySignature } from '../src/modules/webhooks.js';

const SECRET = 'q'.repeat(40);

describe('QR tokens', () => {
  const base = { bookingId: 'b1', salonId: 's1', nonce: 'n1', endsAt: new Date('2030-01-01T10:00:00Z') };
  it('round-trips and expires 60 minutes after the booking ends', () => {
    const t = signQr(SECRET, base);
    const v = verifyQr(SECRET, t, new Date('2030-01-01T10:59:00Z'));
    expect(v.ok && v.payload).toMatchObject({ b: 'b1', s: 's1', n: 'n1', e: Date.parse('2030-01-01T11:00:00Z') / 1000 });
    expect(verifyQr(SECRET, t, new Date('2030-01-01T11:00:01Z'))).toEqual({ ok: false, reason: 'expired' });
  });
  it('rejects tampering, wrong secret and garbage', () => {
    const t = signQr(SECRET, base);
    const [p, s] = t.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ b: 'b2', s: 's1', n: 'n1', e: 9999999999 })).toString('base64url');
    expect(verifyQr(SECRET, `${forged}.${s}`, new Date(0))).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyQr('z'.repeat(40), t, new Date(0))).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyQr(SECRET, `${p}.`, new Date(0)).ok).toBe(false);
    expect(verifyQr(SECRET, 'nonsense', new Date(0))).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('entitlements', () => {
  const plan = (code: string, o: Partial<PlanRow>): PlanRow => ({ code, name: code, max_branches: 1, max_staff: 3, custom_roles: false, desktop_access: false, analytics_level: 'basic', csv_export: false, bill_templates: false, ...o });
  const plans = { starter: plan('starter', {}), pro: plan('pro', { max_branches: 3, max_staff: null, custom_roles: true, desktop_access: true, analytics_level: 'full', csv_export: true, bill_templates: true }) };
  const now = new Date('2026-11-10T00:00:00Z');
  const day = 86_400_000;
  const sub = (o: Partial<SubscriptionRow>): SubscriptionRow => ({ plan_code: 'starter', status: 'active', trial_ends_at: null, current_period_end: null, comp_until: null, past_due_since: null, ...o });

  it('trial gives Pro limits, expired trial is read-only', () => {
    const e = entitlements(sub({ status: 'trialing', plan_code: 'pro', trial_ends_at: new Date(+now + day) }), plans, now);
    expect(e.planCode).toBe('pro');
    expect(e.limits.maxStaff).toBeNull();
    expect(e.readOnly).toBe(false);
    const x = entitlements(sub({ status: 'trialing', plan_code: 'pro', trial_ends_at: new Date(+now - 1) }), plans, now);
    expect(x.readOnly).toBe(true);
    expect(x.discoverable).toBe(false);
  });
  it('active starter has starter limits', () => {
    const e = entitlements(sub({}), plans, now);
    expect(e.limits).toMatchObject({ maxStaff: 3, customRoles: false, desktopAccess: false, analyticsLevel: 'basic', csvExport: false });
  });
  it('past_due keeps full access for 7 days then goes read-only', () => {
    expect(entitlements(sub({ status: 'past_due', past_due_since: new Date(+now - 6 * day) }), plans, now).readOnly).toBe(false);
    const late = entitlements(sub({ status: 'past_due', past_due_since: new Date(+now - 8 * day) }), plans, now);
    expect(late.readOnly).toBe(true);
  });
  it.each(['halted', 'cancelled', 'expired'] as const)('%s is read-only', (status) => {
    expect(entitlements(sub({ status }), plans, now).readOnly).toBe(true);
  });
  it('comp_until restores access until it passes', () => {
    expect(entitlements(sub({ status: 'expired', comp_until: new Date(+now + day) }), plans, now).readOnly).toBe(false);
    expect(entitlements(sub({ status: 'expired', comp_until: new Date(+now - day) }), plans, now).readOnly).toBe(true);
  });
});

describe('RBAC defaults', () => {
  it('matches the spec grants', () => {
    expect(ALL_PERMISSIONS).toHaveLength(18);
    expect(DEFAULT_ROLE_PERMISSIONS.owner).toEqual(ALL_PERMISSIONS);
    expect(DEFAULT_ROLE_PERMISSIONS.manager).toContain('payments.configure');
    expect(DEFAULT_ROLE_PERMISSIONS.manager).not.toContain('roles.manage');
    expect(DEFAULT_ROLE_PERMISSIONS.receptionist).toEqual(expect.arrayContaining(['booking.create', 'billing.create', 'checkin.scan', 'customers.view']));
    expect(DEFAULT_ROLE_PERMISSIONS.receptionist).not.toContain('billing.void');
    expect([...DEFAULT_ROLE_PERMISSIONS.stylist].sort()).toEqual(['booking.view', 'checkin.scan', 'services.view']);
    expect(isPermission('booking.view')).toBe(true);
    expect(isPermission('root')).toBe(false);
  });
});

describe('validation helpers', () => {
  it('phones must be E.164', () => {
    expect(phoneE164.safeParse('+919876543210').success).toBe(true);
    expect(phoneE164.safeParse('9876543210').success).toBe(false);
    expect(phoneE164.safeParse('+0123').success).toBe(false);
  });
  it('prices 0..₹1,00,000 and durations 5..480', () => {
    expect(paise.safeParse(10_000_000).success).toBe(true);
    expect(paise.safeParse(10_000_001).success).toBe(false);
    expect(paise.safeParse(-1).success).toBe(false);
    expect(paise.safeParse(1.5).success).toBe(false);
    expect(durationMin.safeParse(4).success).toBe(false);
    expect(durationMin.safeParse(480).success).toBe(true);
    expect(durationMin.safeParse(481).success).toBe(false);
  });
  it('password policy and email normalisation', () => {
    expect(PASSWORD_RE.test('abcdefg1')).toBe(true);
    expect(PASSWORD_RE.test('abcdefgh')).toBe(false);
    expect(PASSWORD_RE.test('a1')).toBe(false);
    expect(password.safeParse('12345678').success).toBe(false);
    expect(email.parse('  Foo@Example.COM ')).toBe('foo@example.com');
  });
  it('parse() trims, rejects unknown fields and reports field paths', () => {
    const s = z.strictObject({ name: z.string().trim().min(1), n: z.number().int().min(1).max(5) });
    expect(parse(s, { name: '  x  ', n: 3 })).toEqual({ name: 'x', n: 3 });
    try {
      parse(s, { name: 'x', n: 9, extra: 1 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      const err = e as AppError;
      expect(err.code).toBe('VALIDATION_FAILED');
      expect(err.status).toBe(422);
      expect(JSON.stringify(err.details)).toContain('unknown field');
    }
  });
  it('login identifiers are normalised', () => {
    expect(normalizeIdentifier('Foo@Bar.com')).toEqual({ kind: 'email', value: 'foo@bar.com' });
    expect(normalizeIdentifier('98765 43210')).toEqual({ kind: 'phone', value: '+919876543210' });
    expect(normalizeIdentifier('+919876543210')).toEqual({ kind: 'phone', value: '+919876543210' });
  });
});

describe('image magic bytes', () => {
  it('detects jpeg/png/webp and rejects others', () => {
    expect(detectMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe('image/jpeg');
    expect(detectMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(detectMime(Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 ')]))).toBe('image/webp');
    expect(detectMime(Buffer.from('<svg xmlns=...>'))).toBeNull();
    expect(detectMime(Buffer.from('GIF89a'))).toBeNull();
  });
});

describe('config and tokens', () => {
  it('fails fast with a clear message', () => {
    expect(() => loadConfig({ NODE_ENV: 'development' })).toThrow(ConfigError);
    try {
      loadConfig({ DATABASE_URL: 'x', JWT_SECRET: 'short', QR_SECRET: SECRET });
    } catch (e) {
      expect((e as Error).message).toContain('JWT_SECRET');
    }
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'x', JWT_SECRET: SECRET, QR_SECRET: SECRET })).toThrow(/RAZORPAY/);
  });
  it('access tokens are HS256 and verified', () => {
    const t = signAccess(SECRET, { sub: 'u', role: 'customer', sid: 's' });
    expect(verifyAccess(SECRET, t)).toEqual({ sub: 'u', role: 'customer', sid: 's' });
    expect(verifyAccess('o'.repeat(40), t)).toBeNull();
    expect(verifyAccess(SECRET, 'a.b.c')).toBeNull();
  });
  it('razorpay signature check is constant-time hex HMAC', () => {
    const raw = Buffer.from('{"a":1}');
    const sig = createHmac('sha256', SECRET).update(raw).digest('hex');
    expect(verifyRazorpaySignature(raw, sig, SECRET)).toBe(true);
    expect(verifyRazorpaySignature(raw, sig.replace(/.$/, '0'), SECRET)).toBe(sig.endsWith('0'));
    expect(verifyRazorpaySignature(raw, undefined, SECRET)).toBe(false);
    expect(verifyRazorpaySignature(Buffer.from('{"a":2}'), sig, SECRET)).toBe(false);
  });
});
