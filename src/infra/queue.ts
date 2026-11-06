import { PgBoss } from 'pg-boss';
import { buildSsl } from '../db.js';
import type { Logger } from 'pino';

export type JobHandler = (data: any) => Promise<void>;

export interface EnqueueOptions {
  /** de-duplicates: a job with the same key already queued/active is not added again */
  singletonKey?: string;
}

/**
 * Background job queue. Implementations: PgBossQueue (Postgres, default in production), MemoryQueue (tests/dev,
 * in-process, no durability) and InlineQueue (QUEUE_ENABLED=false: handlers run inside the request).
 * Handlers must be idempotent: they can run more than once.
 */
export interface JobQueue {
  readonly driver: 'pgboss' | 'memory' | 'inline';
  register(name: string, handler: JobHandler): void;
  enqueue(name: string, data: object, opts?: EnqueueOptions): Promise<void>;
  /** run a job repeatedly (only in processes that consume jobs) */
  every(name: string, ms: number, data?: object): void;
  /** consume=false => this process only enqueues (WORKER_MODE=api with a durable queue) */
  start(consume: boolean): Promise<void>;
  stop(): Promise<void>;
  depth(): Promise<number>;
  stats(): Promise<{ name: string; queued: number; active: number; failed: number }[]>;
  ping(): Promise<boolean>;
  /** test helper: resolves when all in-flight work finished (memory/inline only) */
  drain(): Promise<void>;
}

const MAX_ATTEMPTS = 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MemoryQueue implements JobQueue {
  readonly driver = 'memory' as const;
  private handlers = new Map<string, JobHandler>();
  private pending = new Set<Promise<void>>();
  private keys = new Set<string>();
  private timers: NodeJS.Timeout[] = [];
  private failed = 0;
  constructor(private log: Logger, private retryBaseMs = 50) {}
  register(name: string, h: JobHandler) {
    this.handlers.set(name, h);
  }
  async enqueue(name: string, data: object, opts: EnqueueOptions = {}) {
    const dk = opts.singletonKey ? `${name}:${opts.singletonKey}` : null;
    if (dk && this.keys.has(dk)) return;
    if (dk) this.keys.add(dk);
    const h = this.handlers.get(name);
    if (!h) throw new Error(`no handler registered for job ${name}`);
    const run = (async () => {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          await h(data);
          return;
        } catch (err) {
          if (attempt === MAX_ATTEMPTS) {
            this.failed++;
            this.log.error({ err, job: name }, 'job failed permanently');
            return;
          }
          await sleep(this.retryBaseMs * 2 ** attempt);
        }
      }
    })().finally(() => {
      if (dk) this.keys.delete(dk);
    });
    const p = run.then(() => {
      this.pending.delete(p);
    });
    this.pending.add(p);
  }
  every(name: string, ms: number, data: object = {}) {
    const t = setInterval(() => void this.enqueue(name, data, { singletonKey: 'every' }).catch(() => {}), ms);
    t.unref();
    this.timers.push(t);
  }
  async start() {}
  async stop() {
    this.timers.forEach(clearInterval);
    await this.drain();
  }
  async depth() {
    return this.pending.size;
  }
  async stats() {
    return [{ name: 'all', queued: 0, active: this.pending.size, failed: this.failed }];
  }
  async ping() {
    return true;
  }
  async drain() {
    while (this.pending.size) await Promise.all([...this.pending]);
  }
}

export class InlineQueue implements JobQueue {
  readonly driver = 'inline' as const;
  private handlers = new Map<string, JobHandler>();
  private timers: NodeJS.Timeout[] = [];
  register(name: string, h: JobHandler) {
    this.handlers.set(name, h);
  }
  async enqueue(name: string, data: object) {
    await this.handlers.get(name)?.(data);
  }
  every(name: string, ms: number, data: object = {}) {
    const t = setInterval(() => void this.enqueue(name, data).catch(() => {}), ms);
    t.unref();
    this.timers.push(t);
  }
  async start() {}
  async stop() {
    this.timers.forEach(clearInterval);
  }
  async depth() {
    return 0;
  }
  async stats() {
    return [];
  }
  async ping() {
    return true;
  }
  async drain() {}
}

export class PgBossQueue implements JobQueue {
  readonly driver = 'pgboss' as const;
  private boss: PgBoss;
  private handlers = new Map<string, JobHandler>();
  private timers: NodeJS.Timeout[] = [];
  private started = false;
  constructor(connectionString: string, private log: Logger, ssl: boolean, sslCaFile?: string) {
    this.boss = new PgBoss({ connectionString, schema: 'pgboss', max: 3, ...(ssl ? { ssl: buildSsl(true, sslCaFile) } : {}) } as any);
    this.boss.on('error', (err: unknown) => this.log.error({ err }, 'pg-boss error'));
  }
  register(name: string, h: JobHandler) {
    this.handlers.set(name, h);
  }
  async start(consume: boolean) {
    await this.boss.start();
    this.started = true;
    for (const [name, h] of this.handlers) {
      await this.boss.createQueue(name).catch(() => {}); // already exists
      if (consume) {
        // 0.5 s polling, batches of 10, two local workers, continuous fetching while batches come back full (~20 events drain in a few seconds).
        // Handlers are idempotent and lock the rows they change, so parallel workers are safe.
        await this.boss.work(name, { pollingIntervalSeconds: 0.5, batchSize: 10, localConcurrency: 2, burstWhenBatchFull: true } as any, async (jobs: any[]) => {
          for (const j of jobs) await h(j.data ?? {});
        });
      }
    }
  }
  async enqueue(name: string, data: object, opts: EnqueueOptions = {}) {
    if (!this.started) throw new Error('queue not started');
    await this.boss.send(name, data, { retryLimit: MAX_ATTEMPTS, retryDelay: 5, retryBackoff: true, ...(opts.singletonKey ? { singletonKey: opts.singletonKey } : {}) } as any);
  }
  every(name: string, ms: number, data: object = {}) {
    const t = setInterval(() => void this.enqueue(name, data, { singletonKey: 'every' }).catch(() => {}), ms);
    t.unref();
    this.timers.push(t);
  }
  async stop() {
    this.timers.forEach(clearInterval);
    if (this.started) await this.boss.stop({ graceful: true, timeout: 10_000 } as any);
    this.started = false;
  }
  async stats() {
    const out: { name: string; queued: number; active: number; failed: number }[] = [];
    for (const name of this.handlers.keys()) {
      const [s] = await this.boss.getQueueStats(name);
      out.push({ name, queued: s?.queuedCount ?? 0, active: s?.activeCount ?? 0, failed: s?.failedCount ?? 0 });
    }
    return out;
  }
  async depth() {
    return (await this.stats()).reduce((a, s) => a + s.queued, 0);
  }
  async ping() {
    return this.started;
  }
  async drain() {}
}
