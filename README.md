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

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` | development | `development`, `test`, `production`. Production also requires the Razorpay vars and `CORS_ORIGINS` |
| `PORT` | 8080 | HTTP port |
| `LOG_LEVEL` | info | pino level |
| `DATABASE_URL` | required | Postgres connection string |
| `DATABASE_SSL` | false | `true` for hosts that need TLS (Supabase). Certificates are always verified |
| `DATABASE_SSL_CA_FILE` | empty | PEM CA to trust, path relative to the repo root (e.g. `certs/supabase-prod-ca-2021.crt`); empty = Node default trust store |
| `DB_POOLER` | false | `true` behind a transaction pooler (Supabase :6543): no startup parameters, timeouts via `SET LOCAL` per transaction |
| `DB_POOL_MAX` | 10 | pooled connections per instance (`DATABASE_POOL_MAX` is an alias) |
| `STATEMENT_TIMEOUT_MS` / `LOCK_TIMEOUT_MS` / `IDLE_TX_TIMEOUT_MS` | 5000 / 2000 / 10000 | per-query, lock-wait and idle-in-transaction timeouts (0 disables) |
| `JWT_SECRET` | required | HS256 secret, >= 32 chars |
| `QR_SECRET` | required | HMAC secret for booking QR tokens, >= 32 chars |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | prod | Razorpay API keys (test keys until launch) |
| `RAZORPAY_WEBHOOK_SECRET` | prod | secret configured on the Razorpay webhook |
| `CORS_ORIGINS` | prod | comma-separated browser origins |
| `WEBSITE_URL` | http://localhost:3000 | base URL for sales invite links |
| `TRUST_PROXY` | 1 | number of proxies in front (Render = 1) |
| `WORKER_MODE` | both | `api`, `worker` or `both` |
| `QUEUE_ENABLED` | true | `false` runs jobs inline inside the request |
| `QUEUE_DRIVER` | pgboss | `pgboss` (Postgres, durable) or `memory` |
| `QUEUE_DATABASE_URL` | empty | direct (non-pooler, schema-owner) connection for pg-boss; falls back to `DATABASE_URL` |
| `QUEUE_MAX_DEPTH` | 5000 | optional reads are shed (503) above this backlog |
| `CACHE_DRIVER` / `RATE_LIMIT_DRIVER` | memory | `memory` or `redis` (needs `REDIS_URL`) |
| `REDIS_URL` | empty | Redis connection string for the redis drivers |
| `CACHE_TTL_PLANS_S` / `_CATALOG_S` / `_SALON_PUBLIC_S` / `_DISCOVER_S` / `_AVAILABILITY_S` / `_ENTITLEMENTS_S` / `_SESSION_S` | 3600 / 86400 / 120 / 45 / 8 / 30 / 30 | cache TTLs in seconds (0 disables) |
| `RATE_LIMIT_GENERAL_PER_MIN` | 300 | per IP |
| `RATE_LIMIT_LOGIN_PER_15MIN` | 10 | per IP + identifier |
| `RATE_LIMIT_CONTACT_PER_HOUR` / `RATE_LIMIT_REGISTER_PER_HOUR` | 5 / 5 | per IP |
| `RATE_LIMIT_AVAILABILITY_PER_MIN` / `RATE_LIMIT_HOLD_PER_MIN` | 60 / 10 | per user (IP when anonymous) |
| `RATE_LIMIT_CHECKIN_PER_MIN` | 120 | per salon |
| `MAX_HELD_PER_CUSTOMER` / `MAX_UPCOMING_PER_CUSTOMER` / `MAX_BOOKINGS_PER_DAY` | 3 / 10 / 5 | slot-hoarding caps |
| `BODY_LIMIT_KB` / `MEDIA_BODY_LIMIT_KB` | 100 / 400 | JSON body limits |
| `REQUEST_TIMEOUT_MS` | 15000 | request timeout (504 `TIMEOUT`) |
| `LOAD_SHED_LAG_MS` / `LOAD_SHED_POOL_WAITING` | 500 / 50 | event-loop lag and DB pool waiters above which optional reads get 503 |
| `METRICS_ENABLED` / `METRICS_TOKEN` | true / empty | `GET /metrics`; with a token it needs `Authorization: Bearer <token>` or `X-Metrics-Token`. **Production refuses to start with metrics enabled and no token** |
| `BFF_SHARED_SECRET` | empty | >= 24 chars; the website server sends it as `X-Trim-BFF-Key` with `X-Trim-Client-IP` so per-visitor rate limits work behind the proxy (see docs/CONTRACT_DECISIONS.md). Warned about at start-up in production when empty |
| `ARGON2_MEMORY_KIB` | 19456 | argon2id memory cost |

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
| `npm run loadtest:check` | after a k6 run: asserts zero overlapping active bookings (see `loadtest/`) |
| `npm run razorpay:plans -- --dry-run` | create the 4 Razorpay plans from the `plans` table (owner runs this with TEST keys; never run by CI) |

## Tests

`npm test` needs no Docker and no installed Postgres: `tests/globalSetup.ts` boots **embedded-postgres** (real PostgreSQL 18 binaries incl. `btree_gist`), migrates and seeds a template database once, and each test file clones it. Suites: slot maths across timezones/DST/closures/time off, QR, entitlements, RBAC defaults, validation, and API-level integration including the spec section 7 concurrency rules (50 parallel holds, partial overlaps, hold expiry, idempotency keys, double check-in, optimistic versions, 30 parallel invoices, webhook replay/out-of-order, max_staff race), plus rate limiting, cache invalidation, queue-backed webhook (pg-boss), 409 alternatives, hoarding caps, rollups/exports, TLS option builder, RLS migration and a contract test that validates responses against `src/schemas.ts`. Last run: 9 files, 122 tests passing.

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
