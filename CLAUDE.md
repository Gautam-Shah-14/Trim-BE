# Trim-BE — Claude instructions
Workspace rules live in `../CLAUDE.md` (secrets policy, no push, RBAC, Razorpay scope). Spec: `docs/superpowers/specs/2026-11-01-trim-platform-design.md` (API contract §6, concurrency §7, scale/caching/queues §11). Repo-specific notes below.

- Stack: Node 24, TypeScript strict, Express, `pg`, zod, vitest. SQL migrations in `migrations/` (numbered, forward-only). `openapi.yaml` is generated (`npm run openapi`) and must match §6.
- Commands: `npm run lint`, `npm run typecheck`, `npm run build`, `npm test` (starts a real embedded PostgreSQL 18 with `btree_gist`; no Docker needed), `npm run migrate`, `npm run dev`.
- Never weaken the DB constraints: the bookings exclusion constraint, unique idempotency/webhook keys and invoice counters are the correctness layer. Cache, Redis and the queue are optimisations only (§11).
- Every salon route goes through the RBAC + entitlement middleware; add permissions to the spec first.
- New env var → `.env.example` + README table + zod env schema in the same change. Never log secrets.
- Do not apply migrations to the remote Supabase project without the owner's go-ahead.
- Update `docs/CHANGELOG.md` (Unreleased) with every behaviour or contract change and note which clients are affected.
