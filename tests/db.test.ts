import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildSsl, createPool, repoRoot, withTx } from '../src/db.js';
import { startCtx, type Ctx } from './helpers.js';

const CA = 'certs/supabase-prod-ca-2021.crt';

describe('TLS option builder (verified TLS only)', () => {
  it('is off when DATABASE_SSL is false', () => {
    expect(buildSsl(false)).toBeUndefined();
    expect(buildSsl(false, CA)).toBeUndefined();
  });
  it('uses the default trust store with verification when no CA file is given', () => {
    const s = buildSsl(true);
    expect(s).toEqual({ rejectUnauthorized: true });
    expect(s).not.toHaveProperty('ca');
  });
  it('trusts the given CA file (relative paths resolve from the repo root) and still verifies', () => {
    const rel = buildSsl(true, CA)!;
    expect(rel.rejectUnauthorized).toBe(true);
    expect(rel.ca).toContain('BEGIN CERTIFICATE');
    const abs = buildSsl(true, path.join(repoRoot, CA))!;
    expect(abs.ca).toBe(rel.ca);
  });
  it('fails loudly for a missing or non-PEM file, and never disables verification', () => {
    expect(() => buildSsl(true, 'certs/does-not-exist.crt')).toThrow(/DATABASE_SSL_CA_FILE could not be read/);
    expect(() => buildSsl(true, 'package.json')).toThrow(/PEM certificate/);
    for (const s of [buildSsl(true), buildSsl(true, CA)]) expect(s!.rejectUnauthorized).toBe(true);
  });
  it('config exposes the new env vars', () => {
    const c = loadConfig({ DATABASE_URL: 'x', JWT_SECRET: 'j'.repeat(32), QR_SECRET: 'q'.repeat(32), DATABASE_SSL: 'true', DATABASE_SSL_CA_FILE: CA, DB_POOLER: 'true' });
    expect(c).toMatchObject({ databaseSsl: true, databaseSslCaFile: CA, dbPooler: true });
    expect(loadConfig({ DATABASE_URL: 'x', JWT_SECRET: 'j'.repeat(32), QR_SECRET: 'q'.repeat(32) })).toMatchObject({ databaseSsl: false, databaseSslCaFile: '', dbPooler: false });
  });
});

describe('transaction-pooler mode', () => {
  let ctx: Ctx;
  afterAll(() => ctx?.close());
  it('sends no startup parameters; applies the timeouts with SET LOCAL inside transactions', async () => {
    ctx = await startCtx();
    const pool = createPool({ url: ctx.config.databaseUrl, ssl: false, max: 2, statementTimeoutMs: 5000, lockTimeoutMs: 2000, idleTxTimeoutMs: 10_000, pooler: true });
    try {
      expect((await pool.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('0'); // no session-level setting
      const inside = await withTx(pool, async (c) => ({
        s: (await c.query('SHOW statement_timeout')).rows[0].statement_timeout,
        l: (await c.query('SHOW lock_timeout')).rows[0].lock_timeout,
        i: (await c.query('SHOW idle_in_transaction_session_timeout')).rows[0].idle_in_transaction_session_timeout,
      }));
      expect(inside).toEqual({ s: '5s', l: '2s', i: '10s' });
      // SET LOCAL does not leak out of the transaction
      expect((await pool.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('0');
    } finally {
      await pool.end();
    }
  });
});

describe('migration 0010 (RLS lockdown) is idempotent and role-aware', () => {
  let ctx: Ctx;
  afterAll(async () => {
    await ctx?.pool.query('DROP OWNED BY trim_api').catch(() => {});
    await ctx?.pool.query('DROP ROLE IF EXISTS trim_api').catch(() => {});
    await ctx?.pool.query('DROP OWNED BY anon').catch(() => {});
    await ctx?.pool.query('DROP ROLE IF EXISTS anon').catch(() => {});
    await ctx?.close();
  });
  it('enables RLS everywhere; revokes anon; creates the trim_api_all policy per table when trim_api exists; can run twice', async () => {
    ctx = await startCtx();
    const sql = readFileSync(path.join(repoRoot, 'migrations', '0010_rls_lockdown.sql'), 'utf8');
    const tables = (await ctx.pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows.map((r) => r.tablename as string);
    // already applied on the template DB (roles absent => only RLS): every table has RLS on
    const rls = await ctx.pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity");
    expect(rls.rows[0].n).toBe(0);
    expect((await ctx.pool.query("SELECT count(*)::int AS n FROM pg_policies WHERE policyname = 'trim_api_all'")).rows[0].n).toBe(0);

    await ctx.pool.query('CREATE ROLE anon NOLOGIN');
    await ctx.pool.query('CREATE ROLE trim_api NOLOGIN');
    await ctx.pool.query('GRANT SELECT ON public.plans TO anon');
    expect((await ctx.pool.query("SELECT has_table_privilege('anon', 'public.plans', 'SELECT') AS ok")).rows[0].ok).toBe(true);

    await ctx.pool.query(sql);
    await ctx.pool.query(sql); // idempotent
    expect((await ctx.pool.query("SELECT has_table_privilege('anon', 'public.plans', 'SELECT') AS ok")).rows[0].ok).toBe(false);
    const pol = await ctx.pool.query("SELECT tablename FROM pg_policies WHERE policyname = 'trim_api_all' AND roles = '{trim_api}'");
    expect(pol.rows.map((r) => r.tablename).sort()).toEqual(tables.sort());
  });
});
