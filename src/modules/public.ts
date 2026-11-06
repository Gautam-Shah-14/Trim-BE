import { Api, send } from '../http/api.js';
import { sendCached } from '../http/httpCache.js';
import { contactLimiter } from '../http/rateLimit.js';
import { parse, z, str, optStr, email, phoneE164, uuid } from '../http/validate.js';
import { E } from '../errors.js';
import { PERMISSIONS } from '../lib/permissions.js';

export const planDto = (p: Record<string, any>) => ({
  code: p.code,
  name: p.name,
  priceMonthlyPaise: p.price_monthly_paise,
  priceAnnualPaise: p.price_annual_paise,
  maxBranches: p.max_branches,
  maxStaff: p.max_staff,
  customRoles: p.custom_roles,
  desktopAccess: p.desktop_access,
  analyticsLevel: p.analytics_level,
  csvExport: p.csv_export,
  billTemplates: p.bill_templates,
  trialDays: 14,
});

const contactSchema = z.strictObject({
  name: str(120),
  email,
  phone: phoneE164.optional(),
  salonName: optStr(120),
  message: str(4000, 5),
  /** honeypot: real users never fill this */
  website: z.string().max(500).optional(),
});

const hairstyleQuery = z.object({
  faceShape: z.string().trim().optional(),
  audience: z.enum(['men', 'women', 'unisex']).optional(),
});

const SHAPES = ['Heart', 'Oblong', 'Oval', 'Round', 'Square'];

export const hairstyleDto = (h: Record<string, any>) => ({
  id: h.id,
  name: h.name,
  audience: h.audience,
  faceShapes: h.face_shapes,
  length: h.length,
  description: h.description,
  tags: h.tags,
  imageMediaId: h.image_media_id,
  maintenance: h.maintenance,
  serviceTemplateIds: h.template_ids ?? [],
});

const HAIR_SQL = `SELECT h.*, COALESCE((SELECT array_agg(m.template_id) FROM hairstyle_service_map m WHERE m.hairstyle_id = h.id), '{}') AS template_ids
                    FROM hairstyle_catalog h`;

export function register(api: Api) {
  const { deps, deps: { config } } = api;

  api.get('/plans', { summary: 'Public plans and prices', tag: 'Public', auth: 'none', returns: 'Plan[]' }, async (_req, res) => {
    const data = await deps.cache.getOrLoad('plans', config.cacheTtl.plans, async () => (await deps.pool.query('SELECT * FROM plans WHERE is_active ORDER BY price_monthly_paise')).rows.map(planDto));
    sendCached(_req, res, { data }, { maxAge: 300, swr: 600 });
  });

  api.post('/contact', { summary: 'Website contact form', tag: 'Public', auth: 'none', body: contactSchema, status: 201, note: 'Honeypot field `website` must be empty; bots get a silent 201' }, async (req, res) => {
    const b = parse(contactSchema, req.body);
    if (b.website && b.website.trim() !== '') {
      send(res, { ok: true }, undefined, 201); // pretend success, store nothing
      return;
    }
    await deps.pool.query('INSERT INTO contact_messages (name, email, phone, salon_name, message) VALUES ($1,$2,$3,$4,$5)', [b.name, b.email, b.phone ?? null, b.salonName ?? null, b.message]);
    send(res, { ok: true }, undefined, 201);
  }, [contactLimiter(config.rateLimit.contactPerHour)]);

  api.get('/hairstyles', { summary: 'Hairstyle catalog', tag: 'Hairstyles', auth: 'none', query: hairstyleQuery, returns: 'Hairstyle[]' }, async (req, res) => {
    const q = parse(hairstyleQuery, req.query);
    let shape: string | null = null;
    if (q.faceShape) {
      shape = SHAPES.find((s) => s.toLowerCase() === q.faceShape!.toLowerCase()) ?? null;
      if (!shape) throw E.validation('Unknown face shape', [{ field: 'faceShape', issue: `must be one of ${SHAPES.join(', ')}` }]);
    }
    const cv = await deps.cache.version('catalog');
    const body = await deps.cache.getOrLoad(`hair:v${cv}:${shape ?? '-'}:${q.audience ?? '-'}`, config.cacheTtl.catalog, async () => {
    const r = await deps.pool.query(
      `${HAIR_SQL} WHERE ($1::text IS NULL OR $1 = ANY(h.face_shapes))
         AND ($2::text IS NULL OR h.audience::text = $2 OR (h.audience = 'unisex' AND $2 IN ('men','women')))
       ORDER BY h.name`,
      [shape, q.audience ?? null],
    );
    return { data: r.rows.map(hairstyleDto), meta: { count: r.rowCount } };
    });
    sendCached(req, res, body, { maxAge: 300, swr: 3600 });
  });

  api.get('/hairstyles/:id', { summary: 'One hairstyle', tag: 'Hairstyles', auth: 'none', returns: 'Hairstyle' }, async (req, res) => {
    const id = parse(uuid, req.params['id']);
    const cv = await deps.cache.version('catalog');
    const dto = await deps.cache.getOrLoad(`hair1:v${cv}:${id}`, config.cacheTtl.catalog, async () => {
      const r = await deps.pool.query(`${HAIR_SQL} WHERE h.id = $1`, [id]);
      return r.rows[0] ? hairstyleDto(r.rows[0]) : null;
    });
    if (!dto) throw E.notFound('Hairstyle');
    sendCached(req, res, { data: dto }, { maxAge: 300, swr: 3600 });
  });

  api.get('/service-templates', { summary: 'Starter service catalog', tag: 'Services', auth: 'user', returns: 'ServiceTemplate[]' }, async (_req, res) => {
    const data = await deps.cache.getOrLoad('templates', config.cacheTtl.catalog, async () => {
      const r = await deps.pool.query('SELECT id, category, name, audience, default_duration_min, suggested_price_paise, sort FROM service_templates ORDER BY sort, name');
      return r.rows.map((t) => ({ id: t.id, category: t.category, name: t.name, audience: t.audience, defaultDurationMin: t.default_duration_min, suggestedPricePaise: t.suggested_price_paise, sort: t.sort }));
    });
    sendCached(_req, res, { data }, { maxAge: 3600, swr: 86400, scope: 'private' });
  });

  api.get('/permissions', { summary: 'All permission keys', tag: 'Roles', auth: 'user', returns: 'Permission[]' }, async (_req, res) => {
    send(res, Object.entries(PERMISSIONS).map(([key, description]) => ({ key, description })));
  });

  api.get('/invites/:code', { summary: 'Look up a sales invite (prefills the register page)', tag: 'Public', auth: 'none', returns: 'InvitePrefill' }, async (req, res) => {
    const code = String(req.params['code']);
    const r = await deps.pool.query(
      `SELECT l.salon_name, l.owner_name, l.phone, l.email, l.city FROM lead_invites i JOIN leads l ON l.id = i.lead_id
        WHERE i.code = $1 AND i.used_at IS NULL AND i.expires_at > now()`,
      [code],
    );
    const l = r.rows[0];
    if (!l) throw E.notFound('Invite');
    send(res, { salonName: l.salon_name, ownerName: l.owner_name, phone: l.phone, email: l.email, city: l.city });
  });
}
