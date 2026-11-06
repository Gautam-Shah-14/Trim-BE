import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { MemoryCache, RedisCache, type Cache, type RedisLike } from './cache.js';
import { MemoryLimiter, RedisLimiter, type RateLimiter } from './limiter.js';
import { InlineQueue, MemoryQueue, PgBossQueue, type JobQueue } from './queue.js';

function redisClient(config: Config, log: Logger): RedisLike {
  const r = new Redis(config.redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: false });
  r.on('error', (err: Error) => log.warn({ err: err.message }, 'redis error (cache/limiter fail open)'));
  return r as unknown as RedisLike;
}

/** Drivers chosen from env. Redis is optional; everything works with the in-memory defaults (Stage A). */
export function buildDrivers(config: Config, log: Logger): { cache: Cache; limiter: RateLimiter; queue: JobQueue } {
  let shared: RedisLike | null = null;
  const redis = () => (shared ??= redisClient(config, log));
  const cache: Cache = config.cacheDriver === 'redis' ? new RedisCache(redis()) : new MemoryCache();
  const limiter: RateLimiter = config.rateLimitDriver === 'redis' ? new RedisLimiter(redis()) : new MemoryLimiter();
  const queue: JobQueue = !config.queue.enabled
    ? new InlineQueue()
    : config.queue.driver === 'memory'
      ? new MemoryQueue(log)
      : new PgBossQueue(config.queueDatabaseUrl || config.databaseUrl, log, config.databaseSsl, config.databaseSslCaFile || undefined);
  return { cache, limiter, queue };
}

export { type Cache, type RateLimiter, type JobQueue };
