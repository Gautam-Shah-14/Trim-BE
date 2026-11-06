import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import type { TestProject } from 'vitest/node';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { seedReference } from '../src/seed/index.js';

declare module 'vitest' {
  export interface ProvidedContext {
    pg: { host: string; port: number; user: string; password: string; template: string };
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

let pgServer: EmbeddedPostgres | undefined;

/**
 * Starts ONE real in-process-managed PostgreSQL (embedded-postgres, PG 18 with btree_gist) for the whole run,
 * migrates + seeds a template database, and lets every test file clone it (CREATE DATABASE ... TEMPLATE).
 */
export default async function setup(project: TestProject) {
  const port = await freePort();
  const password = randomBytes(12).toString('hex'); // throwaway, generated per run
  const dir = mkdtempSync(path.join(os.tmpdir(), 'trim-pg-'));
  pgServer = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password, port, persistent: false, postgresFlags: ['-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off', '-c', 'max_connections=200'], onLog: () => {}, onError: () => {} });
  await pgServer.initialise();
  await pgServer.start();
  await pgServer.createDatabase('trim_template');
  const pool = createPool({ url: `postgres://postgres:${password}@127.0.0.1:${port}/trim_template`, ssl: false, max: 2 });
  await runMigrations(pool);
  await seedReference(pool);
  await pool.end();
  project.provide('pg', { host: '127.0.0.1', port, user: 'postgres', password, template: 'trim_template' });
  return teardown;
}

async function teardown() {
  // embedded-postgres' own stop() can leave the child + its pipes referenced on Windows, which is what made vitest print
  // "close timed out ... 2 Vite servers". Stop gracefully with a deadline, then make sure the child and its pipes are gone.
  const child = (pgServer as unknown as { process?: ChildProcess } | undefined)?.process;
  try {
    await Promise.race([pgServer?.stop(), new Promise((r) => setTimeout(r, 8000))]);
  } catch {
    /* a non-zero checkpointer exit on shutdown is harmless */
  }
  if (child && child.exitCode === null && !child.killed) child.kill();
  child?.stdin?.destroy();
  child?.stdout?.destroy();
  child?.stderr?.destroy();
  child?.unref();
  pgServer = undefined;
}
