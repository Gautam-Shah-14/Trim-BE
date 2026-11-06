import { Api, bumpPlans, bumpSalon, bumpUser, send } from '../http/api.js';
import { parse, z, str, optStr, uuid, email, phoneE164, password, isoInstant, pageQuery, keysetFrom, pageOf, decodeCursor, encodeCursor } from '../http/validate.js';
import { E } from '../errors.js';
import { isPgError, withTx } from '../db.js';
import { auditReq } from '../lib/audit.js';
import { recomputeRating } from '../lib/booking.js';
import { planDto, hairstyleDto } from './public.js';
import { salonDto } from './salon.js';

const SHAPES = ['Heart', 'Oblong', 'Oval', 'Round', 'Square'] as const;

const salonListQuery = pageQuery.extend({ status: z.enum(['pending', 'approved', 'suspended']).optional(), q: z.string().trim().max(80).optional() });
const salonPatch = z.strictObject({ status: z.enum(['pending', 'approved', 'suspended']) });
const planPatch = z.strictObject({
  name: str(40).optional(),
  priceMonthlyPaise: z.number().int().min(0).max(100_000_000).optional(),
  priceAnnualPaise: z.number().int().min(0).max(1_000_000_000).optional(),
  maxBranches: z.number().int().min(1).max(100).nullable().optional(),
  maxStaff: z.number().int().min(1).max(10000).nullable().optional(),
  customRoles: z.boolean().optional(),
  desktopAccess: z.boolean().optional(),
  analyticsLevel: z.enum(['basic', 'full']).optional(),
  csvExport: z.boolean().optional(),
  billTemplates: z.boolean().optional(),
  isActive: z.boolean().optional(),
});
const compSchema = z.strictObject({ until: isoInstant.nullable() });
const contactQuery = pageQuery.extend({ status: z.enum(['new', 'handled']).optional() });
const contactPatch = z.strictObject({ status: z.enum(['new', 'handled']).optional(), assignedTo: uuid.nullable().optional() });
const usersQuery = pageQuery.extend({ q: z.string().trim().max(80).optional(), role: z.enum(['customer', 'salon_user', 'admin', 'sales_agent']).optional() });
const auditQuery = z.object({ salonId: uuid.optional(), action: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().max(100).optional() });
const agentSchema = z.strictObject({ fullName: str(120), email, phone: phoneE164.optional(), password });
const userPatch = z.strictObject({ isActive: z.boolean() });
const reviewPatch = z.strictObject({ status: z.enum(['visible', 'hidden']) });
const hairstyleBody = z.strictObject({
  name: str(80),
  audience: z.enum(['men', 'women', 'unisex']),
  faceShapes: z.array(z.enum(SHAPES)).min(1).max(5),
  length: z.enum(['short', 'medium', 'long']),
  description: str(600),
  tags: z.array(str(30)).max(15).default([]),
  maintenance: z.enum(['low', 'medium', 'high']).default('medium'),
  imageMediaId: uuid.nullable().optional(),
  serviceTemplateIds: z.array(uuid).max(20).optional(),
});
const hairstylePatch = hairstyleBody.partial();

const LIKE = (s: string) => `%${s.replace(/[%_\\]/g, '\\$&')}%`;

export function register(api: Api) {
  const { deps } = api;

  api.get('/admin/salons', { summary: 'List salons (approval queue)', tag: 'Admin', auth: 'admin', query: salonListQuery, returns: 'AdminSalon[]' }, async (req, res) => {
    const q = parse(salonListQuery, req.query);
    const ks = keysetFrom(q.cursor);
    const params: unknown[] = [q.limit + 1];
    const where: string[] = [];
    if (q.status) { params.push(q.status); where.push(`s.status = $${params.length}`); }
    if (q.q) { params.push(LIKE(q.q)); where.push(`(s.name ILIKE $${params.length} OR s.city ILIKE $${params.length})`); }
    if (ks) { params.push(ks.t, ks.id); where.push(`(s.created_at, s.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`); }
    const r = await deps.pool.query(
      `SELECT s.*, s.created_at::text AS _ck, sub.status AS sub_status, sub.plan_code, sub.trial_ends_at, sub.comp_until,
              u.full_name AS owner_name, u.email AS owner_email, u.phone_e164 AS owner_phone
         FROM salons s JOIN subscriptions sub ON sub.salon_id = s.id LEFT JOIN users u ON u.id = s.created_by
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY s.created_at DESC, s.id DESC LIMIT $1`,
      params,
    );
    const { items, nextCursor } = pageOf(r.rows as { id: string; _ck: string }[], q.limit);
    send(res, items.map((s: any) => ({ ...salonDto(s), subscription: { status: s.sub_status, planCode: s.plan_code, trialEndsAt: s.trial_ends_at, compUntil: s.comp_until }, owner: { name: s.owner_name, email: s.owner_email, phone: s.owner_phone } })), { limit: q.limit, nextCursor });
  });

  api.get('/admin/salons/:id', { summary: 'Salon detail for review', tag: 'Admin', auth: 'admin', returns: 'AdminSalonDetail' }, async (req, res) => {
    const id = parse(uuid, req.params['id']);
    const s = await deps.pool.query('SELECT * FROM salons WHERE id = $1', [id]);
    if (!s.rows[0]) throw E.notFound('Salon');
    const [sub, staff, counts] = await Promise.all([
      deps.pool.query('SELECT * FROM subscriptions WHERE salon_id = $1', [id]),
      deps.pool.query(`SELECT st.id, st.display_name, r.name AS role_name, st.is_active, u.email, u.phone_e164 FROM salon_staff st JOIN salon_roles r ON r.id = st.role_id JOIN users u ON u.id = st.user_id WHERE st.salon_id = $1 ORDER BY st.created_at`, [id]),
      deps.pool.query(`SELECT (SELECT count(*)::int FROM bookings WHERE salon_id = $1) AS bookings, (SELECT count(*)::int FROM invoices WHERE salon_id = $1) AS invoices, (SELECT count(*)::int FROM salon_services WHERE salon_id = $1) AS services`, [id]),
    ]);
    const x = sub.rows[0];
    send(res, {
      ...salonDto(s.rows[0]),
      subscription: { planCode: x.plan_code, interval: x.interval, status: x.status, trialEndsAt: x.trial_ends_at, currentPeriodEnd: x.current_period_end, compUntil: x.comp_until, cancelAtPeriodEnd: x.cancel_at_period_end },
      staff: staff.rows.map((m) => ({ id: m.id, displayName: m.display_name, roleName: m.role_name, isActive: m.is_active, email: m.email, phone: m.phone_e164 })),
      counts: counts.rows[0],
    });
  });

  api.patch('/admin/salons/:id', { summary: 'Approve / suspend a salon', tag: 'Admin', auth: 'admin', body: salonPatch, returns: 'Salon' }, async (req, res) => {
    const b = parse(salonPatch, req.body);
    const id = parse(uuid, req.params['id']);
    const r = await deps.pool.query(
      `UPDATE salons SET status = $2::salon_status,
              approved_by = CASE WHEN $2 = 'approved' THEN $3::uuid ELSE approved_by END,
              approved_at = CASE WHEN $2 = 'approved' THEN now() ELSE approved_at END
        WHERE id = $1 RETURNING *`,
      [id, b.status, req.auth!.userId],
    );
    if (!r.rows[0]) throw E.notFound('Salon');
    bumpSalon(res, id);
    await auditReq(req, { action: `salon.${b.status}`, entity: 'salon', entityId: id, salonId: id });
    send(res, salonDto(r.rows[0]));
  });

  api.get('/admin/plans', { summary: 'All plans including inactive', tag: 'Admin', auth: 'admin', returns: 'AdminPlan[]' }, async (_req, res) => {
    const r = await deps.pool.query('SELECT * FROM plans ORDER BY price_monthly_paise');
    send(res, r.rows.map((p) => ({ ...planDto(p), isActive: p.is_active, razorpayPlanIdMonthly: p.razorpay_plan_id_monthly, razorpayPlanIdAnnual: p.razorpay_plan_id_annual })));
  });

  const PLAN_COL: Record<string, string> = {
    name: 'name', priceMonthlyPaise: 'price_monthly_paise', priceAnnualPaise: 'price_annual_paise', maxBranches: 'max_branches', maxStaff: 'max_staff',
    customRoles: 'custom_roles', desktopAccess: 'desktop_access', analyticsLevel: 'analytics_level', csvExport: 'csv_export', billTemplates: 'bill_templates', isActive: 'is_active',
  };
  api.patch('/admin/plans/:code', { summary: 'Edit plan prices / limits', tag: 'Admin', auth: 'admin', body: planPatch, returns: 'Plan', note: 'Changing a price clears the matching razorpay_plan_id (Razorpay plans are immutable) so scripts/create-razorpay-plans.ts can recreate it' }, async (req, res) => {
    const b = parse(planPatch, req.body);
    const code = String(req.params['code']);
    if (code !== 'starter' && code !== 'pro') throw E.notFound('Plan');
    const sets: string[] = [];
    const vals: unknown[] = [code];
    for (const [k, v] of Object.entries(b)) {
      if (v === undefined) continue;
      vals.push(v);
      sets.push(`${PLAN_COL[k]} = $${vals.length}`);
    }
    if (b.priceMonthlyPaise !== undefined) sets.push('razorpay_plan_id_monthly = NULL');
    if (b.priceAnnualPaise !== undefined) sets.push('razorpay_plan_id_annual = NULL');
    if (!sets.length) throw E.validation('Nothing to update', [{ field: '', issue: 'no fields supplied' }]);
    const r = await deps.pool.query(`UPDATE plans SET ${sets.join(', ')}, updated_at = now() WHERE code = $1 RETURNING *`, vals);
    await deps.cache.del('plans');
    bumpPlans(res);
    await auditReq(req, { action: 'plan.updated', entity: 'plan', entityId: code, meta: b });
    send(res, planDto(r.rows[0]));
  });

  api.post('/admin/salons/:id/comp', { summary: 'Grant/extend complimentary access until a date (null clears)', tag: 'Admin', auth: 'admin', body: compSchema, returns: 'CompResult' }, async (req, res) => {
    const b = parse(compSchema, req.body);
    const id = parse(uuid, req.params['id']);
    const r = await deps.pool.query('UPDATE subscriptions SET comp_until = $2, updated_at = now() WHERE salon_id = $1 RETURNING comp_until, trial_ends_at, status, plan_code', [id, b.until]);
    if (!r.rows[0]) throw E.notFound('Salon');
    bumpSalon(res, id);
    await auditReq(req, { action: 'subscription.comp', entity: 'salon', entityId: id, salonId: id, meta: { until: b.until } });
    send(res, { salonId: id, compUntil: r.rows[0].comp_until, trialEndsAt: r.rows[0].trial_ends_at, status: r.rows[0].status, planCode: r.rows[0].plan_code });
  });

  api.get('/admin/contact-messages', { summary: 'Contact inbox', tag: 'Admin', auth: 'admin', query: contactQuery, returns: 'ContactMessage[]' }, async (req, res) => {
    const q = parse(contactQuery, req.query);
    const ks = keysetFrom(q.cursor);
    const params: unknown[] = [q.limit + 1];
    const where: string[] = [];
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
    if (ks) { params.push(ks.t, ks.id); where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`); }
    const r = await deps.pool.query(`SELECT *, created_at::text AS _ck FROM contact_messages ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT $1`, params);
    const { items, nextCursor } = pageOf(r.rows as { id: string; _ck: string }[], q.limit);
    send(res, items.map((m: any) => ({ id: m.id, name: m.name, email: m.email, phone: m.phone, salonName: m.salon_name, message: m.message, status: m.status, assignedTo: m.assigned_to, createdAt: m.created_at })), { limit: q.limit, nextCursor });
  });

  api.patch('/admin/contact-messages/:id', { summary: 'Mark handled / assign', tag: 'Admin', auth: 'admin', body: contactPatch, returns: 'ContactMessage' }, async (req, res) => {
    const b = parse(contactPatch, req.body);
    const r = await deps.pool.query(
      `UPDATE contact_messages SET status = COALESCE($2::contact_status, status), assigned_to = CASE WHEN $3::boolean THEN $4::uuid ELSE assigned_to END WHERE id = $1 RETURNING *`,
      [parse(uuid, req.params['id']), b.status ?? null, b.assignedTo !== undefined, b.assignedTo ?? null],
    );
    const m = r.rows[0];
    if (!m) throw E.notFound('Message');
    send(res, { id: m.id, name: m.name, email: m.email, phone: m.phone, salonName: m.salon_name, message: m.message, status: m.status, assignedTo: m.assigned_to, createdAt: m.created_at });
  });

  api.get('/admin/users', { summary: 'Users', tag: 'Admin', auth: 'admin', query: usersQuery, returns: 'AdminUser[]' }, async (req, res) => {
    const q = parse(usersQuery, req.query);
    const ks = keysetFrom(q.cursor);
    const params: unknown[] = [q.limit + 1];
    const where: string[] = [];
    if (q.role) { params.push(q.role); where.push(`platform_role = $${params.length}`); }
    if (q.q) { params.push(LIKE(q.q)); where.push(`(full_name ILIKE $${params.length} OR email::text ILIKE $${params.length} OR phone_e164 ILIKE $${params.length})`); }
    if (ks) { params.push(ks.t, ks.id); where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`); }
    const r = await deps.pool.query(`SELECT id, full_name, email, phone_e164, platform_role, is_active, created_at, created_at::text AS _ck FROM users ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT $1`, params);
    const { items, nextCursor } = pageOf(r.rows as { id: string; _ck: string }[], q.limit);
    send(res, items.map((u: any) => ({ id: u.id, fullName: u.full_name, email: u.email, phone: u.phone_e164, role: u.platform_role, isActive: u.is_active, createdAt: u.created_at })), { limit: q.limit, nextCursor });
  });

  api.post('/admin/sales-agents', { summary: 'Create a sales agent account', tag: 'Admin', auth: 'admin', body: agentSchema, returns: 'AdminUser', status: 201 }, async (req, res) => {
    const b = parse(agentSchema, req.body);
    const hash = await deps.hasher.hash(b.password);
    try {
      const r = await deps.pool.query(
        "INSERT INTO users (email, phone_e164, password_hash, full_name, platform_role) VALUES ($1,$2,$3,$4,'sales_agent') RETURNING id, full_name, email, phone_e164, platform_role, is_active, created_at",
        [b.email, b.phone ?? null, hash, b.fullName],
      );
      const u = r.rows[0];
      await auditReq(req, { action: 'sales_agent.created', entity: 'user', entityId: u.id });
      send(res, { id: u.id, fullName: u.full_name, email: u.email, phone: u.phone_e164, role: u.platform_role, isActive: u.is_active, createdAt: u.created_at }, undefined, 201);
    } catch (err) {
      if (isPgError(err, '23505')) throw E.conflict('That email or phone is already registered', 'ACCOUNT_EXISTS');
      throw err;
    }
  });

  api.patch('/admin/users/:id', { summary: 'Activate / deactivate a user (sales agents and others)', tag: 'Admin', auth: 'admin', body: userPatch, returns: 'AdminUser' }, async (req, res) => {
    const b = parse(userPatch, req.body);
    const id = parse(uuid, req.params['id']);
    if (id === req.auth!.userId) throw E.conflict('You cannot change your own active state', 'SELF_CHANGE');
    const u = await withTx(deps.pool, async (c) => {
      const r = await c.query('UPDATE users SET is_active = $2, updated_at = now() WHERE id = $1 RETURNING id, full_name, email, phone_e164, platform_role, is_active, created_at', [id, b.isActive]);
      if (!r.rows[0]) throw E.notFound('User');
      if (!b.isActive) await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
      return r.rows[0];
    });
    bumpUser(res, id);
    await auditReq(req, { action: b.isActive ? 'user.activated' : 'user.deactivated', entity: 'user', entityId: id });
    send(res, { id: u.id, fullName: u.full_name, email: u.email, phone: u.phone_e164, role: u.platform_role, isActive: u.is_active, createdAt: u.created_at });
  });

  api.get('/admin/stats', { summary: 'Platform counters', tag: 'Admin', auth: 'admin', returns: 'AdminStats' }, async (_req, res) => {
    const r = await deps.pool.query(`
      SELECT (SELECT count(*)::int FROM users WHERE platform_role = 'customer') AS customers,
             (SELECT count(*)::int FROM salons) AS salons,
             (SELECT count(*)::int FROM salons WHERE status = 'pending') AS salons_pending,
             (SELECT count(*)::int FROM salons WHERE status = 'approved') AS salons_approved,
             (SELECT count(*)::int FROM subscriptions WHERE status = 'active') AS subs_active,
             (SELECT count(*)::int FROM subscriptions WHERE status = 'trialing' AND trial_ends_at > now()) AS subs_trialing,
             (SELECT count(*)::int FROM subscriptions WHERE status IN ('past_due','halted')) AS subs_troubled,
             (SELECT count(*)::int FROM bookings WHERE created_at > now() - interval '30 days' AND status NOT IN ('held','expired')) AS bookings_30d,
             (SELECT count(*)::int FROM contact_messages WHERE status = 'new') AS contact_new,
             (SELECT COALESCE(sum(amount_paise),0)::bigint FROM subscription_receipts WHERE issued_at > now() - interval '30 days') AS receipts_30d_paise,
             (SELECT count(*)::int FROM leads) AS leads`);
    const x = r.rows[0];
    send(res, {
      customers: x.customers, salons: { total: x.salons, pending: x.salons_pending, approved: x.salons_approved },
      subscriptions: { active: x.subs_active, trialing: x.subs_trialing, troubled: x.subs_troubled },
      bookingsLast30Days: x.bookings_30d, newContactMessages: x.contact_new, subscriptionReceiptsLast30DaysPaise: x.receipts_30d_paise, leads: x.leads,
    });
  });

  api.get('/admin/audit', { summary: 'Audit log', tag: 'Admin', auth: 'admin', query: auditQuery, returns: 'AuditEntry[]' }, async (req, res) => {
    const q = parse(auditQuery, req.query);
    const cur = decodeCursor<{ id: number }>(q.cursor);
    const params: unknown[] = [q.limit + 1];
    const where: string[] = [];
    if (q.salonId) { params.push(q.salonId); where.push(`salon_id = $${params.length}`); }
    if (q.action) { params.push(q.action); where.push(`action = $${params.length}`); }
    if (cur) { params.push(cur.id); where.push(`id < $${params.length}`); }
    const r = await deps.pool.query(`SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT $1`, params);
    const hasMore = r.rows.length > q.limit;
    const rows = hasMore ? r.rows.slice(0, q.limit) : r.rows;
    send(res, rows.map((a) => ({ id: a.id, actorUserId: a.actor_user_id, salonId: a.salon_id, action: a.action, entity: a.entity, entityId: a.entity_id, meta: a.meta, ip: a.ip, createdAt: a.created_at })), { limit: q.limit, nextCursor: hasMore ? encodeCursor({ id: rows[rows.length - 1]!.id }) : null });
  });

  api.patch('/admin/reviews/:id', { summary: 'Hide / restore a review', tag: 'Admin', auth: 'admin', body: reviewPatch }, async (req, res) => {
    const b = parse(reviewPatch, req.body);
    const id = parse(uuid, req.params['id']);
    await withTx(deps.pool, async (c) => {
      const r = await c.query<{ salon_id: string }>('UPDATE reviews SET status = $2::review_status WHERE id = $1 RETURNING salon_id', [id, b.status]);
      if (!r.rows[0]) throw E.notFound('Review');
      await recomputeRating(c, r.rows[0].salon_id);
    });
    const rv = await deps.pool.query<{ salon_id: string }>('SELECT salon_id FROM reviews WHERE id = $1', [id]);
    bumpSalon(res, rv.rows[0]?.salon_id);
    await auditReq(req, { action: `review.${b.status}`, entity: 'review', entityId: id });
    send(res, { ok: true });
  });

  // ---- hairstyle catalog CRUD
  const HAIR_SQL = `SELECT h.*, COALESCE((SELECT array_agg(m.template_id) FROM hairstyle_service_map m WHERE m.hairstyle_id = h.id), '{}') AS template_ids FROM hairstyle_catalog h WHERE h.id = $1`;

  api.post('/admin/hairstyles', { summary: 'Add a hairstyle', tag: 'Admin', auth: 'admin', body: hairstyleBody, returns: 'Hairstyle', status: 201 }, async (req, res) => {
    const b = parse(hairstyleBody, req.body);
    try {
      const id = await withTx(deps.pool, async (c) => {
        const r = await c.query<{ id: string }>(
          'INSERT INTO hairstyle_catalog (name, audience, face_shapes, length, description, tags, maintenance, image_media_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
          [b.name, b.audience, b.faceShapes, b.length, b.description, b.tags, b.maintenance, b.imageMediaId ?? null],
        );
        if (b.serviceTemplateIds?.length) await c.query('INSERT INTO hairstyle_service_map (hairstyle_id, template_id) SELECT $1, unnest($2::uuid[])', [r.rows[0]!.id, [...new Set(b.serviceTemplateIds)]]);
        return r.rows[0]!.id;
      });
      await deps.cache.bump('catalog');
      send(res, hairstyleDto((await deps.pool.query(HAIR_SQL, [id])).rows[0]), undefined, 201);
    } catch (err) {
      if (isPgError(err, '23505')) throw E.conflict('A hairstyle with that name exists', 'NAME_TAKEN');
      if (isPgError(err, '23503')) throw E.validation('Unknown template or media id', [{ field: 'serviceTemplateIds', issue: 'not found' }]);
      throw err;
    }
  });

  api.patch('/admin/hairstyles/:id', { summary: 'Edit a hairstyle', tag: 'Admin', auth: 'admin', body: hairstylePatch, returns: 'Hairstyle' }, async (req, res) => {
    const b = parse(hairstylePatch, req.body);
    const id = parse(uuid, req.params['id']);
    const map: Record<string, string> = { name: 'name', audience: 'audience', faceShapes: 'face_shapes', length: 'length', description: 'description', tags: 'tags', maintenance: 'maintenance', imageMediaId: 'image_media_id' };
    await withTx(deps.pool, async (c) => {
      const sets: string[] = [];
      const vals: unknown[] = [id];
      for (const [k, v] of Object.entries(b)) {
        if (v === undefined || k === 'serviceTemplateIds') continue;
        vals.push(v);
        sets.push(`${map[k]} = $${vals.length}`);
      }
      if (sets.length) {
        const r = await c.query(`UPDATE hairstyle_catalog SET ${sets.join(', ')} WHERE id = $1`, vals);
        if (!r.rowCount) throw E.notFound('Hairstyle');
      } else {
        const ex = await c.query('SELECT 1 FROM hairstyle_catalog WHERE id = $1', [id]);
        if (!ex.rowCount) throw E.notFound('Hairstyle');
      }
      if (b.serviceTemplateIds) {
        await c.query('DELETE FROM hairstyle_service_map WHERE hairstyle_id = $1', [id]);
        if (b.serviceTemplateIds.length) await c.query('INSERT INTO hairstyle_service_map (hairstyle_id, template_id) SELECT $1, unnest($2::uuid[])', [id, [...new Set(b.serviceTemplateIds)]]);
      }
    }).catch((err) => {
      if (isPgError(err, '23505')) throw E.conflict('A hairstyle with that name exists', 'NAME_TAKEN');
      throw err;
    });
    await deps.cache.bump('catalog');
    send(res, hairstyleDto((await deps.pool.query(HAIR_SQL, [id])).rows[0]));
  });

  api.delete('/admin/hairstyles/:id', { summary: 'Remove a hairstyle', tag: 'Admin', auth: 'admin' }, async (req, res) => {
    const r = await deps.pool.query('DELETE FROM hairstyle_catalog WHERE id = $1', [parse(uuid, req.params['id'])]);
    if (!r.rowCount) throw E.notFound('Hairstyle');
    await deps.cache.bump('catalog');
    send(res, { ok: true });
  });

  api.get('/admin/queue', { summary: 'Background queue health (driver, depth, failed jobs, unprocessed webhook events)', tag: 'Admin', auth: 'admin', returns: 'QueueHealth' }, async (_req, res) => {
    const pending = await deps.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM subscription_events WHERE processed_at IS NULL');
    send(res, { driver: deps.queue.driver, depth: await deps.queue.depth(), maxDepth: deps.config.queue.maxDepth, workerMode: deps.config.workerMode, jobs: await deps.queue.stats(), unprocessedWebhookEvents: pending.rows[0]!.n });
  });
}

export { optStr };
