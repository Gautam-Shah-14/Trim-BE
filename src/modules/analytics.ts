import { Api, send } from '../http/api.js';
import { parse, z, dateStr, pageQuery, decodeCursor, encodeCursor } from '../http/validate.js';
import { E } from '../errors.js';
import { addDays, isValidDateString, localDateOf, localDayRange } from '../lib/slots.js';

const rangeQuery = z.object({ from: dateStr.optional(), to: dateStr.optional() });
const customersQuery = pageQuery.extend({ q: z.string().trim().max(60).optional() });

const CKEY = "COALESCE(NULLIF(customer_phone, ''), 'name:' || lower(customer_name))";

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function resolveRange(q: { from?: string; to?: string }, tz: string) {
  const today = localDateOf(Date.now(), tz);
  const to = q.to ?? today;
  const from = q.from ?? addDays(to, -29);
  for (const [k, v] of [['from', from], ['to', to]] as const) {
    if (!isValidDateString(v)) throw E.validation('Invalid date', [{ field: k, issue: 'not a calendar date' }]);
  }
  if (from > to) throw E.validation('from must not be after to', [{ field: 'from', issue: 'after to' }]);
  if (addDays(from, 366) < to) throw E.validation('Range too large (max 366 days)', [{ field: 'to', issue: 'range exceeds 366 days' }]);
  return { from, to, start: new Date(localDayRange(from, tz).start), end: new Date(localDayRange(to, tz).end) };
}

export function register(api: Api) {
  const { deps } = api;

  api.get('/salons/:salonId/analytics/summary', { summary: 'Analytics summary (basic or full by plan)', tag: 'Analytics', auth: 'salon', perm: 'analytics.view', query: rangeQuery, returns: 'AnalyticsSummary', note: 'Dates are salon-local calendar dates (default last 30 days). `full` level adds per-service, per-staff, heat map, repeat rate and daily series.' }, async (req, res) => {
    const ctx = req.salonCtx!;
    const tz = ctx.salon.timezone;
    const rg = resolveRange(parse(rangeQuery, req.query), tz);
    const level = ctx.ent.limits.analyticsLevel;
    const p = [ctx.salonId, rg.start, rg.end];

    const basic = await deps.pool.query(
      `SELECT (SELECT count(*)::int FROM bookings WHERE salon_id = $1 AND starts_at >= $2 AND starts_at < $3 AND status NOT IN ('held','expired')) AS bookings,
              (SELECT count(*)::int FROM bookings WHERE salon_id = $1 AND starts_at >= $2 AND starts_at < $3 AND status = 'completed') AS completed,
              (SELECT count(*)::int FROM bookings WHERE salon_id = $1 AND starts_at >= $2 AND starts_at < $3 AND status = 'no_show') AS no_shows,
              (SELECT count(*)::int FROM bookings WHERE salon_id = $1 AND starts_at >= $2 AND starts_at < $3 AND status = 'cancelled') AS cancelled,
              (SELECT COALESCE(sum(total_paise),0)::bigint FROM invoices WHERE salon_id = $1 AND created_at >= $2 AND created_at < $3 AND status = 'paid') AS revenue,
              (SELECT count(*)::int FROM invoices WHERE salon_id = $1 AND created_at >= $2 AND created_at < $3 AND status = 'paid') AS invoices`,
      p,
    );
    const b = basic.rows[0];
    const out: Record<string, unknown> = {
      level,
      range: { from: rg.from, to: rg.to, timezone: tz },
      totals: { bookings: b.bookings, completed: b.completed, noShows: b.no_shows, cancelled: b.cancelled, revenuePaise: b.revenue, invoices: b.invoices },
    };
    if (level === 'full') {
      const [byService, byStaff, heat, repeat, daily] = await Promise.all([
        deps.pool.query(
          `SELECT it.name, sum(it.qty)::int AS qty, sum(it.line_total_paise)::bigint AS revenue
             FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id
            WHERE i.salon_id = $1 AND i.created_at >= $2 AND i.created_at < $3 AND i.status = 'paid'
            GROUP BY it.name ORDER BY revenue DESC, it.name LIMIT 30`, p),
        deps.pool.query(
          `SELECT st.id, st.display_name, count(*) FILTER (WHERE b.status NOT IN ('held','expired'))::int AS bookings,
                  count(*) FILTER (WHERE b.status = 'completed')::int AS completed,
                  count(*) FILTER (WHERE b.status = 'no_show')::int AS no_shows,
                  COALESCE(sum(i.total_paise) FILTER (WHERE i.status = 'paid'), 0)::bigint AS revenue
             FROM salon_staff st
             LEFT JOIN bookings b ON b.staff_id = st.id AND b.starts_at >= $2 AND b.starts_at < $3
             LEFT JOIN invoices i ON i.booking_id = b.id
            WHERE st.salon_id = $1 GROUP BY st.id ORDER BY revenue DESC, st.display_name`, p),
        deps.pool.query(
          `SELECT extract(dow FROM starts_at AT TIME ZONE $4)::int AS weekday, extract(hour FROM starts_at AT TIME ZONE $4)::int AS hour, count(*)::int AS n
             FROM bookings WHERE salon_id = $1 AND starts_at >= $2 AND starts_at < $3 AND status NOT IN ('held','expired','cancelled')
            GROUP BY 1, 2 ORDER BY 1, 2`, [...p, tz]),
        deps.pool.query(
          `WITH in_range AS (
              SELECT DISTINCT ${CKEY} AS ckey FROM bookings WHERE salon_id = $1 AND status = 'completed' AND starts_at >= $2 AND starts_at < $3),
            lifetime AS (
              SELECT ${CKEY} AS ckey, count(*) AS n FROM bookings WHERE salon_id = $1 AND status = 'completed' GROUP BY 1)
           SELECT count(*)::int AS total, count(*) FILTER (WHERE l.n >= 2)::int AS repeat FROM in_range r JOIN lifetime l USING (ckey)`, p),
        deps.pool.query(
          `SELECT d::date::text AS date,
                  (SELECT count(*)::int FROM bookings b WHERE b.salon_id = $1 AND b.status NOT IN ('held','expired') AND (b.starts_at AT TIME ZONE $4)::date = d::date) AS bookings,
                  (SELECT count(*)::int FROM bookings b WHERE b.salon_id = $1 AND b.status = 'completed' AND (b.starts_at AT TIME ZONE $4)::date = d::date) AS completed,
                  (SELECT COALESCE(sum(i.total_paise),0)::bigint FROM invoices i WHERE i.salon_id = $1 AND i.status = 'paid' AND (i.created_at AT TIME ZONE $4)::date = d::date) AS revenue
             FROM generate_series($2::date, $3::date, interval '1 day') d`, [ctx.salonId, rg.from, rg.to, tz]),
      ]);
      const rp = repeat.rows[0];
      Object.assign(out, {
        byService: byService.rows.map((x) => ({ name: x.name, qty: x.qty, revenuePaise: x.revenue })),
        byStaff: byStaff.rows.map((x) => ({ staffId: x.id, displayName: x.display_name, bookings: x.bookings, completed: x.completed, noShows: x.no_shows, revenuePaise: x.revenue })),
        hourlyHeatMap: heat.rows.map((x) => ({ weekday: x.weekday, hour: x.hour, bookings: x.n })),
        repeatCustomers: { customers: rp.total, repeat: rp.repeat, rate: rp.total ? Math.round((rp.repeat / rp.total) * 1000) / 1000 : 0 },
        dailySeries: daily.rows.map((x) => ({ date: x.date, bookings: x.bookings, completed: x.completed, revenuePaise: x.revenue })),
      });
    }
    send(res, out);
  });

  api.get('/salons/:salonId/analytics/export.csv', { summary: 'CSV export of invoices in range', tag: 'Analytics', auth: 'salon', perm: 'analytics.view', query: rangeQuery, raw: 'text/csv', note: 'Requires the csv_export entitlement (Pro). Allowed in read-only mode.' }, async (req, res) => {
    const ctx = req.salonCtx!;
    if (!ctx.ent.limits.csvExport) throw E.planLimit('CSV export needs the Pro plan', 'csv_export');
    const rg = resolveRange(parse(rangeQuery, req.query), ctx.salon.timezone);
    const r = await deps.pool.query(
      `SELECT i.invoice_no, i.created_at, i.customer_name, i.customer_phone, i.subtotal_paise, i.discount_paise, i.tax_paise, i.total_paise, i.status,
              COALESCE((SELECT string_agg(p.method_code || ':' || p.amount_paise, ' | ' ORDER BY p.paid_at) FROM invoice_payments p WHERE p.invoice_id = i.id), '') AS payments
         FROM invoices i WHERE i.salon_id = $1 AND i.created_at >= $2 AND i.created_at < $3 ORDER BY i.created_at, i.invoice_no`,
      [ctx.salonId, rg.start, rg.end],
    );
    const head = ['invoice_no', 'created_at', 'customer_name', 'customer_phone', 'subtotal_paise', 'discount_paise', 'tax_paise', 'total_paise', 'status', 'payments'];
    const lines = [head.join(','), ...r.rows.map((x) => [x.invoice_no, x.created_at, x.customer_name, x.customer_phone, x.subtotal_paise, x.discount_paise, x.tax_paise, x.total_paise, x.status, x.payments].map(csvCell).join(','))];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="trim-invoices-${rg.from}-${rg.to}.csv"`);
    res.status(200).send(`${lines.join('\r\n')}\r\n`);
  });

  // ---- customers CRM
  api.get('/salons/:salonId/customers', { summary: 'Customers derived from bookings and invoices', tag: 'Customers', auth: 'salon', perm: 'customers.view', query: customersQuery, returns: 'Customer[]' }, async (req, res) => {
    const q = parse(customersQuery, req.query);
    const offset = decodeCursor<{ o: number }>(q.cursor)?.o ?? 0;
    const params: unknown[] = [req.salonCtx!.salonId, q.limit + 1, offset];
    let filter = '';
    if (q.q) {
      params.push(`%${q.q.replace(/[%_\\]/g, '\\$&')}%`);
      filter = `WHERE name ILIKE $4 OR phone ILIKE $4`;
    }
    const r = await deps.pool.query(
      `WITH b AS (
          SELECT ${CKEY} AS ckey, max(customer_name) AS name, max(customer_phone) AS phone, (array_agg(customer_id) FILTER (WHERE customer_id IS NOT NULL))[1] AS customer_id,
                 count(*)::int AS bookings, count(*) FILTER (WHERE status = 'completed')::int AS visits, count(*) FILTER (WHERE status = 'no_show')::int AS no_shows,
                 max(starts_at) FILTER (WHERE status = 'completed') AS last_visit
            FROM bookings WHERE salon_id = $1 AND status NOT IN ('held','expired') GROUP BY 1),
        i AS (
          SELECT ${CKEY} AS ckey, max(customer_name) AS name, max(customer_phone) AS phone,
                 COALESCE(sum(total_paise) FILTER (WHERE status = 'paid'), 0)::bigint AS spent
            FROM invoices WHERE salon_id = $1 GROUP BY 1),
        m AS (
          SELECT COALESCE(b.ckey, i.ckey) AS ckey, COALESCE(b.name, i.name) AS name, COALESCE(b.phone, i.phone) AS phone, b.customer_id,
                 COALESCE(b.bookings, 0) AS bookings, COALESCE(b.visits, 0) AS visits, COALESCE(b.no_shows, 0) AS no_shows, b.last_visit, COALESCE(i.spent, 0) AS spent
            FROM b FULL OUTER JOIN i ON i.ckey = b.ckey)
       SELECT * FROM m ${filter} ORDER BY last_visit DESC NULLS LAST, name LIMIT $2 OFFSET $3`,
      params,
    );
    const hasMore = r.rows.length > q.limit;
    const rows = hasMore ? r.rows.slice(0, q.limit) : r.rows;
    send(res, rows.map(customerDto), { limit: q.limit, nextCursor: hasMore ? encodeCursor({ o: offset + q.limit }) : null });
  });

  api.get('/salons/:salonId/customers/:customerKey', { summary: 'Customer detail with history (key = id from the list, URL-encoded)', tag: 'Customers', auth: 'salon', perm: 'customers.view', returns: 'CustomerDetail' }, async (req, res) => {
    const key = String(req.params['customerKey']);
    const salonId = req.salonCtx!.salonId;
    const [bk, inv] = await Promise.all([
      deps.pool.query(
        `SELECT b.id, b.status, b.starts_at, b.total_price_paise, b.customer_name, b.customer_phone, st.display_name AS staff_name
           FROM bookings b JOIN salon_staff st ON st.id = b.staff_id
          WHERE b.salon_id = $1 AND ${CKEY.replace(/customer_phone/g, 'b.customer_phone').replace(/customer_name/g, 'b.customer_name')} = $2 AND b.status NOT IN ('held','expired')
          ORDER BY b.starts_at DESC LIMIT 50`, [salonId, key]),
      deps.pool.query(
        `SELECT id, invoice_no, total_paise, status, created_at, customer_name, customer_phone FROM invoices
          WHERE salon_id = $1 AND ${CKEY} = $2 ORDER BY created_at DESC LIMIT 50`, [salonId, key]),
    ]);
    if (!bk.rows.length && !inv.rows.length) throw E.notFound('Customer');
    const first = bk.rows[0] ?? inv.rows[0];
    send(res, {
      id: key, name: first.customer_name, phone: first.customer_phone,
      bookings: bk.rows.map((x) => ({ id: x.id, status: x.status, startsAt: x.starts_at, totalPricePaise: x.total_price_paise, staffName: x.staff_name })),
      invoices: inv.rows.map((x) => ({ id: x.id, invoiceNo: x.invoice_no, totalPaise: x.total_paise, status: x.status, createdAt: x.created_at })),
    });
  });
}

const customerDto = (c: Record<string, any>) => ({
  id: c.ckey, name: c.name, phone: c.phone, customerId: c.customer_id, bookings: c.bookings, visits: c.visits, noShows: c.no_shows,
  lastVisitAt: c.last_visit, totalSpentPaise: c.spent,
});
