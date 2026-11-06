/** Run after a load test: npm run loadtest:check  (reads DATABASE_URL). Exit code 1 when a double booking exists. */
import 'dotenv/config';
import { createPool } from '../src/db.js';
import { findOverlaps, winnersPerSlot } from '../src/lib/invariants.js';

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('DATABASE_URL is not set (see .env.example)');
  process.exit(1);
}
const pool = createPool({ url, ssl: ['true', '1'].includes(process.env['DATABASE_SSL'] ?? ''), sslCaFile: process.env['DATABASE_SSL_CA_FILE'] || undefined, max: 1 });
try {
  const overlaps = await findOverlaps(pool);
  if (overlaps.length) console.log(`FAIL: ${overlaps.length} overlapping active bookings`, overlaps);
  else console.log('OK: zero overlapping active bookings');
  console.table(await winnersPerSlot(pool));
  process.exitCode = overlaps.length ? 1 : 0;
} finally {
  await pool.end();
}
