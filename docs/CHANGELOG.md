# Changelog

All notable changes to Trim-BE. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Hot-slot latency fix (round 4)
Behind a slow database link (Render Singapore -> Supabase Mumbai, pool of 5) 30 parallel holds on one slot returned 1 x 201 and 29 x 504, and overlapping starts produced 500s. Cause: every contender held a pooled connection while queueing on the staff/day advisory lock, then ran the full ~17-round-trip path (the losers too, plus a ~40-round-trip alternatives computation each), so the pool starved; pool-acquire timeouts were unmapped (500). Fix: reads moved out of the transaction, in-process single flight for identical staff+start, one-statement fail-fast pre-check + stale-hold sweep, one-statement booking+items insert, merged working-hours lookup, coalesced alternatives, and pool/statement/lock timeouts now answer 503 `OVERLOADED` + `Retry-After`. The exclusion constraint is unchanged and remains the only authority. No contract change except that saturation is now 503 instead of 500. Clients: treat 503 like 429 (back off using Retry-After).

### Deployment
- Added `render.yaml` (Render Blueprint for the `trim-tokenburners-api` web service (the name `trim-api` is taken on onrender.com by another account): Singapore, free plan, Node 24, health check `/health`, verified TLS to Supabase, secrets as `sync: false`). Build command uses `npm ci --include=dev` so TypeScript is installed even when `NODE_ENV=production`. No contract change; no client is affected.

### QA round 3 (2026-11-07 report)
Contract-affecting (additive): website must send `X-Trim-BFF-Key` + `X-Trim-Client-IP` (W); lockout 429 now has `Retry-After` and `details.retryAfterSec` (all clients); NUL characters are `422 VALIDATION_FAILED`; provider failure on checkout/cancel is `502 UPSTREAM_ERROR` with `reason: PAYMENT_PROVIDER` instead of 500 (W, S, D); wrong method gives `405 METHOD_NOT_ALLOWED` with `Allow` instead of 404.
- D-01 authenticated BFF client IP (`BFF_SHARED_SECRET`); D-02 NUL rejection at the edge; D-03 lockout `Retry-After`; D-04 webhook worker polls every 0.5 s with batches of 10 and 2 workers; D-05 `/metrics` token mandatory in production (Bearer or `X-Metrics-Token`), config refuses to start otherwise; D-06 export-range test uses the salon-local date; D-08 502 `UPSTREAM_ERROR`; D-09 405; D-15 test Postgres initialised with `--encoding=UTF8`, new non-ASCII round-trip test.
- Not changed: the register limiter still counts rejected requests (5 typos from one NAT block sign-up for an hour; revisit if it bites), avatar read access (D-13) and magic-byte-only media validation (D-14) are by design.

### Contract additions (all additive; existing response shapes unchanged)
Affected clients are listed per item (C = customer app, S = salon app, D = desktop, W = website).
- `POST /bookings/hold`, walk-in and reschedule: `409 SLOT_TAKEN` now carries `details.alternatives[{staffId,startsAt,endsAt}]` (C, S, D). Offer them for one-tap re-booking.
- New `409 CONFLICT` reasons `HOLD_LIMIT`, `UPCOMING_LIMIT`, `DAILY_LIMIT` (max 3 active holds, 10 upcoming confirmed, 5 created per 24 h per customer) (C).
- `429 RATE_LIMITED` with `Retry-After` and `RateLimit-*` headers; new limits for register (5/h/IP), availability (60/min/user), hold (10/min/user), check-in (120/min/salon). Back off with jitter (all clients). New `503 OVERLOADED` and `504 TIMEOUT` (all).
- `ETag`/`Cache-Control`/`If-None-Match` (304) on public GETs: plans, hairstyles, discover, salon profile, public reviews (C, W). Do not poll availability faster than every 10 s.
- Subscription view: `paymentMethodAuthorized`, `nextChargeAt` (set by `subscription.authenticated` while still `trialing`) (W, S, D).
- Analytics summary: `repeatCustomerRate` alias of `repeatCustomers.rate` (D, W).
- `GET /analytics/export.csv` returns `202 {jobId}` for ranges over 92 days; new `POST .../analytics/export`, `GET .../jobs/:jobId`, `GET .../jobs/:jobId/download` (D).
- `POST /webhooks/razorpay` responds `result: queued|duplicate` (state is applied asynchronously) (no client impact; clients poll).
- New `GET /admin/queue`, `GET /ready`, `GET /metrics` (W admin console may show queue health).
- `error.reason` values are now a documented, stable list (`openapi.yaml` `x-error-reasons`, docs/CONTRACT_DECISIONS.md). `GET /me` and `register-owner` (`inviteCode`) unchanged but documented.
- `openapi.yaml` now has full response schemas generated from `src/schemas.ts` and verified against real responses by `tests/contract.test.ts`.

### Added
- Scale layer (spec section 11): Cache / RateLimiter / JobQueue interfaces with memory implementations and optional Redis drivers (ioredis; tested only against an in-memory fake, never a live Redis), pg-boss Postgres queue with `WORKER_MODE=api|worker|both`, webhook processing as a job with a retry safety net, cache-aside with single-flight + version-key invalidation + stale-while-revalidate, per-route rate limits, slot-hoarding caps, per-staff/day advisory lock plus transaction retry for hot slots, statement/lock/idle timeouts, body and request limits, load shedding, circuit breaker around Razorpay, `/ready`, `/metrics`, `daily_salon_stats` rollup job, async CSV exports, bounding-box discovery prefilter, new indexes (migration 0008).
- Migration 0009 (`payment_authorized_at`, `next_charge_at`) and migration 0010: idempotent RLS lockdown (RLS on every public table, `anon`/`authenticated` privileges revoked; guarded so it is a no-op for the roles on plain Postgres). Identical to what was applied by hand on the remote project; 0001-0007 were applied remotely and must never be edited.
- `DATABASE_SSL_CA_FILE` (verified TLS with a custom CA; `certs/supabase-prod-ca-2021.crt` is the public Supabase root CA) and `DB_POOLER` (transaction-pooler mode). TLS is always verified (`rejectUnauthorized` is never false).
- `loadtest/` k6 scripts (not run) and `npm run loadtest:check`.
- docs/CONTRACT_DECISIONS.md.

### Changed
- `DATABASE_POOL_MAX` renamed `DB_POOL_MAX` (old name still accepted); `HOLD_SWEEPER_ENABLED` removed (the sweep is the `booking.sweep` job).
- Fixed: vitest no longer prints "close timed out ... Vite servers" (embedded Postgres child process is released in teardown).

### Known gaps
- `max_branches` is stored but not enforced (no multi-branch endpoint in the contract).
- Mid-term plan change (upgrade/downgrade) is not implemented; cancel at period end and re-subscribe.
- Push notifications are not delivered (tokens are stored only).
- The Razorpay integration has only been exercised against a fake gateway and signed fixture events, never against Razorpay itself.

## [0.1.0] - 2026-11-02

### Added
- REST API under `/v1` implementing the spec section 6 contract (107 operations) plus `openapi.yaml` (OpenAPI 3.1, generated from the route registry).
- PostgreSQL schema as forward-only SQL migrations with a runner; seeds for plans, 31 service templates and 73 hairstyles across Heart/Oblong/Oval/Round/Square for men/women/unisex.
- Own auth: argon2id, 15-minute JWT, rotating hashed refresh tokens with reuse detection, account lockout, rate limits.
- Per-salon RBAC (18 permissions, 4 system roles created with every salon, custom roles on Pro) and entitlement helper (Starter/Pro, trial, past-due grace, comp, read-only mode).
- Availability engine (timezone/DST aware, closures, time off, staff speed); booking hold/confirm/cancel/walk-in/reschedule (version)/check-in/complete/no-show; signed QR tokens; hold sweeper.
- Invoices with gap-free per-salon numbering and split payments, payment methods, reviews and replies, analytics (basic/full), CSV export, customers CRM.
- Media in the database (base64, 200 KB cap, magic-byte check, ETag); discovery search with haversine distance.
- Razorpay subscription checkout, signature-verified idempotent webhook, receipts; `scripts/create-razorpay-plans.ts`.
- Admin, sales (leads, invites, pipeline) and contact (honeypot) endpoints; audit log.
- pino logging, helmet, CORS allow-list, request ids, `/health`, graceful shutdown.
- Tests against a real embedded PostgreSQL covering the section 7 concurrency rules; GitHub workflows `ci`, `keepalive`, `backup` (inactive until pushed).
- Documentation: README, Architecture, KT guide.
