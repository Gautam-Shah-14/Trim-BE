# Load tests (k6)

These scripts were written to the spec (section 11.9) but **have not been run**. Run them only against a disposable test deployment, never against production without the owner's approval. They are not part of CI.

Install k6 (https://k6.io), then, for example:

```bash
k6 run -e BASE_URL=http://localhost:8080 -e SALON_ID=... -e SERVICE_ID=... loadtest/browse.js
```

| Script | Scenario | Pass criteria |
|---|---|---|
| `browse.js` | discover -> salon -> availability, ramps to 150 req/s | read p95 < 300 ms, error rate < 0.5 % |
| `hot-slot.js` | 500 virtual users hold the same staff/time | exactly one 201 (`slot_won == 1`), the rest `409 SLOT_TAKEN` with alternatives, no 5xx; then `npm run loadtest:check` prints zero overlaps |
| `auth-burst.js` | login and register burst | 429 with `Retry-After` when limits bite, never 5xx |
| `webhook-replay.js` | the same signed event delivered ~10x each | always 200 fast; one `subscription_events` row per event id |
| `day-in-life.js` | 150 req/s for 10 min, mixed browse/hold/confirm/salon reads | read p95 < 300 ms, hold p95 < 500 ms, error rate < 0.5 % |

Prepare the target server for the test: raise `RATE_LIMIT_REGISTER_PER_HOUR` (the scripts register customers in `setup()`), create a salon with one bookable staff member, a service and opening hours covering the start hour, and make sure `MAX_*` caps are at their defaults. Secrets (webhook secret, owner password) are passed with `-e` from your shell; nothing is stored in this folder. Record results (stage, instance size, numbers) in `docs/Architecture.md`.
