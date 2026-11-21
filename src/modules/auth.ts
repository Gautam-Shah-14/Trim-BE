import { randomInt, randomBytes } from 'node:crypto';
import type { Request } from 'express';
import type pg from 'pg';
import jwt from 'jsonwebtoken';
import { Api, bumpUser, getPlans, send } from '../http/api.js';
import { loginLimiter, registerLimiter, refreshLimiter } from '../http/rateLimit.js';
import { parse, z, str, optStr, phoneE164, email, password } from '../http/validate.js';
import { E, AppError } from '../errors.js';
import { withTx, isPgError } from '../db.js';
import { entitlements, type SubscriptionRow } from '../lib/entitlements.js';
import { ACCESS_TTL_SECONDS, REFRESH_TTL_MS, newId, newRefreshToken, sha256Hex, signAccess } from '../lib/security.js';
import { audit, auditReq } from '../lib/audit.js';
import { createSalonWithDefaults } from '../lib/salons.js';
import { isValidTimezone } from '../lib/slots.js';
import { otpEmail } from '../lib/otpMail.js';
import { generateSecret, otpAuthUrl, verifyTotp, encryptSecret, decryptSecret, generateBackupCodes } from '../lib/totp.js';
import type { Deps } from '../http/types.js';

const CLIENTS = ['customer_app', 'salon_app', 'desktop', 'website'] as const;

interface UserRow {
  id: string;
  phone_e164: string | null;
  email: string | null;
  full_name: string;
  platform_role: 'customer' | 'salon_user' | 'admin' | 'sales_agent';
  avatar_media_id: string | null;
  must_change_password: boolean;
  is_active: boolean;
}

export const userDto = (u: UserRow) => ({
  id: u.id,
  fullName: u.full_name,
  phone: u.phone_e164,
  email: u.email,
  role: u.platform_role,
  avatarMediaId: u.avatar_media_id,
  mustChangePassword: u.must_change_password,
});

/** Accepts +E.164, 10-digit Indian mobile numbers, or an e-mail address. */
export function normalizeIdentifier(raw: string): { kind: 'phone' | 'email'; value: string } {
  const s = raw.trim();
  if (s.includes('@')) return { kind: 'email', value: s.toLowerCase() };
  const digits = s.replace(/[\s-]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(digits)) return { kind: 'phone', value: digits };
  if (/^[6-9]\d{9}$/.test(digits)) return { kind: 'phone', value: `+91${digits}` };
  if (/^91[6-9]\d{9}$/.test(digits)) return { kind: 'phone', value: `+${digits}` };
  return { kind: 'phone', value: digits };
}

export async function loadMemberships(pool: pg.Pool | pg.PoolClient, userId: string) {
  const r = await pool.query<{
    salon_id: string; salon_name: string; salon_status: string; role_id: string; role_name: string; staff_id: string; perms: string[];
    plan_code: string; sub_status: SubscriptionRow['status']; trial_ends_at: Date | null; current_period_end: Date | null;
    comp_until: Date | null; past_due_since: Date | null; founding_trial: boolean;
  }>(
    `SELECT s.id AS salon_id, s.name AS salon_name, s.status AS salon_status, r.id AS role_id, r.name AS role_name, st.id AS staff_id,
            COALESCE(array_agg(p.permission) FILTER (WHERE p.permission IS NOT NULL), '{}') AS perms,
            sub.plan_code, sub.status AS sub_status, sub.trial_ends_at, sub.current_period_end, sub.comp_until, sub.past_due_since, sub.founding_trial
       FROM salon_staff st
       JOIN salons s ON s.id = st.salon_id
       JOIN salon_roles r ON r.id = st.role_id
       JOIN subscriptions sub ON sub.salon_id = s.id
       LEFT JOIN salon_role_permissions p ON p.role_id = r.id
      WHERE st.user_id = $1 AND st.is_active
      GROUP BY s.id, r.id, st.id, sub.id
      ORDER BY s.created_at`,
    [userId],
  );
  const plans = await getPlans(pool as pg.Pool);
  return r.rows.map((m) => {
    const ent = entitlements(
      { plan_code: m.plan_code, status: m.sub_status, trial_ends_at: m.trial_ends_at, current_period_end: m.current_period_end, comp_until: m.comp_until, past_due_since: m.past_due_since, founding_trial: m.founding_trial },
      plans,
    );
    const suspended = m.salon_status === 'suspended';
    return {
      salonId: m.salon_id,
      salonName: m.salon_name,
      salonStatus: m.salon_status,
      staffId: m.staff_id,
      roleId: m.role_id,
      roleName: m.role_name,
      permissions: m.perms,
      planCode: ent.planCode,
      subscriptionStatus: ent.effectiveStatus,
      readOnly: ent.readOnly || suspended,
      desktopAccess: ent.limits.desktopAccess,
    };
  });
}

async function issueSession(db: pg.Pool | pg.PoolClient, deps: Deps, user: UserRow, o: { deviceLabel?: string | null; client?: string | null; familyId?: string }) {
  const refreshToken = newRefreshToken();
  const sessionId = newId();
  await db.query(
    `INSERT INTO sessions (id, user_id, refresh_token_hash, family_id, device_label, client, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [sessionId, user.id, sha256Hex(refreshToken), o.familyId ?? newId(), o.deviceLabel ?? null, o.client ?? null, new Date(Date.now() + REFRESH_TTL_MS)],
  );
  const accessToken = signAccess(deps.config.jwtSecret, { sub: user.id, role: user.platform_role, sid: sessionId });
  return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS, sessionId };
}

async function authResult(db: pg.Pool | pg.PoolClient, deps: Deps, user: UserRow, o: { deviceLabel?: string | null; client?: string | null }) {
  const tokens = await issueSession(db, deps, user, o);
  const memberships = await loadMemberships(db, user.id);
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
    user: userDto(user),
    memberships: memberships.map((m) => ({ ...m })),
  };
}

const USER_COLS = 'id, phone_e164, email, full_name, platform_role, avatar_media_id, must_change_password, is_active';

const registerSchema = z.strictObject({
  fullName: str(120),
  phone: phoneE164.optional(),
  email: email.optional(),
  emailVerificationToken: z.string().max(200).optional(),
  password,
  deviceLabel: optStr(100),
  client: z.enum(CLIENTS).optional(),
});

const ownerSchema = z.strictObject({
  fullName: str(120),
  phone: phoneE164,
  email,
  emailVerificationToken: z.string().min(1).max(200),
  password,
  inviteCode: optStr(64),
  salon: z.strictObject({
    name: str(120),
    city: optStr(80),
    state: optStr(80),
    addressLine: optStr(200),
    pincode: optStr(12),
    phone: phoneE164.optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    timezone: z.string().refine(isValidTimezone, 'unknown IANA timezone').optional(),
    description: optStr(1000),
  }),
});

const loginSchema = z.strictObject({
  identifier: str(254),
  password: z.string().min(1).max(128),
  deviceLabel: optStr(100),
  client: z.enum(CLIENTS),
});

function conflictFromUnique(err: unknown): AppError | null {
  if (isPgError(err, '23505')) {
    const c = (err as { constraint?: string }).constraint ?? '';
    if (c.includes('phone')) return E.conflict('An account with this phone already exists', 'PHONE_TAKEN');
    if (c.includes('email')) return E.conflict('An account with this email already exists', 'EMAIL_TAKEN');
  }
  return null;
}

export function register(api: Api) {
  const { deps } = api;
  const { config } = deps;
  let dummy: Promise<string> | null = null; // hash of a random string; equalises timing for unknown users

  api.post('/auth/register', { summary: 'Customer sign-up', tag: 'Auth', auth: 'none', body: registerSchema, returns: 'AuthResult', status: 201 }, async (req, res) => {
    const b = parse(registerSchema, req.body);
    if (!b.phone && !b.email) throw E.validation('Provide a phone or an email', [{ field: 'phone', issue: 'phone or email is required' }]);
    // If email is provided, require a valid email verification token
    if (b.email) {
      if (!b.emailVerificationToken) throw E.validation('Email must be verified before registration', [{ field: 'emailVerificationToken', issue: 'required when email is provided' }]);
      const valid = await consumeEmailVerificationToken(deps.pool, b.email, b.emailVerificationToken);
      if (!valid) throw E.validation('Email verification token is invalid or expired', [{ field: 'emailVerificationToken', issue: 'invalid or expired' }]);
    }
    const hash = await deps.hasher.hash(b.password);
    try {
      const out = await withTx(deps.pool, async (c) => {
        const u = await c.query<UserRow>(
          `INSERT INTO users (phone_e164, email, password_hash, full_name, platform_role) VALUES ($1,$2,$3,$4,'customer') RETURNING ${USER_COLS}`,
          [b.phone ?? null, b.email ?? null, hash, b.fullName],
        );
        return authResult(c, deps, u.rows[0]!, { deviceLabel: b.deviceLabel, client: b.client ?? 'customer_app' });
      });
      send(res, out, undefined, 201);
    } catch (err) {
      throw conflictFromUnique(err) ?? err;
    }
  }, [registerLimiter('register', () => config.rateLimit.registerPerHour)]);

  api.post('/auth/register-owner', { summary: 'Register a salon owner (creates pending salon + 14-day Pro trial)', tag: 'Auth', auth: 'none', body: ownerSchema, returns: 'AuthResult', status: 201 }, async (req, res) => {
    const b = parse(ownerSchema, req.body);
    // Email verification is mandatory for owners
    const emailValid = await consumeEmailVerificationToken(deps.pool, b.email, b.emailVerificationToken);
    if (!emailValid) throw E.validation('Email verification token is invalid or expired', [{ field: 'emailVerificationToken', issue: 'invalid or expired' }]);
    const hash = await deps.hasher.hash(b.password);
    try {
      const out = await withTx(deps.pool, async (c) => {
        let leadId: string | null = null;
        if (b.inviteCode) {
          const inv = await c.query<{ lead_id: string }>(
            'UPDATE lead_invites SET used_at = now() WHERE code = $1 AND used_at IS NULL AND expires_at > now() RETURNING lead_id',
            [b.inviteCode],
          );
          if (!inv.rows[0]) throw E.validation('Invite code is invalid or expired', [{ field: 'inviteCode', issue: 'invalid or expired' }]);
          leadId = inv.rows[0].lead_id;
        }
        const u = await c.query<UserRow>(
          `INSERT INTO users (phone_e164, email, password_hash, full_name, platform_role) VALUES ($1,$2,$3,$4,'salon_user') RETURNING ${USER_COLS}`,
          [b.phone, b.email, hash, b.fullName],
        );
        const user = u.rows[0]!;
        // Check if this email is on the founding waitlist
        const wl = await c.query<{ id: string; founding: boolean }>(
          'SELECT id, founding FROM waitlist_signups WHERE email = $1 AND founding = true AND matched_salon_id IS NULL',
          [b.email],
        );
        const isFoundingTrial = !!wl.rows[0];
        const salon = await createSalonWithDefaults(c, { ...b.salon, createdBy: user.id, ownerUserId: user.id, ownerDisplayName: b.fullName, foundingTrial: isFoundingTrial });
        if (wl.rows[0]) {
          await c.query('UPDATE waitlist_signups SET matched_salon_id = $2 WHERE id = $1', [wl.rows[0].id, salon.salonId]);
        }
        if (leadId) await c.query("UPDATE leads SET stage = 'trial', updated_at = now() WHERE id = $1 AND stage IN ('new','contacted')", [leadId]);
        const result = await authResult(c, deps, user, { client: 'website' });
        await audit(c, { actorUserId: user.id, salonId: salon.salonId, action: 'salon.registered', entity: 'salon', entityId: salon.salonId, ip: req.ip });
        return { ...result, salon: { id: salon.salonId, name: b.salon.name, status: 'pending' } };
      });
      send(res, out, undefined, 201);
    } catch (err) {
      throw conflictFromUnique(err) ?? err;
    }
  }, [registerLimiter('register-owner', () => config.rateLimit.registerPerHour)]);

  api.post('/auth/login', { summary: 'Log in with phone/email + password', tag: 'Auth', auth: 'none', body: loginSchema, returns: 'AuthResult', note: 'client=desktop requires the desktop_access entitlement (403 PLAN_LIMIT)' }, async (req, res) => {
    const b = parse(loginSchema, req.body);
    const id = normalizeIdentifier(b.identifier);
    const col = id.kind === 'email' ? 'email' : 'phone_e164';
    const r = await deps.pool.query<UserRow & { password_hash: string; locked_until: Date | null }>(
      `SELECT ${USER_COLS}, password_hash, locked_until FROM users WHERE ${col} = $1`,
      [id.value],
    );
    const u = r.rows[0];
    if (!u) {
      await deps.hasher.verify(await (dummy ??= deps.hasher.hash(newRefreshToken())), b.password); // keep timing similar
      throw E.unauth('Invalid credentials');
    }
    if (u.locked_until && u.locked_until.getTime() > Date.now()) {
      const retryAfterSec = Math.max(1, Math.ceil((u.locked_until.getTime() - Date.now()) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      throw new AppError('RATE_LIMITED', 'Account temporarily locked after too many failed attempts', { lockedUntil: u.locked_until.toISOString(), retryAfterSec });
    }
    const ok = await deps.hasher.verify(u.password_hash, b.password);
    if (!ok) {
      await deps.pool.query(
        `UPDATE users SET
           locked_until = CASE WHEN failed_login_count + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END,
           failed_login_count = CASE WHEN failed_login_count + 1 >= 5 THEN 0 ELSE failed_login_count + 1 END
         WHERE id = $1`,
        [u.id],
      );
      throw E.unauth('Invalid credentials');
    }
    if (!u.is_active) throw E.unauth('Account is deactivated');
    await deps.pool.query('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1 AND (failed_login_count <> 0 OR locked_until IS NOT NULL)', [u.id]);

    // Activate founding trial on first login: set trial_ends_at = now + 60 days
    if (u.platform_role === 'salon_user') {
      await deps.pool.query(
        `UPDATE subscriptions SET trial_ends_at = now() + interval '60 days', updated_at = now()
         WHERE salon_id IN (SELECT salon_id FROM salon_staff WHERE user_id = $1 AND is_active)
           AND founding_trial = true AND trial_ends_at IS NULL AND status = 'trialing'`,
        [u.id],
      );
    }

    // Client-role gate: customer_app is for customers only
    if (b.client === 'customer_app' && u.platform_role === 'salon_user') {
      throw E.forbidden('This account is registered as a salon owner. Please use the Salon app.');
    }

    if (b.client === 'desktop' || b.client === 'salon_app') {
      const m = await loadMemberships(deps.pool, u.id);
      if (u.platform_role !== 'admin') {
        if (m.length === 0) throw E.forbidden('This account is not a member of any salon');
        if (b.client === 'desktop' && !m.some((x) => x.desktopAccess)) {
          throw E.planLimit('The desktop app requires the Pro plan', 'desktop_access');
        }
      }
    }

    // MFA check: if user has MFA enabled, return mfaRequired instead of full auth
    const mfaCheck = await deps.pool.query<{ mfa_enabled: boolean }>('SELECT mfa_enabled FROM users WHERE id = $1', [u.id]);
    if (mfaCheck.rows[0]?.mfa_enabled) {
      const mfaToken = jwt.sign({ sub: u.id, purpose: 'mfa' }, config.jwtSecret, { algorithm: 'HS256', expiresIn: 300 });
      send(res, { mfaRequired: true, mfaToken });
      return;
    }

    const out = await authResult(deps.pool, deps, u, { deviceLabel: b.deviceLabel, client: b.client });
    send(res, out);
  }, [loginLimiter(config.rateLimit.loginPer15Min)]);

  const refreshSchema = z.strictObject({ refreshToken: z.string().min(20).max(200) });
  api.post('/auth/refresh', { summary: 'Rotate the refresh token', tag: 'Auth', auth: 'none', body: refreshSchema, returns: 'AuthTokens', note: 'Reusing an already-rotated token revokes the whole session family' }, async (req, res) => {
    const b = parse(refreshSchema, req.body);
    const hash = sha256Hex(b.refreshToken);
    const result = await withTx(deps.pool, async (c) => {
      const s = await c.query<{ id: string; user_id: string; family_id: string; revoked_at: Date | null; expires_at: Date; device_label: string | null; client: string | null }>(
        'SELECT id, user_id, family_id, revoked_at, expires_at, device_label, client FROM sessions WHERE refresh_token_hash = $1 FOR UPDATE',
        [hash],
      );
      const row = s.rows[0];
      if (!row) return { err: E.unauth('Invalid refresh token') };
      if (row.revoked_at) {
        // reuse detection: kill the family
        await c.query('UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()), replaced_by = NULL WHERE family_id = $1', [row.family_id]);
        return { err: E.unauth('Refresh token reuse detected; please log in again'), reuse: row };
      }
      if (row.expires_at.getTime() < Date.now()) return { err: E.unauth('Refresh token expired') };
      const u = await c.query<UserRow>(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [row.user_id]);
      const user = u.rows[0];
      if (!user || !user.is_active) return { err: E.unauth('Account is deactivated') };
      const tokens = await issueSession(c, deps, user, { deviceLabel: row.device_label, client: row.client, familyId: row.family_id });
      await c.query('UPDATE sessions SET revoked_at = now(), replaced_by = $2 WHERE id = $1', [row.id, tokens.sessionId]);
      return { tokens, user };
    });
    await deps.cache.bump(`user:${'tokens' in result && result.user ? result.user.id : ('reuse' in result && result.reuse ? result.reuse.user_id : '')}`);
    if ('err' in result) {
      if ('reuse' in result && result.reuse) {
        await audit(deps.pool, { actorUserId: result.reuse.user_id, action: 'auth.refresh_reuse', entity: 'session', entityId: result.reuse.id, ip: req.ip });
      }
      throw result.err;
    }
    send(res, { accessToken: result.tokens.accessToken, refreshToken: result.tokens.refreshToken, expiresIn: result.tokens.expiresIn });
  }, [refreshLimiter(Math.max(10, Math.round(config.rateLimit.generalPerMin / 5)))]);

  api.post('/auth/logout', { summary: 'Revoke the current session', tag: 'Auth', auth: 'user' }, async (req, res) => {
    await deps.pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [req.auth!.sessionId]);
    bumpUser(res, req.auth!.userId);
    send(res, { ok: true });
  });

  // OTP and MFA endpoints
  registerOtpEndpoints(api);
  registerMfaEndpoints(api);

  api.post('/auth/logout-all', { summary: 'Revoke every session of the user', tag: 'Auth', auth: 'user' }, async (req, res) => {
    await deps.pool.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [req.auth!.userId]);
    bumpUser(res, req.auth!.userId);
    send(res, { ok: true });
  });

  const changePw = z.strictObject({ currentPassword: z.string().min(1).max(128), newPassword: password });
  api.post('/auth/change-password', { summary: 'Change password (revokes other sessions)', tag: 'Auth', auth: 'user', body: changePw }, async (req, res) => {
    const b = parse(changePw, req.body);
    const r = await deps.pool.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [req.auth!.userId]);
    if (!(await deps.hasher.verify(r.rows[0]!.password_hash, b.currentPassword))) throw E.unauth('Current password is incorrect');
    const hash = await deps.hasher.hash(b.newPassword);
    await withTx(deps.pool, async (c) => {
      await c.query('UPDATE users SET password_hash = $2, must_change_password = false, updated_at = now() WHERE id = $1', [req.auth!.userId, hash]);
      await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [req.auth!.userId, req.auth!.sessionId]);
    });
    bumpUser(res, req.auth!.userId);
    await auditReq(req, { action: 'auth.password_changed', entity: 'user', entityId: req.auth!.userId });
    send(res, { ok: true });
  });
}

// ---- Email OTP helpers ----

/** Verify and consume an email verification token. Returns true if valid. */
async function consumeEmailVerificationToken(pool: pg.Pool, emailAddr: string, token: string): Promise<boolean> {
  const tokenHash = sha256Hex(token);
  // The row has used_at set when verify-otp was called; we DELETE to consume the one-time token
  const r = await pool.query<{ id: string }>(
    `DELETE FROM email_otps
     WHERE token_hash = $1 AND email = $2 AND used_at IS NOT NULL AND expires_at > now()
     RETURNING id`,
    [tokenHash, emailAddr.toLowerCase()],
  );
  return r.rowCount! > 0;
}

/** OTP send/verify endpoints */
function registerOtpEndpoints(api: Api) {
  const { deps } = api;
  const { config } = deps;

  const sendOtpSchema = z.strictObject({ email });

  api.post('/auth/send-otp', {
    summary: 'Send a 6-digit verification OTP to an email address',
    tag: 'Auth', auth: 'none', body: sendOtpSchema, returns: 'Ok', note: 'Rate-limited: 5/email/hour, 20/IP/hour',
  }, async (req, res) => {
    const b = parse(sendOtpSchema, req.body);
    const addr = b.email.toLowerCase();

    // Rate limit per email
    const emailLimit = await deps.limiter.consume(`otp-email:${addr}`, config.rateLimit.otpPerEmailPerHour, 3_600_000);
    if (!emailLimit.allowed) {
      res.setHeader('Retry-After', String(emailLimit.retryAfterSec));
      throw new AppError('RATE_LIMITED', 'Too many OTP requests for this email, try again later', { retryAfterSec: emailLimit.retryAfterSec });
    }

    // Check max 5 active (unused, unexpired) OTPs per email
    const active = await deps.pool.query<{ cnt: string }>(
      "SELECT count(*)::text AS cnt FROM email_otps WHERE email = $1 AND used_at IS NULL AND expires_at > now()",
      [addr],
    );
    if (parseInt(active.rows[0]!.cnt) >= 5) {
      throw new AppError('RATE_LIMITED', 'Too many pending verification codes for this email');
    }

    // Generate 6-digit OTP
    const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const otpHash = sha256Hex(otp);
    const expiresAt = new Date(Date.now() + 5 * 60_000); // 5 minutes

    await deps.pool.query(
      'INSERT INTO email_otps (email, otp_hash, expires_at) VALUES ($1, $2, $3)',
      [addr, otpHash, expiresAt],
    );

    // Send email (best-effort)
    if (deps.mailer.enabled) {
      const msg = otpEmail(addr, otp);
      await deps.mailer.send(msg).catch((err) => {
        deps.log.error({ err, email: addr }, 'failed to send OTP email');
      });
    }

    send(res, { ok: true as const });
  }, [registerLimiter('otp-ip', () => config.rateLimit.otpPerIpPerHour)]);

  const verifyOtpSchema = z.strictObject({ email, code: z.string().regex(/^\d{6}$/, 'must be a 6-digit code') });

  api.post('/auth/verify-otp', {
    summary: 'Verify an email OTP and get a one-time verification token',
    tag: 'Auth', auth: 'none', body: verifyOtpSchema, returns: 'EmailVerificationResult',
  }, async (req, res) => {
    const b = parse(verifyOtpSchema, req.body);
    const addr = b.email.toLowerCase();
    const otpHash = sha256Hex(b.code);

    // Find matching unused, unexpired OTP
    const r = await deps.pool.query<{ id: string }>(
      `SELECT id FROM email_otps
       WHERE email = $1 AND otp_hash = $2 AND used_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [addr, otpHash],
    );

    if (!r.rows[0]) {
      throw E.validation('Invalid or expired verification code', [{ field: 'code', issue: 'invalid or expired' }]);
    }

    // Generate a one-time verification token
    const verificationToken = randomBytes(32).toString('base64url');
    const tokenHash = sha256Hex(verificationToken);
    const tokenExpires = new Date(Date.now() + 15 * 60_000); // 15 minutes

    // Mark OTP as used and store the token hash
    await deps.pool.query(
      'UPDATE email_otps SET used_at = now(), token_hash = $2, expires_at = $3 WHERE id = $1',
      [r.rows[0].id, tokenHash, tokenExpires],
    );

    send(res, { emailVerificationToken: verificationToken });
  }, [registerLimiter('verify-otp-ip', () => config.rateLimit.otpPerIpPerHour)]);
}

// ---- MFA endpoints ----

function registerMfaEndpoints(api: Api) {
  const { deps } = api;
  const { config } = deps;

  api.post('/auth/mfa/setup', {
    summary: 'Generate a TOTP secret for MFA setup (returns QR code)',
    tag: 'Auth', auth: 'user', returns: 'MfaSetup',
  }, async (req, res) => {
    if (!config.mfaEncryptionKey) throw E.conflict('MFA is not configured on this server', 'MFA_NOT_CONFIGURED');
    const userId = req.auth!.userId;

    // Check if already enabled
    const u = await deps.pool.query<{ mfa_enabled: boolean; email: string | null }>('SELECT mfa_enabled, email FROM users WHERE id = $1', [userId]);
    if (u.rows[0]?.mfa_enabled) throw E.conflict('MFA is already enabled', 'MFA_ALREADY_ENABLED');
    if (!u.rows[0]?.email) throw E.validation('An email address is required for MFA setup', [{ field: 'email', issue: 'required for MFA' }]);

    const secret = generateSecret();
    const url = otpAuthUrl(secret, u.rows[0].email);
    const encrypted = encryptSecret(secret, config.mfaEncryptionKey);

    // Store encrypted secret (not yet enabled)
    await deps.pool.query('UPDATE users SET mfa_secret_encrypted = $2, updated_at = now() WHERE id = $1', [userId, encrypted]);

    // Generate QR code as data URL
    let qrDataUrl = '';
    try {
      const QRCode = await import('qrcode');
      qrDataUrl = await QRCode.toString(url, { type: 'svg' });
      qrDataUrl = `data:image/svg+xml;base64,${Buffer.from(qrDataUrl).toString('base64')}`;
    } catch {
      // QR generation failed, client can use the secret manually
    }

    send(res, { secret, otpAuthUrl: url, qrDataUrl });
  });

  const verifySetupSchema = z.strictObject({ code: z.string().regex(/^\d{6}$/, 'must be a 6-digit code') });

  api.post('/auth/mfa/verify-setup', {
    summary: 'Verify TOTP code to complete MFA setup, returns backup codes',
    tag: 'Auth', auth: 'user', body: verifySetupSchema, returns: 'MfaBackupCodes',
  }, async (req, res) => {
    if (!config.mfaEncryptionKey) throw E.conflict('MFA is not configured on this server', 'MFA_NOT_CONFIGURED');
    const b = parse(verifySetupSchema, req.body);
    const userId = req.auth!.userId;

    const u = await deps.pool.query<{ mfa_enabled: boolean; mfa_secret_encrypted: string | null }>(
      'SELECT mfa_enabled, mfa_secret_encrypted FROM users WHERE id = $1', [userId],
    );
    if (u.rows[0]?.mfa_enabled) throw E.conflict('MFA is already enabled', 'MFA_ALREADY_ENABLED');
    if (!u.rows[0]?.mfa_secret_encrypted) throw E.validation('Call /auth/mfa/setup first', [{ field: 'code', issue: 'no pending MFA setup' }]);

    const secret = decryptSecret(u.rows[0].mfa_secret_encrypted, config.mfaEncryptionKey);
    if (!verifyTotp(secret, b.code)) {
      throw E.validation('Invalid TOTP code', [{ field: 'code', issue: 'code does not match' }]);
    }

    // Generate backup codes
    const backupCodes = generateBackupCodes(8);
    const backupHashes = backupCodes.map((c) => sha256Hex(c));

    await deps.pool.query(
      'UPDATE users SET mfa_enabled = true, mfa_backup_codes_hash = $2, updated_at = now() WHERE id = $1',
      [userId, backupHashes],
    );

    await auditReq(req, { action: 'auth.mfa_enabled', entity: 'user', entityId: userId });
    send(res, { backupCodes });
  });

  const disableSchema = z.strictObject({ code: z.string().regex(/^\d{6}$/, 'must be a 6-digit code') });

  api.post('/auth/mfa/disable', {
    summary: 'Disable MFA (requires a valid TOTP code)',
    tag: 'Auth', auth: 'user', body: disableSchema, returns: 'Ok',
  }, async (req, res) => {
    if (!config.mfaEncryptionKey) throw E.conflict('MFA is not configured on this server', 'MFA_NOT_CONFIGURED');
    const b = parse(disableSchema, req.body);
    const userId = req.auth!.userId;

    const u = await deps.pool.query<{ mfa_enabled: boolean; mfa_secret_encrypted: string | null }>(
      'SELECT mfa_enabled, mfa_secret_encrypted FROM users WHERE id = $1', [userId],
    );
    if (!u.rows[0]?.mfa_enabled || !u.rows[0].mfa_secret_encrypted) {
      throw E.conflict('MFA is not enabled', 'MFA_NOT_ENABLED');
    }

    const secret = decryptSecret(u.rows[0].mfa_secret_encrypted, config.mfaEncryptionKey);
    if (!verifyTotp(secret, b.code)) {
      throw E.validation('Invalid TOTP code', [{ field: 'code', issue: 'code does not match' }]);
    }

    await deps.pool.query(
      'UPDATE users SET mfa_enabled = false, mfa_secret_encrypted = NULL, mfa_backup_codes_hash = NULL, updated_at = now() WHERE id = $1',
      [userId],
    );

    await auditReq(req, { action: 'auth.mfa_disabled', entity: 'user', entityId: userId });
    bumpUser(res, userId);
    send(res, { ok: true as const });
  });

  const challengeSchema = z.strictObject({
    mfaToken: z.string().min(10).max(2000),
    code: z.string().regex(/^\d{6}$/).optional(),
    backupCode: z.string().min(1).max(20).optional(),
    deviceLabel: optStr(100),
    client: z.enum(CLIENTS).optional(),
  });

  api.post('/auth/mfa/challenge', {
    summary: 'Complete MFA challenge with TOTP code or backup code',
    tag: 'Auth', auth: 'none', body: challengeSchema, returns: 'AuthResult',
  }, async (req, res) => {
    if (!config.mfaEncryptionKey) throw E.conflict('MFA is not configured on this server', 'MFA_NOT_CONFIGURED');
    const b = parse(challengeSchema, req.body);
    if (!b.code && !b.backupCode) throw E.validation('Provide either code or backupCode', [{ field: 'code', issue: 'code or backupCode required' }]);

    // Verify the MFA token
    let userId: string;
    try {
      const payload = jwt.verify(b.mfaToken, config.jwtSecret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
      if (payload.purpose !== 'mfa' || typeof payload.sub !== 'string') throw new Error('bad');
      userId = payload.sub;
    } catch {
      throw E.unauth('MFA token is invalid or expired');
    }

    // Rate limit per mfaToken
    const rl = await deps.limiter.consume(`mfa-challenge:${sha256Hex(b.mfaToken)}`, 5, 5 * 60_000);
    if (!rl.allowed) {
      throw new AppError('RATE_LIMITED', 'Too many MFA attempts, request a new login', { retryAfterSec: rl.retryAfterSec });
    }

    const u = await deps.pool.query<UserRow & { mfa_secret_encrypted: string | null; mfa_backup_codes_hash: string[] | null }>(
      `SELECT ${USER_COLS}, mfa_secret_encrypted, mfa_backup_codes_hash FROM users WHERE id = $1`,
      [userId],
    );
    const user = u.rows[0];
    if (!user || !user.is_active) throw E.unauth('Account is deactivated');
    if (!user.mfa_secret_encrypted) throw E.unauth('MFA is not configured for this account');

    const secret = decryptSecret(user.mfa_secret_encrypted, config.mfaEncryptionKey);

    if (b.code) {
      if (!verifyTotp(secret, b.code)) {
        throw E.validation('Invalid TOTP code', [{ field: 'code', issue: 'code does not match' }]);
      }
    } else if (b.backupCode) {
      const codeHash = sha256Hex(b.backupCode.toLowerCase());
      const hashes = user.mfa_backup_codes_hash ?? [];
      const idx = hashes.indexOf(codeHash);
      if (idx === -1) {
        throw E.validation('Invalid backup code', [{ field: 'backupCode', issue: 'invalid backup code' }]);
      }
      // Mark backup code as used by removing it
      const remaining = [...hashes];
      remaining.splice(idx, 1);
      await deps.pool.query('UPDATE users SET mfa_backup_codes_hash = $2, updated_at = now() WHERE id = $1', [userId, remaining]);
    }

    const out = await authResult(deps.pool, deps, user, { deviceLabel: b.deviceLabel, client: b.client ?? undefined });
    send(res, out);
  }, [loginLimiter(config.rateLimit.loginPer15Min)]);
}

export type { Request };
