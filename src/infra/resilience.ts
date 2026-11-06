import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../errors.js';

/** Opens after `threshold` consecutive failures, rejects fast for `cooldownMs`, then lets one trial call through. */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  constructor(private threshold = 5, private cooldownMs = 30_000, private now: () => number = Date.now) {}
  get state(): 'closed' | 'open' | 'half-open' {
    if (this.failures < this.threshold) return 'closed';
    return this.now() - this.openedAt >= this.cooldownMs ? 'half-open' : 'open';
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') throw new Error('circuit open');
    try {
      const out = await fn();
      this.failures = 0;
      return out;
    } catch (err) {
      this.failures++;
      if (this.failures >= this.threshold) this.openedAt = this.now();
      throw err;
    }
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, what = 'operation'): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      t = setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

// ---------------------------------------------------------------- load shedding
const CRITICAL = [/^\/v1\/bookings/, /^\/v1\/salons\/[^/]+\/(bookings|checkin|invoices)/, /^\/v1\/webhooks\//, /^\/v1\/auth\//, /^\/(health|ready|metrics)/];

export function isCritical(path: string): boolean {
  return CRITICAL.some((r) => r.test(path));
}

/** Pure decision: shed non-critical requests when the event loop lags or the DB pool queue grows. */
export function shouldShed(i: { path: string; lagMs: number; poolWaiting: number; queueDepth: number }, cfg: { lagMs: number; poolWaiting: number; queueMaxDepth: number }): boolean {
  if (isCritical(i.path)) return false;
  return (cfg.lagMs > 0 && i.lagMs > cfg.lagMs) || (cfg.poolWaiting > 0 && i.poolWaiting > cfg.poolWaiting) || i.queueDepth > cfg.queueMaxDepth;
}

export function loadShedder(opts: { cfg: { lagMs: number; poolWaiting: number; queueMaxDepth: number }; poolWaiting: () => number; queueDepth: () => number; onShed: () => void }) {
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  const mw = (req: Request, res: Response, next: NextFunction) => {
    const lagMs = h.mean / 1e6 || 0;
    if (shouldShed({ path: req.path, lagMs, poolWaiting: opts.poolWaiting(), queueDepth: opts.queueDepth() }, opts.cfg)) {
      opts.onShed();
      res.setHeader('Retry-After', '5');
      return next(new AppError('OVERLOADED', 'The service is busy, please retry shortly'));
    }
    next();
  };
  return { mw, stop: () => h.disable() };
}
