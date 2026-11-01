import 'dotenv/config';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('DATABASE_URL is not set (see .env.example)');
  process.exit(1);
}
const pool = createPool({ url, ssl: ['true', '1'].includes(process.env['DATABASE_SSL'] ?? ''), max: 2 });
try {
  const applied = await runMigrations(pool, undefined, (m) => console.log(m));
  console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.');
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
