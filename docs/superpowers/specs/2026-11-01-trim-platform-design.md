# Trim Platform — Design Spec (v1)

Status: approved by owner in conversation on 2026-11-01. This file is the single source of truth. Every repo implements its part of it. If something here is wrong or ambiguous, make the smallest sensible call, record it in your repo's `docs/Architecture.md` under "Decisions", and keep going.

## 1. What Trim is
Trim is a salon booking and salon-operations platform, a product of the TokenBurners studio. (Internal note, never in public copy: the Razorpay account belongs to the owner personally.)

- **Customers** use a free Android app: find salons, get an on-device AI face-shape + hairstyle suggestion, book services, show a QR at the salon, pay the salon directly (cash/card/UPI), get a bill, leave a review.
- **Salons** pay Trim a subscription (2 tiers) and get a salon mobile app (daily work) and, on the Pro tier, a Windows desktop app (analytics, setup, staff, billing history).
- **Money rule:** Razorpay is used ONLY for salon subscriptions. Customer-to-salon payments happen at the salon; Trim only records the method on the bill. No customer online payments, no payouts, no refunds of service money.
- **Architecture goal:** keep the core generic (Business → Staff → Service(duration, price) → Calendar/Booking → Check-in → Invoice → Review) so it can be reused for other appointment businesses. Face-shape is a plug-in module on the customer side only.

Non-goals (v1): online customer payments, payouts/Route, AR try-on, multi-language, iOS release, SMS/OTP, GST tax invoices (the owner has no GSTIN; see §9), push-notification delivery (store tokens only).

## 2. Repos and stacks (all live under `C:\Users\GautamShah.AzureAD\Downloads\FL\Trim\`)
| Repo | Content | Stack |
|---|---|---|
| `Trim-BE` | REST API, SQL migrations, OpenAPI | Node 24, TypeScript, Express, `pg`, zod |
| `Trim-APK` | `customer/` (applicationId `com.tokenburners.trim`) and `salon/` (`com.tokenburners.trim.salon`) — two independent Flutter projects, NO shared package | Flutter 3.47 + GetX |
| `Trim-Desktop` | Salon desktop app | .NET 10, WPF, CommunityToolkit.Mvvm |
| `Trim-Website` | Marketing, owner registration, contact, pricing, downloads, policies, owner portal, admin console | Next.js (App Router) + TypeScript |

Separate languages on purpose. The API contract (§6, and `Trim-BE/openapi.yaml`) is the only coupling.

Git rules for every repo: work on branch `develop`, commit locally with meaningful messages, **NEVER `git push`**, never commit secrets (`.env`, keys). Repo-local git identity is already configured. Each repo must have: `README.md` (what/why/setup/run/test/structure), `docs/Architecture.md`, `docs/KT_Guide.md` (onboarding a new dev: how to run, where things are, how to add a feature, gotchas), `docs/CHANGELOG.md` (Keep-a-Changelog format, an `Unreleased` + `0.1.0` entry).

## 3. Brand (Trim has its OWN design system, separate from TokenBurners)
Reuse the old logo files: `C:\Users\GAUTAM~1.AZU\AppData\Local\Temp\claude\c--Users-GautamShah-AzureAD-Downloads-FL-Trim\8f543fb7-fafc-4f5a-96f6-dc2e6f0658d2\scratchpad\apk\assets\flutter_assets\asset\images\` (`Logo.png` 196x237 amber map-pin with white hair-flame, `Logo.svg`, `App_Name.svg` = black "trim" wordmark with amber accent). The old APK code is discarded; only these images (and the idea of `hairstyles.json`) are reused.

Initial tokens (design agent may refine but must keep names and publish final values to `Trim-Website/docs/design-tokens.json`; clients copy from there):
- `amber` #FFB808 (brand, fills, buttons — text on amber is `ink`, never white)
- `amber-deep` #8A5F00 (amber used as text/links on light surfaces, 5:1 on white)
- `ink` #1A1608, `ink-muted` #5E5640, `surface` #FFFFFF, `surface-warm` #FFF8E6, `line` #E7DEC4
- dark theme: `surface` #14110A, `surface-raised` #1F1A0F, `ink` #F7F1E1, `ink-muted` #BDB398, `line` #3A3322; `amber` stays #FFB808
- semantic: `success` #1F7A3E, `danger` #B3261E, `info` #1D5FA8 (each with a light-surface-safe pair)
- type: Plus Jakarta Sans (headings/UI), Inter (body), 8px spacing grid, radii 8/12/999.
Apps/website must support light and dark.

## 4. Roles, RBAC, tiers
**Platform roles (users.platform_role):** `customer`, `salon_user` (owner/staff of a salon), `admin`, `sales_agent`.
**Salon roles** (per salon, table `salon_roles` + `salon_role_permissions`; defaults seeded per salon; `is_system=true` ones can't be deleted):
`owner` (all), `manager`, `receptionist`, `stylist`. Pro tier may create custom roles; Starter uses the four system roles (permissions of the system roles can't be edited on Starter).

**Permission keys:** `booking.view`, `booking.create`, `booking.update`, `booking.cancel`, `checkin.scan`, `billing.view`, `billing.create`, `billing.void`, `services.view`, `services.edit`, `staff.view`, `staff.manage`, `roles.manage`, `analytics.view`, `settings.edit`, `payments.configure`, `reviews.reply`, `customers.view`.

Default grants: owner = all; manager = all except `roles.manage`, `payments.configure`... (give manager `payments.configure`, not `roles.manage`); receptionist = booking.*, checkin.scan, billing.view/create, services.view, customers.view; stylist = booking.view, checkin.scan, services.view.

Permissions are enforced **server-side** on every salon-scoped route. Clients only hide UI. The last active owner of a salon can't be deactivated or demoted. Staff are deactivated, never deleted.

**Tiers (seed data in `plans`, prices editable by admin; all money is integer paise):**
| | Starter | Pro |
|---|---|---|
| Price monthly / annual | ₹599 (59900) / ₹5,999 (599900) | ₹1,299 (129900) / ₹12,999 (1299900) |
| max_branches | 1 | 3 |
| max_staff | 3 | unlimited (null) |
| custom_roles | false | true |
| desktop_access | false | true |
| analytics_level | `basic` | `full` |
| csv_export | false | true |
| bill_templates | false | true |
| Trial | 14 days at Pro level (status `trialing`) | |
A founding offer is a coupon concept handled manually for now (admin can extend a salon's trial/`comp_until`).

Entitlement checks live in the API (`entitlements(salon)` helper) — never trust clients. Subscription states: `trialing`, `active`, `past_due` (7-day grace, still full access), `halted` / `expired` / `cancelled` → **read-only** (no new bookings/bills, salon hidden from customer discovery, existing confirmed bookings honoured, staff can still view and check in existing bookings and export data).

## 5. Data model (Postgres 15+, SQL migrations in `Trim-BE/migrations`, timestamps `timestamptz` UTC, ids `uuid` default `gen_random_uuid()`, money `integer` paise, soft-delete only where stated)
Extensions: `pgcrypto`, `btree_gist`, `citext`.

- `users` (id, phone_e164 unique nullable, email citext unique nullable, CHECK at least one, password_hash [argon2id], full_name, platform_role, is_active, failed_login_count, locked_until, created_at, updated_at)
- `sessions` (id, user_id, refresh_token_hash, family_id, device_label, expires_at, revoked_at, replaced_by, created_at) — refresh rotation with reuse detection (reuse of a revoked token revokes the whole family)
- `media` (id, owner_user_id, salon_id null, kind enum[logo,salon_photo,avatar,staff_photo], mime, byte_size, data_base64 text, sha256, created_at) — **base64 images live here only**; max 200 KB decoded, mimes jpeg/png/webp; list queries must never select `data_base64`
- `salons` (id, name, slug unique, description, phone, address_line, city, state, pincode, lat, lng, timezone default 'Asia/Kolkata', logo_media_id, brand_color, bill_footer, gstin null, gst_enabled bool default false, status enum[pending,approved,suspended], approved_by, approved_at, created_by, created_at)
- `salon_hours` (salon_id, weekday 0-6, opens, closes, is_closed) + `salon_closures` (salon_id, date, reason)
- `salon_staff` (id, salon_id, user_id, role_id, display_name, photo_media_id, speed_multiplier numeric default 1.0 CHECK 0.5–2.0, is_bookable bool, is_active, created_at) unique(salon_id,user_id)
- `staff_hours` (staff_id, weekday, start, end) optional override of salon hours; `staff_time_off` (staff_id, during tstzrange)
- `salon_roles` (id, salon_id, name, is_system), `salon_role_permissions` (role_id, permission)
- `service_templates` (id, category, name, audience enum[all,men,women,kids], default_duration_min, suggested_price_paise, sort) — gender-neutral starter catalog, seeded (Hair: haircut, kids haircut, hair wash & blow-dry, styling, hair colour, highlights, global colour, keratin/smoothening, hair spa, scalp treatment; Beard & shave: beard trim, beard styling, clean shave, moustache trim; Skin: cleanup, facial, de-tan, bleach, threading, waxing (arms/legs/full body); Nails: manicure, pedicure; Spa: head massage, body massage; Bridal/groom: bridal makeup, groom package; Combos)
- `salon_services` (id, salon_id, template_id null, category, name, description, audience, duration_min CHECK 5–480, buffer_min default 0, price_paise CHECK >=0, is_active, sort) — **each salon sets its own services, prices, durations**
- `staff_services` (staff_id, service_id) — which staff can do which service
- `bookings` (id, salon_id, customer_id null [walk-in], customer_name, customer_phone, staff_id, source enum[app,walk_in], status enum[held,confirmed,checked_in,completed,cancelled,no_show,expired], starts_at, ends_at, during tstzrange GENERATED, total_duration_min, total_price_paise, hold_expires_at, qr_nonce, version int default 0, cancelled_reason, created_at, updated_at, idempotency_key)
  - **`EXCLUDE USING gist (staff_id WITH =, during WITH &&) WHERE (status IN ('held','confirmed','checked_in'))`** — the DB itself refuses overlapping bookings for one staff member
  - unique(customer_id, idempotency_key) where key not null
- `booking_items` (booking_id, service_id, name_snapshot, duration_min, price_paise_snapshot, position)
- `invoices` (id, salon_id, booking_id null, invoice_no, customer_name, customer_phone, subtotal_paise, discount_paise, tax_paise default 0, total_paise, tax_label, gstin_snapshot, status enum[draft,paid,void], voided_reason, created_by, created_at) unique(salon_id, invoice_no); `invoice_items`; `invoice_payments` (invoice_id, method_code, amount_paise, reference, paid_at) — split payments allowed, sum must equal total to mark `paid`
- `invoice_counters` (salon_id pk, last_no) — incremented with `UPDATE … RETURNING` inside the invoice transaction (no gaps, no duplicates)
- `salon_payment_methods` (salon_id, code [cash,card,upi,wallet,bank_transfer,other], label, is_enabled, upi_id null, sort) — salons choose accepted methods
- `reviews` (id, booking_id unique, salon_id, customer_id, rating 1–5, comment ≤1000, status enum[visible,hidden,reported], reply_text, reply_by, reply_at, created_at) — only for bookings with status `completed` and own customer; salon rating aggregate maintained
- `review_reports` (review_id, reported_by, reason)
- `saved_looks` — NOT in DB (customers save suggested styles to their phone gallery)
- `hairstyle_catalog` (id, name, audience enum[men,women,unisex], face_shapes text[], length enum[short,medium,long], description, tags text[], image_media_id null, maintenance enum[low,medium,high]) seeded with ≥ 60 styles across Heart/Oblong/Oval/Round/Square, men + women + unisex; `hairstyle_service_map` (hairstyle_id, template_id) to link a style to bookable service templates
- `plans` (code unique [starter,pro], name, price_monthly_paise, price_annual_paise, razorpay_plan_id_monthly, razorpay_plan_id_annual, limits & feature columns per §4, is_active)
- `subscriptions` (id, salon_id unique, plan_code, interval enum[monthly,annual], status enum[trialing,active,past_due,halted,cancelled,expired], trial_ends_at, current_period_end, comp_until, razorpay_subscription_id unique null, cancel_at_period_end, created_at, updated_at)
- `subscription_events` (id, razorpay_event_id **unique**, type, payload jsonb, processed_at) — webhook idempotency
- `subscription_receipts` (id, salon_id, razorpay_payment_id **unique**, amount_paise, period_start, period_end, receipt_no, issued_at) — plain receipts, NOT tax invoices
- `contact_messages` (id, name, email, phone, salon_name, message, status enum[new,handled], assigned_to, created_at)
- `leads` (id, salon_name, owner_name, phone, email, city, source, stage enum[new,contacted,trial,subscribed,lost], owner_agent_id, notes, created_at) — used by sales agents
- `audit_log` (id, actor_user_id, salon_id null, action, entity, entity_id, meta jsonb, ip, created_at)
- `device_tokens` (user_id, token, platform, created_at) — stored only

Booking holds: selecting a slot creates a `held` booking with `hold_expires_at = now()+5min`; a sweeper (`setInterval` 30 s and also a lazy check on every availability query) flips expired holds to `expired`. The same exclusion constraint covers holds, so two people can never hold the same staff time.

## 6. API contract (REST, JSON, prefix `/v1`)
Conventions:
- Success: `{ "data": … , "meta"?: {…} }`. Error: `{ "error": { "code": "VALIDATION_FAILED", "message": "…", "details"?: [{ "field","issue" }] } }` with proper HTTP status. Codes: `VALIDATION_FAILED` 422, `UNAUTHENTICATED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409 (e.g. `SLOT_TAKEN`, `HOLD_EXPIRED`, `ALREADY_CHECKED_IN`, `VERSION_MISMATCH`), `PLAN_LIMIT` 402/403 (`details.limit`), `SUBSCRIPTION_INACTIVE` 403, `RATE_LIMITED` 429.
- Auth: `Authorization: Bearer <access JWT>` (15 min, HS256 with `JWT_SECRET`, claims `sub, role, sid`). Refresh tokens are opaque 256-bit random, stored hashed (sha-256), rotated on every refresh.
- Writes that create money-adjacent/booking state accept `Idempotency-Key` (uuid) header.
- Pagination: `?limit=20&cursor=<opaque>`; max 100. Money = integer paise. Times = ISO-8601 UTC strings. Phones = E.164 (`+91…`).
- All inputs validated with zod at the edge; DB CHECK/NOT NULL as the backstop. Rate limit: 10 login attempts/15 min per IP+identifier, lock account 15 min after 5 failures; general 300 req/min/IP.
- Salon-scoped routes: `/v1/salons/:salonId/...` — middleware loads membership + permissions and subscription entitlements.

### Auth & profile
| Method | Path | Notes |
|---|---|---|
| POST | /auth/register | customer sign-up: `{fullName, phone? , email?, password}` (≥8 chars, 1 letter+1 digit) |
| POST | /auth/register-owner | website: `{fullName, phone, email, password, salon:{name, city, …}}` → creates user (`salon_user`), salon `pending`, trial subscription (Pro level, 14d), owner role |
| POST | /auth/login | `{identifier, password, deviceLabel?, client: "customer_app"|"salon_app"|"desktop"|"website"}` → `{accessToken, refreshToken, user, memberships:[{salonId, salonName, roleName, permissions[]}]}`. `desktop` client requires an entitlement `desktop_access`, else 403 `PLAN_LIMIT` |
| POST | /auth/refresh | `{refreshToken}` rotate |
| POST | /auth/logout | revoke session; /auth/logout-all |
| POST | /auth/change-password | |
| GET/PATCH | /me | profile; PATCH avatar via media |
| POST | /me/device-token | store FCM token |
| DELETE | /me | customer account deletion (anonymise) |

### Media
POST `/media` (`{kind, mime, dataBase64, salonId?}`, ≤200 KB decoded, validates magic bytes) → `{id}`; GET `/media/:id` → raw bytes with `Content-Type`, `ETag`, `Cache-Control: public, max-age=86400` (public for logo/salon_photo/staff_photo kinds; avatars require auth). Lists return media **ids only**.

### Customer-facing
| GET | /discover/salons | `?lat&lng&radiusKm&q&category&minRating&sort=distance|rating&limit&cursor` — only `approved` + subscription active/trialing/past_due |
| GET | /discover/salons/:salonId | profile, hours, services (active), staff (bookable) with their service ids, rating, review count |
| GET | /discover/salons/:salonId/reviews | paged |
| GET | /salons/:salonId/availability | `?serviceIds=a,b&staffId?&date=YYYY-MM-DD` → `{slots:[{staffId, startsAt, endsAt}]}` computed from staff free gaps, total duration = Σ(duration×staff.speed_multiplier, rounded up to 5 min)+buffer, salon timezone aware, excludes held/confirmed times |
| POST | /bookings/hold | `{salonId, staffId, serviceIds[], startsAt}` + Idempotency-Key → `held` booking, `holdExpiresAt` (409 `SLOT_TAKEN` on exclusion violation) |
| POST | /bookings/:id/confirm | holds → `confirmed`, generates `qrToken` (see QR) ; 409 `HOLD_EXPIRED` |
| POST | /bookings/:id/cancel | customer cancel allowed ≥ 2 h before start (configurable per salon `cancel_cutoff_min`) |
| GET | /bookings | my bookings (`?status`), GET /bookings/:id (includes `qrToken` while confirmed) |
| POST | /bookings/:id/review | `{rating, comment?}` only when completed & mine; 409 if exists |
| GET | /hairstyles | `?faceShape=Oval&audience=men|women|unisex` ; GET /hairstyles/:id |

### Salon-scoped (permission in brackets)
- Salon profile: GET/PATCH `/salons/:salonId` [`settings.edit`; GET any member]; hours: GET/PUT `/salons/:salonId/hours`, closures CRUD [`settings.edit`]
- Services: GET `/service-templates` (any authed); CRUD `/salons/:salonId/services` [`services.edit`; GET `services.view`]; PUT `/salons/:salonId/staff/:staffId/services`
- Staff: GET `/salons/:salonId/staff` [`staff.view`]; POST (create staff account: `{fullName, phone|email, tempPassword, roleId}`; plan `max_staff` enforced → `PLAN_LIMIT`) / PATCH / POST `…/:staffId/deactivate` / `reactivate` [`staff.manage`]; staff hours + time off [`staff.manage`]
- Roles: GET `/salons/:salonId/roles` [`staff.view`], POST/PATCH/DELETE [`roles.manage` + `custom_roles` entitlement]; GET `/permissions`
- Bookings: GET `/salons/:salonId/bookings` `?date&staffId&status` [`booking.view`]; POST walk-in `/salons/:salonId/bookings` `{customerName, customerPhone?, staffId, serviceIds, startsAt}` creates `confirmed` with `source=walk_in` [`booking.create`]; PATCH reschedule with `version` (optimistic lock → 409 `VERSION_MISMATCH`) [`booking.update`]; POST `…/cancel`, `…/no-show` [`booking.cancel`/`booking.update`]; POST `/salons/:salonId/checkin` `{qrToken}` [`checkin.scan`] → atomically `confirmed → checked_in` (`UPDATE … WHERE status='confirmed' AND salon_id=$ AND qr_nonce=$ RETURNING`; second scan → 409 `ALREADY_CHECKED_IN`; wrong salon → 403; outside window [starts_at−30min, ends_at+60min] → 409 `OUT_OF_WINDOW`); POST `…/bookings/:id/complete` [`booking.update`]
- Billing: POST `/salons/:salonId/invoices` `{bookingId?, customerName, customerPhone?, items[{serviceId?, name, qty, unitPricePaise}], discountPaise, payments[{methodCode, amountPaise, reference?}]}` [`billing.create`] (server recomputes totals; payment methods must be enabled for the salon; idempotent via key; if bookingId given the booking is marked `completed`); GET list/detail [`billing.view`]; POST `…/void` `{reason}` [`billing.void`]; invoice numbers `<PREFIX>-<YYYY>-<NNNNNN>` from the counter. If `gst_enabled` and salon has gstin, tax lines may be added by the salon (`taxRatePct` per invoice) — default off.
- Payment methods: GET/PUT `/salons/:salonId/payment-methods` [`payments.configure`]
- Reviews: GET `/salons/:salonId/reviews`, POST `…/:reviewId/reply` [`reviews.reply`]; customers can report via POST `/reviews/:id/report`
- Customers CRM: GET `/salons/:salonId/customers` (derived from bookings/invoices) [`customers.view`], detail with history
- Analytics: GET `/salons/:salonId/analytics/summary?from&to` [`analytics.view`; `basic` = counts of bookings/completed/no-shows/revenue total; `full` adds per-service, per-staff, hourly heat map, repeat-customer rate, daily series], GET `…/analytics/export.csv` [`analytics.view` + `csv_export`]
- Subscription (owner only, via `settings.edit`+owner): GET `/salons/:salonId/subscription` (plan, status, limits, usage, period end, receipts), POST `/salons/:salonId/subscription/checkout` `{planCode, interval}` → creates Razorpay Subscription, returns `{razorpaySubscriptionId, keyId}` for Razorpay Checkout; POST `…/subscription/cancel` (`cancel_at_period_end`); GET `…/subscription/receipts`

### Public / website / admin
- GET `/plans` (public); POST `/contact` (public, rate-limited, honeypot field `website` must be empty)
- POST `/webhooks/razorpay` — verify `X-Razorpay-Signature` with `RAZORPAY_WEBHOOK_SECRET` over the raw body; insert into `subscription_events` (unique `razorpay_event_id`; duplicate → 200 no-op) then apply: `subscription.authenticated/activated/charged/pending/halted/cancelled/completed`, `payment.failed` → update `subscriptions`, insert `subscription_receipts` on `charged`. Webhook is the source of truth; never trust a client-side success callback — after Checkout the client just polls GET subscription.
- Admin (`admin` role): GET/PATCH `/admin/salons` (approve/suspend; approving sets `approved`), GET `/admin/salons/:id`, PATCH `/admin/plans/:code` (prices/limits), POST `/admin/salons/:id/comp` `{until}`, GET `/admin/contact-messages` + PATCH, GET `/admin/users`, GET `/admin/stats`, GET `/admin/audit`, hairstyle catalog CRUD, user management of `sales_agent`s.
- Sales agent (`sales_agent` or `admin`): CRUD `/sales/leads`, POST `/sales/leads/:id/invite` (creates a salon-owner invite code to the website register page prefilled), GET `/sales/pipeline`.

### QR token
`qrToken` = compact signed token `base64url(payload).base64url(hmac_sha256(QR_SECRET, payload))`, payload `{b: bookingId, s: salonId, n: qr_nonce, e: exp}` with `exp = ends_at + 60 min`. The QR encodes the token string. The nonce is stored on the booking and rotated on reschedule so old QRs die.

## 7. Concurrency and validation rules (must all be implemented AND tested)
1. Double-booking: only via the exclusion constraint. A test spawns ≥ 50 parallel `hold` requests for the same staff/time and asserts exactly 1 succeeds, others get `SLOT_TAKEN`. Partially-overlapping ranges also tested.
2. Hold expiry frees the slot; confirming an expired hold → `HOLD_EXPIRED`.
3. `Idempotency-Key` on hold, confirm, invoice create, subscription checkout: same key + same body → same response; same key + different body → 422.
4. Check-in is an atomic conditional update; a parallel double scan yields one success.
5. Invoice numbering via `invoice_counters` in the same transaction; a parallel test creating 30 invoices asserts contiguous unique numbers.
6. Optimistic `version` on booking updates.
7. Webhook replay: same `razorpay_event_id` twice changes state once; out-of-order events are handled by comparing event `created_at`.
8. Plan limits enforced inside a transaction with a row lock on the salon (`SELECT … FOR UPDATE`) so two parallel "add staff" calls can't exceed `max_staff`.
9. Validation: reject unknown fields, trim strings, E.164 phones, prices ≥ 0 and ≤ ₹1,00,000 (10_000_000 paise), duration 5–480, rating 1–5, comment ≤ 1000, image mime/magic/size, date ranges (no past holds; booking max 60 days ahead), payment sums equal invoice total.

## 8. Clients — responsibilities
**Customer app (`Trim-APK/customer`, GetX, min SDK 24):** splash → onboarding → login/signup → home (nearby salons, search, categories) → salon detail (services, staff, reviews, photos) → book flow (services → staff → date/time slots → review → hold countdown → confirm) → booking QR screen (brightness boost, big QR) → my bookings (upcoming/past, cancel) → leave review prompt after completion → profile (avatar via media, change password, delete account) → **Style Studio**: camera/gallery photo → on-device face landmarks → face shape + confidence + quality gate (single face, frontal, lit) + user override → hairstyle suggestions (filter men/women/unisex) → "Save look to gallery" (render a shareable image card with the style and save to the phone gallery with the `gal` package, asks permission) → "Book this style" (shows salons offering the mapped services). Photos never leave the device. Face-shape logic: ML Kit face mesh/landmarks → ratios (face length / cheekbone width, jaw width / cheekbone, forehead / cheekbone, jaw-angle proxy) → rule-based classifier for Oval, Round, Square, Heart, Oblong, kept in a pure Dart class `FaceShapeClassifier` with unit tests over synthetic landmark fixtures; clearly labelled "suggestion, not a guarantee". Offline-tolerant: cache the hairstyle catalog.
**Salon app (`Trim-APK/salon`):** login (staff or owner) → role-aware home (today's queue, next up) → QR scanner (`mobile_scanner`) with clear success/duplicate/wrong-salon/out-of-window states and a manual code fallback → walk-in booking → bookings list/day view, reschedule/cancel/no-show/complete → quick bill (services, discount, payment method(s) from the salon's enabled list, share PDF via system share sheet) → services & prices (from template or custom) → staff list (add/deactivate, role assign — per permissions) → payment methods → salon profile & logo → reviews and replies → subscription status banner + "read-only" mode UI + link to website to manage plan → settings. All UI gated by the permission list returned at login; every server 403 handled gracefully.
**Desktop (`Trim-Desktop`, WPF):** login (needs Pro) → dashboard (KPIs, charts) → analytics (date range, per service/staff/hour, repeat rate, CSV export) → bookings calendar (day/week by staff) with drag-less actions → billing (create, history, void, print/PDF with salon logo and footer via QuestPDF, printable thermal-width layout optional) → services & prices → staff & RBAC editor (custom roles & permission matrix) → payment methods → salon branding (logo, colour, footer, optional GSTIN toggle) → customers CRM → reviews → subscription page (status, receipts, link to website to change plan). USB barcode/QR scanner support: a focused "scan" box that accepts keyboard-wedge input and calls `/checkin`.
**Website (`Trim-Website`):** Home (hero, how it works for customers and salons, feature grid, screenshots placeholders), For salons (features, Starter vs Pro), Pricing (reads `/plans`, monthly/annual toggle, founding-salon note), Register (owner + salon → `/auth/register-owner`), Login → owner portal (`/portal`: salon status [pending approval/approved], subscription + Razorpay Checkout button using `checkout.js`, receipts, downloads for Salon APK, Customer APK, Desktop installer — links come from env/JSON `downloads.json`, never hard-coded binaries), Contact (→ `/contact`), Download page, legal: **Trim does not write its own Privacy Policy, Terms or Cookies pages. It links directly to the TokenBurners ones** — Privacy Policy `https://tokenburners.co.in/legal/privacy-policy`, Terms of Use `https://tokenburners.co.in/legal/terms-of-use`, Cookies Notice `https://tokenburners.co.in/legal/cookies-notice` (footer, register/checkout consent text, apps' About/Legal screens; open in a new tab/external browser; keep the URLs in ONE config constant per repo). Trim keeps only short product notices on its own site, written in the TokenBurners voice: Refund & Cancellation for subscriptions, Payments notice (Trim does not process customer-to-salon payments), AI suggestion notice (suggestion, not a guarantee; face photos are processed on the customer's device and not uploaded), Review guidelines. Branding: Trim is presented as **a TokenBurners product** (footer "A TokenBurners product" linking to tokenburners.co.in); contact email connect@tokenburners.co.in. **Never write an individual's name, "sole proprietor" or "trading as" anywhere public**, and never claim a registered company; say only "Trim by TokenBurners". GST wording: "Receipts issued; Trim is not GST-registered at this time." Admin console `/admin` (admin/sales_agent roles): salons approval queue, plans & pricing editor, contact inbox, leads/pipeline with invite generation, stats. Static marketing pages must be SSG, fast, accessible (WCAG AA), responsive, light/dark, with SEO metadata + sitemap + OG image. Deploy config for Vercel included; **do not deploy**. Domain target: a TokenBurners subdomain (`trim.tokenburners.co.in`) — configure via env `NEXT_PUBLIC_SITE_URL`.

## 9. Legal/ops notes (drafts only; owner must have a lawyer review before launch)
- Privacy Policy, Terms of Use and Cookies come from the TokenBurners site (linked, not copied). The short Trim notices (refund/cancellation, payments, AI suggestion, reviews) are drafts; `docs/LEGAL_TODO.md` lists what to confirm: whether the TokenBurners policies need a Trim/face-photo/subscription section (they don't mention these today and the site has no refund policy, which Razorpay activation needs), GST threshold with a CA, DPDP consent wording, cold-email/WhatsApp consent rules.
- Subscriptions issue **plain receipts**, never "tax invoice".
- Secrets via env only: `DATABASE_URL, JWT_SECRET, QR_SECRET, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET, CORS_ORIGINS, PORT`. Provide `.env.example`. Razorpay account is the owner's personal account shared with another product → the API must namespace everything (notes `{app:"trim", salonId}`), and `scripts/create-razorpay-plans.ts` creates the 4 plans (starter/pro × monthly/annual) from `plans` in the DB using the owner's test keys when they run it.
- Free-tier infra for now: Supabase free Postgres used as plain Postgres (API connects with `DATABASE_URL`; clients never talk to Supabase); keep-alive + nightly `pg_dump` GitHub Actions workflows are provided in `Trim-BE/.github/workflows/` (inactive until pushed). Base64 media keeps the DB small via the 200 KB cap.

## 10. Definition of done for the first build
Every repo: builds clean, runs locally, has tests where logic exists (BE: unit + concurrency tests against a real Postgres; customer app: classifier + controller tests; desktop: ViewModel/service tests; website: build + lint + a11y smoke), README + docs trio, local commits on `develop`, no push, no secrets. The BE exposes `openapi.yaml` that matches §6; clients code against §6 and use a swappable API base URL. §11 (scale and resilience) is a second-pass hardening of the backend and applies on top of this.

## 11. Scale, caching, rate limiting, queues and slot contention (added 2026-11-04)
Goal: behave correctly at 1k requests/day and stay correct, and fast, up to ~1M requests/day. **Correctness never depends on cache, Redis or the queue**: the database constraints in §5/§7 are the only authority; everything here is an optimisation or protection layer.

### 11.1 Capacity model (planning numbers, to be confirmed by load tests, not guarantees)
- 1k/day is trivial. 1M/day is about 12 req/s on average; plan for a peak of roughly 10–15x, so 120–180 req/s. About 90% is reads (discover, salon profile, availability); writes (holds, confirms, check-ins, invoices) are fewer but are where contention lives.
- A single stateless Node instance can serve that read load if the database is not hit for every request. The real bottlenecks are DB connections, hot rows (popular salon/slot) and cold-start/sleeping free tiers.
- **Free tiers (Supabase free, Render free) are for development and the first few salons only.** Realistic upgrade path: Stage A → B → C below. Costs are the owner's call.
| Stage | Load | Shape |
|---|---|---|
| A | up to ~10k req/day | 1 API instance (`WORKER_MODE=both`), in-memory cache + limiter behind interfaces, Postgres job queue |
| B | ~100k req/day | 2+ API instances + 1 worker, Redis (managed key-value) for cache and limits, Supabase Pro with the transaction pooler, CDN in front of public GETs |
| C | ~1M req/day | autoscaled API instances, separate worker, Redis, CDN, read replica for analytics/search, partitioned big tables, rollup tables |
All three run the same code; the stage is chosen by environment variables.

### 11.2 Caching (interface `Cache` with `MemoryCache` and `RedisCache`)
- Never cache anything user-specific or permission-dependent across users; cache keys for authenticated reads include the user id.
- Cache-aside with **request coalescing (single-flight)** so one miss triggers one DB query, plus jittered TTLs and stale-while-revalidate to avoid stampedes.
- Targets and TTLs: plans 1 h; service templates and hairstyle catalog 24 h; public salon profile/services/staff 60–300 s with **version-key invalidation** (`salon:{id}:v` bumped by any salon/service/staff/hours mutation); discovery search results 30–60 s keyed by geohash cell + filters; per-staff free-gap data for availability 5–10 s (the final answer is always re-verified by the DB constraint at hold time); entitlements 30 s with explicit invalidation on subscription webhooks and admin changes; session/permission lookups 30–60 s with invalidation on role or staff change.
- HTTP caching: `ETag` + `Cache-Control` (`public, max-age`, `stale-while-revalidate`) on public GETs and media; honour `If-None-Match` (304). Media bytes are served with long cache headers so a CDN absorbs them.
- Cache failure = fall through to the DB (never fail the request because Redis is down).

### 11.3 Rate limiting and abuse protection (`RateLimiter` with memory and Redis sliding-window/token-bucket)
- Layers: global per-IP; per-user; per-route; per-salon for write bursts. Correct client IP via configured `trust proxy`.
- Defaults (all env-configurable): login 10/15 min per IP+identifier and account lockout (already in §6); register 5/hour per IP; `/contact` 5/hour per IP + honeypot; availability 60/min per user; booking hold 10/min per user; check-in 120/min per salon; general 300/min per IP. Razorpay webhook is exempt from limits but signature-verified.
- Responses: `429 RATE_LIMITED` with `Retry-After` and `RateLimit-*` headers. **Clients must back off with jitter and honour `Retry-After`.**
- Slot-hoarding limits: max 3 concurrent `held` bookings per customer, max 10 upcoming confirmed bookings per customer, max 5 bookings created per day per customer; excess → `422`/`409` with a clear code.
- Hard limits: JSON body 100 KB (media upload route 400 KB), request timeout 15 s, per-query `statement_timeout` 5 s, `lock_timeout` 2 s, `idle_in_transaction_session_timeout` 10 s.

### 11.4 Validation (everything in §7.9 plus)
Central zod schemas per route; reject unknown fields; canonicalise (trim, case-fold emails, E.164 phones); enforce length/range caps on every string and array (e.g. ≤ 20 service ids per booking); validate path/query ids as UUIDs; keyset pagination only (no unbounded `OFFSET`); responses validated against `openapi.yaml` in contract tests; all SQL parameterised; file uploads checked by magic bytes and decoded size; errors never leak internals.

### 11.5 Many users picking the same slot (hot-slot design)
1. Availability is advisory. The **only** thing that wins a slot is one atomic `INSERT` of the `held` booking guarded by the exclusion constraint; no read-then-write anywhere.
2. The loser gets an immediate `409 SLOT_TAKEN` (constraint violation mapped; never blocks). The 409 body includes `details.alternatives`: the next ≤ 3 free start times for the same staff/service set, so the app can offer one tap re-booking.
3. Transactions are short and contain no external calls. On deadlock/serialization errors (`40P01`, `40001`) retry up to 2 times with jittered backoff, then return `409`/`503`.
4. Optional fast-fail: a short-lived Redis `SET NX` on `(staff, startsAt)` rejects obvious duplicates before they reach the DB; it is an optimisation and is not trusted for correctness. Without Redis it is skipped.
5. Holds expire by predicate (`hold_expires_at < now()` treated as free in queries and in a lazy cleanup) so correctness does not depend on the sweeper; the sweeper job (§11.6) tidies state with `FOR UPDATE SKIP LOCKED`.
6. Per-user caps (§11.3) stop one user hoarding slots; idempotency keys make client retries safe.
7. Confirm, cancel, check-in and invoice creation stay single conditional `UPDATE … WHERE status=…` operations, safe under any concurrency.

### 11.6 Background jobs / queueing
- **Choice: a Postgres-backed queue (`pg-boss`)**: no extra infrastructure, transactional with business writes, `SKIP LOCKED`, retries with backoff, dead-letter, cron scheduling. Revisit BullMQ + Redis only if load tests show queue throughput is a bottleneck. Queue interface (`JobQueue`) keeps this swappable.
- Jobs: **Razorpay webhook processing** (the endpoint verifies the signature, stores the event idempotently, returns `200` immediately; a worker applies it); hold-expiry sweep (every 30 s); notifications (email/push, stored-token delivery later); contact-message email; nightly analytics rollups into `daily_salon_stats`; large CSV/analytics exports (`POST …/analytics/export` → `202 {jobId}` → `GET …/jobs/:id`; small exports stay synchronous); audit-log retention.
- Process model: one codebase, `WORKER_MODE=api|worker|both`. Workers are idempotent; jobs have max attempts and are visible on an admin queue-health endpoint.
- Bounded queues and backpressure: if queue depth exceeds a limit the API sheds non-critical work (never bookings/check-ins).

### 11.7 Database for scale
- Pooler: connect through the Supabase transaction pooler in Stage B/C (no session-level features, prepared statements off); `DB_POOL_MAX` per instance = pooler limit ÷ instances.
- Indexes (verify with `EXPLAIN`): `bookings(salon_id, starts_at)`, `bookings(customer_id, starts_at DESC)`, `bookings(staff_id, starts_at)` plus the exclusion GiST index, `invoices(salon_id, created_at DESC)`, `reviews(salon_id, created_at DESC)`, `sessions(user_id)`, partial indexes on active rows.
- Discovery: PostGIS (`geography` + GiST) or geohash column with bounding-box prefilter; never compute haversine over the whole table.
- Rollups: `daily_salon_stats` (per salon/day/service/staff) so analytics don't scan raw bookings; partition `audit_log` and old `bookings` by month in Stage C; read replica for analytics/search when needed.
- Media: base64 stays in `media` (owner decision) but reads are CDN-cached and never in list queries; if media traffic grows, moving to object storage is a documented later option.

### 11.8 Resilience and observability
Graceful shutdown (drain), `/health` (liveness) and `/ready` (DB + queue + cache), circuit breaker + timeouts + retries (idempotent) around Razorpay, load shedding with `503` when event-loop lag or pool wait exceeds thresholds, request ids, structured logs (pino), `/metrics` (Prometheus text: rps, latency histograms, error rate, DB pool wait, queue depth, cache hit ratio, `SLOT_TAKEN` rate, 429 rate), error tracking hook (Sentry-compatible), documented alerts.

### 11.9 Load testing (in `Trim-BE/loadtest`, k6 scripts; not run in CI)
Scenarios: browse-heavy mix (discover → salon → availability), **hot-slot stampede** (500 virtual users, one slot: exactly 1 winner; after the run an invariant query asserts zero overlapping active bookings), login/register burst, webhook replay, mixed day-in-the-life at 150 req/s for 10 min. Targets to confirm, not promises: read p95 < 300 ms, hold p95 < 500 ms, error rate < 0.5%, zero double-bookings, no 5xx from contention. Results go in `docs/Architecture.md` with the stage they were measured on.

### 11.10 New config (add to `.env.example` and README; defaults keep Stage A working with no Redis)
`REDIS_URL` (optional), `CACHE_DRIVER=memory|redis`, `RATE_LIMIT_DRIVER=memory|redis`, `RATE_LIMIT_*` overrides, `CACHE_TTL_*` overrides, `DB_POOL_MAX`, `STATEMENT_TIMEOUT_MS`, `LOCK_TIMEOUT_MS`, `QUEUE_ENABLED`, `WORKER_MODE`, `TRUST_PROXY`, `METRICS_ENABLED`.

### 11.11 Contract changes for clients (announce in every repo's CHANGELOG)
`429` handling with `Retry-After` and jittered backoff; `409 SLOT_TAKEN` may carry `details.alternatives[{staffId, startsAt, endsAt}]` and the booking UIs should offer them; send `If-None-Match` on GETs where easy; never poll availability faster than every 10 s and prefer refresh-on-focus; show the hold countdown from the server's `holdExpiresAt`; analytics export may return `202 {jobId}`; new caps on active holds/bookings (§11.3) with clear error codes.

### 11.12 Honest limits
These measures make the design capable of 1M requests/day, but it only becomes true after the load tests pass on the paid stage (Supabase Pro, an always-on host, Redis). On free tiers expect cold starts and connection limits. Numbers in this section are planning targets.
