/**
 * Create (or promote) a platform admin.
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='...' ADMIN_NAME='Your Name' npm run admin:create
 * The password is read from the environment so it never lands in shell history or the repo.
 */
import 'dotenv/config';
import { createPool } from '../src/db.js';
import { makePasswordHasher } from '../src/lib/security.js';

const { DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
if (!DATABASE_URL || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('Set DATABASE_URL, ADMIN_EMAIL and ADMIN_PASSWORD (see docs/KT_Guide.md).');
  process.exit(1);
}
if (!/^(?=.*[A-Za-z])(?=.*\d).{8,}$/.test(ADMIN_PASSWORD)) {
  console.error('ADMIN_PASSWORD must be at least 8 characters with a letter and a digit.');
  process.exit(1);
}
const pool = createPool({ url: DATABASE_URL, ssl: ['true', '1'].includes(process.env['DATABASE_SSL'] ?? ''), sslCaFile: process.env['DATABASE_SSL_CA_FILE'] || undefined, max: 2 });
try {
  const hash = await makePasswordHasher(19456).hash(ADMIN_PASSWORD);
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, platform_role) VALUES ($1,$2,$3,'admin')
     ON CONFLICT (email) DO UPDATE SET platform_role = 'admin', password_hash = EXCLUDED.password_hash, is_active = true, updated_at = now()
     RETURNING id`,
    [ADMIN_EMAIL.toLowerCase(), hash, ADMIN_NAME ?? 'Admin'],
  );
  console.log(`Admin ready: ${ADMIN_EMAIL} (${r.rows[0].id})`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
