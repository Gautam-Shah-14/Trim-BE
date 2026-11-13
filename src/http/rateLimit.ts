import { ipKeyGenerator } from 'express-rate-limit';
import type { Request, RequestHandler } from 'express';
import { AppError } from '../errors.js';
import { verifyAccess } from '../lib/security.js';

const ipOf = (req: Request) => ipKeyGenerator(req.ip ?? '');

/** user id from a (valid) bearer token without hitting the DB; falls back to the client IP */
function actorKey(req: Request): string {
  const h = req.header('authorization');
  if (h && /^Bearer /i.test(h)) {
    const c = verifyAccess(req.deps.config.jwtSecret, h.slice(7).trim());
    if (c) return `u:${c.sub}`;
  }
  return `ip:${ipOf(req)}`;
}

interface Opts {
  name: string;
  limit: number | (() => number);
  windowMs: number;
  key?: (req: Request) => string;
  message?: string;
}

/**
 * Sliding-window limiter on the configured RateLimiter driver (memory or Redis).
 * Always sets RateLimit-Limit/Remaining/Reset; on 429 also Retry-After (seconds).
 */
function limiter(o: Opts): RequestHandler {
  return async (req, res, next) => {
    try {
      const limit = typeof o.limit === 'function' ? o.limit() : o.limit;
      const r = await req.deps.limiter.consume(`${o.name}:${(o.key ?? ipOf)(req)}`, limit, o.windowMs);
      res.setHeader('RateLimit-Limit', String(r.limit));
      res.setHeader('RateLimit-Remaining', String(r.remaining));
      res.setHeader('RateLimit-Reset', String(Math.ceil(r.resetMs / 1000)));
      if (!r.allowed) {
        res.setHeader('Retry-After', String(r.retryAfterSec));
        req.deps.metrics.inc('rate_limited_total', { limiter: o.name });
        return next(new AppError('RATE_LIMITED', o.message ?? 'Too many requests, slow down', { retryAfterSec: r.retryAfterSec }));
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

const MIN = 60_000;
const HOUR = 3_600_000;

export const generalLimiter = (perMin: number) => limiter({ name: 'general', limit: perMin, windowMs: MIN });

/** login attempts per IP + identifier per 15 minutes */
export const loginLimiter = (limit: number) =>
  limiter({
    name: 'login',
    limit,
    windowMs: 15 * MIN,
    message: 'Too many login attempts, try again later',
    key: (req) => `${ipOf(req)}|${typeof req.body?.identifier === 'string' ? req.body.identifier.trim().toLowerCase() : ''}`,
  });

export const contactLimiter = (perHour: number) => limiter({ name: 'contact', limit: perHour, windowMs: HOUR, message: 'Too many messages, try again later' });
/** founding-salon waitlist sign-ups per client IP (BFF-authenticated X-Trim-Client-IP when present) per hour */
export const waitlistLimiter = (perHour: number) => limiter({ name: 'waitlist', limit: perHour, windowMs: HOUR, message: 'Too many sign-ups from this address, try again later' });
export const registerLimiter =(name: string, perHour: () => number) => limiter({ name, limit: perHour, windowMs: HOUR, message: 'Too many sign-ups from this address, try again later' });
export const refreshLimiter = (perMin: number) => limiter({ name: 'refresh', limit: perMin, windowMs: MIN });
/** per signed-in user (or IP when anonymous) */
export const userLimiter = (name: string, perMin: number) => limiter({ name, limit: perMin, windowMs: MIN, key: actorKey });
/** per salon, for write bursts such as check-in */
export const salonLimiter = (name: string, perMin: number) => limiter({ name, limit: perMin, windowMs: MIN, key: (req) => `salon:${String(req.params['salonId'])}` });
