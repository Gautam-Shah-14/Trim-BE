import type pg from 'pg';
import { Api, send } from '../http/api.js';
import { withIdempotency } from '../http/idempotency.js';
import { parse, z, str, uuid, paise, phoneE164, dateStr, pageQuery, keysetFrom, pageOf } from '../http/validate.js';
import { AppError, E } from '../errors.js';
import { isPgError, withTx } from '../db.js';
import { auditReq } from '../lib/audit.js';
import { localDateOf } from '../lib/slots.js';

export const METHOD_CODES = ['cash', 'card', 'upi', 'wallet', 'bank_transfer', 'other'] as const;
const MAX_SUBTOTAL = 100_000_000; // ₹10,00,000 per bill

const invoiceSchema = z.strictObject({
  bookingId: uuid.optional(),
  customerName: str(120).optional(),
  customerPhone: phoneE164.optional(),
  items: z
    .array(z.strictObject({ serviceId: uuid.optional(), name: str(120), qty: z.number().int().min(1).max(100), unitPricePaise: paise }))
    .min(1)
    .max(50),
  discountPaise: paise.default(0),
  taxRatePct: z.number().min(0).max(40).optional(),
  payments: z.array(z.strictObject({ methodCode: z.enum(METHOD_CODES), amountPaise: z.number().int().min(1).max(MAX_SUBTOTAL * 2), reference: z.string().trim().max(100).optional() })).max(10).default([]),
});
const voidSchema = z.strictObject({ reason: str(300) });
const listQuery = pageQuery.extend({
  from: dateStr.optional(),
  to: dateStr.optional(),
  status: z.enum(['draft', 'paid', 'void']).optional(),
  q: z.string().trim().max(60).optional(),
});
const methodsSchema = z.strictObject({
  methods: z
    .array(z.strictObject({ code: z.enum(METHOD_CODES), label: str(40).optional(), isEnabled: z.boolean(), upiId: z.string().trim().regex(/^[\w.-]{2,}@[A-Za-z]{2,}$/, 'invalid UPI id').nullable().optional() }))
    .min(1)
    .max(6),
});

const INVOICE_SELECT = `
  SELECT i.*,
    (SELECT COALESCE(json_agg(json_build_object('serviceId', it.service_id, 'name', it.name, 'qty', it.qty, 'unitPricePaise', it.unit_price_paise, 'lineTotalPaise', it.line_total_paise) ORDER BY it.position), '[]'::json) FROM invoice_items it WHERE it.invoice_id = i.id) AS items,
    (SELECT COALESCE(json_agg(json_build_object('methodCode', p.method_code, 'amountPaise', p.amount_paise, 'reference', p.reference, 'paidAt', p.paid_at) ORDER BY p.paid_at, p.id), '[]'::json) FROM invoice_payments p WHERE p.invoice_id = i.id) AS payments
  FROM invoices i`;

export const invoiceDto = (i: Record<string, any>) => ({
  id: i.id,
  salonId: i.salon_id,
  bookingId: i.booking_id,
  invoiceNo: i.invoice_no,
  customerName: i.customer_name,
  customerPhone: i.customer_phone,
  subtotalPaise: i.subtotal_paise,
  discountPaise: i.discount_paise,
  taxPaise: i.tax_paise,
  taxLabel: i.tax_label,
  taxRatePct: i.tax_rate_pct,
  gstinSnapshot: i.gstin_snapshot,
  totalPaise: i.total_paise,
  status: i.status,
  voidedReason: i.voided_reason,
  items: i.items,
  payments: i.payments,
  createdAt: i.created_at,
});

async function fetchInvoice(db: pg.Pool | pg.PoolClient, salonId: string, id: string) {
  const r = await db.query(`${INVOICE_SELECT} WHERE i.id = $1 AND i.salon_id = $2`, [id, salonId]);
  return r.rows[0] as Record<string, any> | undefined;
}

export function register(api: Api) {
  const { deps } = api;

  api.post('/salons/:salonId/invoices', { summary: 'Create a bill (totals recomputed server-side, split payments)', tag: 'Billing', auth: 'salon', perm: 'billing.create', writable: true, body: invoiceSchema, returns: 'Invoice', status: 201, idempotent: true, note: 'Payment amounts must sum to the total; methods must be enabled for the salon; bookingId marks the booking completed' }, async (req, res) => {
    const ctx = req.salonCtx!;
    const b = parse(invoiceSchema, req.body);
    const out = await withIdempotency(req, 'billing.invoice', `${req.auth!.userId}:${ctx.salonId}`, b, async () => {
      const id = await withTx(deps.pool, async (c) => {
        let customerName = b.customerName;
        let customerPhone = b.customerPhone ?? null;
        if (b.bookingId) {
          const bk = await c.query<{ status: string; customer_name: string; customer_phone: string | null }>(
            'SELECT status, customer_name, customer_phone FROM bookings WHERE id = $1 AND salon_id = $2 FOR UPDATE',
            [b.bookingId, ctx.salonId],
          );
          const row = bk.rows[0];
          if (!row) throw E.validation('Unknown bookingId for this salon', [{ field: 'bookingId', issue: 'not found' }]);
          if (!['confirmed', 'checked_in', 'completed'].includes(row.status)) throw E.conflict(`A ${row.status} booking cannot be billed`, 'INVALID_STATE');
          customerName ??= row.customer_name;
          customerPhone ??= row.customer_phone;
        }
        if (!customerName) throw E.validation('customerName is required', [{ field: 'customerName', issue: 'required without bookingId' }]);

        const svcIds = [...new Set(b.items.map((i) => i.serviceId).filter((x): x is string => !!x))];
        if (svcIds.length) {
          const ok = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM salon_services WHERE salon_id = $1 AND id = ANY($2::uuid[])', [ctx.salonId, svcIds]);
          if (ok.rows[0]!.n !== svcIds.length) throw E.validation('Unknown serviceId', [{ field: 'items', issue: 'service does not belong to this salon' }]);
        }
        const lines = b.items.map((i) => ({ ...i, line: i.qty * i.unitPricePaise }));
        const subtotal = lines.reduce((a, l) => a + l.line, 0);
        if (subtotal > MAX_SUBTOTAL) throw E.validation('Bill total is too large', [{ field: 'items', issue: 'subtotal exceeds ₹10,00,000' }]);
        if (b.discountPaise > subtotal) throw E.validation('Discount exceeds subtotal', [{ field: 'discountPaise', issue: 'greater than subtotal' }]);
        let tax = 0;
        let taxLabel: string | null = null;
        let gstinSnap: string | null = null;
        if (b.taxRatePct !== undefined && b.taxRatePct > 0) {
          if (!ctx.salon.gstEnabled || !ctx.salon.gstin) throw E.validation('Tax can only be added when GST is enabled with a GSTIN', [{ field: 'taxRatePct', issue: 'GST not enabled for this salon' }]);
          tax = Math.round(((subtotal - b.discountPaise) * b.taxRatePct) / 100);
          taxLabel = `GST ${b.taxRatePct}%`;
          gstinSnap = ctx.salon.gstin;
        }
        const total = subtotal - b.discountPaise + tax;

        const sum = b.payments.reduce((a, p) => a + p.amountPaise, 0);
        if (sum !== total) throw E.validation('Payments must add up to the invoice total', [{ field: 'payments', issue: `payments sum ${sum} != total ${total}` }]);
        if (b.payments.length) {
          const codes = [...new Set(b.payments.map((p) => p.methodCode))];
          const en = await c.query<{ code: string }>('SELECT code FROM salon_payment_methods WHERE salon_id = $1 AND is_enabled AND code = ANY($2::text[])', [ctx.salonId, codes]);
          const enabled = new Set(en.rows.map((r) => r.code));
          const bad = codes.filter((x) => !enabled.has(x));
          if (bad.length) throw E.validation('Payment method not enabled for this salon', bad.map((x) => ({ field: 'payments', issue: `${x} is not enabled` })));
        }

        // gap-free numbering: the counter row lock serialises concurrent bills, rollback releases the number
        const ctr = await c.query<{ last_no: number }>('UPDATE invoice_counters SET last_no = last_no + 1 WHERE salon_id = $1 RETURNING last_no', [ctx.salonId]);
        const no = ctr.rows[0]!.last_no;
        const year = localDateOf(Date.now(), ctx.salon.timezone).slice(0, 4);
        const invoiceNo = `${ctx.salon.invoicePrefix}-${year}-${String(no).padStart(6, '0')}`;

        let invId: string;
        try {
          const ins = await c.query<{ id: string }>(
            `INSERT INTO invoices (salon_id, booking_id, invoice_no, customer_name, customer_phone, subtotal_paise, discount_paise, tax_paise, total_paise,
                                   tax_label, tax_rate_pct, gstin_snapshot, status, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'paid',$13) RETURNING id`,
            [ctx.salonId, b.bookingId ?? null, invoiceNo, customerName, customerPhone, subtotal, b.discountPaise, tax, total, taxLabel, b.taxRatePct ?? null, gstinSnap, req.auth!.userId],
          );
          invId = ins.rows[0]!.id;
        } catch (err) {
          if (isPgError(err, '23505', 'invoices_booking_uniq')) throw E.conflict('This booking already has an invoice', 'INVOICE_EXISTS');
          throw err;
        }
        for (const [pos, l] of lines.entries()) {
          await c.query('INSERT INTO invoice_items (invoice_id, position, service_id, name, qty, unit_price_paise, line_total_paise) VALUES ($1,$2,$3,$4,$5,$6,$7)', [invId, pos, l.serviceId ?? null, l.name, l.qty, l.unitPricePaise, l.line]);
        }
        for (const p of b.payments) {
          await c.query('INSERT INTO invoice_payments (invoice_id, method_code, amount_paise, reference) VALUES ($1,$2,$3,$4)', [invId, p.methodCode, p.amountPaise, p.reference ?? null]);
        }
        if (b.bookingId) {
          await c.query("UPDATE bookings SET status = 'completed', qr_nonce = NULL, version = version + 1, updated_at = now() WHERE id = $1 AND status IN ('confirmed','checked_in')", [b.bookingId]);
        }
        return invId;
      });
      await auditReq(req, { action: 'invoice.created', entity: 'invoice', entityId: id });
      return { status: 201, body: { data: invoiceDto((await fetchInvoice(deps.pool, ctx.salonId, id))!) } };
    });
    if (out.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(out.status).json(out.body);
  });

  api.get('/salons/:salonId/invoices', { summary: 'List invoices', tag: 'Billing', auth: 'salon', perm: 'billing.view', query: listQuery, returns: 'Invoice[]' }, async (req, res) => {
    const ctx = req.salonCtx!;
    const q = parse(listQuery, req.query);
    const params: unknown[] = [ctx.salonId, q.limit + 1];
    const where: string[] = [];
    const ks = keysetFrom(q.cursor);
    if (ks) { params.push(ks.t, ks.id); where.push(`AND (i.created_at, i.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`); }
    if (q.status) { params.push(q.status); where.push(`AND i.status = $${params.length}`); }
    if (q.from) { params.push(`${q.from} 00:00 ${ctx.salon.timezone}`); where.push(`AND i.created_at >= $${params.length}::timestamptz`); }
    if (q.to) { params.push(`${q.to} 00:00 ${ctx.salon.timezone}`); where.push(`AND i.created_at < ($${params.length}::timestamptz + interval '1 day')`); }
    if (q.q) { params.push(`%${q.q.replace(/[%_\\]/g, '\\$&')}%`); where.push(`AND (i.invoice_no ILIKE $${params.length} OR i.customer_name ILIKE $${params.length} OR i.customer_phone ILIKE $${params.length})`); }
    const r = await deps.pool.query(
      `${INVOICE_SELECT.replace('SELECT i.*,', 'SELECT i.*, i.created_at::text AS _ck,')} WHERE i.salon_id = $1 ${where.join(' ')} ORDER BY i.created_at DESC, i.id DESC LIMIT $2`,
      params,
    );
    const { items, nextCursor } = pageOf(r.rows as { id: string; _ck: string }[], q.limit);
    send(res, items.map(invoiceDto), { limit: q.limit, nextCursor });
  });

  api.get('/salons/:salonId/invoices/:invoiceId', { summary: 'Invoice detail', tag: 'Billing', auth: 'salon', perm: 'billing.view', returns: 'Invoice' }, async (req, res) => {
    const row = await fetchInvoice(deps.pool, req.salonCtx!.salonId, parse(uuid, req.params['invoiceId']));
    if (!row) throw E.notFound('Invoice');
    send(res, invoiceDto(row));
  });

  api.post('/salons/:salonId/invoices/:invoiceId/void', { summary: 'Void an invoice', tag: 'Billing', auth: 'salon', perm: 'billing.void', body: voidSchema, returns: 'Invoice' }, async (req, res) => {
    const b = parse(voidSchema, req.body);
    const id = parse(uuid, req.params['invoiceId']);
    const u = await deps.pool.query("UPDATE invoices SET status = 'void', voided_reason = $3, voided_at = now() WHERE id = $1 AND salon_id = $2 AND status <> 'void' RETURNING id", [id, req.salonCtx!.salonId, b.reason]);
    if (!u.rowCount) {
      const cur = await fetchInvoice(deps.pool, req.salonCtx!.salonId, id);
      if (!cur) throw E.notFound('Invoice');
      throw E.conflict('Invoice is already void', 'ALREADY_VOID');
    }
    await auditReq(req, { action: 'invoice.voided', entity: 'invoice', entityId: id, meta: { reason: b.reason } });
    send(res, invoiceDto((await fetchInvoice(deps.pool, req.salonCtx!.salonId, id))!));
  });

  // ---- payment methods
  const methods = async (salonId: string) => {
    const r = await deps.pool.query('SELECT code, label, is_enabled, upi_id, sort FROM salon_payment_methods WHERE salon_id = $1 ORDER BY sort, code', [salonId]);
    return r.rows.map((m) => ({ code: m.code, label: m.label, isEnabled: m.is_enabled, upiId: m.upi_id, sort: m.sort }));
  };

  api.get('/salons/:salonId/payment-methods', { summary: 'Payment methods the salon accepts (any member can read)', tag: 'Billing', auth: 'salon', returns: 'PaymentMethod[]' }, async (req, res) => {
    send(res, await methods(req.salonCtx!.salonId));
  });

  api.put('/salons/:salonId/payment-methods', { summary: 'Choose accepted payment methods', tag: 'Billing', auth: 'salon', perm: 'payments.configure', body: methodsSchema, returns: 'PaymentMethod[]' }, async (req, res) => {
    const b = parse(methodsSchema, req.body);
    const salonId = req.salonCtx!.salonId;
    if (new Set(b.methods.map((m) => m.code)).size !== b.methods.length) throw E.validation('Duplicate method code', [{ field: 'methods', issue: 'code repeated' }]);
    await withTx(deps.pool, async (c) => {
      for (const m of b.methods) {
        await c.query(
          `INSERT INTO salon_payment_methods (salon_id, code, label, is_enabled, upi_id, sort)
           VALUES ($1,$2,COALESCE($3, initcap(replace($2,'_',' '))),$4,$5, (SELECT COALESCE(max(sort),0)+1 FROM salon_payment_methods WHERE salon_id = $1))
           ON CONFLICT (salon_id, code) DO UPDATE SET label = COALESCE($3, salon_payment_methods.label), is_enabled = EXCLUDED.is_enabled,
             upi_id = CASE WHEN $6::boolean THEN EXCLUDED.upi_id ELSE salon_payment_methods.upi_id END`,
          [salonId, m.code, m.label ?? null, m.isEnabled, m.upiId ?? null, m.upiId !== undefined],
        );
      }
      const n = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM salon_payment_methods WHERE salon_id = $1 AND is_enabled', [salonId]);
      if (n.rows[0]!.n === 0) throw new AppError('VALIDATION_FAILED', 'At least one payment method must stay enabled', [{ field: 'methods', issue: 'all methods disabled' }]);
    });
    await auditReq(req, { action: 'payment_methods.updated', entity: 'salon', entityId: salonId });
    send(res, await methods(salonId));
  });
}
