import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { E } from '../errors.js';

export interface Replayable {
  status: number;
  body: unknown;
}

const KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export function idempotencyKeyOf(req: Request): string | null {
  const raw = req.header('idempotency-key');
  if (raw === undefined) return null;
  if (!KEY_RE.test(raw)) throw E.validation('Invalid Idempotency-Key header', [{ field: 'Idempotency-Key', issue: 'must be 8-128 chars [A-Za-z0-9_-] (a UUID is recommended)' }]);
  return raw;
}

/**
 * Same key + same request => the stored response is replayed; same key + different request => 422.
 * Failed (thrown) requests are not stored so the client may retry with the same key.
 * Without the header the handler simply runs.
 */
export async function withIdempotency(
  req: Request,
  endpoint: string,
  scope: string,
  payload: unknown,
  run: () => Promise<Replayable>,
  _retry = true,
): Promise<Replayable & { replayed: boolean }> {
  const key = idempotencyKeyOf(req);
  if (!key) return { ...(await run()), replayed: false };
  const pool = req.deps.pool;
  const hash = createHash('sha256').update(stable({ p: payload, e: endpoint })).digest('hex');

  const ins = await pool.query(
    'INSERT INTO idempotency_keys (scope, key, endpoint, request_hash) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING 1',
    [scope, key, endpoint, hash],
  );
  if (ins.rowCount === 1) {
    try {
      const out = await run();
      await pool.query(
        'UPDATE idempotency_keys SET response_status=$4, response_body=$5 WHERE scope=$1 AND key=$2 AND endpoint=$3',
        [scope, key, endpoint, out.status, JSON.stringify(out.body)],
      );
      return { ...out, replayed: false };
    } catch (err) {
      await pool.query('DELETE FROM idempotency_keys WHERE scope=$1 AND key=$2 AND endpoint=$3', [scope, key, endpoint]);
      throw err;
    }
  }

  for (let i = 0; i < 40; i++) {
    const r = await pool.query<{ request_hash: string; response_status: number | null; response_body: unknown; age: number }>(
      'SELECT request_hash, response_status, response_body, extract(epoch from now()-created_at)::float AS age FROM idempotency_keys WHERE scope=$1 AND key=$2 AND endpoint=$3',
      [scope, key, endpoint],
    );
    const row = r.rows[0];
    if (!row) {
      if (_retry) return withIdempotency(req, endpoint, scope, payload, run, false);
      break;
    }
    if (row.request_hash !== hash) {
      throw E.validation('Idempotency-Key was already used with a different request body', [
        { field: 'Idempotency-Key', issue: 'reused with different payload' },
      ]);
    }
    if (row.response_status !== null) return { status: row.response_status, body: row.response_body, replayed: true };
    if (row.age > 30) {
      await pool.query('DELETE FROM idempotency_keys WHERE scope=$1 AND key=$2 AND endpoint=$3 AND response_status IS NULL', [scope, key, endpoint]);
      if (_retry) return withIdempotency(req, endpoint, scope, payload, run, false);
      break;
    }
    await new Promise((res) => setTimeout(res, 100));
  }
  throw E.conflict('A request with this Idempotency-Key is still being processed', 'IDEMPOTENCY_IN_PROGRESS');
}
