# Changelog

All notable changes to Trim-BE. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
