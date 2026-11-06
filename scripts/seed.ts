import 'dotenv/config';
import { createPool } from '../src/db.js';
import { seedReference } from '../src/seed/index.js';

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('DATABASE_URL is not set (see .env.example)');
  process.exit(1);
}
const pool = createPool({ url, ssl: ['true', '1'].includes(process.env['DATABASE_SSL'] ?? ''), sslCaFile: process.env['DATABASE_SSL_CA_FILE'] || undefined, max: 2 });
try {
  const r = await seedReference(pool);
  console.log(`Seeded ${r.templates} service templates and ${r.hairstyles} hairstyles.`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
