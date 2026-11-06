import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

// Return int8 as JS number (counts, sums fit comfortably) and numeric as number.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

const here = path.dirname(fileURLToPath(import.meta.url));
/** repo root (works from src/ via tsx and from dist/src/ after build) */
export const repoRoot = path.resolve(here, here.includes(`${path.sep}dist${path.sep}`) ? '../..' : '..');

export interface TlsOptions {
  ca?: string;
  rejectUnauthorized: true;
}

/**
 * Verified TLS only: certificates are ALWAYS checked (never rejectUnauthorized:false).
 * With a CA file (path relative to the repo root, or absolute) that CA is trusted; without one Node's default trust store is used.
 */
export function buildSsl(enabled: boolean, caFile?: string, root: string = repoRoot): TlsOptions | undefined {
  if (!enabled) return undefined;
  if (!caFile) return { rejectUnauthorized: true };
  const file = path.resolve(root, caFile);
  let ca: string;
  try {
    ca = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`DATABASE_SSL_CA_FILE could not be read (${file}): ${(err as Error).message}`, { cause: err });
  }
  if (!ca.includes('BEGIN CERTIFICATE')) throw new Error(`DATABASE_SSL_CA_FILE (${file}) does not look like a PEM certificate`);
  return { ca, rejectUnauthorized: true };
}

export interface PoolOptions {
  url: string;
  ssl: boolean;
  sslCaFile?: string;
  max: number;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  idleTxTimeoutMs?: number;
  /**
   * Behind a transaction pooler (Supabase :6543, pgbouncer) session state does not survive between statements and startup
   * parameters may be rejected. In that mode no session-level settings are sent: the timeouts are applied with SET LOCAL
   * inside every transaction opened by withTx(). Only unnamed (non-prepared) statements are used by this code base.
   */
  pooler?: boolean;
}

const txTimeouts = new WeakMap<pg.Pool, string>();

export function createPool(opts: PoolOptions): pg.Pool {
  const pooled = !!opts.pooler;
  const pool = new pg.Pool({
    ...(!pooled && opts.statementTimeoutMs ? { statement_timeout: opts.statementTimeoutMs, query_timeout: opts.statementTimeoutMs + 2000 } : {}),
    ...(!pooled && opts.idleTxTimeoutMs ? { idle_in_transaction_session_timeout: opts.idleTxTimeoutMs } : {}),
    ...(!pooled && opts.lockTimeoutMs ? { options: `-c lock_timeout=${opts.lockTimeoutMs}` } : {}),
    connectionString: opts.url,
    max: opts.max,
    ssl: buildSsl(opts.ssl, opts.sslCaFile),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  if (pooled) {
    const parts: string[] = [];
    if (opts.statementTimeoutMs) parts.push(`SET LOCAL statement_timeout = ${Math.floor(opts.statementTimeoutMs)}`);
    if (opts.lockTimeoutMs) parts.push(`SET LOCAL lock_timeout = ${Math.floor(opts.lockTimeoutMs)}`);
    if (opts.idleTxTimeoutMs) parts.push(`SET LOCAL idle_in_transaction_session_timeout = ${Math.floor(opts.idleTxTimeoutMs)}`);
    if (parts.length) txTimeouts.set(pool, parts.join('; '));
  }
  return pool;
}

/** Run fn inside a transaction. Rolls back on throw. */
export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const local = txTimeouts.get(pool);
    if (local) await client.query(local);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection may already be gone */
    }
    throw err;
  } finally {
    client.release();
  }
}

export function isPgError(err: unknown, code: string, constraint?: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; constraint?: string };
  return e.code === code && (constraint === undefined || e.constraint === constraint);
}
