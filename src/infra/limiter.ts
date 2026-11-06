import type { RedisLike } from './cache.js';

export interface LimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** ms until the oldest hit leaves the window (approximate for sliding counters) */
  resetMs: number;
  retryAfterSec: number;
}

/** Sliding-window-counter limiter. Implementations: MemoryLimiter, RedisLimiter (fails open on Redis errors). */
export interface RateLimiter {
  readonly driver: 'memory' | 'redis';
  consume(key: string, limit: number, windowMs: number): Promise<LimitResult>;
  close(): Promise<void>;
}

function decide(limit: number, windowMs: number, prev: number, curr: number, elapsedMs: number): LimitResult {
  // weighted previous window + current window (classic sliding window counter)
  const weighted = prev * (1 - elapsedMs / windowMs) + curr;
  const allowed = weighted <= limit;
  const remaining = Math.max(0, Math.floor(limit - weighted));
  const resetMs = Math.max(1, windowMs - elapsedMs);
  return { allowed, limit, remaining, resetMs, retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil(resetMs / 1000)) };
}

export class MemoryLimiter implements RateLimiter {
  readonly driver = 'memory' as const;
  private m = new Map<string, { win: number; curr: number; prev: number; windowMs: number }>();
  private timer: NodeJS.Timeout;
  constructor() {
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [k, e] of this.m) if (Math.floor(now / e.windowMs) - e.win > 1) this.m.delete(k);
    }, 60_000);
    this.timer.unref();
  }
  async consume(key: string, limit: number, windowMs: number): Promise<LimitResult> {
    const now = Date.now();
    const win = Math.floor(now / windowMs);
    let e = this.m.get(key);
    if (!e) this.m.set(key, (e = { win, curr: 0, prev: 0, windowMs }));
    if (e.win !== win) {
      e.prev = win - e.win === 1 ? e.curr : 0;
      e.curr = 0;
      e.win = win;
    }
    e.curr++;
    const r = decide(limit, windowMs, e.prev, e.curr, now - win * windowMs);
    if (!r.allowed) e.curr--; // rejected hits do not count against the caller
    return r;
  }
  async close() {
    clearInterval(this.timer);
    this.m.clear();
  }
}

export class RedisLimiter implements RateLimiter {
  readonly driver = 'redis' as const;
  constructor(private r: RedisLike, private prefix = 'trim:rl:') {}
  async consume(key: string, limit: number, windowMs: number): Promise<LimitResult> {
    const now = Date.now();
    const win = Math.floor(now / windowMs);
    const k = `${this.prefix}${key}:${win}`;
    try {
      const curr = await this.r.incr(k);
      if (curr === 1) await this.r.pexpire(k, windowMs * 2);
      const prev = Number((await this.r.get(`${this.prefix}${key}:${win - 1}`)) ?? 0);
      const res = decide(limit, windowMs, prev, curr, now - win * windowMs);
      return res;
    } catch {
      // Redis down: never fail the request because of the limiter
      return { allowed: true, limit, remaining: limit, resetMs: windowMs, retryAfterSec: 0 };
    }
  }
  async close() {
    await this.r.quit();
  }
}
