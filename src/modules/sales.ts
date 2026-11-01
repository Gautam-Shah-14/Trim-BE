import { randomBytes } from 'node:crypto';
import { Api, send } from '../http/api.js';
import { parse, z, str, optStr, uuid, email, phoneE164, pageQuery, keysetFrom, pageOf } from '../http/validate.js';
import { E } from '../errors.js';
import { auditReq } from '../lib/audit.js';

const STAGES = ['new', 'contacted', 'trial', 'subscribed', 'lost'] as const;
const leadBody = z.strictObject({
  salonName: str(120),
  ownerName: optStr(120),
  phone: phoneE164.optional(),
  email: email.optional(),
  city: optStr(80),
  source: optStr(60),
  stage: z.enum(STAGES).optional(),
  notes: z.string().trim().max(4000).optional(),
  ownerAgentId: uuid.optional(),
});
const leadPatch = leadBody.partial();
const listQuery = pageQuery.extend({ stage: z.enum(STAGES).optional(), q: z.string().trim().max(80).optional() });

const dto = (l: Record<string, any>) => ({
  id: l.id, salonName: l.salon_name, ownerName: l.owner_name, phone: l.phone, email: l.email, city: l.city, source: l.source,
  stage: l.stage, ownerAgentId: l.owner_agent_id, notes: l.notes, createdAt: l.created_at, updatedAt: l.updated_at,
});
const COL: Record<string, string> = { salonName: 'salon_name', ownerName: 'owner_name', phone: 'phone', email: 'email', city: 'city', source: 'source', stage: 'stage', notes: 'notes', ownerAgentId: 'owner_agent_id' };

export function register(api: Api) {
  const { deps } = api;
  /** sales agents only see their own leads; admins see everything */
  const scope = (req: { auth?: { role: string; userId: string } }) => (req.auth!.role === 'admin' ? null : req.auth!.userId);

  api.get('/sales/leads', { summary: 'List leads (agents: own only)', tag: 'Sales', auth: 'sales', query: listQuery, returns: 'Lead[]' }, async (req, res) => {
    const q = parse(listQuery, req.query);
    const ks = keysetFrom(q.cursor);
    const params: unknown[] = [q.limit + 1, scope(req)];
    const where = ['($2::uuid IS NULL OR owner_agent_id = $2)'];
    if (q.stage) { params.push(q.stage); where.push(`stage = $${params.length}`); }
    if (q.q) { params.push(`%${q.q.replace(/[%_\\]/g, '\\$&')}%`); where.push(`(salon_name ILIKE $${params.length} OR owner_name ILIKE $${params.length} OR city ILIKE $${params.length})`); }
    if (ks) { params.push(ks.t, ks.id); where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`); }
    const r = await deps.pool.query(`SELECT *, created_at::text AS _ck FROM leads WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT $1`, params);
    const { items, nextCursor } = pageOf(r.rows as { id: string; _ck: string }[], q.limit);
    send(res, items.map(dto), { limit: q.limit, nextCursor });
  });

  api.post('/sales/leads', { summary: 'Create a lead', tag: 'Sales', auth: 'sales', body: leadBody, returns: 'Lead', status: 201 }, async (req, res) => {
    const b = parse(leadBody, req.body);
    const owner = req.auth!.role === 'admin' ? (b.ownerAgentId ?? req.auth!.userId) : req.auth!.userId;
    const r = await deps.pool.query(
      `INSERT INTO leads (salon_name, owner_name, phone, email, city, source, stage, notes, owner_agent_id) VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::lead_stage,'new'),$8,$9) RETURNING *`,
      [b.salonName, b.ownerName ?? null, b.phone ?? null, b.email ?? null, b.city ?? null, b.source ?? null, b.stage ?? null, b.notes ?? null, owner],
    );
    send(res, dto(r.rows[0]), undefined, 201);
  });

  api.get('/sales/leads/:id', { summary: 'Lead detail', tag: 'Sales', auth: 'sales', returns: 'Lead' }, async (req, res) => {
    const r = await deps.pool.query('SELECT * FROM leads WHERE id = $1 AND ($2::uuid IS NULL OR owner_agent_id = $2)', [parse(uuid, req.params['id']), scope(req)]);
    if (!r.rows[0]) throw E.notFound('Lead');
    send(res, dto(r.rows[0]));
  });

  api.patch('/sales/leads/:id', { summary: 'Update a lead', tag: 'Sales', auth: 'sales', body: leadPatch, returns: 'Lead' }, async (req, res) => {
    const b = parse(leadPatch, req.body);
    if (b.ownerAgentId && req.auth!.role !== 'admin') throw E.forbidden('Only an admin can reassign leads');
    const sets: string[] = [];
    const vals: unknown[] = [parse(uuid, req.params['id']), scope(req)];
    for (const [k, v] of Object.entries(b)) {
      if (v === undefined) continue;
      vals.push(v);
      sets.push(`${COL[k]} = $${vals.length}${k === 'stage' ? '::lead_stage' : ''}`);
    }
    if (!sets.length) throw E.validation('Nothing to update', [{ field: '', issue: 'no fields supplied' }]);
    const r = await deps.pool.query(`UPDATE leads SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND ($2::uuid IS NULL OR owner_agent_id = $2) RETURNING *`, vals);
    if (!r.rows[0]) throw E.notFound('Lead');
    send(res, dto(r.rows[0]));
  });

  api.delete('/sales/leads/:id', { summary: 'Delete a lead', tag: 'Sales', auth: 'sales' }, async (req, res) => {
    const r = await deps.pool.query('DELETE FROM leads WHERE id = $1 AND ($2::uuid IS NULL OR owner_agent_id = $2)', [parse(uuid, req.params['id']), scope(req)]);
    if (!r.rowCount) throw E.notFound('Lead');
    send(res, { ok: true });
  });

  api.post('/sales/leads/:id/invite', { summary: 'Create a salon-owner invite code for the website register page', tag: 'Sales', auth: 'sales', returns: 'Invite', status: 201 }, async (req, res) => {
    const id = parse(uuid, req.params['id']);
    const l = await deps.pool.query('SELECT * FROM leads WHERE id = $1 AND ($2::uuid IS NULL OR owner_agent_id = $2)', [id, scope(req)]);
    if (!l.rows[0]) throw E.notFound('Lead');
    const code = randomBytes(9).toString('base64url');
    const r = await deps.pool.query("INSERT INTO lead_invites (code, lead_id, created_by, expires_at) VALUES ($1,$2,$3, now() + interval '30 days') RETURNING expires_at", [code, id, req.auth!.userId]);
    await deps.pool.query("UPDATE leads SET stage = 'contacted', updated_at = now() WHERE id = $1 AND stage = 'new'", [id]);
    await auditReq(req, { action: 'lead.invited', entity: 'lead', entityId: id });
    send(res, { code, url: `${deps.config.websiteUrl}/register?invite=${encodeURIComponent(code)}`, expiresAt: r.rows[0].expires_at }, undefined, 201);
  });

  api.get('/sales/pipeline', { summary: 'Lead counts per stage', tag: 'Sales', auth: 'sales', returns: 'Pipeline' }, async (req, res) => {
    const r = await deps.pool.query('SELECT stage, count(*)::int AS n FROM leads WHERE ($1::uuid IS NULL OR owner_agent_id = $1) GROUP BY stage', [scope(req)]);
    const map = new Map(r.rows.map((x) => [x.stage as string, x.n as number]));
    const stages = STAGES.map((s) => ({ stage: s, count: map.get(s) ?? 0 }));
    send(res, { stages, total: stages.reduce((a, s) => a + s.count, 0) });
  });
}
