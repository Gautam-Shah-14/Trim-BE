import type { NextFunction, Request, Response } from 'express';
import { E, type FieldIssue } from '../errors.js';

const NUL_ISSUE = 'must not contain NUL (\\u0000) characters';

function scan(v: unknown, path: string, out: FieldIssue[], depth = 0): void {
  if (out.length >= 5 || depth > 12) return;
  if (typeof v === 'string') {
    if (v.includes('\u0000')) out.push({ field: path || 'body', issue: NUL_ISSUE });
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => scan(x, `${path}[${i}]`, out, depth + 1));
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k.includes('\u0000')) out.push({ field: path || 'body', issue: NUL_ISSUE });
      scan(x, path ? `${path}.${k}` : k, out, depth + 1);
    }
  }
}

/**
 * PostgreSQL text cannot hold NUL bytes (error 22021 would surface as a 500). Reject them at the edge, in one place:
 * the raw URL (path and query, encoded as %00 or literal), every string in a parsed JSON body (any depth, keys included).
 * Returns 422 VALIDATION_FAILED. The raw-body webhook route is left alone (its body is a Buffer, signature checked first).
 */
export function rejectNulBytes(req: Request, _res: Response, next: NextFunction) {
  const issues: FieldIssue[] = [];
  const url = req.originalUrl || req.url;
  if (/%00/i.test(url) || url.includes('\u0000')) issues.push({ field: 'url', issue: NUL_ISSUE });
  if (!Buffer.isBuffer(req.body)) scan(req.body, '', issues);
  if (issues.length) return next(E.validation('Request contains NUL characters', issues));
  next();
}
