import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';

/**
 * Send `{data, meta?}` with a weak ETag and Cache-Control; honours If-None-Match (304).
 * `scope: 'public'` lets a CDN cache it; use 'private' for anything user specific.
 */
export function sendCached(req: Request, res: Response, body: { data: unknown; meta?: unknown }, o: { maxAge: number; swr?: number; scope?: 'public' | 'private' }) {
  const json = JSON.stringify(body);
  const etag = `W/"${createHash('sha1').update(json).digest('base64url').slice(0, 22)}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', `${o.scope ?? 'public'}, max-age=${o.maxAge}${o.swr ? `, stale-while-revalidate=${o.swr}` : ''}`);
  res.setHeader('Vary', 'Accept-Encoding, Authorization');
  const inm = req.header('if-none-match');
  if (inm && inm.split(',').some((t) => t.trim() === etag)) {
    res.status(304).end();
    return;
  }
  res.status(200).type('application/json').send(json);
}
