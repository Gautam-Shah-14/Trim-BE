# AGENTS.md — Trim-BE
See `../AGENTS.md` for workspace rules and `CLAUDE.md` here for details.

| Task | Command |
|---|---|
| Install | `npm install` |
| Lint / typecheck | `npm run lint` / `npm run typecheck` |
| Build | `npm run build` |
| Tests (real embedded Postgres 18) | `npm test` |
| Dev server | `npm run dev` (needs a local `.env`; copy `.env.example`) |
| Migrate / seed | `npm run migrate` / `npm run seed` |
| Regenerate OpenAPI | `npm run openapi` |

Rules: no push; no secrets in git (`.env` ignored, `.env.example` committed); the API contract is spec §6 — change the spec, then the code, then `openapi.yaml`; DB constraints are the only authority for booking/payment correctness; keep docs and `docs/CHANGELOG.md` current.
