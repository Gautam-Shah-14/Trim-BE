import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type ErrorRequestHandler, type Express, Router } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import type pg from 'pg';
import type { Config } from './config.js';
import { AppError } from './errors.js';
import { Api } from './http/api.js';
import { generalLimiter } from './http/rateLimit.js';
import type { Deps } from './http/types.js';
import { createRazorpayGateway, type PaymentGateway } from './lib/gateway.js';
import { makePasswordHasher } from './lib/security.js';
import * as admin from './modules/admin.js';
import * as analytics from './modules/analytics.js';
import * as auth from './modules/auth.js';
import * as billing from './modules/billing.js';
import * as bookings from './modules/bookings.js';
import * as discover from './modules/discover.js';
import * as me from './modules/me.js';
import * as media from './modules/media.js';
import * as pub from './modules/public.js';
import * as reviews from './modules/reviews.js';
import * as roles from './modules/roles.js';
import * as sales from './modules/sales.js';
import * as salon from './modules/salon.js';
import * as services from './modules/services.js';
import * as staff from './modules/staff.js';
import * as subscription from './modules/subscription.js';
import * as webhooks from './modules/webhooks.js';

const VERSION = '0.1.0';

export interface CreateAppOptions {
  config: Config;
  pool: pg.Pool;
  log: Logger;
  gateway?: PaymentGateway;
}

export const MODULES = [pub, auth, me, media, discover, salon, services, staff, roles, bookings, billing, reviews, analytics, subscription, webhooks, admin, sales];

/** Build the Express app. Used by server.ts, by tests (with a fake gateway) and by the OpenAPI generator. */
export function createApp(opts: CreateAppOptions): { app: Express; api: Api; deps: Deps } {
  const { config, pool, log } = opts;
  const deps: Deps = {
    config,
    pool,
    log,
    hasher: makePasswordHasher(config.argon2MemoryKib),
    gateway: opts.gateway ?? createRazorpayGateway(config.razorpay),
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('etag', false);

  app.use((req, res, next) => {
    const incoming = req.header('x-request-id');
    req.id = incoming && /^[\w.-]{8,100}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', req.id);
    req.deps = deps;
    next();
  });
  app.use(
    pinoHttp({
      logger: log,
      genReqId: (req) => (req as express.Request).id,
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      serializers: {
        req: (r) => ({ id: r.id, method: r.method, url: String(r.url).split('?')[0] }),
        res: (r) => ({ statusCode: r.statusCode }),
      },
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id', 'If-None-Match'],
      exposedHeaders: ['X-Request-Id', 'ETag', 'Idempotent-Replayed', 'Content-Disposition'],
      maxAge: 600,
    }),
  );

  // Razorpay needs the exact raw bytes for signature verification: this must precede express.json()
  app.use('/v1/webhooks/razorpay', express.raw({ type: '*/*', limit: '1mb' }));
  app.use(express.json({ limit: '400kb' }));

  app.get('/health', async (_req, res) => {
    let db = 'up';
    try {
      await Promise.race([pool.query('SELECT 1'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
    } catch {
      db = 'down';
    }
    res.status(db === 'up' ? 200 : 503).json({ status: db === 'up' ? 'ok' : 'degraded', db, version: VERSION, uptimeSec: Math.round(process.uptime()), time: new Date().toISOString() });
  });

  const v1 = Router();
  v1.use(generalLimiter(config.rateLimit.generalPerMin));
  const api = new Api(v1, deps);
  for (const m of MODULES) m.register(api);
  app.use('/v1', v1);

  app.use((_req, _res, next) => next(new AppError('NOT_FOUND', 'Route not found')));
  app.use(errorHandler(log));
  return { app, api, deps };
}

const errorHandler = (log: Logger): ErrorRequestHandler => (err, req, res, _next) => {
  if (res.headersSent) return;
  if (err instanceof AppError) {
    const body: Record<string, unknown> = { code: err.code, message: err.message };
    if (err.details !== undefined) body['details'] = err.details;
    if (err.reason) body['reason'] = err.reason;
    res.status(err.status).json({ error: body });
    return;
  }
  const e = err as { type?: string; status?: number; code?: string };
  if (e.type === 'entity.parse.failed') {
    res.status(422).json({ error: { code: 'VALIDATION_FAILED', message: 'Request body is not valid JSON' } });
    return;
  }
  if (e.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'VALIDATION_FAILED', message: 'Request body is too large' } });
    return;
  }
  if (e.code === '22P02' || e.code === '22003' || e.code === '22007' || e.code === '22008') {
    res.status(422).json({ error: { code: 'VALIDATION_FAILED', message: 'A value has an invalid format' } });
    return;
  }
  log.error({ err, reqId: req.id }, 'unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong. Quote request id ' + req.id } });
};
