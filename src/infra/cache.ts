import type { Metrics } from './metrics.js';

/** Low level key/value driver. Values are opaque strings. Implementations: MemoryCache, RedisCache. */
export interface Cache {
  readonly driver: 'memory' | 'redis';
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
  del(key: string): Promise<void>;
  /** atomic counter used for version keys */
  incr(key: string): Promise<number>;
  /** set if absent with a TTL; true when this caller created it */
  setNx(key: string, ttlMs: number): Promise<boolean>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export class MemoryCache implements Cache {
  readonly driver = 'memory' as const;
  private m = new Map<string, { v: string; exp: number }>();
  private timer: NodeJS.Timeout;
  constructor(private maxEntries = 10_000) {
    this.timer = setInterval(() => this.sweep(), 30_000);
    this.timer.unref();
  }
  private sweep() {
    const now = Date.now();
    for (const [k, e] of this.m) if (e.exp <= now) this.m.delete(k);
  }
  async get(key: string) {
    const e = this.m.get(key);
    if (!e) return null;
    if (e.exp <= Date.now()) {
      this.m.delete(key);
      return null;
    }
    return e.v;
  }
  async set(key: string, value: string, ttlSec: number) {
    if (this.m.size >= this.maxEntries) {
      this.sweep();
      if (this.m.size >= this.maxEntries) this.m.delete(this.m.keys().next().value as string); // evict oldest
    }
    this.m.set(key, { v: value, exp: Date.now() + ttlSec * 1000 });
  }
  async del(key: string) {
    this.m.delete(key);
  }
  async incr(key: string) {
    const cur = Number((await this.get(key)) ?? 0) + 1;
    this.m.set(key, { v: String(cur), exp: Date.now() + 30 * 86_400_000 });
    return cur;
  }
  async setNx(key: string, ttlMs: number) {
    if (await this.get(key)) return false;
    this.m.set(key, { v: '1', exp: Date.now() + ttlMs });
    return true;
  }
  async ping() {
    return true;
  }
  async close() {
    clearInterval(this.timer);
    this.m.clear();
  }
}

/** The subset of ioredis we use (so tests can pass a fake). */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  pttl(key: string): Promise<number>;
  ping(): Promise<string>;
  quit(): Promise<unknown>;
}

export class RedisCache implements Cache {
  readonly driver = 'redis' as const;
  constructor(private r: RedisLike, private prefix = 'trim:') {}
  get(key: string) {
    return this.r.get(this.prefix + key);
  }
  async set(key: string, value: string, ttlSec: number) {
    await this.r.set(this.prefix + key, value, 'EX', Math.max(1, Math.ceil(ttlSec)));
  }
  async del(key: string) {
    await this.r.del(this.prefix + key);
  }
  incr(key: string) {
    return this.r.incr(this.prefix + key);
  }
  async setNx(key: string, ttlMs: number) {
    return (await this.r.set(this.prefix + key, '1', 'PX', ttlMs, 'NX')) === 'OK';
  }
  async ping() {
    return (await this.r.ping()) === 'PONG';
  }
  async close() {
    await this.r.quit();
  }
}

interface Envelope {
  v: unknown;
  /** epoch ms after which the value is stale (still served while revalidating) */
  fresh: number;
}

/**
 * Safe cache facade: cache-aside with single-flight, jittered TTL, stale-while-revalidate and version keys.
 * Any driver failure falls through to the loader - the cache can never fail a request (spec 11.2).
 */
export class CacheService {
  private inflight = new Map<string, Promise<unknown>>();
  constructor(readonly driver: Cache, private metrics?: Metrics) {}

  async version(scope: string): Promise<number> {
    try {
      return Number((await this.driver.get(`v:${scope}`)) ?? 0);
    } catch {
      return 0;
    }
  }
  async bump(scope: string): Promise<void> {
    try {
      await this.driver.incr(`v:${scope}`);
    } catch {
      /* ignore */
    }
  }
  async del(key: string): Promise<void> {
    try {
      await this.driver.del(key);
    } catch {
      /* ignore */
    }
  }

  /** ttlSec = 0 disables caching for this call (loader runs every time). */
  async getOrLoad<T>(key: string, ttlSec: number, loader: () => Promise<T>): Promise<T> {
    if (ttlSec <= 0) return loader();
    let env: Envelope | null = null;
    try {
      const raw = await this.driver.get(key);
      if (raw) env = JSON.parse(raw) as Envelope;
    } catch {
      /* fall through */
    }
    if (env) {
      this.metrics?.inc('cache_hits_total');
      if (env.fresh < Date.now()) void this.refresh(key, ttlSec, loader).catch(() => {}); // stale-while-revalidate
      return env.v as T;
    }
    this.metrics?.inc('cache_misses_total');
    return this.refresh(key, ttlSec, loader);
  }

  /** single-flight: concurrent misses for one key share one loader call */
  private refresh<T>(key: string, ttlSec: number, loader: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;
    const p = (async () => {
      try {
        const v = await loader();
        const jitter = 1 + (Math.random() - 0.5) * 0.2; // +-10 %
        const fresh = Date.now() + ttlSec * 1000 * jitter;
        try {
          await this.driver.set(key, JSON.stringify({ v, fresh } satisfies Envelope), ttlSec * 3); // keep 3x for SWR
        } catch {
          /* cache down: still return the value */
        }
        return v;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }
}
