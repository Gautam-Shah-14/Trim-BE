import pg from 'pg';

export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

// Return int8 as JS number (counts, sums fit comfortably) and numeric as number.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export function createPool(opts: { url: string; ssl: boolean; max: number }): pg.Pool {
  return new pg.Pool({
    connectionString: opts.url,
    max: opts.max,
    ssl: opts.ssl ? { rejectUnauthorized: false } : undefined,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

/** Run fn inside a transaction. Rolls back on throw. */
export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
