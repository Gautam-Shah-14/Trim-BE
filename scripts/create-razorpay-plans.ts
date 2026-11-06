/**
 * Creates the 4 Razorpay plans (starter/pro x monthly/annual) from the `plans` table and stores the
 * returned plan ids back in the DB. NOT run by CI or by the build: the owner runs it once with TEST keys.
 *
 *   npm run razorpay:plans -- --dry-run     # print what would be created, no API calls
 *   npm run razorpay:plans                  # create missing plans (test keys only)
 *   npm run razorpay:plans -- --live        # required to use rzp_live_ keys (do not, until launch)
 *
 * Reads DATABASE_URL, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET from .env. Plans are tagged notes {app:"trim"}
 * because the Razorpay account is shared with another product. Razorpay plans are immutable: if a price
 * changes in `plans`, the admin API clears the stored id and re-running this script creates a new plan.
 */
import 'dotenv/config';
import Razorpay from 'razorpay';
import { createPool } from '../src/db.js';

const args = new Set(process.argv.slice(2));
const dry = args.has('--dry-run');
const live = args.has('--live');

const { DATABASE_URL, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } = process.env;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set (see .env.example)');
  process.exit(1);
}
if (!dry && (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET)) {
  console.error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set (use TEST keys).');
  process.exit(1);
}
if (!dry && RAZORPAY_KEY_ID!.startsWith('rzp_live_') && !live) {
  console.error('Refusing to use LIVE keys without --live. Use test keys until launch.');
  process.exit(1);
}

const pool = createPool({ url: DATABASE_URL, ssl: ['true', '1'].includes(process.env['DATABASE_SSL'] ?? ''), sslCaFile: process.env['DATABASE_SSL_CA_FILE'] || undefined, max: 2 });
try {
  const rz = dry ? null : new Razorpay({ key_id: RAZORPAY_KEY_ID!, key_secret: RAZORPAY_KEY_SECRET! });
  const plans = (await pool.query('SELECT * FROM plans WHERE is_active ORDER BY price_monthly_paise')).rows;
  for (const p of plans) {
    for (const interval of ['monthly', 'annual'] as const) {
      const col = interval === 'monthly' ? 'razorpay_plan_id_monthly' : 'razorpay_plan_id_annual';
      const amount: number = interval === 'monthly' ? p.price_monthly_paise : p.price_annual_paise;
      if (p[col]) {
        console.log(`= ${p.code}/${interval}: already has ${p[col]}`);
        continue;
      }
      const body = {
        period: interval === 'monthly' ? ('monthly' as const) : ('yearly' as const),
        interval: 1,
        item: { name: `Trim ${p.name} (${interval})`, amount, currency: 'INR', description: `Trim ${p.name} plan, billed ${interval}` },
        notes: { app: 'trim', planCode: p.code, interval },
      };
      if (dry || !rz) {
        console.log(`~ would create ${p.code}/${interval}: INR ${(amount / 100).toFixed(2)}`);
        continue;
      }
      const created = await rz.plans.create(body);
      await pool.query(`UPDATE plans SET ${col} = $2, updated_at = now() WHERE code = $1`, [p.code, created.id]);
      console.log(`+ ${p.code}/${interval}: created ${created.id}`);
    }
  }
} catch (err) {
  console.error('Failed:', (err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
