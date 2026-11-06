import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { NextFunction, Request, Response } from 'express';

const digest = (s: string) => createHash('sha256').update(s).digest();

/** a valid IPv4/IPv6 literal (no ports, no zone ids, no lists) or null */
export function parseClientIp(raw: string | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (v.length > 45 || v.includes('%')) return null;
  return isIP(v) ? v.toLowerCase() : null;
}

/**
 * Authenticated BFF client IP. The website's server (behind Vercel) calls this API from a shared egress IP, so per-IP rate limits
 * would see ONE client for all visitors. When a request carries `X-Trim-BFF-Key` equal to BFF_SHARED_SECRET (constant-time compare)
 * AND `X-Trim-Client-IP` is a valid IP address, that address becomes `req.ip` (used by rate limiting, audit log and metrics).
 * Without the secret, or with a wrong key, both headers are ignored: they are never trusted unauthenticated.
 * Direct clients (mobile apps, desktop) keep the normal TRUST_PROXY behaviour.
 */
export function bffClientIp(secret: string) {
  const expected = secret ? digest(secret) : null;
  return (req: Request, _res: Response, next: NextFunction) => {
    if (expected) {
      const key = req.header('x-trim-bff-key');
      if (key && timingSafeEqual(digest(key), expected)) {
        const ip = parseClientIp(req.header('x-trim-client-ip'));
        if (ip) Object.defineProperty(req, 'ip', { value: ip, configurable: true, enumerable: true });
      }
    }
    next();
  };
}
