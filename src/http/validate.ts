import { z, type ZodType } from 'zod';
import { E, type FieldIssue } from '../errors.js';
import { PASSWORD_RE } from '../lib/security.js';

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data ?? {});
  if (r.success) return r.data;
  const details: FieldIssue[] = r.error.issues.map((i) => {
    let field = i.path.join('.');
    if (i.code === 'unrecognized_keys') field = (i as { keys: string[] }).keys.join(',');
    return { field, issue: i.code === 'unrecognized_keys' ? 'unknown field' : i.message };
  });
  throw E.validation('Request validation failed', details);
}

/** trimmed non-empty string with max length */
export const str = (max: number, min = 1) => z.string().trim().min(min).max(max);
export const optStr = (max: number) => z.string().trim().max(max).optional();

export const uuid = z.string().uuid();
export const phoneE164 = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, 'must be E.164 (e.g. +919876543210)');
export const email = z.string().trim().toLowerCase().email().max(254);
export const password = z.string().regex(PASSWORD_RE, 'must be at least 8 characters with a letter and a digit');
export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
export const timeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'must be HH:MM');
export const isoInstant = z
  .string()
  .datetime({ offset: true })
  .transform((s) => new Date(s));
/** integer paise, 0 .. ₹1,00,000 */
export const paise = z.number().int().min(0).max(10_000_000);
export const durationMin = z.number().int().min(5).max(480);
export const idList = (max = 20) => z.array(uuid).min(1).max(max);

export const commaIds = z
  .string()
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(uuid).min(1).max(20));

export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(600).optional(),
});

export function encodeCursor(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}
export function decodeCursor<T = Record<string, unknown>>(c: string | undefined): T | null {
  if (!c) return null;
  try {
    return JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as T;
  } catch {
    throw E.validation('Invalid cursor', [{ field: 'cursor', issue: 'invalid cursor' }]);
  }
}

/** keyset helper for (created_at desc, id desc). Rows must expose `_ck` (created_at::text) and `id`. */
export function pageOf<T extends { id: string; _ck: string }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ t: last._ck, id: last.id }) : null;
  return { items: items.map(({ _ck: _drop, ...rest }) => rest), nextCursor };
}

export function keysetFrom(cursor: string | undefined): { t: string; id: string } | null {
  const c = decodeCursor<{ t?: string; id?: string }>(cursor);
  if (!c) return null;
  if (typeof c.t !== 'string' || typeof c.id !== 'string') throw E.validation('Invalid cursor', [{ field: 'cursor', issue: 'invalid cursor' }]);
  return { t: c.t, id: c.id };
}

export { z };
