import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
/** /migrations lives at the repo root (works for src/ via tsx and dist/src/ after build) */
export function defaultMigrationsDir(): string {
  const up = here.includes(`${path.sep}dist${path.sep}`) ? '../..' : '..';
  return path.resolve(here, up, 'migrations');
}

export async function runMigrations(pool: pg.Pool, dir = defaultMigrationsDir(), log: (m: string) => void = () => {}): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(path.join(dir, f), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${f} failed: ${(err as Error).message}`);
      }
      applied.push(f);
      log(`applied ${f}`);
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(727274)');
    } finally {
      client.release();
    }
  }
  return applied;
}
