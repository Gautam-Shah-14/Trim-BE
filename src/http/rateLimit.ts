import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { AppError } from '../errors.js';

function limiter(opts: { windowMs: number; limit: number; key?: (req: Request) => string; message: string }): RequestHandler {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => (opts.key ? opts.key(req) : ipKeyGenerator(req.ip ?? '')),
    handler: (_req, _res, next) => next(new AppError('RATE_LIMITED', opts.message)),
  });
}

export const generalLimiter = (perMin: number) => limiter({ windowMs: 60_000, limit: perMin, message: 'Too many requests, slow down' });

/** 10 attempts / 15 min per IP + identifier */
export const loginLimiter = (limit: number) =>
  limiter({
    windowMs: 15 * 60_000,
    limit,
    message: 'Too many login attempts, try again later',
    key: (req) => {
      const id = typeof req.body?.identifier === 'string' ? req.body.identifier.trim().toLowerCase() : '';
      return `${ipKeyGenerator(req.ip ?? '')}|${id}`;
    },
  });

export const contactLimiter = (perHour: number) => limiter({ windowMs: 3_600_000, limit: perHour, message: 'Too many messages, try again later' });

/** brute-force guard for refresh/register endpoints */
export const authLimiter = (perMin: number) => limiter({ windowMs: 60_000, limit: perMin, message: 'Too many requests, slow down' });
