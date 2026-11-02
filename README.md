# Trim-BE

REST API for the **Trim** salon booking and salon-operations platform (a TokenBurners product). Node 24, TypeScript (strict), Express 5, `pg`, `zod`. Contract: spec section 6 in [`docs/superpowers/specs/2026-11-01-trim-platform-design.md`](docs/superpowers/specs/2026-11-01-trim-platform-design.md) and the generated [`openapi.yaml`](openapi.yaml) (OpenAPI 3.1, 107 operations).

What it does: own auth (argon2id, JWT + rotating refresh tokens), per-salon RBAC, plan entitlements, availability and booking holds (the database refuses double bookings with a `gist` exclusion constraint), QR check-in, invoices with split payments, reviews, analytics, media (base64), discovery search, salon subscriptions through Razorpay (webhook driven), admin and sales endpoints.

## Setup

```bash
npm install
cp .env.example .env        # fill in values; .env is gitignored
npm run migrate             # applies /migrations (forward-only, tracked in schema_migrations)
npm run seed                # service templates + 73 hairstyles (idempotent; plans come from migration 0003)
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='...' npm run admin:create   # first admin
npm run dev                 # http://localhost:8080/health
```

Requirements: Node >= 24 and PostgreSQL 15+ with `pgcrypto`, `btree_gist`, `citext` (Supabase works as plain Postgres).

## Environment

All configuration comes from environment variables, validated with zod at startup (the process exits with a readable message if something is wrong). Never commit `.env`.

| Variable | Required | Meaning |
|---|---|---|
| `NODE_ENV` | no (development) | `development`, `test`, `production`. Production also requires the Razorpay vars and `CORS_ORIGINS` |
| `PORT` | no (8080) | HTTP port |
| `LOG_LEVEL` | no (info) | pino level |
| `DATABASE_URL` | yes | Postgres connection string |
| `DATABASE_SSL` | no (false) | `true` for hosts that need TLS (Supabase) |
| `DATABASE_POOL_MAX` | no (10) | pool size |
| `JWT_SECRET` | yes | HS256 secret, >= 32 chars |
| `QR_SECRET` | yes | HMAC secret for booking QR tokens, >= 32 chars |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | prod | Razorpay API keys (test keys until launch) |
| `RAZORPAY_WEBHOOK_SECRET` | prod | secret configured on the Razorpay webhook |
| `CORS_ORIGINS` | prod | comma-separated browser origins |
| `WEBSITE_URL` | no | base URL for sales invite links |
| `TRUST_PROXY` | no (1) | number of proxies in front (Render = 1) |
| `HOLD_SWEEPER_ENABLED` | no (true) | in-process 30 s sweeper of expired holds |
| `RATE_LIMIT_GENERAL_PER_MIN` | no (300) | per IP |
| `RATE_LIMIT_LOGIN_PER_15MIN` | no (10) | per IP + identifier |
| `RATE_LIMIT_CONTACT_PER_HOUR` | no (5) | per IP |
| `ARGON2_MEMORY_KIB` | no (19456) | argon2id memory cost |

## Scripts

| Command | What |
|---|---|
| `npm run dev` | tsx watch server |
| `npm run build` / `npm start` | compile to `dist/` / run compiled server |
| `npm test` | vitest (starts a real embedded PostgreSQL, see below) |
| `npm run lint` / `npm run typecheck` | eslint / tsc |
| `npm run migrate` / `npm run seed` | apply migrations / seed reference data |
| `npm run openapi` | regenerate `openapi.yaml` from the route registry (CI fails if stale) |
| `npm run admin:create` | create/promote an admin (env: `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`) |
| `npm run razorpay:plans -- --dry-run` | create the 4 Razorpay plans from the `plans` table (owner runs this with TEST keys; never run by CI) |

## Tests

`npm test` needs no Docker and no installed Postgres: `tests/globalSetup.ts` boots **embedded-postgres** (real PostgreSQL 18 binaries incl. `btree_gist`), migrates and seeds a template database once, and each test file clones it. Suites: slot maths across timezones/DST/closures/time off, QR, entitlements, RBAC defaults, validation, and API-level integration including the spec section 7 concurrency rules (50 parallel holds, partial overlaps, hold expiry, idempotency keys, double check-in, optimistic versions, 30 parallel invoices, webhook replay/out-of-order, max_staff race). Last run: 5 files, 86 tests passing.

## Structure

```
migrations/          numbered, forward-only SQL (runner: src/migrate.ts)
src/app.ts           app factory (middleware order, module registration)
src/server.ts        process entry: config, pool, sweeper, graceful shutdown
src/http/            Api route registry + auth/salon/permission guards, zod helpers, idempotency, rate limits
src/modules/         one file per area: auth, me, media, discover, salon, services, staff, roles, bookings,
                     billing, reviews, analytics, subscription, webhooks, admin, sales, public
src/lib/             pure/domain logic: slots, entitlements, qr, permissions, security, booking, gateway (Razorpay)
src/seed/            service templates and hairstyle catalog
scripts/             migrate, seed, create-admin, create-razorpay-plans, gen-openapi
tests/               vitest suites
.github/workflows/   ci, keepalive, backup (inert until the repo is pushed)
docs/                Architecture, KT_Guide, CHANGELOG, spec
```

## API overview

Base path `/v1`; responses `{data, meta?}` or `{error:{code,message,details?}}`; money in integer paise; times ISO-8601 UTC. `/health` is outside `/v1`. Groups: Auth, Profile (`/me`), Media, Discover + availability, Bookings (customer), Salon (profile, hours, closures), Services, Staff, Roles, Salon bookings + check-in, Billing + payment methods, Reviews, Analytics + CSV, Customers CRM, Subscription, Webhooks, Admin, Sales, public (`/plans`, `/contact`, `/hairstyles`, `/service-templates`). The full list with schemas is in `openapi.yaml`; deviations and interpretations of the spec are in [docs/Architecture.md](docs/Architecture.md) under "Decisions".

Docs: [Architecture](docs/Architecture.md), [KT guide](docs/KT_Guide.md), [Changelog](docs/CHANGELOG.md).
