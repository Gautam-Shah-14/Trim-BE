# KT Guide (new developer onboarding)

## Run it locally in 10 minutes
1. Node 24+, a Postgres 15+ (any; or point at a throwaway database). Needs extensions `pgcrypto`, `btree_gist`, `citext` (`CREATE EXTENSION` works on Supabase and Render Postgres).
2. `npm install`, `cp .env.example .env`, edit `DATABASE_URL`, generate `JWT_SECRET` and `QR_SECRET` (the command is in `.env.example`).
3. `npm run migrate && npm run seed`, create an admin with `npm run admin:create`, then `npm run dev`. `GET /health` should say `db: up`.
4. `npm test` needs nothing installed (embedded Postgres). The first run extracts binaries and takes a minute.

## Where things are
- `src/app.ts` wires middleware and registers modules; `src/http/api.ts` holds the route registry and guards.
- A route declares its policy in metadata: `auth: 'none'|'user'|'customer'|'admin'|'sales'|'salon'`, `perm`, `writable`, `ownerOnly`. Salon routes get membership, permissions and entitlements in `req.salonCtx`.
- Business rules live in `src/lib` (pure where possible): `slots.ts`, `entitlements.ts`, `qr.ts`, `booking.ts`, `permissions.ts`.
- All SQL is inline in modules (no ORM). Money is integer paise everywhere.

## Add a route
1. Pick or create `src/modules/<area>.ts` exporting `register(api: Api)`; add it to `MODULES` in `src/app.ts`.
2. Define a zod `z.strictObject` for the body (and a query schema) and call `parse(schema, req.body)`.
3. `api.post('/salons/:salonId/things', { summary, tag, auth: 'salon', perm: 'services.edit', writable: true, body: schema, returns: 'Thing', status: 201 }, async (req, res) => { ...; send(res, dto, undefined, 201) })`.
4. Throw `E.notFound()`, `E.conflict(msg, reason)`, `E.validation(...)`, `E.planLimit(...)`; never build error JSON by hand.
5. If it creates money or booking state, accept `Idempotency-Key` via `withIdempotency` (see billing and bookings).
6. Run `npm run openapi` and commit the regenerated `openapi.yaml` (CI and a test fail otherwise).
7. Add a test in `tests/` (helpers: `startCtx`, `makeOwner`, `makeCustomer`, `call`).

## Add a migration
Create `migrations/NNNN_description.sql` with the next number. Forward-only: never edit an applied file; fix with a new migration. The runner takes an advisory lock, runs each file in a transaction and records it in `schema_migrations`. Apply with `npm run migrate`. Tests clone a template DB built from all migrations, so a broken migration fails every test.

## Add a permission
Add it to `PERMISSIONS` and the default role lists in `src/lib/permissions.ts`. Existing salons keep their stored role permissions, so also add a migration that inserts the new permission for the relevant system roles.

## Debugging
- Every response has `X-Request-Id`; the same id is in the pino logs (`reqId`). 500 messages quote it.
- `LOG_LEVEL=debug` for more. Logs are JSON; pipe through `npx pino-pretty` locally.
- Booking problems: query `bookings` for `status`, `during`, `hold_expires_at`. The exclusion constraint is `bookings_no_overlap`.
- Subscription problems: `subscription_events` holds every webhook payload (unique event id); `subscriptions.last_event_at` explains "stale" events.
- `audit_log` records admin actions, staff/role changes, voids and subscription changes (`GET /v1/admin/audit`).

## Gotchas
- Express 5: `req.query` is read-only, so queries are parsed per handler. Async handler errors propagate automatically.
- The webhook route needs the raw body; `express.raw` is mounted before `express.json` in `app.ts`. Do not move it.
- `pg` returns `bigint` and `numeric` as numbers (parsers in `src/db.ts`); timestamps as `Date`.
- Concurrent inserts into an exclusion-constrained table can raise `40P01` (deadlock) instead of `23P01`; both mean "slot taken".
- Do not run several statements concurrently on one `PoolClient` (`Promise.all` on a transaction client is deprecated in pg).
- Lists must never select `media.data_base64`.
- Every query on salon data carries `salon_id = $n`; keep it that way.
- Tests set `ARGON2_MEMORY_KIB=1024` and huge rate limits; real config uses the defaults.
- On Windows, if `npm install` blocks install scripts, run `node scripts/hydrate-symlinks.js` inside `node_modules/@embedded-postgres/windows-x64` once (it recreates files embedded-postgres needs).

## Runbook: Razorpay (TEST mode)
1. Razorpay dashboard in Test Mode: Settings > API Keys > generate. Put `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` in `.env` (never in git).
2. Create plans: `npm run razorpay:plans -- --dry-run`, then `npm run razorpay:plans`. It creates starter/pro x monthly/annual from the `plans` table (notes `app=trim`) and stores the ids in the DB. The account is shared with another product; everything created here is tagged. The script refuses `rzp_live_` keys without `--live`.
3. Webhook: Settings > Webhooks > add `https://<api-host>/v1/webhooks/razorpay`, choose a secret (this becomes `RAZORPAY_WEBHOOK_SECRET`), tick `subscription.authenticated, activated, charged, pending, halted, cancelled, completed` and `payment.failed`. For local work expose the port with a tunnel and use the tunnel URL.
4. Try it: the owner portal (or `POST /v1/salons/:id/subscription/checkout`) returns `razorpaySubscriptionId` + `keyId`; pay with a Razorpay test card/UPI; watch `subscription_events` and `GET /subscription` flip to `active`. Receipts land in `subscription_receipts` (plain receipts, never "tax invoices").
5. Changing a price: `PATCH /v1/admin/plans/:code` clears the stored Razorpay plan id; re-run the script; existing subscribers stay on their old plan.

## Runbook: deploy on Render (later, needs owner approval)
1. New Postgres (or keep Supabase with its connection string and `DATABASE_SSL=true`). Run `npm run migrate && npm run seed` once against it.
2. New Web Service from the repo: build `npm ci && npm run build`, start `npm start`, health check path `/health`, Node 24.
3. Environment: everything in `.env.example` (production requires Razorpay keys and `CORS_ORIGINS`); `TRUST_PROXY=1`.
4. Point the Razorpay webhook at the Render URL. Add repo secrets `API_BASE_URL` and `DATABASE_URL` for `keepalive.yml`, and `DATABASE_URL` (+ optional `BACKUP_PASSPHRASE`) for `backup.yml`.
5. Free-tier caveats: the service sleeps (keepalive pings daily; the first request after idle is slow) and free Supabase has no backups (the nightly artifact is the only one). Upgrade when the first salon pays.
6. Run migrations as a deploy step before switching traffic. Rollbacks are done with a new forward migration.
