import { Api, send } from '../http/api.js';
import { userLimiter } from '../http/rateLimit.js';
import { parse, z, dateStr, uuid, pageQuery, decodeCursor, encodeCursor } from '../http/validate.js';
import { E } from '../errors.js';
import { invoicesCsv } from '../lib/csv.js';
import { addDays, isValidDateString, localDateOf, localDayRange } from '../lib/slots.js';

const rangeQuery = z.object({ from: dateStr.optional(), to: dateStr.optional() });
const customersQuery = pageQuery.extend({ q: z.string().trim().max(60).optional() });

const CKEY = "COALESCE(NULLIF(customer_phone, ''), 'name:' || lower(customer_name))";

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

const LIVE_SERIES_SQL = `
  SELECT d::date::text AS date,
         (SELECT count(*)::int FROM bookings b WHERE b.salon_id = $1 AND b.status NOT IN ('held','expired') AND (b.starts_at AT TIME ZONE $4)::date = d::date) AS bookings,
         (SELECT count(*)::int FROM bookings b WHERE b.salon_id = $1 AND b.status = 'completed' AND (b.starts_at AT TIME ZONE $4)::date = d::date) AS completed,
         (SELECT COALESCE(sum(i.total_paise),0)::bigint FROM invoices i WHERE i.salon_id = $1 AND i.status = 'paid' AND (i.created_at AT TIME ZONE $4)::date = d::date) AS revenue
    FROM generate_series($2::date, $3::date, interval '1 day') d`;

const LARGE_EXPORT_DAYS = 92;
const exportBody = z.strictObject({ from: dateStr.optional(), to: dateStr.optional() });

export function register(api: Api) {
  const { deps } = api;

  /** past days come from the daily_salon_stats rollup when it is complete for the range, today/missing days are computed live */
  async function dailySeries(salonId: string, from: string, to: string, tz: string): Promise<{ rows: { date: string; bookings: number; completed: number; revenue: number }[] }> {
    const today = localDateOf(Date.now(), tz);
    const lastPast = to < today ? to : addDays(today, -1);
    if (from <= lastPast) {
      const r = await deps.pool.query<{ date: string; bookings: number; completed: number; revenue: number }>(
        "SELECT day::text AS date, bookings, completed, revenue_paise AS revenue FROM daily_salon_stats WHERE salon_id = $1 AND dim = 'day' AND day BETWEEN $2::date AND $3::date ORDER BY day",
        [salonId, from, lastPast],
      );
      let expected = 0;
      for (let d = from; d <= lastPast; d = addDays(d, 1)) expected++;
      if (r.rows.length === expected) {
        const live = to > lastPast ? (await deps.pool.query(LIVE_SERIES_SQL, [salonId, addDays(lastPast, 1), to, tz])).rows : [];
        return { rows: [...r.rows, ...live] };
      }
    }
    return deps.pool.query(LIVE_SERIES_SQL, [salonId, from, to, tz]);
  }


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
        dailySeries(ctx.salonId, rg.from, rg.to, tz),
      ]);
      const rp = repeat.rows[0];
      Object.assign(out, {
        byService: byService.rows.map((x) => ({ name: x.name, qty: x.qty, revenuePaise: x.revenue })),
        byStaff: byStaff.rows.map((x) => ({ staffId: x.id, displayName: x.display_name, bookings: x.bookings, completed: x.completed, noShows: x.no_shows, revenuePaise: x.revenue })),
        hourlyHeatMap: heat.rows.map((x) => ({ weekday: x.weekday, hour: x.hour, bookings: x.n })),
        repeatCustomers: { customers: rp.total, repeat: rp.repeat, rate: rp.total ? Math.round((rp.repeat / rp.total) * 1000) / 1000 : 0 },
        repeatCustomerRate: rp.total ? Math.round((rp.repeat / rp.total) * 1000) / 1000 : 0,
        dailySeries: daily.rows.map((x) => ({ date: x.date, bookings: x.bookings, completed: x.completed, revenuePaise: x.revenue })),
      });
    }
    send(res, out);
  });

  api.get('/salons/:salonId/analytics/export.csv', { summary: 'CSV export of invoices in range', tag: 'Analytics', auth: 'salon', perm: 'analytics.view', query: rangeQuery, raw: 'text/csv', note: 'Requires the csv_export entitlement (Pro). Allowed in read-only mode. Ranges over 92 days return 202 {jobId} - poll GET /salons/:salonId/jobs/:jobId.' }, async (req, res) => {
    const ctx = req.salonCtx!;
    if (!ctx.ent.limits.csvExport) throw E.planLimit('CSV export needs the Pro plan', 'csv_export');
    const rg = resolveRange(parse(rangeQuery, req.query), ctx.salon.timezone);
    const days = Math.round((rg.end.getTime() - rg.start.getTime()) / 86_400_000);
    if (days > LARGE_EXPORT_DAYS) {
      // big ranges are generated by a worker; the client polls GET .../jobs/:jobId (spec 11.6)
      const jobId = await createExportJob(ctx.salonId, req.auth!.userId, rg.start, rg.end);
      res.status(202).json({ data: { jobId, status: 'queued' } });
      return;
    }
    const csv = await invoicesCsv(deps.pool, ctx.salonId, rg.start, rg.end);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="trim-invoices-${rg.from}-${rg.to}.csv"`);
    res.status(200).send(csv);
  });

  async function createExportJob(salonId: string, userId: string, start: Date, end: Date): Promise<string> {
    const j = await deps.pool.query<{ id: string }>(
      "INSERT INTO export_jobs (salon_id, requested_by, params) VALUES ($1,$2,$3) RETURNING id",
      [salonId, userId, JSON.stringify({ start: start.toISOString(), end: end.toISOString() })],
    );
    await deps.queue.enqueue('export.run', { jobId: j.rows[0]!.id }, { singletonKey: j.rows[0]!.id });
    return j.rows[0]!.id;
  }

  api.post('/salons/:salonId/analytics/export', { summary: 'Start an asynchronous invoice CSV export (202 + jobId)', tag: 'Analytics', auth: 'salon', perm: 'analytics.view', body: exportBody, status: 202, returns: 'ExportStarted', note: 'Requires the csv_export entitlement (Pro). Poll GET /salons/:salonId/jobs/:jobId, then download.', limit: [userLimiter('export', 6)] }, async (req, res) => {
    const ctx = req.salonCtx!;
    if (!ctx.ent.limits.csvExport) throw E.planLimit('CSV export needs the Pro plan', 'csv_export');
    const rg = resolveRange(parse(exportBody, req.body), ctx.salon.timezone);
    const jobId = await createExportJob(ctx.salonId, req.auth!.userId, rg.start, rg.end);
    send(res, { jobId, status: 'queued' }, undefined, 202);
  });

  const jobDto = (j: Record<string, any>) => ({ id: j.id, kind: j.kind, status: j.status, error: j.error, createdAt: j.created_at, finishedAt: j.finished_at, downloadPath: j.status === 'done' ? `/v1/salons/${j.salon_id}/jobs/${j.id}/download` : null });

  api.get('/salons/:salonId/jobs/:jobId', { summary: 'Status of an asynchronous export job', tag: 'Analytics', auth: 'salon', perm: 'analytics.view', returns: 'ExportJob' }, async (req, res) => {
    const r = await deps.pool.query('SELECT id, salon_id, kind, status, error, created_at, finished_at FROM export_jobs WHERE id = $1 AND salon_id = $2', [parse(uuid, req.params['jobId']), req.salonCtx!.salonId]);
    if (!r.rows[0]) throw E.notFound('Job');
    send(res, jobDto(r.rows[0]));
  });

  api.get('/salons/:salonId/jobs/:jobId/download', { summary: 'Download the finished export (CSV)', tag: 'Analytics', auth: 'salon', perm: 'analytics.view', raw: 'text/csv' }, async (req, res) => {
    const r = await deps.pool.query('SELECT status, result_csv FROM export_jobs WHERE id = $1 AND salon_id = $2', [parse(uuid, req.params['jobId']), req.salonCtx!.salonId]);
    if (!r.rows[0]) throw E.notFound('Job');
    if (r.rows[0].status !== 'done') throw E.conflict('The export is not ready yet', 'NOT_READY');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="trim-export.csv"');
    res.status(200).send(r.rows[0].result_csv);
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
