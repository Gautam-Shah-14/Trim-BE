import { z, type ZodType } from 'zod';

/**
 * Response payload schemas (the `data` member). These are the AUTHORITATIVE shapes: openapi.yaml is generated from them and
 * tests/contract.test.ts validates real responses against them, so a DTO change that is not reflected here fails the build.
 */
const s = z.strictObject;
const str = z.string();
const nstr = z.string().nullable();
const int = z.number().int();
const nint = z.number().int().nullable();
const num = z.number();
const nnum = z.number().nullable();
const bool = z.boolean();
const id = z.string();
const nid = z.string().nullable();
const ts = z.string().describe('ISO-8601 UTC timestamp');
const nts = ts.nullable();
const strs = z.array(z.string());
const arr = <T extends ZodType>(t: T) => z.array(t);

const User = s({ id, fullName: str, phone: nstr, email: nstr, role: z.enum(['customer', 'salon_user', 'admin', 'sales_agent']), avatarMediaId: nid, mustChangePassword: bool });
const Membership = s({
  salonId: id, salonName: str, salonStatus: z.enum(['pending', 'approved', 'suspended']), staffId: id, roleId: id, roleName: str, permissions: strs,
  planCode: str, subscriptionStatus: str, readOnly: bool, desktopAccess: bool,
});
const AuthTokens = s({ accessToken: str, refreshToken: str, expiresIn: int });
const AuthResult = s({ accessToken: str, refreshToken: str, expiresIn: int, user: User, memberships: arr(Membership), salon: s({ id, name: str, status: str }).optional() });
const MeResult = s({ user: User, memberships: arr(Membership) });

const Limits = s({ maxBranches: nint, maxStaff: nint, customRoles: bool, desktopAccess: bool, analyticsLevel: z.enum(['basic', 'full']), csvExport: bool, billTemplates: bool });
const Entitlements = s({ planCode: str, status: str, readOnly: bool, graceEndsAt: nts, limits: Limits });

const SalonBase = {
  id, name: str, slug: str, description: nstr, phone: nstr, addressLine: nstr, city: nstr, state: nstr, pincode: nstr, lat: nnum, lng: nnum, timezone: str,
  logoMediaId: nid, brandColor: nstr, billFooter: nstr, gstin: nstr, gstEnabled: bool, invoicePrefix: str, cancelCutoffMin: int, ratingAvg: num, ratingCount: int,
  status: z.enum(['pending', 'approved', 'suspended']), createdAt: ts,
};
const Salon = s(SalonBase);
const SalonFull = s({ ...SalonBase, photoMediaIds: strs, entitlements: Entitlements, myRole: s({ roleName: nstr, permissions: strs }) });
const Hours = s({ weekday: int, opens: str, closes: str, isClosed: bool });
const Closure = s({ id, date: str, reason: nstr });
const Service = s({ id, templateId: nid, category: str, name: str, description: nstr, audience: z.enum(['all', 'men', 'women', 'kids']), durationMin: int, bufferMin: int, pricePaise: int, isActive: bool, sort: int });
const ServiceTemplate = s({ id, category: str, name: str, audience: z.enum(['all', 'men', 'women', 'kids']), defaultDurationMin: int, suggestedPricePaise: int, sort: int });
const Staff = s({
  id, userId: id, displayName: str, fullName: str, roleId: id, roleName: str, photoMediaId: nid, speedMultiplier: num, isBookable: bool, isActive: bool, serviceIds: strs,
  phone: nstr.optional(), email: nstr.optional(), createdAt: ts,
});
const StaffHours = s({ weekday: int, start: str, end: str });
const TimeOff = s({ id, from: ts, to: ts, reason: nstr });
const Role = s({ id, name: str, isSystem: bool, permissions: strs, memberCount: int });
const Permission = s({ key: str, description: str });
const ServiceIds = s({ serviceIds: strs });

const Booking = s({
  id, salonId: id, salonName: str, customerId: nid, customerName: str, customerPhone: nstr, staffId: id, staffName: str, source: z.enum(['app', 'walk_in']),
  status: z.enum(['held', 'confirmed', 'checked_in', 'completed', 'cancelled', 'no_show', 'expired']), startsAt: ts, endsAt: ts, totalDurationMin: int, totalPricePaise: int,
  holdExpiresAt: nts, version: int, cancelledReason: nstr, items: arr(s({ serviceId: nid, name: str, durationMin: int, pricePaise: int })), hasReview: bool, createdAt: ts,
  qrToken: str.optional().describe('Only on customer GET /bookings and confirm while status=confirmed'),
});
const Invoice = s({
  id, salonId: id, bookingId: nid, invoiceNo: str, customerName: str, customerPhone: nstr, subtotalPaise: int, discountPaise: int, taxPaise: int, taxLabel: nstr, taxRatePct: nnum,
  gstinSnapshot: nstr, totalPaise: int, status: z.enum(['draft', 'paid', 'void']), voidedReason: nstr,
  items: arr(s({ serviceId: nid, name: str, qty: int, unitPricePaise: int, lineTotalPaise: int })),
  payments: arr(s({ methodCode: str, amountPaise: int, reference: nstr, paidAt: ts })), createdAt: ts,
});
const PaymentMethod = s({ code: z.enum(['cash', 'card', 'upi', 'wallet', 'bank_transfer', 'other']), label: str, isEnabled: bool, upiId: nstr, sort: int });

const SalonReview = s({ id, bookingId: id, rating: int, comment: nstr, status: z.enum(['visible', 'hidden', 'reported']), customerName: str, replyText: nstr, replyAt: nts, createdAt: ts });
const PublicReview = s({ id, rating: int, comment: nstr, customerName: str, replyText: nstr, replyAt: nts, createdAt: ts });
const NewReview = s({ id, bookingId: id, rating: int, comment: nstr, status: str, createdAt: ts });

const Plan = s({
  code: str, name: str, priceMonthlyPaise: int, priceAnnualPaise: int, maxBranches: nint, maxStaff: nint, customRoles: bool, desktopAccess: bool,
  analyticsLevel: z.enum(['basic', 'full']), csvExport: bool, billTemplates: bool, trialDays: int,
});
const AdminPlan = s({ ...Plan.shape, isActive: bool, razorpayPlanIdMonthly: nstr, razorpayPlanIdAnnual: nstr });

const SalonSummary = s({
  id, name: str, slug: str, city: nstr, addressLine: nstr, lat: nnum, lng: nnum, logoMediaId: nid, ratingAvg: num, ratingCount: int, distanceKm: nnum, startingPricePaise: nint, categories: strs,
});
const SalonDetail = s({
  id, name: str, slug: str, description: nstr, phone: nstr, addressLine: nstr, city: nstr, state: nstr, pincode: nstr, lat: nnum, lng: nnum, timezone: str, logoMediaId: nid,
  ratingAvg: num, ratingCount: int, reviewCount: int, cancelCutoffMin: int, photoMediaIds: strs, hours: arr(Hours), closures: arr(s({ date: str, reason: nstr })),
  services: arr(Service), staff: arr(s({ id, displayName: str, photoMediaId: nid, serviceIds: strs })),
});
const Hairstyle = s({
  id, name: str, audience: z.enum(['men', 'women', 'unisex']), faceShapes: strs, length: z.enum(['short', 'medium', 'long']), description: str, tags: strs, imageMediaId: nid,
  maintenance: z.enum(['low', 'medium', 'high']), serviceTemplateIds: strs,
});
const Slot = s({ staffId: id, startsAt: ts, endsAt: ts });
const Availability = s({ date: str, timezone: str, slots: arr(Slot) });

const Receipt = s({ id, receiptNo: str, amountPaise: int, periodStart: nts, periodEnd: nts, razorpayPaymentId: str, issuedAt: ts, kind: z.literal('receipt') });
const SubscriptionView = s({
  planCode: str, interval: z.enum(['monthly', 'annual']), status: z.enum(['trialing', 'active', 'past_due', 'halted', 'cancelled', 'expired']),
  trialEndsAt: nts, currentPeriodEnd: nts, compUntil: nts, cancelAtPeriodEnd: bool, razorpaySubscriptionId: nstr,
  paymentMethodAuthorized: bool.describe('true once the customer authorised the Razorpay mandate (subscription.authenticated), even while still trialing'),
  nextChargeAt: nts.describe('when Razorpay will take the next (first, during a trial) charge, if known'),
  entitlements: Entitlements, limits: Limits, usage: s({ activeStaff: int, customRoles: int }), recentReceipts: arr(Receipt),
});
const CheckoutResult = s({ razorpaySubscriptionId: str, keyId: str });

const AnalyticsSummary = s({
  level: z.enum(['basic', 'full']),
  range: s({ from: str, to: str, timezone: str }),
  totals: s({ bookings: int, completed: int, noShows: int, cancelled: int, revenuePaise: int, invoices: int }),
  byService: arr(s({ name: str, qty: int, revenuePaise: int })).optional(),
  byStaff: arr(s({ staffId: id, displayName: str, bookings: int, completed: int, noShows: int, revenuePaise: int })).optional(),
  hourlyHeatMap: arr(s({ weekday: int.describe('0=Sunday'), hour: int, bookings: int })).optional(),
  repeatCustomers: s({ customers: int, repeat: int, rate: num }).optional(),
  repeatCustomerRate: num.optional().describe('same as repeatCustomers.rate (0..1)'),
  dailySeries: arr(s({ date: str, bookings: int, completed: int, revenuePaise: int })).optional(),
});
const Customer = s({ id: str, name: nstr, phone: nstr, customerId: nid, bookings: int, visits: int, noShows: int, lastVisitAt: nts, totalSpentPaise: int });
const CustomerDetail = s({
  id: str, name: nstr, phone: nstr,
  bookings: arr(s({ id, status: str, startsAt: ts, totalPricePaise: int, staffName: str })),
  invoices: arr(s({ id, invoiceNo: str, totalPaise: int, status: str, createdAt: ts })),
});
const ExportJob = s({ id, kind: str, status: z.enum(['queued', 'running', 'done', 'failed']), error: nstr, createdAt: ts, finishedAt: nts, downloadPath: nstr });
const ExportStarted = s({ jobId: id, status: z.literal('queued') });

const SubSummary = s({ status: str, planCode: str, trialEndsAt: nts, compUntil: nts });
const AdminSalon = s({ ...SalonBase, subscription: SubSummary, owner: s({ name: nstr, email: nstr, phone: nstr }) });
const AdminSalonDetail = s({
  ...SalonBase,
  subscription: s({ planCode: str, interval: str, status: str, trialEndsAt: nts, currentPeriodEnd: nts, compUntil: nts, cancelAtPeriodEnd: bool }),
  staff: arr(s({ id, displayName: str, roleName: str, isActive: bool, email: nstr, phone: nstr })),
  counts: s({ bookings: int, invoices: int, services: int }),
});
const CompResult = s({ salonId: id, compUntil: nts, trialEndsAt: nts, status: str, planCode: str });
const AdminUser = s({ id, fullName: str, email: nstr, phone: nstr, role: str, isActive: bool, createdAt: ts });
const AdminStats = s({
  customers: int, salons: s({ total: int, pending: int, approved: int }), subscriptions: s({ active: int, trialing: int, troubled: int }),
  bookingsLast30Days: int, newContactMessages: int, subscriptionReceiptsLast30DaysPaise: int, leads: int,
  activeUsers: s({
    asOf: str.describe('IST date YYYY-MM-DD'), dau: int, wau: int.describe('distinct users in the 7 IST days ending asOf'), mau: int.describe('distinct users in the 30 IST days ending asOf'),
    byRole: s({ customer: s({ dau: int, wau: int, mau: int }), salon_user: s({ dau: int, wau: int, mau: int }) }),
    series: arr(s({ day: str, dau: int })).describe('30 IST days ending asOf, oldest first, missing days are 0'),
  }).describe('activity = authenticated API usage, at most one record per user per IST day'),
});
const AuditEntry = s({ id: int, actorUserId: nid, salonId: nid, action: str, entity: nstr, entityId: nstr, meta: z.record(str, z.unknown()), ip: nstr, createdAt: ts });
const ContactMessage = s({ id, name: str, email: str, phone: nstr, salonName: nstr, message: str, status: z.enum(['new', 'handled']), assignedTo: nid, createdAt: ts });
const Lead = s({
  id, salonName: str, ownerName: nstr, phone: nstr, email: nstr, city: nstr, source: nstr, stage: z.enum(['new', 'contacted', 'trial', 'subscribed', 'lost']),
  ownerAgentId: nid, notes: nstr, createdAt: ts, updatedAt: ts,
});
const Pipeline = s({ stages: arr(s({ stage: z.enum(['new', 'contacted', 'trial', 'subscribed', 'lost']), count: int })), total: int });
const Invite = s({ code: str, url: str, expiresAt: ts });
const InvitePrefill = s({ salonName: str, ownerName: nstr, phone: nstr, email: nstr, city: nstr });
const QueueHealth = s({
  driver: z.enum(['pgboss', 'memory', 'inline']), depth: int, maxDepth: int, workerMode: z.enum(['api', 'worker', 'both']),
  jobs: arr(s({ name: str, queued: int, active: int, failed: int })), unprocessedWebhookEvents: int,
});
const MediaId = s({ id });
const Ok = s({ ok: z.literal(true) });
const WebhookAck = s({ received: z.literal(true), result: z.enum(['queued', 'duplicate']) });

export const SCHEMAS: Record<string, ZodType> = {
  User, Membership, AuthTokens, AuthResult, MeResult, Limits, Entitlements, Salon, SalonFull, Hours, Closure, Service, ServiceTemplate, Staff, StaffHours, TimeOff, Role, Permission,
  ServiceIds, Booking, Invoice, PaymentMethod, SalonReview, PublicReview, NewReview, Plan, AdminPlan, SalonSummary, SalonDetail, Hairstyle, Slot, Availability, Receipt,
  SubscriptionView, CheckoutResult, AnalyticsSummary, Customer, CustomerDetail, ExportJob, ExportStarted, AdminSalon, AdminSalonDetail, CompResult, AdminUser, AdminStats, AuditEntry,
  ContactMessage, Lead, Pipeline, Invite, InvitePrefill, QueueHealth, MediaId, Ok, WebhookAck,
};

/** documented reason codes for generic CONFLICT / FORBIDDEN errors (error.reason). Stable: clients may switch on them. */
export const ERROR_REASONS: Record<string, string> = {
  WRONG_SALON: '403 FORBIDDEN - the QR code belongs to another salon',
  QR_OUTDATED: '409 CONFLICT - the booking was rescheduled, this QR is no longer valid',
  CANCEL_CUTOFF: '409 CONFLICT - customer cancel is only allowed >= salon.cancelCutoffMin before the start (details.cutoffMin)',
  HOLD_LIMIT: '409 CONFLICT - customer already has the maximum number of active holds (default 3; details.limit/current)',
  UPCOMING_LIMIT: '409 CONFLICT - customer already has the maximum number of upcoming confirmed bookings (default 10)',
  DAILY_LIMIT: '409 CONFLICT - customer created the maximum number of bookings in the last 24 h (default 5)',
  INVALID_STATE: '409 CONFLICT - the booking/subscription is in a state that does not allow this action',
  TOO_EARLY: '409 CONFLICT - no-show can only be set after the start time',
  LAST_OWNER: '409 CONFLICT - a salon must keep one active owner',
  REVIEW_EXISTS: '409 CONFLICT - the booking already has a review',
  NOT_COMPLETED: '409 CONFLICT - only completed bookings can be reviewed',
  ALREADY_REPORTED: '409 CONFLICT - you already reported this review',
  ALREADY_SUBSCRIBED: '409 CONFLICT - an active subscription exists; cancel it first',
  PLAN_NOT_CONFIGURED: '409 CONFLICT - the Razorpay plan id for this plan/interval is not set yet',
  PHONE_TAKEN: '409 CONFLICT - phone already registered',
  EMAIL_TAKEN: '409 CONFLICT - email already registered',
  ACCOUNT_EXISTS: '409 CONFLICT - email or phone already registered (admin create)',
  INVOICE_EXISTS: '409 CONFLICT - the booking already has a non-void invoice',
  ALREADY_VOID: '409 CONFLICT - invoice already void',
  IDEMPOTENCY_IN_PROGRESS: '409 CONFLICT - a request with this Idempotency-Key is still running',
  DUPLICATE_CLOSURE: '409 CONFLICT - date already marked closed',
  ROLE_NAME_TAKEN: '409 CONFLICT - role name already used in this salon',
  ROLE_IN_USE: '409 CONFLICT - role still has staff',
  SYSTEM_ROLE: '403 FORBIDDEN - system roles cannot be deleted/renamed',
  OWNER_ROLE_LOCKED: '403 FORBIDDEN - the owner role cannot be edited',
  PHOTO_LIMIT: '409 CONFLICT - salon photo limit reached',
  NAME_TAKEN: '409 CONFLICT - hairstyle name exists',
  SELF_CHANGE: '409 CONFLICT - admins cannot change their own active state',
  NOT_READY: '409 CONFLICT - export job not finished',
};
