import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Api, authenticate, send } from '../http/api.js';
import { parse, z, uuid } from '../http/validate.js';
import { E } from '../errors.js';
import { sha256Hex } from '../lib/security.js';
import { auditReq } from '../lib/audit.js';
import type { Permission } from '../lib/permissions.js';

export const MAX_MEDIA_BYTES = 200 * 1024;
const PUBLIC_KINDS = new Set(['logo', 'salon_photo', 'staff_photo']);

export type DetectedMime = 'image/jpeg' | 'image/png' | 'image/webp';

/** Detect the real image type from magic bytes. */
export function detectMime(b: Buffer): DetectedMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

const mediaSchema = z.strictObject({
  kind: z.enum(['logo', 'salon_photo', 'avatar', 'staff_photo']),
  mime: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  dataBase64: z.string().min(8).max(300_000),
  salonId: uuid.optional(),
});

const run = (mw: RequestHandler, req: Request, res: Response) =>
  new Promise<void>((resolve, reject) => {
    const next: NextFunction = (err?: unknown) => (err ? reject(err) : resolve());
    Promise.resolve(mw(req, res, next)).catch(reject);
  });

export function register(api: Api) {
  const { deps } = api;

  api.post('/media', { summary: 'Upload an image (base64, ≤200 KB decoded)', tag: 'Media', auth: 'user', body: mediaSchema, returns: 'MediaId', status: 201, note: 'logo/salon_photo need settings.edit; staff_photo needs staff.manage or settings.edit in that salon' }, async (req, res) => {
    const b = parse(mediaSchema, req.body);
    const b64 = b.dataBase64.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw E.validation('Invalid base64', [{ field: 'dataBase64', issue: 'not valid base64' }]);
    const bytes = Buffer.from(b64, 'base64');
    if (bytes.byteLength === 0) throw E.validation('Empty image', [{ field: 'dataBase64', issue: 'empty' }]);
    if (bytes.byteLength > MAX_MEDIA_BYTES) throw E.validation('Image too large (max 200 KB)', [{ field: 'dataBase64', issue: 'exceeds 204800 bytes' }]);
    const real = detectMime(bytes);
    if (!real) throw E.validation('File is not a JPEG, PNG or WebP image', [{ field: 'dataBase64', issue: 'unrecognised image signature' }]);
    if (real !== b.mime) throw E.validation('Declared mime does not match the image content', [{ field: 'mime', issue: `content is ${real}` }]);

    if (b.kind === 'avatar') {
      if (b.salonId) throw E.validation('avatar must not carry a salonId', [{ field: 'salonId', issue: 'not allowed for avatar' }]);
    } else {
      if (!b.salonId) throw E.validation('salonId is required for this kind', [{ field: 'salonId', issue: 'required' }]);
      if (req.auth!.role !== 'admin') {
        const need: Permission[] = b.kind === 'staff_photo' ? ['staff.manage', 'settings.edit'] : ['settings.edit'];
        const r = await deps.pool.query<{ permission: string }>(
          `SELECT p.permission FROM salon_staff st JOIN salon_role_permissions p ON p.role_id = st.role_id
            WHERE st.salon_id = $1 AND st.user_id = $2 AND st.is_active`,
          [b.salonId, req.auth!.userId],
        );
        if (!r.rows.some((x) => (need as string[]).includes(x.permission))) throw E.forbidden('Missing permission for this upload');
      }
      if (b.kind === 'salon_photo') {
        const c = await deps.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM media WHERE salon_id = $1 AND kind = 'salon_photo'", [b.salonId]);
        if (c.rows[0]!.n >= 12) throw E.conflict('A salon can have at most 12 photos', 'PHOTO_LIMIT');
      }
    }
    const r = await deps.pool.query<{ id: string }>(
      'INSERT INTO media (owner_user_id, salon_id, kind, mime, byte_size, data_base64, sha256) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [req.auth!.userId, b.salonId ?? null, b.kind, real, bytes.byteLength, b64, sha256Hex(bytes)],
    );
    send(res, { id: r.rows[0]!.id }, undefined, 201);
  });

  api.get('/media/:id', { summary: 'Fetch raw image bytes', tag: 'Media', auth: 'none', raw: 'image/*', note: 'Public for logo/salon_photo/staff_photo; avatars need a Bearer token. Supports ETag / If-None-Match.' }, async (req, res) => {
    const id = parse(uuid, req.params['id']);
    const m = await deps.pool.query<{ kind: string; mime: string; sha256: string }>('SELECT kind, mime, sha256 FROM media WHERE id = $1', [id]);
    const meta = m.rows[0];
    if (!meta) throw E.notFound('Media');
    const isPublic = PUBLIC_KINDS.has(meta.kind);
    if (!isPublic) await run(authenticate, req, res);
    const etag = `"${meta.sha256}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', isPublic ? 'public, max-age=86400' : 'private, max-age=86400');
    res.setHeader('Content-Type', meta.mime);
    if (req.header('if-none-match') === etag) {
      res.status(304).end();
      return;
    }
    const d = await deps.pool.query<{ data_base64: string }>('SELECT data_base64 FROM media WHERE id = $1', [id]);
    res.status(200).end(Buffer.from(d.rows[0]!.data_base64, 'base64'));
  });

  api.delete('/media/:id', { summary: 'Delete an image you uploaded', tag: 'Media', auth: 'user' }, async (req, res) => {
    const id = parse(uuid, req.params['id']);
    const r = await deps.pool.query(
      `DELETE FROM media WHERE id = $1 AND (owner_user_id = $2 OR $3 = 'admin'
         OR EXISTS (SELECT 1 FROM salon_staff st JOIN salon_role_permissions p ON p.role_id = st.role_id
                     WHERE st.salon_id = media.salon_id AND st.user_id = $2 AND st.is_active AND p.permission = 'settings.edit'))`,
      [id, req.auth!.userId, req.auth!.role],
    );
    if (r.rowCount === 0) throw E.notFound('Media');
    await auditReq(req, { action: 'media.deleted', entity: 'media', entityId: id });
    send(res, { ok: true });
  });
}
