import { Api, send } from '../http/api.js';
import { parse, z, str, optStr, phoneE164, uuid, dateStr, timeStr } from '../http/validate.js';
import { E } from '../errors.js';
import { isPgError, withTx } from '../db.js';
import { isValidDateString, isValidTimezone } from '../lib/slots.js';
import { auditReq } from '../lib/audit.js';
import type { SalonCtx } from '../http/types.js';

export const entDto = (ent: SalonCtx['ent']) => ({
  planCode: ent.planCode,
  status: ent.effectiveStatus,
  readOnly: ent.readOnly,
  graceEndsAt: ent.graceEndsAt?.toISOString() ?? null,
  limits: ent.limits,
});

const patchSchema = z.strictObject({
  name: str(120).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  phone: phoneE164.nullable().optional(),
  addressLine: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().max(80).nullable().optional(),
  state: z.string().trim().max(80).nullable().optional(),
  pincode: z.string().trim().max(12).nullable().optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  timezone: z.string().refine(isValidTimezone, 'unknown IANA timezone').optional(),
  logoMediaId: uuid.nullable().optional(),
  brandColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'must be #RRGGBB').nullable().optional(),
  billFooter: z.string().trim().max(500).nullable().optional(),
  gstin: z.string().trim().toUpperCase().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'invalid GSTIN').nullable().optional(),
  gstEnabled: z.boolean().optional(),
  invoicePrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,6}$/, '2-6 letters/digits').optional(),
  cancelCutoffMin: z.number().int().min(0).max(7 * 24 * 60).optional(),
});

const hoursSchema = z.strictObject({
  hours: z
    .array(
      z.strictObject({ weekday: z.number().int().min(0).max(6), opens: timeStr.default('10:00'), closes: timeStr.default('20:00'), isClosed: z.boolean().default(false) }),
    )
    .min(1)
    .max(7),
});

const closureSchema = z.strictObject({ date: dateStr, reason: optStr(200) });

const COLUMN: Record<string, string> = {
  name: 'name', description: 'description', phone: 'phone', addressLine: 'address_line', city: 'city', state: 'state', pincode: 'pincode',
  lat: 'lat', lng: 'lng', timezone: 'timezone', logoMediaId: 'logo_media_id', brandColor: 'brand_color', billFooter: 'bill_footer',
  gstin: 'gstin', gstEnabled: 'gst_enabled', invoicePrefix: 'invoice_prefix', cancelCutoffMin: 'cancel_cutoff_min',
};

export const salonDto = (s: Record<string, any>) => ({
  id: s.id,
  name: s.name,
  slug: s.slug,
  description: s.description,
  phone: s.phone,
  addressLine: s.address_line,
  city: s.city,
  state: s.state,
  pincode: s.pincode,
  lat: s.lat,
  lng: s.lng,
  timezone: s.timezone,
  logoMediaId: s.logo_media_id,
  brandColor: s.brand_color,
  billFooter: s.bill_footer,
  gstin: s.gstin,
  gstEnabled: s.gst_enabled,
  invoicePrefix: s.invoice_prefix,
  cancelCutoffMin: s.cancel_cutoff_min,
  ratingAvg: s.rating_avg,
  ratingCount: s.rating_count,
  status: s.status,
  createdAt: s.created_at,
});

export const hoursDto = (h: Record<string, any>) => ({
  weekday: h.weekday,
  opens: String(h.opens).slice(0, 5),
  closes: String(h.closes).slice(0, 5),
  isClosed: h.is_closed,
});

export function register(api: Api) {
  const { deps } = api;

  api.get('/salons/:salonId', { summary: 'Salon profile (any member)', tag: 'Salon', auth: 'salon', returns: 'Salon' }, async (req, res) => {
    const ctx = req.salonCtx!;
    const s = await deps.pool.query('SELECT * FROM salons WHERE id = $1', [ctx.salonId]);
    const photos = await deps.pool.query("SELECT id FROM media WHERE salon_id = $1 AND kind = 'salon_photo' ORDER BY created_at", [ctx.salonId]);
    send(res, {
      ...salonDto(s.rows[0]),
      photoMediaIds: photos.rows.map((p) => p.id),
      entitlements: entDto(ctx.ent),
      myRole: { roleName: ctx.roleName, permissions: [...ctx.permissions] },
    });
  });

  api.patch('/salons/:salonId', { summary: 'Update salon profile/branding', tag: 'Salon', auth: 'salon', perm: 'settings.edit', body: patchSchema, returns: 'Salon', note: 'billFooter / brandColor need the bill_templates entitlement (Pro)' }, async (req, res) => {
    const ctx = req.salonCtx!;
    const b = parse(patchSchema, req.body);
    if ((b.billFooter !== undefined || b.brandColor !== undefined) && !ctx.ent.limits.billTemplates) {
      throw E.planLimit('Custom bill footer and brand colour need the Pro plan', 'bill_templates');
    }
    const cur = await deps.pool.query<{ gstin: string | null }>('SELECT gstin FROM salons WHERE id = $1', [ctx.salonId]);
    const effectiveGstin = b.gstin === undefined ? cur.rows[0]!.gstin : b.gstin;
    if (b.gstEnabled && !effectiveGstin) throw E.validation('gstin is required to enable GST', [{ field: 'gstin', issue: 'required when gstEnabled' }]);
    if (b.logoMediaId) {
      const m = await deps.pool.query("SELECT 1 FROM media WHERE id = $1 AND salon_id = $2 AND kind = 'logo'", [b.logoMediaId, ctx.salonId]);
      if (!m.rowCount) throw E.validation('logoMediaId must be a logo uploaded for this salon', [{ field: 'logoMediaId', issue: 'unknown media' }]);
    }
    const sets: string[] = [];
    const vals: unknown[] = [ctx.salonId];
    for (const [k, v] of Object.entries(b)) {
      if (v === undefined) continue;
      vals.push(v);
      sets.push(`${COLUMN[k]} = $${vals.length}`);
    }
    if (!sets.length) throw E.validation('Nothing to update', [{ field: '', issue: 'no fields supplied' }]);
    const r = await deps.pool.query(`UPDATE salons SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
    await auditReq(req, { action: 'salon.updated', entity: 'salon', entityId: ctx.salonId, meta: { fields: Object.keys(b) } });
    send(res, salonDto(r.rows[0]));
  });

  api.get('/salons/:salonId/hours', { summary: 'Weekly opening hours', tag: 'Salon', auth: 'salon', returns: 'Hours[]' }, async (req, res) => {
    const r = await deps.pool.query('SELECT * FROM salon_hours WHERE salon_id = $1 ORDER BY weekday', [req.salonCtx!.salonId]);
    send(res, r.rows.map(hoursDto));
  });

  api.put('/salons/:salonId/hours', { summary: 'Replace/upsert weekly hours (weekday 0=Sunday)', tag: 'Salon', auth: 'salon', perm: 'settings.edit', body: hoursSchema, returns: 'Hours[]' }, async (req, res) => {
    const b = parse(hoursSchema, req.body);
    const days = new Set(b.hours.map((h) => h.weekday));
    if (days.size !== b.hours.length) throw E.validation('Duplicate weekday', [{ field: 'hours', issue: 'weekday repeated' }]);
    for (const h of b.hours) {
      if (!h.isClosed && h.opens >= h.closes) throw E.validation('opens must be before closes', [{ field: `hours[${h.weekday}]`, issue: 'opens >= closes' }]);
    }
    const out = await withTx(deps.pool, async (c) => {
      for (const h of b.hours) {
        await c.query(
          `INSERT INTO salon_hours (salon_id, weekday, opens, closes, is_closed) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (salon_id, weekday) DO UPDATE SET opens = EXCLUDED.opens, closes = EXCLUDED.closes, is_closed = EXCLUDED.is_closed`,
          [req.salonCtx!.salonId, h.weekday, h.opens, h.closes, h.isClosed],
        );
      }
      return c.query('SELECT * FROM salon_hours WHERE salon_id = $1 ORDER BY weekday', [req.salonCtx!.salonId]);
    });
    send(res, out.rows.map(hoursDto));
  });

  api.get('/salons/:salonId/closures', { summary: 'Closure dates (holidays)', tag: 'Salon', auth: 'salon', returns: 'Closure[]' }, async (req, res) => {
    const r = await deps.pool.query("SELECT id, to_char(date,'YYYY-MM-DD') AS date, reason FROM salon_closures WHERE salon_id = $1 AND date >= current_date - 30 ORDER BY date", [req.salonCtx!.salonId]);
    send(res, r.rows);
  });

  api.post('/salons/:salonId/closures', { summary: 'Add a closure date', tag: 'Salon', auth: 'salon', perm: 'settings.edit', body: closureSchema, returns: 'Closure', status: 201 }, async (req, res) => {
    const b = parse(closureSchema, req.body);
    if (!isValidDateString(b.date)) throw E.validation('Invalid date', [{ field: 'date', issue: 'not a calendar date' }]);
    try {
      const r = await deps.pool.query("INSERT INTO salon_closures (salon_id, date, reason) VALUES ($1,$2,$3) RETURNING id, to_char(date,'YYYY-MM-DD') AS date, reason", [req.salonCtx!.salonId, b.date, b.reason ?? null]);
      send(res, r.rows[0], undefined, 201);
    } catch (err) {
      if (isPgError(err, '23505')) throw E.conflict('That date is already marked closed', 'DUPLICATE_CLOSURE');
      throw err;
    }
  });

  api.delete('/salons/:salonId/closures/:closureId', { summary: 'Remove a closure date', tag: 'Salon', auth: 'salon', perm: 'settings.edit' }, async (req, res) => {
    const r = await deps.pool.query('DELETE FROM salon_closures WHERE id = $1 AND salon_id = $2', [parse(uuid, req.params['closureId']), req.salonCtx!.salonId]);
    if (!r.rowCount) throw E.notFound('Closure');
    send(res, { ok: true });
  });
}
