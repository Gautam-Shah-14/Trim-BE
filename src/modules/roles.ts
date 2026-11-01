import { Api, send } from '../http/api.js';
import { parse, z, str, uuid } from '../http/validate.js';
import { E } from '../errors.js';
import { isPgError, withTx } from '../db.js';
import { auditReq } from '../lib/audit.js';
import { isPermission } from '../lib/permissions.js';

const perms = z.array(z.string().refine(isPermission, 'unknown permission key')).max(40);
const createSchema = z.strictObject({ name: str(40), permissions: perms });
const patchSchema = z.strictObject({ name: str(40).optional(), permissions: perms.optional() });

const ROLE_SQL = `
  SELECT r.id, r.name, r.is_system,
         COALESCE((SELECT array_agg(p.permission ORDER BY p.permission) FROM salon_role_permissions p WHERE p.role_id = r.id), '{}') AS permissions,
         (SELECT count(*)::int FROM salon_staff st WHERE st.role_id = r.id AND st.is_active) AS member_count
    FROM salon_roles r`;

const dto = (r: Record<string, any>) => ({ id: r.id, name: r.name, isSystem: r.is_system, permissions: r.permissions, memberCount: r.member_count });

export function register(api: Api) {
  const { deps } = api;

  api.get('/salons/:salonId/roles', { summary: 'List roles with permissions', tag: 'Roles', auth: 'salon', perm: 'staff.view', returns: 'Role[]' }, async (req, res) => {
    const r = await deps.pool.query(`${ROLE_SQL} WHERE r.salon_id = $1 ORDER BY r.is_system DESC, r.name`, [req.salonCtx!.salonId]);
    send(res, r.rows.map(dto));
  });

  api.post('/salons/:salonId/roles', { summary: 'Create a custom role', tag: 'Roles', auth: 'salon', perm: 'roles.manage', writable: true, body: createSchema, returns: 'Role', status: 201, note: 'Requires the custom_roles entitlement (Pro)' }, async (req, res) => {
    const ctx = req.salonCtx!;
    if (!ctx.ent.limits.customRoles) throw E.planLimit('Custom roles need the Pro plan', 'custom_roles');
    const b = parse(createSchema, req.body);
    try {
      const id = await withTx(deps.pool, async (c) => {
        const r = await c.query<{ id: string }>('INSERT INTO salon_roles (salon_id, name, is_system) VALUES ($1,$2,false) RETURNING id', [ctx.salonId, b.name]);
        await c.query('INSERT INTO salon_role_permissions (role_id, permission) SELECT $1, unnest($2::text[])', [r.rows[0]!.id, [...new Set(b.permissions)]]);
        return r.rows[0]!.id;
      });
      await auditReq(req, { action: 'role.created', entity: 'role', entityId: id });
      const r = await deps.pool.query(`${ROLE_SQL} WHERE r.id = $1`, [id]);
      send(res, dto(r.rows[0]), undefined, 201);
    } catch (err) {
      if (isPgError(err, '23505')) throw E.conflict('A role with that name already exists', 'ROLE_NAME_TAKEN');
      throw err;
    }
  });

  api.patch('/salons/:salonId/roles/:roleId', { summary: 'Edit a role', tag: 'Roles', auth: 'salon', perm: 'roles.manage', body: patchSchema, returns: 'Role', note: 'Starter cannot edit system role permissions; the owner role is never editable' }, async (req, res) => {
    const ctx = req.salonCtx!;
    const b = parse(patchSchema, req.body);
    const roleId = parse(uuid, req.params['roleId']);
    await withTx(deps.pool, async (c) => {
      const cur = await c.query<{ name: string; is_system: boolean }>('SELECT name, is_system FROM salon_roles WHERE id = $1 AND salon_id = $2 FOR UPDATE', [roleId, ctx.salonId]);
      const role = cur.rows[0];
      if (!role) throw E.notFound('Role');
      if (role.is_system && role.name === 'owner') throw E.forbidden('The owner role cannot be edited', 'OWNER_ROLE_LOCKED');
      if (!ctx.ent.limits.customRoles) {
        if (role.is_system) throw E.planLimit('Editing role permissions needs the Pro plan', 'custom_roles');
        throw E.planLimit('Custom roles need the Pro plan', 'custom_roles');
      }
      if (b.name && role.is_system) throw E.forbidden('System roles cannot be renamed');
      if (b.name) await c.query('UPDATE salon_roles SET name = $2 WHERE id = $1', [roleId, b.name]);
      if (b.permissions) {
        await c.query('DELETE FROM salon_role_permissions WHERE role_id = $1', [roleId]);
        await c.query('INSERT INTO salon_role_permissions (role_id, permission) SELECT $1, unnest($2::text[])', [roleId, [...new Set(b.permissions)]]);
      }
    }).catch((err) => {
      if (isPgError(err, '23505')) throw E.conflict('A role with that name already exists', 'ROLE_NAME_TAKEN');
      throw err;
    });
    await auditReq(req, { action: 'role.updated', entity: 'role', entityId: roleId, meta: { fields: Object.keys(b) } });
    const r = await deps.pool.query(`${ROLE_SQL} WHERE r.id = $1`, [roleId]);
    send(res, dto(r.rows[0]));
  });

  api.delete('/salons/:salonId/roles/:roleId', { summary: 'Delete a custom role', tag: 'Roles', auth: 'salon', perm: 'roles.manage', note: 'Requires custom_roles entitlement; system roles and roles with members cannot be deleted' }, async (req, res) => {
    const ctx = req.salonCtx!;
    if (!ctx.ent.limits.customRoles) throw E.planLimit('Custom roles need the Pro plan', 'custom_roles');
    const roleId = parse(uuid, req.params['roleId']);
    await withTx(deps.pool, async (c) => {
      const cur = await c.query<{ is_system: boolean; n: number }>(
        'SELECT r.is_system, (SELECT count(*)::int FROM salon_staff st WHERE st.role_id = r.id) AS n FROM salon_roles r WHERE r.id = $1 AND r.salon_id = $2 FOR UPDATE',
        [roleId, ctx.salonId],
      );
      const r = cur.rows[0];
      if (!r) throw E.notFound('Role');
      if (r.is_system) throw E.forbidden('System roles cannot be deleted', 'SYSTEM_ROLE');
      if (r.n > 0) throw E.conflict('Reassign staff before deleting this role', 'ROLE_IN_USE');
      await c.query('DELETE FROM salon_roles WHERE id = $1', [roleId]);
    });
    await auditReq(req, { action: 'role.deleted', entity: 'role', entityId: roleId });
    send(res, { ok: true });
  });
}
