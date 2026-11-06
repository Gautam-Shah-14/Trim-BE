import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { inject } from 'vitest';
import { createApp, type CreateAppOptions } from '../src/app.js';
import type { Deps } from '../src/http/types.js';
import { loadConfig, type Config } from '../src/config.js';
import { createPool } from '../src/db.js';
import type { CreateSubscriptionInput, PaymentGateway } from '../src/lib/gateway.js';
import { createLogger } from '../src/logger.js';
import { addDays, localDateOf, zonedToUtc } from '../src/lib/slots.js';

export interface FakeGateway extends PaymentGateway {
  created: CreateSubscriptionInput[];
  cancelled: { id: string; atCycleEnd: boolean }[];
}

export function fakeGateway(): FakeGateway {
  const g: FakeGateway = {
    keyId: 'rzp_test_fake',
    created: [],
    cancelled: [],
    async createSubscription(input) {
      g.created.push(input);
      return { id: `sub_${randomBytes(6).toString('hex')}` };
    },
    async cancelSubscription(id, atCycleEnd) {
      g.cancelled.push({ id, atCycleEnd });
    },
  };
  return g;
}

export interface Ctx {
  base: string;
  pool: pg.Pool;
  config: Config;
  gateway: FakeGateway;
  deps: Deps;
  webhookSecret: string;
  close: () => Promise<void>;
}

/** Clone the migrated template DB into a fresh database and boot the real app on an ephemeral port. */
export async function startCtx(overrides: Record<string, string> = {}, extra: Partial<CreateAppOptions> = {}): Promise<Ctx> {
  const p = inject('pg');
  const name = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ host: p.host, port: p.port, user: p.user, password: p.password, database: 'postgres' });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} TEMPLATE ${p.template}`);
  await admin.end();
  const webhookSecret = randomBytes(16).toString('hex');
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: `postgres://${p.user}:${p.password}@${p.host}:${p.port}/${name}`,
    JWT_SECRET: randomBytes(32).toString('hex'),
    QR_SECRET: randomBytes(32).toString('hex'),
    RAZORPAY_KEY_ID: 'rzp_test_fake',
    RAZORPAY_KEY_SECRET: randomBytes(8).toString('hex'),
    RAZORPAY_WEBHOOK_SECRET: webhookSecret,
    CORS_ORIGINS: 'http://localhost:3000',
    ARGON2_MEMORY_KIB: '1024',
    RATE_LIMIT_GENERAL_PER_MIN: '100000',
    RATE_LIMIT_LOGIN_PER_15MIN: '100000',
    RATE_LIMIT_CONTACT_PER_HOUR: '100000',
    DATABASE_POOL_MAX: '20',
    QUEUE_DRIVER: 'memory',
    RATE_LIMIT_REGISTER_PER_HOUR: '100000',
    RATE_LIMIT_AVAILABILITY_PER_MIN: '100000',
    RATE_LIMIT_HOLD_PER_MIN: '100000',
    RATE_LIMIT_CHECKIN_PER_MIN: '100000',
    // caches off by default so tests that edit rows with SQL see them immediately; cache.test.ts turns them on
    CACHE_TTL_PLANS_S: '0',
    CACHE_TTL_CATALOG_S: '0',
    CACHE_TTL_SALON_PUBLIC_S: '0',
    CACHE_TTL_DISCOVER_S: '0',
    CACHE_TTL_AVAILABILITY_S: '0',
    CACHE_TTL_ENTITLEMENTS_S: '0',
    CACHE_TTL_SESSION_S: '0',
    ...overrides,
  });
  const pool = createPool({ url: config.databaseUrl, ssl: false, max: config.databasePoolMax, statementTimeoutMs: config.statementTimeoutMs, lockTimeoutMs: config.lockTimeoutMs, idleTxTimeoutMs: config.idleTxTimeoutMs });
  const gateway = fakeGateway();
  const { app, deps, close: closeApp } = createApp({ config, pool, log: createLogger(process.env['TEST_LOG'] ?? 'silent', 'test'), gateway, ...extra });
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base, pool, config, gateway, deps, webhookSecret,
    close: async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await closeApp();
      await pool.end();
      await new Promise<void>((resolve) => {
        const dropper = new pg.Client({ host: p.host, port: p.port, user: p.user, password: p.password, database: 'postgres' });
        dropper.connect().then(() => dropper.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)).catch(() => {}).finally(() => dropper.end().catch(() => {}).finally(resolve));
      });
    },
  };
}

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export async function call(ctx: Ctx, method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts.raw !== undefined) body = opts.raw;
  else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['Content-Type'] ??= 'application/json';
  }
  const r = await fetch(`${ctx.base}${path}`, { method, headers, body });
  const text = await r.text();
  let parsed: any = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON (csv, bytes) */
  }
  return { status: r.status, body: parsed, headers: r.headers };
}

export const PASSWORD = 'Passw0rdTest';
let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}${randomBytes(2).toString('hex')}`;
export const phone = () => `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

export interface Owner {
  token: string;
  refreshToken: string;
  userId: string;
  salonId: string;
  staffId: string;
  email: string;
  serviceId: string;
  roleIds: Record<string, string>;
}

/** Register an owner, approve the salon, add one 30-minute service. */
export async function makeOwner(ctx: Ctx, opts: { approve?: boolean; lat?: number; lng?: number; city?: string; name?: string } = {}): Promise<Owner> {
  const email = `owner-${uniq()}@example.test`;
  const r = await call(ctx, 'POST', '/v1/auth/register-owner', {
    body: {
      fullName: 'Olivia Owner', phone: phone(), email, password: PASSWORD,
      salon: { name: opts.name ?? `Salon ${uniq()}`, city: opts.city ?? 'Pune', lat: opts.lat ?? 18.5204, lng: opts.lng ?? 73.8567 },
    },
  });
  if (r.status !== 201) throw new Error(`register-owner failed: ${JSON.stringify(r.body)}`);
  const salonId = r.body.data.salon.id as string;
  if (opts.approve !== false) await ctx.pool.query("UPDATE salons SET status = 'approved' WHERE id = $1", [salonId]);
  const token = r.body.data.accessToken as string;
  const svc = await call(ctx, 'POST', `/v1/salons/${salonId}/services`, { token, body: { category: 'Hair', name: 'Haircut', durationMin: 30, pricePaise: 30000 } });
  if (svc.status !== 201) throw new Error(`service failed: ${JSON.stringify(svc.body)}`);
  const roles = await ctx.pool.query('SELECT id, name FROM salon_roles WHERE salon_id = $1', [salonId]);
  return {
    token, refreshToken: r.body.data.refreshToken, userId: r.body.data.user.id, salonId, email,
    staffId: r.body.data.memberships[0].staffId, serviceId: svc.body.data.id,
    roleIds: Object.fromEntries(roles.rows.map((x) => [x.name, x.id])),
  };
}

const minutesOfDay = (ms: number, tz: string) => {
  const [h, m] = new Date(ms).toLocaleTimeString('en-GB', { timeZone: tz, hour12: false }).split(':').map(Number) as [number, number];
  return h * 60 + m;
};

/**
 * Open the salon 00:00-23:59 on every day in a timezone where "now .. now+100min" does not cross local midnight, so tests that
 * book "20 minutes from now" are stable at any time of day.
 */
export async function openAllDay(ctx: Ctx, o: Owner): Promise<string> {
  const tz =
    ['Asia/Kolkata', 'UTC', 'America/New_York', 'Asia/Tokyo', 'Europe/London'].find((z) => {
      const a = minutesOfDay(Date.now(), z);
      const b = minutesOfDay(Date.now() + 100 * 60_000, z);
      return a >= 30 && b > a && b <= 23 * 60;
    }) ?? 'UTC';
  await ctx.pool.query('UPDATE salons SET timezone = $1 WHERE id = $2', [tz, o.salonId]);
  const r = await call(ctx, 'PUT', `/v1/salons/${o.salonId}/hours`, {
    token: o.token,
    body: { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '00:00', closes: '23:59', isClosed: false })) },
  });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  return tz;
}

export async function makeCustomer(ctx: Ctx): Promise<{ token: string; userId: string; email: string }> {
  const email = `cust-${uniq()}@example.test`;
  const r = await call(ctx, 'POST', '/v1/auth/register', { body: { fullName: 'Chandni Customer', email, phone: phone(), password: PASSWORD } });
  if (r.status !== 201) throw new Error(`register failed: ${JSON.stringify(r.body)}`);
  return { token: r.body.data.accessToken, userId: r.body.data.user.id, email };
}

/** ISO instant for `daysAhead` days from now at local `hh:mm` in the salon timezone (default Kolkata). */
export function slotAt(daysAhead: number, hhmm: string, tz = 'Asia/Kolkata'): string {
  const date = addDays(localDateOf(Date.now(), tz), daysAhead);
  return new Date(zonedToUtc(date, hhmm, tz)).toISOString();
}

export function sign(ctx: Ctx, raw: string): string {
  return createHmac('sha256', ctx.webhookSecret).update(raw).digest('hex');
}

export async function webhook(ctx: Ctx, event: Record<string, unknown>, eventId: string = randomUUID(), signature?: string): Promise<Res> {
  const raw = JSON.stringify(event);
  const r = await call(ctx, 'POST', '/v1/webhooks/razorpay', {
    raw,
    headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature ?? sign(ctx, raw), 'X-Razorpay-Event-Id': eventId },
  });
  await ctx.deps.queue.drain(); // the worker applies the event after the 200
  return r;
}

export async function eventResult(ctx: Ctx, eventId: string): Promise<string | null> {
  return (await ctx.pool.query('SELECT result FROM subscription_events WHERE razorpay_event_id = $1', [eventId])).rows[0]?.result ?? null;
}

/** minimal in-memory stand-in for ioredis: lets us exercise RedisCache/RedisLimiter without a Redis server */
export class FakeRedis {
  data = new Map<string, { v: string; exp: number | null }>();
  calls: string[] = [];
  down = false;
  private live(k: string) {
    const e = this.data.get(k);
    if (e && e.exp !== null && e.exp <= Date.now()) this.data.delete(k);
    return this.data.get(k);
  }
  private chk(name: string) {
    this.calls.push(name);
    if (this.down) throw new Error('redis down');
  }
  async get(k: string) { this.chk('get'); return this.live(k)?.v ?? null; }
  async set(k: string, v: string, ...args: (string | number)[]) {
    this.chk('set');
    let exp: number | null = null;
    let nx = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === 'EX') exp = Date.now() + Number(args[++i]) * 1000;
      else if (args[i] === 'PX') exp = Date.now() + Number(args[++i]);
      else if (args[i] === 'NX') nx = true;
    }
    if (nx && this.live(k)) return null;
    this.data.set(k, { v, exp });
    return 'OK';
  }
  async del(...ks: string[]) { this.chk('del'); let n = 0; for (const k of ks) if (this.data.delete(k)) n++; return n; }
  async incr(k: string) { this.chk('incr'); const n = Number(this.live(k)?.v ?? 0) + 1; this.data.set(k, { v: String(n), exp: this.live(k)?.exp ?? null }); return n; }
  async pexpire(k: string, ms: number) { this.chk('pexpire'); const e = this.live(k); if (!e) return 0; e.exp = Date.now() + ms; return 1; }
  async pttl(k: string) { this.chk('pttl'); const e = this.live(k); return e ? (e.exp === null ? -1 : e.exp - Date.now()) : -2; }
  async ping() { this.chk('ping'); return 'PONG'; }
  async quit() { return 'OK'; }
}
