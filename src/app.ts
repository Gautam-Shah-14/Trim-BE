import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import cors from 'cors';
import express, { type ErrorRequestHandler, type Express, Router } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import type pg from 'pg';
import type { Config } from './config.js';
import { AppError } from './errors.js';
import { Api, setPlanTtl } from './http/api.js';
import { CacheService, type Cache } from './infra/cache.js';
import { buildDrivers } from './infra/index.js';
import type { RateLimiter } from './infra/limiter.js';
import { Metrics } from './infra/metrics.js';
import type { JobQueue } from './infra/queue.js';
import { loadShedder } from './infra/resilience.js';
import { registerJobs } from './jobs/index.js';
import { generalLimiter } from './http/rateLimit.js';
import { bffClientIp } from './http/clientIp.js';
import { rejectNulBytes } from './http/sanitize.js';
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

const safeEqual = (a: string, b: string) => {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
};

export interface CreateAppOptions {
  config: Config;
  pool: pg.Pool;
  log: Logger;
  gateway?: PaymentGateway;
  /** override drivers (tests); default: built from env */
  cache?: Cache;
  limiter?: RateLimiter;
  queue?: JobQueue;
  captureException?: (err: unknown, ctx?: Record<string, unknown>) => void;
}

export const MODULES = [pub, auth, me, media, discover, salon, services, staff, roles, bookings, billing, reviews, analytics, subscription, webhooks, admin, sales];

/** Build the Express app. Used by server.ts, by tests (with a fake gateway) and by the OpenAPI generator. */
export function createApp(opts: CreateAppOptions): { app: Express; api: Api; deps: Deps; close: () => Promise<void> } {
  const { config, pool, log } = opts;
  const built = opts.cache && opts.limiter && opts.queue ? null : buildDrivers(config, log);
  const metrics = new Metrics();
  const driverCache = opts.cache ?? built!.cache;
  const deps: Deps = {
    cache: new CacheService(driverCache, metrics),
    limiter: opts.limiter ?? built!.limiter,
    queue: opts.queue ?? built!.queue,
    metrics,
    captureException: opts.captureException ?? (() => {}),
    config,
    pool,
    log,
    hasher: makePasswordHasher(config.argon2MemoryKib),
    gateway: opts.gateway ?? createRazorpayGateway(config.razorpay),
  };

  setPlanTtl(config.cacheTtl.plans);
  registerJobs(deps);
  metrics.gauge('db_pool_total', () => pool.totalCount);
  metrics.gauge('db_pool_waiting', () => pool.waitingCount);
  metrics.gauge('process_uptime_seconds', () => Math.round(process.uptime()));
  metrics.gauge('queue_depth', () => deps.queue.depth());

  const shed = loadShedder({
    cfg: { lagMs: config.loadShed.lagMs, poolWaiting: config.loadShed.poolWaiting, queueMaxDepth: config.queue.maxDepth },
    poolWaiting: () => pool.waitingCount,
    queueDepth: () => 0,
    onShed: () => metrics.inc('load_shed_total'),
  });

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
  app.use(bffClientIp(config.bffSharedSecret)); // authenticated website client IP (D-01)
  app.use((req, res, next) => {
    const t0 = process.hrtime.bigint();
    const timer = setTimeout(() => {
      if (!res.headersSent) res.status(504).json({ error: { code: 'TIMEOUT', message: 'The request took too long' } });
    }, config.requestTimeoutMs);
    timer.unref();
    res.on('close', () => {
      clearTimeout(timer);
      const route = (req.route?.path as string | undefined) ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      const secs = Number(process.hrtime.bigint() - t0) / 1e9;
      metrics.inc('http_requests_total', { method: req.method, route, status: res.statusCode });
      metrics.observe('http_request_duration_seconds', secs, { route });
    });
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
  app.use('/v1/media', express.json({ limit: `${config.mediaBodyLimitKb}kb` }));
  app.use(express.json({ limit: `${config.bodyLimitKb}kb` }));
  app.use(rejectNulBytes);
  app.use(shed.mw);

  app.get('/health', async (_req, res) => {
    let db = 'up';
    try {
      await Promise.race([pool.query('SELECT 1'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
    } catch {
      db = 'down';
    }
    res.status(db === 'up' ? 200 : 503).json({ status: db === 'up' ? 'ok' : 'degraded', db, version: VERSION, uptimeSec: Math.round(process.uptime()), time: new Date().toISOString() });
  });

  app.get('/ready', async (_req, res) => {
    const probe = async (f: () => Promise<unknown>) => {
      try {
        await Promise.race([f(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
        return 'up';
      } catch {
        return 'down';
      }
    };
    const db = await probe(() => pool.query('SELECT 1'));
    const queue = deps.queue.driver === 'pgboss' ? ((await probe(async () => { if (!(await deps.queue.ping())) throw new Error('down'); })) as string) : 'up';
    const cache = await probe(async () => { if (!(await driverCache.ping())) throw new Error('down'); });
    // cache and queue degrade gracefully, only the database makes the instance unready
    res.status(db === 'up' ? 200 : 503).json({ status: db === 'up' ? 'ready' : 'not_ready', db, queue, cache, queueDriver: deps.queue.driver, cacheDriver: driverCache.driver });
  });

  if (config.metrics.enabled) {
    app.get('/metrics', async (req, res) => {
      const given = req.header('x-metrics-token') ?? (req.header('authorization') ?? '').replace(/^Bearer /i, '');
      if (config.metrics.token && !safeEqual(given, config.metrics.token)) {
        res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Metrics token required' } });
        return;
      }
      res.type('text/plain; version=0.0.4').send(await metrics.render());
    });
  }

  const v1 = Router();
  const general = generalLimiter(config.rateLimit.generalPerMin);
  v1.use((req, res, next) => (req.path.startsWith('/webhooks/') ? next() : general(req, res, next))); // webhook: signature-verified, not rate limited
  const api = new Api(v1, deps);
  for (const m of MODULES) m.register(api);
  app.use('/v1', v1);

  // wrong method on a known path => 405 + Allow (not a misleading 404)
  const patterns = api.routes.map((r) => ({ re: new RegExp(`^/v1${r.path.replace(/:[^/]+/g, '[^/]+')}/?$`), method: r.method.toUpperCase() }));
  app.use((req, res, next) => {
    const allowed = [...new Set(patterns.filter((p) => p.re.test(req.path)).map((p) => p.method))];
    if (allowed.length) {
      if (allowed.includes('GET')) allowed.push('HEAD');
      res.setHeader('Allow', allowed.join(', '));
      return next(new AppError('METHOD_NOT_ALLOWED', `${req.method} is not allowed here; use ${allowed.join(', ')}`));
    }
    next(new AppError('NOT_FOUND', 'Route not found'));
  });
  app.use(errorHandler(log, () => deps));
  const close = async () => {
    shed.stop();
    await deps.queue.stop().catch(() => {});
    await driverCache.close().catch(() => {});
    await deps.limiter.close().catch(() => {});
  };
  return { app, api, deps, close };
}

const errorHandler = (log: Logger, deps: () => Deps): ErrorRequestHandler => (err, req, res, _next) => {
  if (res.headersSent) return;
  if (err instanceof AppError) {
    if (err.code === 'SLOT_TAKEN') deps().metrics.inc('slot_taken_total');
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
  deps().captureException(err, { reqId: req.id, path: req.path });
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong. Quote request id ' + req.id } });
};
