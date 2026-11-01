import { Api, send } from '../http/api.js';
import { parse, z, str, optStr, uuid, paise, durationMin } from '../http/validate.js';
import { E } from '../errors.js';
import { withTx } from '../db.js';
import { auditReq } from '../lib/audit.js';

const AUDIENCES = ['all', 'men', 'women', 'kids'] as const;

const createSchema = z.strictObject({
  templateId: uuid.optional(),
  category: str(60).optional(),
  name: str(120).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  audience: z.enum(AUDIENCES).optional(),
  durationMin: durationMin.optional(),
  bufferMin: z.number().int().min(0).max(120).optional(),
  pricePaise: paise.optional(),
  isActive: z.boolean().optional(),
  sort: z.number().int().min(0).max(10000).optional(),
});
const patchSchema = z.strictObject({
  category: str(60).optional(),
  name: str(120).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  audience: z.enum(AUDIENCES).optional(),
  durationMin: durationMin.optional(),
  bufferMin: z.number().int().min(0).max(120).optional(),
  pricePaise: paise.optional(),
  isActive: z.boolean().optional(),
  sort: z.number().int().min(0).max(10000).optional(),
});
const staffServicesSchema = z.strictObject({ serviceIds: z.array(uuid).max(200) });

export const serviceDto = (s: Record<string, any>) => ({
  id: s.id,
  templateId: s.template_id,
  category: s.category,
  name: s.name,
  description: s.description,
  audience: s.audience,
  durationMin: s.duration_min,
  bufferMin: s.buffer_min,
  pricePaise: s.price_paise,
  isActive: s.is_active,
  sort: s.sort,
});

const COL: Record<string, string> = {
  category: 'category', name: 'name', description: 'description', audience: 'audience', durationMin: 'duration_min',
  bufferMin: 'buffer_min', pricePaise: 'price_paise', isActive: 'is_active', sort: 'sort',
};

export function register(api: Api) {
  const { deps } = api;

  api.get('/salons/:salonId/services', { summary: 'List salon services (incl. inactive)', tag: 'Services', auth: 'salon', perm: 'services.view', returns: 'Service[]' }, async (req, res) => {
    const r = await deps.pool.query('SELECT * FROM salon_services WHERE salon_id = $1 ORDER BY sort, category, name', [req.salonCtx!.salonId]);
    send(res, r.rows.map(serviceDto));
  });

  api.post('/salons/:salonId/services', { summary: 'Create a service (optionally from a template)', tag: 'Services', auth: 'salon', perm: 'services.edit', writable: true, body: createSchema, returns: 'Service', status: 201 }, async (req, res) => {
    const b = parse(createSchema, req.body);
    let t: Record<string, any> | null = null;
    if (b.templateId) {
      const r = await deps.pool.query('SELECT * FROM service_templates WHERE id = $1', [b.templateId]);
      t = r.rows[0] ?? null;
      if (!t) throw E.validation('Unknown templateId', [{ field: 'templateId', issue: 'not found' }]);
    }
    const category = b.category ?? t?.category;
    const name = b.name ?? t?.name;
    const dur = b.durationMin ?? t?.default_duration_min;
    const price = b.pricePaise ?? t?.suggested_price_paise;
    const missing = [!category && 'category', !name && 'name', dur === undefined && 'durationMin', price === undefined && 'pricePaise'].filter(Boolean) as string[];
    if (missing.length) throw E.validation('Missing fields', missing.map((f) => ({ field: f, issue: 'required when no template is given' })));
    const r = await deps.pool.query(
      `INSERT INTO salon_services (salon_id, template_id, category, name, description, audience, duration_min, buffer_min, price_paise, is_active, sort)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.salonCtx!.salonId, b.templateId ?? null, category, name, b.description ?? null, b.audience ?? t?.audience ?? 'all', dur, b.bufferMin ?? 0, price, b.isActive ?? true, b.sort ?? t?.sort ?? 0],
    );
    await auditReq(req, { action: 'service.created', entity: 'service', entityId: r.rows[0].id });
    send(res, serviceDto(r.rows[0]), undefined, 201);
  });

  api.patch('/salons/:salonId/services/:serviceId', { summary: 'Update a service', tag: 'Services', auth: 'salon', perm: 'services.edit', writable: true, body: patchSchema, returns: 'Service' }, async (req, res) => {
    const b = parse(patchSchema, req.body);
    const sets: string[] = [];
    const vals: unknown[] = [parse(uuid, req.params['serviceId']), req.salonCtx!.salonId];
    for (const [k, v] of Object.entries(b)) {
      if (v === undefined) continue;
      vals.push(v);
      sets.push(`${COL[k]} = $${vals.length}`);
    }
    if (!sets.length) throw E.validation('Nothing to update', [{ field: '', issue: 'no fields supplied' }]);
    const r = await deps.pool.query(`UPDATE salon_services SET ${sets.join(', ')} WHERE id = $1 AND salon_id = $2 RETURNING *`, vals);
    if (!r.rows[0]) throw E.notFound('Service');
    await auditReq(req, { action: 'service.updated', entity: 'service', entityId: r.rows[0].id, meta: { fields: Object.keys(b) } });
    send(res, serviceDto(r.rows[0]));
  });

  api.delete('/salons/:salonId/services/:serviceId', { summary: 'Delete a service (past bookings keep their snapshots)', tag: 'Services', auth: 'salon', perm: 'services.edit', writable: true }, async (req, res) => {
    const id = parse(uuid, req.params['serviceId']);
    const r = await deps.pool.query('DELETE FROM salon_services WHERE id = $1 AND salon_id = $2', [id, req.salonCtx!.salonId]);
    if (!r.rowCount) throw E.notFound('Service');
    await auditReq(req, { action: 'service.deleted', entity: 'service', entityId: id });
    send(res, { ok: true });
  });

  api.put('/salons/:salonId/staff/:staffId/services', { summary: 'Set which services a staff member performs', tag: 'Staff', auth: 'salon', perm: 'staff.manage', body: staffServicesSchema, returns: 'ServiceIds', note: 'A staff member with no rows performs all services' }, async (req, res) => {
    const b = parse(staffServicesSchema, req.body);
    const staffId = parse(uuid, req.params['staffId']);
    const salonId = req.salonCtx!.salonId;
    const ids = [...new Set(b.serviceIds)];
    await withTx(deps.pool, async (c) => {
      const st = await c.query('SELECT 1 FROM salon_staff WHERE id = $1 AND salon_id = $2', [staffId, salonId]);
      if (!st.rowCount) throw E.notFound('Staff member');
      if (ids.length) {
        const ok = await c.query('SELECT count(*)::int AS n FROM salon_services WHERE salon_id = $1 AND id = ANY($2::uuid[])', [salonId, ids]);
        if (ok.rows[0].n !== ids.length) throw E.validation('Some services do not belong to this salon', [{ field: 'serviceIds', issue: 'unknown service id' }]);
      }
      await c.query('DELETE FROM staff_services WHERE staff_id = $1', [staffId]);
      if (ids.length) await c.query('INSERT INTO staff_services (staff_id, service_id) SELECT $1, unnest($2::uuid[])', [staffId, ids]);
    });
    send(res, { serviceIds: ids });
  });
}

export { optStr };
