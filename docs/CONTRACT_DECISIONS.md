# Contract decisions (shapes the spec left open)

`openapi.yaml` is the authority. Every response payload below is defined in `src/schemas.ts`, converted into `openapi.yaml` by `npm run openapi`, and checked against real responses by `tests/contract.test.ts` (strict: an extra or missing key fails the test). If this file and `openapi.yaml` ever disagree, `openapi.yaml` wins and this file is a bug.

Envelope: success `{ "data": ..., "meta"?: ... }`; error `{ "error": { "code", "message", "details"?, "reason"? } }`. Money is integer paise, times ISO-8601 UTC, phones E.164. Lists with `meta.nextCursor` (null when finished) take `?limit=` (max 100) and `?cursor=` (opaque). Discover uses an opaque offset cursor, everything else keyset.

## Errors

| HTTP | `code` | notes |
|---|---|---|
| 422 | `VALIDATION_FAILED` | `details: [{field, issue}]`; unknown body fields are rejected (`issue: "unknown field"`); also bad JSON and 413 oversize bodies |
| 401 | `UNAUTHENTICATED` | also invalid webhook signature |
| 403 | `FORBIDDEN` | `reason` = the missing permission key (e.g. `billing.void`), or `WRONG_SALON`, `SYSTEM_ROLE`, `OWNER_ROLE_LOCKED` |
| 404 | `NOT_FOUND` | |
| 409 | `SLOT_TAKEN`, `HOLD_EXPIRED`, `ALREADY_CHECKED_IN`, `VERSION_MISMATCH`, `OUT_OF_WINDOW` | specific codes. `SLOT_TAKEN.details.alternatives: [{staffId, startsAt, endsAt}]` (next <= 3 free starts for the same staff and services). `VERSION_MISMATCH.details.currentVersion` |
| 409 | `CONFLICT` | `reason` is stable, see table below |
| 403 | `PLAN_LIMIT` | `details: {limit, max?, current?}` where `limit` is `max_staff`, `custom_roles`, `desktop_access`, `csv_export`, `bill_templates` |
| 403 | `SUBSCRIPTION_INACTIVE` | the salon is read-only (trial over, halted, cancelled, expired, suspended) |
| 429 | `RATE_LIMITED` | headers `Retry-After` (seconds), `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`. `details.retryAfterSec`. Locked account: `details.lockedUntil` |
| 503 | `OVERLOADED` | load shedding of optional reads; `Retry-After: 5` |
| 504 | `TIMEOUT` | request exceeded `REQUEST_TIMEOUT_MS` (15 s) |
| 500 | `INTERNAL` | message quotes the request id |

`error.reason` values (stable, clients may switch on them):

| reason | status | meaning |
|---|---|---|
| `WRONG_SALON` | 403 | check-in QR belongs to another salon |
| `QR_OUTDATED` | 409 | booking was rescheduled; the old QR is dead |
| `CANCEL_CUTOFF` | 409 | customer cancel is too late; `details.cutoffMin` |
| `HOLD_LIMIT` | 409 | customer already has the max active holds (default 3); `details {limit, current}` |
| `UPCOMING_LIMIT` | 409 | max upcoming confirmed bookings (default 10) |
| `DAILY_LIMIT` | 409 | max bookings created in 24 h (default 5) |
| `INVALID_STATE` | 409 | action not allowed in the booking/subscription's current status |
| `TOO_EARLY` | 409 | no-show before the start time |
| `LAST_OWNER` | 409 | cannot deactivate/demote the last active owner |
| `REVIEW_EXISTS`, `NOT_COMPLETED`, `ALREADY_REPORTED` | 409 | review rules |
| `ALREADY_SUBSCRIBED`, `PLAN_NOT_CONFIGURED` | 409 | checkout rules |
| `PHONE_TAKEN`, `EMAIL_TAKEN`, `ACCOUNT_EXISTS` | 409 | duplicate account |
| `INVOICE_EXISTS`, `ALREADY_VOID` | 409 | billing rules |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | same Idempotency-Key still running; retry shortly |
| `DUPLICATE_CLOSURE`, `ROLE_NAME_TAKEN`, `ROLE_IN_USE`, `PHOTO_LIMIT`, `NAME_TAKEN`, `SELF_CHANGE`, `NOT_READY` | 409 | other uniqueness/state rules |

The same list is in `openapi.yaml` (`x-error-reasons` and the `Error.reason` enum). New reasons are additive.

## Auth and profile
- `POST /auth/register`, `/auth/register-owner`, `/auth/login` return `AuthResult`: `{accessToken, refreshToken, expiresIn, user, memberships[], salon?}`. `salon` only on register-owner. `register-owner` accepts an optional `inviteCode` (sales invite): an unknown, used or expired code is a 422 on field `inviteCode`; a valid one moves the lead to `trial`.
- `memberships[]`: `{salonId, salonName, salonStatus, staffId, roleId, roleName, permissions[], planCode, subscriptionStatus, readOnly, desktopAccess}` (the four fields clients need first are `salonId, salonName, roleName, permissions`).
- `GET /me` returns `{user, memberships[]}` (same membership objects). `PATCH /me` returns `User`.
- `POST /auth/refresh` returns `{accessToken, refreshToken, expiresIn}`.

## Subscription view (`GET /salons/:id/subscription`, owner only)
`{planCode, interval, status, trialEndsAt, currentPeriodEnd, compUntil, cancelAtPeriodEnd, razorpaySubscriptionId, paymentMethodAuthorized, nextChargeAt, entitlements, limits, usage{activeStaff, customRoles}, recentReceipts[]}`.
- `entitlements`: `{planCode, status, readOnly, graceEndsAt, limits}`. `status` is the effective status (adds `comped`). `planCode` is the plan whose limits apply right now (Pro during a trial).
- **Paying during the trial:** Razorpay Checkout authorises the mandate and schedules the first charge for the end of the trial; the first `subscription.activated`/`charged` only arrives then. The webhook `subscription.authenticated` therefore sets `paymentMethodAuthorized: true` and `nextChargeAt` (Razorpay `charge_at`/`start_at`) while `status` stays `trialing`. The portal should treat `paymentMethodAuthorized && status in (trialing, active)` as "payment set up". Cleared on `cancelled`, `halted`, `completed` and on a new checkout.
- `POST .../subscription/checkout {planCode, interval}` returns `{razorpaySubscriptionId, keyId}`; poll the view afterwards. `POST .../subscription/cancel` returns the view. `GET .../subscription/receipts` returns `Receipt[]`: `{id, receiptNo, amountPaise, periodStart, periodEnd, razorpayPaymentId, issuedAt, kind:"receipt"}`.

## Analytics (`GET /salons/:id/analytics/summary?from&to`, dates are salon-local `YYYY-MM-DD`)
`{level: "basic"|"full", range{from,to,timezone}, totals{bookings, completed, noShows, cancelled, revenuePaise, invoices}}` plus, only for `full`: `byService[{name, qty, revenuePaise}]`, `byStaff[{staffId, displayName, bookings, completed, noShows, revenuePaise}]`, `hourlyHeatMap[{weekday 0=Sun, hour 0-23, bookings}]` (sparse: empty cells are absent), `repeatCustomers{customers, repeat, rate}`, `repeatCustomerRate` (same as `rate`, 0..1), `dailySeries[{date, bookings, completed, revenuePaise}]` (one row per day, zeros included). Past days of `dailySeries` come from the `daily_salon_stats` rollup when complete, otherwise computed live; today is always live.
- CSV: `GET .../analytics/export.csv` is synchronous for ranges up to 92 days (invoice rows, formula-injection safe). Longer ranges answer `202 {data:{jobId,status:"queued"}}`. `POST .../analytics/export {from?,to?}` always starts a job. `GET .../jobs/:jobId` returns `{id, kind, status: queued|running|done|failed, error, createdAt, finishedAt, downloadPath}`; `GET .../jobs/:jobId/download` returns the CSV once `done` (409 `NOT_READY` before).

## Other shapes
- **Payment methods:** `GET /payment-methods` (any member) returns `[{code, label, isEnabled, upiId, sort}]`. `PUT` body `{methods:[{code, label?, isEnabled, upiId?}]}` upserts by `code` (cash, card, upi, wallet, bank_transfer, other); at least one must stay enabled; response is the full list.
- **Roles:** `GET /roles` returns `[{id, name, isSystem, permissions[], memberCount}]`; `POST {name, permissions[]}`; `PATCH {name?, permissions?}`; `DELETE`. Staff role change: `PATCH /staff/:staffId {roleId}`; create: `POST /staff {fullName, phone|email, tempPassword, roleId, displayName?, speedMultiplier?, isBookable?, serviceIds?}`. `GET /permissions` returns `[{key, description}]`.
- **Staff:** `{id, userId, displayName, fullName, roleId, roleName, photoMediaId, speedMultiplier, isBookable, isActive, serviceIds[], createdAt}` plus `phone`/`email` only for callers with `staff.manage`. A staff member with an empty `serviceIds` performs all services.
- **Customers (CRM):** list item `{id, name, phone, customerId, bookings, visits, noShows, lastVisitAt, totalSpentPaise}`. `id` is the phone (E.164) or `name:<lower-case name>` for phone-less walk-ins; use `encodeURIComponent(id)` in `GET /customers/:customerKey`, which returns `{id, name, phone, bookings[{id,status,startsAt,totalPricePaise,staffName}], invoices[{id,invoiceNo,totalPaise,status,createdAt}]}`.
- **Reviews:** salon list item `{id, bookingId, rating, comment, status, customerName (first name), replyText, replyAt, createdAt}`. Reply body is `{replyText}` (<= 1000 chars) and returns the same item; report body is `{reason}`. Public list item omits `bookingId` and `status`. A customer review (`POST /bookings/:id/review {rating, comment?}`) returns `{id, bookingId, rating, comment, status, createdAt}`.
- **Bookings:** `{id, salonId, salonName, customerId, customerName, customerPhone, staffId, staffName, source, status, startsAt, endsAt, totalDurationMin, totalPricePaise, holdExpiresAt, version, cancelledReason, items[{serviceId,name,durationMin,pricePaise}], hasReview, createdAt, qrToken?}`. `qrToken` only on the customer's confirm / GET while `confirmed`. Reschedule body `{version, startsAt, staffId?}`.
- **Availability:** `{date, timezone, slots[{staffId, startsAt, endsAt}]}` (15 minute grid). It is advisory: only the hold decides. Do not poll faster than every 10 s.
- **Admin:** `GET /admin/stats` -> `{customers, salons{total,pending,approved}, subscriptions{active,trialing,troubled}, bookingsLast30Days, newContactMessages, subscriptionReceiptsLast30DaysPaise, leads}`. `GET /admin/salons` items are salons plus `subscription{status,planCode,trialEndsAt,compUntil}` and `owner{name,email,phone}`. `POST /admin/salons/:id/comp {until: ISO|null}` -> `{salonId, compUntil, trialEndsAt, status, planCode}`. `GET /admin/queue` -> `{driver, depth, maxDepth, workerMode, jobs[], unprocessedWebhookEvents}`.
- **Sales:** lead `{id, salonName, ownerName, phone, email, city, source, stage, ownerAgentId, notes, createdAt, updatedAt}`; `GET /sales/pipeline` -> `{stages[{stage,count}], total}`; `POST /sales/leads/:id/invite` -> `{code, url, expiresAt}` (url = `<WEBSITE_URL>/register?invite=<code>`); `GET /invites/:code` (public) -> `{salonName, ownerName, phone, email, city}`.
- **Webhook ack:** `200 {data:{received:true, result:"queued"|"duplicate"}}`. The event is applied by a worker shortly after.
- **HTTP caching:** public GETs (`/plans`, `/hairstyles`, `/discover/*`, salon profile, public reviews) carry `ETag` + `Cache-Control: public, max-age, stale-while-revalidate`; send `If-None-Match` to get `304`. Media has a SHA-256 ETag and a 1-day cache.
