import type pg from 'pg';
import { Api, send } from '../http/api.js';
import { parse, z, str, uuid, phoneE164, email, password, timeStr, isoInstant } from '../http/validate.js';
import { E } from '../errors.js';
import { isPgError, withTx } from '../db.js';
import { auditReq } from '../lib/audit.js';
import { lockSalon } from '../lib/salonLock.js';

const speed = z.number().min(0.5).max(2.0);

const createSchema = z.strictObject({
  fullName: str(120),
  phone: phoneE164.optional(),
  email: email.optional(),
  tempPassword: password,
  roleId: uuid,
  displayName: str(120).optional(),
  speedMultiplier: speed.optional(),
  isBookable: z.boolean().optional(),
  serviceIds: z.array(uuid).max(200).optional(),
});
const patchSchema = z.strictObject({
  displayName: str(120).optional(),
  roleId: uuid.optional(),
  speedMultiplier: speed.optional(),
  isBookable: z.boolean().optional(),
  photoMediaId: uuid.nullable().optional(),
});
const hoursSchema = z.strictObject({
  hours: z.array(z.strictObject({ weekday: z.number().int().min(0).max(6), start: timeStr, end: timeStr })).max(7),
});
const timeOffSchema = z
  .strictObject({ from: isoInstant, to: isoInstant, reason: z.string().trim().max(200).optional() })
  .refine((v) => v.to > v.from, { message: 'to must be after from', path: ['to'] });

const STAFF_SQL = `
  SELECT st.id, st.user_id, st.display_name, st.role_id, r.name AS role_name, st.photo_media_id, st.speed_multiplier, st.is_bookable, st.is_active,
         st.created_at, u.full_name, u.phone_e164, u.email,
         COALESCE((SELECT array_agg(ss.service_id) FROM staff_services ss WHERE ss.staff_id = st.id), '{}') AS service_ids
    FROM salon_staff st JOIN users u ON u.id = st.user_id JOIN salon_roles r ON r.id = st.role_id`;

export const staffDto = (s: Record<string, any>, withContact: boolean) => ({
  id: s.id,
  userId: s.user_id,
  displayName: s.display_name,
  fullName: s.full_name,
  roleId: s.role_id,
  roleName: s.role_name,
  photoMediaId: s.photo_media_id,
  speedMultiplier: s.speed_multiplier,
  isBookable: s.is_bookable,
  isActive: s.is_active,
  serviceIds: s.service_ids,
  ...(withContact ? { phone: s.phone_e164, email: s.email } : {}),
  createdAt: s.created_at,
});

/** throws unless at least one *other* active owner remains in the salon */
async function assertOtherOwner(c: pg.PoolClient, salonId: string, staffId: string) {
  const r = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM salon_staff st JOIN salon_roles r ON r.id = st.role_id
      WHERE st.salon_id = $1 AND st.is_active AND r.name = 'owner' AND r.is_system AND st.id <> $2`,
    [salonId, staffId],
  );
  if (r.rows[0]!.n === 0) throw E.conflict('A salon must keep at least one active owner', 'LAST_OWNER');
}

async function loadStaff(c: pg.Pool | pg.PoolClient, salonId: string, staffId: string, lock = false) {
  const r = await c.query(`${STAFF_SQL} WHERE st.id = $1 AND st.salon_id = $2${lock ? ' FOR UPDATE OF st' : ''}`, [staffId, salonId]);
  if (!r.rows[0]) throw E.notFound('Staff member');
  return r.rows[0] as Record<string, any>;
}

export function register(api: Api) {
  const { deps } = api;

  api.get('/salons/:salonId/staff', { summary: 'List staff', tag: 'Staff', auth: 'salon', perm: 'staff.view', returns: 'Staff[]', note: 'phone/email only returned with staff.manage' }, async (req, res) => {
    const r = await deps.pool.query(`${STAFF_SQL} WHERE st.salon_id = $1 ORDER BY st.is_active DESC, st.created_at`, [req.salonCtx!.salonId]);
    const withContact = req.salonCtx!.permissions.has('staff.manage');
    send(res, r.rows.map((s) => staffDto(s, withContact)));
  });

  api.post('/salons/:salonId/staff', { summary: 'Create a staff account (enforces plan max_staff)', tag: 'Staff', auth: 'salon', perm: 'staff.manage', writable: true, body: createSchema, returns: 'Staff', status: 201 }, async (req, res) => {
    const b = parse(createSchema, req.body);
    if (!b.phone && !b.email) throw E.validation('Provide a phone or an email', [{ field: 'phone', issue: 'phone or email is required' }]);
    const salonId = req.salonCtx!.salonId;
    const hash = await deps.hasher.hash(b.tempPassword);
    try {
      const staffId = await withTx(deps.pool, async (c) => {
        const { ent } = await lockSalon(c, salonId);
        if (ent.readOnly) throw E.inactive();
        const role = await c.query<{ name: string; is_system: boolean }>('SELECT name, is_system FROM salon_roles WHERE id = $1 AND salon_id = $2', [b.roleId, salonId]);
        if (!role.rows[0]) throw E.validation('Unknown roleId', [{ field: 'roleId', issue: 'not a role of this salon' }]);
        if (role.rows[0].name === 'owner' && role.rows[0].is_system && !req.salonCtx!.isOwner && req.auth!.role !== 'admin') throw E.forbidden('Only an owner can create another owner');
        const max = ent.limits.maxStaff;
        if (max !== null) {
          const cnt = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM salon_staff WHERE salon_id = $1 AND is_active', [salonId]);
          if (cnt.rows[0]!.n >= max) throw E.planLimit(`Your plan allows at most ${max} active staff`, 'max_staff', { max, current: cnt.rows[0]!.n });
        }
        const u = await c.query<{ id: string }>(
          "INSERT INTO users (phone_e164, email, password_hash, full_name, platform_role, must_change_password) VALUES ($1,$2,$3,$4,'salon_user',true) RETURNING id",
          [b.phone ?? null, b.email ?? null, hash, b.fullName],
        );
        const st = await c.query<{ id: string }>(
          'INSERT INTO salon_staff (salon_id, user_id, role_id, display_name, speed_multiplier, is_bookable) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
          [salonId, u.rows[0]!.id, b.roleId, b.displayName ?? b.fullName, b.speedMultiplier ?? 1.0, b.isBookable ?? true],
        );
        if (b.serviceIds?.length) {
          const ids = [...new Set(b.serviceIds)];
          const ok = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM salon_services WHERE salon_id = $1 AND id = ANY($2::uuid[])', [salonId, ids]);
          if (ok.rows[0]!.n !== ids.length) throw E.validation('Some services do not belong to this salon', [{ field: 'serviceIds', issue: 'unknown service id' }]);
          await c.query('INSERT INTO staff_services (staff_id, service_id) SELECT $1, unnest($2::uuid[])', [st.rows[0]!.id, ids]);
        }
        return st.rows[0]!.id;
      });
      await auditReq(req, { action: 'staff.created', entity: 'staff', entityId: staffId });
      send(res, staffDto(await loadStaff(deps.pool, salonId, staffId), true), undefined, 201);
    } catch (err) {
      if (isPgError(err, '23505')) {
        const c = (err as { constraint?: string }).constraint ?? '';
        throw E.conflict(c.includes('email') ? 'That email is already registered' : 'That phone is already registered', c.includes('email') ? 'EMAIL_TAKEN' : 'PHONE_TAKEN');
      }
      throw err;
    }
  });

  api.patch('/salons/:salonId/staff/:staffId', { summary: 'Update staff member / change role', tag: 'Staff', auth: 'salon', perm: 'staff.manage', body: patchSchema, returns: 'Staff' }, async (req, res) => {
    const b = parse(patchSchema, req.body);
    const salonId = req.salonCtx!.salonId;
    const staffId = parse(uuid, req.params['staffId']);
    await withTx(deps.pool, async (c) => {
      await lockSalon(c, salonId);
      const cur = await loadStaff(c, salonId, staffId, true);
      const isOwnerRow = cur.role_name === 'owner';
      if (isOwnerRow && !req.salonCtx!.isOwner && req.auth!.role !== 'admin') throw E.forbidden('Only an owner can modify an owner');
      if (b.roleId && b.roleId !== cur.role_id) {
        const role = await c.query<{ name: string; is_system: boolean }>('SELECT name, is_system FROM salon_roles WHERE id = $1 AND salon_id = $2', [b.roleId, salonId]);
        if (!role.rows[0]) throw E.validation('Unknown roleId', [{ field: 'roleId', issue: 'not a role of this salon' }]);
        if (role.rows[0].name === 'owner' && !req.salonCtx!.isOwner && req.auth!.role !== 'admin') throw E.forbidden('Only an owner can grant the owner role');
        if (isOwnerRow && cur.is_active) await assertOtherOwner(c, salonId, staffId);
      }
      if (b.photoMediaId) {
        const m = await c.query("SELECT 1 FROM media WHERE id = $1 AND salon_id = $2 AND kind = 'staff_photo'", [b.photoMediaId, salonId]);
        if (!m.rowCount) throw E.validation('photoMediaId must be a staff_photo uploaded for this salon', [{ field: 'photoMediaId', issue: 'unknown media' }]);
      }
      await c.query(
        `UPDATE salon_staff SET display_name = COALESCE($3, display_name), role_id = COALESCE($4, role_id),
                speed_multiplier = COALESCE($5, speed_multiplier), is_bookable = COALESCE($6, is_bookable),
                photo_media_id = CASE WHEN $7::boolean THEN $8::uuid ELSE photo_media_id END
          WHERE id = $1 AND salon_id = $2`,
        [staffId, salonId, b.displayName ?? null, b.roleId ?? null, b.speedMultiplier ?? null, b.isBookable ?? null, b.photoMediaId !== undefined, b.photoMediaId ?? null],
      );
    });
    await auditReq(req, { action: 'staff.updated', entity: 'staff', entityId: staffId, meta: { fields: Object.keys(b) } });
    send(res, staffDto(await loadStaff(deps.pool, salonId, staffId), true));
  });

  api.post('/salons/:salonId/staff/:staffId/deactivate', { summary: 'Deactivate staff (never deleted)', tag: 'Staff', auth: 'salon', perm: 'staff.manage', returns: 'Staff' }, async (req, res) => {
    const salonId = req.salonCtx!.salonId;
    const staffId = parse(uuid, req.params['staffId']);
    await withTx(deps.pool, async (c) => {
      await lockSalon(c, salonId);
      const cur = await loadStaff(c, salonId, staffId, true);
      if (cur.role_name === 'owner') {
        if (!req.salonCtx!.isOwner && req.auth!.role !== 'admin') throw E.forbidden('Only an owner can deactivate an owner');
        if (cur.is_active) await assertOtherOwner(c, salonId, staffId);
      }
      await c.query('UPDATE salon_staff SET is_active = false WHERE id = $1', [staffId]);
    });
    await auditReq(req, { action: 'staff.deactivated', entity: 'staff', entityId: staffId });
    send(res, staffDto(await loadStaff(deps.pool, salonId, staffId), true));
  });

  api.post('/salons/:salonId/staff/:staffId/reactivate', { summary: 'Reactivate staff (re-checks max_staff)', tag: 'Staff', auth: 'salon', perm: 'staff.manage', writable: true, returns: 'Staff' }, async (req, res) => {
    const salonId = req.salonCtx!.salonId;
    const staffId = parse(uuid, req.params['staffId']);
    await withTx(deps.pool, async (c) => {
      const { ent } = await lockSalon(c, salonId);
      const cur = await loadStaff(c, salonId, staffId, true);
      if (cur.is_active) return;
      const max = ent.limits.maxStaff;
      if (max !== null) {
        const cnt = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM salon_staff WHERE salon_id = $1 AND is_active', [salonId]);
        if (cnt.rows[0]!.n >= max) throw E.planLimit(`Your plan allows at most ${max} active staff`, 'max_staff', { max, current: cnt.rows[0]!.n });
      }
      await c.query('UPDATE salon_staff SET is_active = true WHERE id = $1', [staffId]);
    });
    await auditReq(req, { action: 'staff.reactivated', entity: 'staff', entityId: staffId });
    send(res, staffDto(await loadStaff(deps.pool, salonId, staffId), true));
  });

  // ---- staff hours / time off
  api.get('/salons/:salonId/staff/:staffId/hours', { summary: 'Staff working-hour overrides', tag: 'Staff', auth: 'salon', perm: 'staff.view', returns: 'StaffHours[]' }, async (req, res) => {
    const staffId = parse(uuid, req.params['staffId']);
    await loadStaff(deps.pool, req.salonCtx!.salonId, staffId);
    const r = await deps.pool.query('SELECT weekday, start_time, end_time FROM staff_hours WHERE staff_id = $1 ORDER BY weekday', [staffId]);
    send(res, r.rows.map((h) => ({ weekday: h.weekday, start: String(h.start_time).slice(0, 5), end: String(h.end_time).slice(0, 5) })));
  });

  api.put('/salons/:salonId/staff/:staffId/hours', { summary: 'Replace staff hour overrides (empty = use salon hours)', tag: 'Staff', auth: 'salon', perm: 'staff.manage', body: hoursSchema, returns: 'StaffHours[]' }, async (req, res) => {
    const b = parse(hoursSchema, req.body);
    const staffId = parse(uuid, req.params['staffId']);
    if (new Set(b.hours.map((h) => h.weekday)).size !== b.hours.length) throw E.validation('Duplicate weekday', [{ field: 'hours', issue: 'weekday repeated' }]);
    for (const h of b.hours) if (h.start >= h.end) throw E.validation('start must be before end', [{ field: `hours[${h.weekday}]`, issue: 'start >= end' }]);
    await withTx(deps.pool, async (c) => {
      await loadStaff(c, req.salonCtx!.salonId, staffId);
      await c.query('DELETE FROM staff_hours WHERE staff_id = $1', [staffId]);
      for (const h of b.hours) await c.query('INSERT INTO staff_hours (staff_id, weekday, start_time, end_time) VALUES ($1,$2,$3,$4)', [staffId, h.weekday, h.start, h.end]);
    });
    send(res, b.hours);
  });

  api.get('/salons/:salonId/staff/:staffId/time-off', { summary: 'Upcoming staff time off', tag: 'Staff', auth: 'salon', perm: 'staff.view', returns: 'TimeOff[]' }, async (req, res) => {
    const staffId = parse(uuid, req.params['staffId']);
    await loadStaff(deps.pool, req.salonCtx!.salonId, staffId);
    const r = await deps.pool.query('SELECT id, lower(during) AS "from", upper(during) AS "to", reason FROM staff_time_off WHERE staff_id = $1 AND upper(during) > now() ORDER BY lower(during)', [staffId]);
    send(res, r.rows);
  });

  api.post('/salons/:salonId/staff/:staffId/time-off', { summary: 'Add staff time off', tag: 'Staff', auth: 'salon', perm: 'staff.manage', body: timeOffSchema, returns: 'TimeOff', status: 201 }, async (req, res) => {
    const b = parse(timeOffSchema, req.body);
    const staffId = parse(uuid, req.params['staffId']);
    await loadStaff(deps.pool, req.salonCtx!.salonId, staffId);
    const r = await deps.pool.query(
      `INSERT INTO staff_time_off (staff_id, during, reason) VALUES ($1, tstzrange($2, $3, '[)'), $4)
       RETURNING id, lower(during) AS "from", upper(during) AS "to", reason`,
      [staffId, b.from, b.to, b.reason ?? null],
    );
    send(res, r.rows[0], undefined, 201);
  });

  api.delete('/salons/:salonId/staff/:staffId/time-off/:timeOffId', { summary: 'Remove staff time off', tag: 'Staff', auth: 'salon', perm: 'staff.manage' }, async (req, res) => {
    const staffId = parse(uuid, req.params['staffId']);
    const r = await deps.pool.query(
      'DELETE FROM staff_time_off t USING salon_staff st WHERE t.id = $1 AND t.staff_id = st.id AND st.id = $2 AND st.salon_id = $3',
      [parse(uuid, req.params['timeOffId']), staffId, req.salonCtx!.salonId],
    );
    if (!r.rowCount) throw E.notFound('Time off');
    send(res, { ok: true });
  });
}
