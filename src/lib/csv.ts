import type pg from 'pg';

export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const HEAD = ['invoice_no', 'created_at', 'customer_name', 'customer_phone', 'subtotal_paise', 'discount_paise', 'tax_paise', 'total_paise', 'status', 'payments'];

export async function invoicesCsv(pool: pg.Pool, salonId: string, start: Date, end: Date): Promise<string> {
  const r = await pool.query(
    `SELECT i.invoice_no, i.created_at, i.customer_name, i.customer_phone, i.subtotal_paise, i.discount_paise, i.tax_paise, i.total_paise, i.status,
            COALESCE((SELECT string_agg(p.method_code || ':' || p.amount_paise, ' | ' ORDER BY p.paid_at) FROM invoice_payments p WHERE p.invoice_id = i.id), '') AS payments
       FROM invoices i WHERE i.salon_id = $1 AND i.created_at >= $2 AND i.created_at < $3 ORDER BY i.created_at, i.invoice_no`,
    [salonId, start, end],
  );
  const lines = [HEAD.join(','), ...r.rows.map((x) => [x.invoice_no, x.created_at, x.customer_name, x.customer_phone, x.subtotal_paise, x.discount_paise, x.tax_paise, x.total_paise, x.status, x.payments].map(csvCell).join(','))];
  return `${lines.join('\r\n')}\r\n`;
}
