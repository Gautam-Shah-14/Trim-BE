import type { Request } from 'express';
import type pg from 'pg';
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
    comp_until: Date | null; past_due_since: Date | null;
  }>(
    `SELECT s.id AS salon_id, s.name AS salon_name, s.status AS salon_status, r.id AS role_id, r.name AS role_name, st.id AS staff_id,
            COALESCE(array_agg(p.permission) FILTER (WHERE p.permission IS NOT NULL), '{}') AS perms,
            sub.plan_code, sub.status AS sub_status, sub.trial_ends_at, sub.current_period_end, sub.comp_until, sub.past_due_since
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
      { plan_code: m.plan_code, status: m.sub_status, trial_ends_at: m.trial_ends_at, current_period_end: m.current_period_end, comp_until: m.comp_until, past_due_since: m.past_due_since },
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
  password,
  deviceLabel: optStr(100),
  client: z.enum(CLIENTS).optional(),
});

const ownerSchema = z.strictObject({
  fullName: str(120),
  phone: phoneE164,
  email,
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
        const salon = await createSalonWithDefaults(c, { ...b.salon, createdBy: user.id, ownerUserId: user.id, ownerDisplayName: b.fullName });
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
      throw new AppError('RATE_LIMITED', 'Account temporarily locked after too many failed attempts', { lockedUntil: u.locked_until.toISOString() });
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

    if (b.client === 'desktop' || b.client === 'salon_app') {
      const m = await loadMemberships(deps.pool, u.id);
      if (u.platform_role !== 'admin') {
        if (m.length === 0) throw E.forbidden('This account is not a member of any salon');
        if (b.client === 'desktop' && !m.some((x) => x.desktopAccess)) {
          throw E.planLimit('The desktop app requires the Pro plan', 'desktop_access');
        }
      }
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

export type { Request };
