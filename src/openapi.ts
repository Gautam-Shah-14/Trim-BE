import { z, type ZodType } from 'zod';
import type { RouteDef } from './http/api.js';

type Json = Record<string, any>;

const obj = (properties: Json, required?: string[]): Json => ({ type: 'object', properties, ...(required ? { required } : {}) });
const str = { type: 'string' };
const uuid = { type: 'string', format: 'uuid' };
const dt = { type: 'string', format: 'date-time' };
const int = { type: 'integer' };

/** Hand-written component schemas for the payloads clients rely on most. Others are generic objects. */
const SCHEMAS: Record<string, Json> = {
  Error: obj(
    {
      error: obj(
        {
          code: { type: 'string', enum: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'SLOT_TAKEN', 'HOLD_EXPIRED', 'ALREADY_CHECKED_IN', 'VERSION_MISMATCH', 'OUT_OF_WINDOW', 'PLAN_LIMIT', 'SUBSCRIPTION_INACTIVE', 'RATE_LIMITED', 'INTERNAL'] },
          message: str,
          details: { description: 'Array of {field, issue} for VALIDATION_FAILED; object (e.g. {limit}) for PLAN_LIMIT', oneOf: [{ type: 'array', items: obj({ field: str, issue: str }) }, { type: 'object' }] },
          reason: { type: 'string', description: 'Machine-readable sub-reason for generic CONFLICT/FORBIDDEN, e.g. CANCEL_CUTOFF, QR_OUTDATED, WRONG_SALON' },
        },
        ['code', 'message'],
      ),
    },
    ['error'],
  ),
  User: obj({ id: uuid, fullName: str, phone: { type: ['string', 'null'] }, email: { type: ['string', 'null'] }, role: { type: 'string', enum: ['customer', 'salon_user', 'admin', 'sales_agent'] }, avatarMediaId: { type: ['string', 'null'] }, mustChangePassword: { type: 'boolean' } }),
  Membership: obj({ salonId: uuid, salonName: str, salonStatus: str, staffId: uuid, roleId: uuid, roleName: str, permissions: { type: 'array', items: str }, planCode: str, subscriptionStatus: str, readOnly: { type: 'boolean' }, desktopAccess: { type: 'boolean' } }),
  AuthTokens: obj({ accessToken: str, refreshToken: str, expiresIn: int }),
  AuthResult: obj({ accessToken: str, refreshToken: str, expiresIn: int, user: { $ref: '#/components/schemas/User' }, memberships: { type: 'array', items: { $ref: '#/components/schemas/Membership' } }, salon: obj({ id: uuid, name: str, status: str }) }),
  Booking: obj({
    id: uuid, salonId: uuid, salonName: str, customerId: { type: ['string', 'null'] }, customerName: str, customerPhone: { type: ['string', 'null'] }, staffId: uuid, staffName: str,
    source: { enum: ['app', 'walk_in'] }, status: { enum: ['held', 'confirmed', 'checked_in', 'completed', 'cancelled', 'no_show', 'expired'] },
    startsAt: dt, endsAt: dt, totalDurationMin: int, totalPricePaise: int, holdExpiresAt: { type: ['string', 'null'], format: 'date-time' }, version: int,
    cancelledReason: { type: ['string', 'null'] }, items: { type: 'array', items: obj({ serviceId: uuid, name: str, durationMin: int, pricePaise: int }) },
    hasReview: { type: 'boolean' }, qrToken: { type: 'string', description: 'Only on customer GET/confirm while status=confirmed' }, createdAt: dt,
  }),
  Invoice: obj({
    id: uuid, salonId: uuid, bookingId: { type: ['string', 'null'] }, invoiceNo: str, customerName: str, customerPhone: { type: ['string', 'null'] },
    subtotalPaise: int, discountPaise: int, taxPaise: int, taxLabel: { type: ['string', 'null'] }, totalPaise: int, status: { enum: ['draft', 'paid', 'void'] },
    items: { type: 'array', items: obj({ serviceId: { type: ['string', 'null'] }, name: str, qty: int, unitPricePaise: int, lineTotalPaise: int }) },
    payments: { type: 'array', items: obj({ methodCode: str, amountPaise: int, reference: { type: ['string', 'null'] }, paidAt: dt }) }, createdAt: dt,
  }),
  Plan: obj({ code: str, name: str, priceMonthlyPaise: int, priceAnnualPaise: int, maxBranches: { type: ['integer', 'null'] }, maxStaff: { type: ['integer', 'null'] }, customRoles: { type: 'boolean' }, desktopAccess: { type: 'boolean' }, analyticsLevel: { enum: ['basic', 'full'] }, csvExport: { type: 'boolean' }, billTemplates: { type: 'boolean' }, trialDays: int }),
  Availability: obj({ date: str, timezone: str, slots: { type: 'array', items: obj({ staffId: uuid, startsAt: dt, endsAt: dt }) } }),
  CheckoutResult: obj({ razorpaySubscriptionId: str, keyId: str }),
  MediaId: obj({ id: uuid }),
};

const PARAM_FORMAT: Record<string, Json> = { code: str, customerKey: str };

function toSchema(s: ZodType): Json {
  const j = z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) as Json;
  delete j['$schema'];
  return j;
}

function ref(name: string): Json {
  return name.endsWith('[]') ? { type: 'array', items: { $ref: `#/components/schemas/${name.slice(0, -2)}` } } : { $ref: `#/components/schemas/${name}` };
}

const ERR = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };

export function buildOpenApi(routes: RouteDef[]): Json {
  const paths: Json = {};
  const used = new Set<string>(['Error']);
  for (const r of routes) {
    const p = r.path.replace(/:(\w+)/g, '{$1}');
    const m = r.meta;
    const params: Json[] = [...r.path.matchAll(/:(\w+)/g)].map((x) => ({ name: x[1], in: 'path', required: true, schema: PARAM_FORMAT[x[1]!] ?? uuid }));
    if (m.query) {
      const qs = toSchema(m.query);
      for (const [name, sch] of Object.entries<Json>(qs['properties'] ?? {})) {
        params.push({ name, in: 'query', required: (qs['required'] ?? []).includes(name), schema: sch });
      }
    }
    if (m.idempotent) params.push({ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', minLength: 8, maxLength: 128 }, description: 'Same key + same body replays the first response; same key + different body is 422.' });

    const status = String(m.status ?? 200);
    const responses: Json = {};
    if (m.raw) {
      responses[status] = { description: m.raw, content: { [m.raw]: { schema: { type: 'string', format: 'binary' } } } };
    } else {
      const schema = m.returns ? (used.add(m.returns.replace('[]', '')), ref(m.returns)) : { type: 'object' };
      responses[status] = {
        description: 'Success',
        content: { 'application/json': { schema: obj({ data: schema, meta: { type: 'object', description: 'Pagination: limit, nextCursor' } }, ['data']) } },
      };
    }
    responses['default'] = ERR;
    const op: Json = {
      tags: [m.tag],
      summary: m.summary,
      ...(m.note || m.perm ? { description: [m.perm ? `Requires salon permission \`${m.perm}\`.` : '', m.writable ? 'Blocked (403 SUBSCRIPTION_INACTIVE) when the salon is read-only.' : '', m.ownerOnly ? 'Salon owner only.' : '', m.note ?? ''].filter(Boolean).join(' ') } : {}),
      operationId: `${r.method}_${p.replace(/[^\w]+/g, '_').replace(/^_|_$/g, '')}`,
      parameters: params,
      ...(m.body ? { requestBody: { required: true, content: { 'application/json': { schema: toSchema(m.body) } } } } : {}),
      responses,
      ...(m.auth === 'none' ? { security: [] } : {}),
      ...(m.perm ? { 'x-permission': m.perm } : {}),
    };
    (paths[p] ??= {})[r.method] = op;
  }
  paths['/health'] = {
    get: {
      tags: ['Ops'], summary: 'Liveness + DB ping (served at /health, outside /v1)', operationId: 'get_health', servers: [{ url: '/' }], security: [],
      responses: { '200': { description: 'ok', content: { 'application/json': { schema: obj({ status: str, db: str, version: str, uptimeSec: int, time: dt }) } } }, '503': { description: 'database down' } },
    },
  };
  const schemas: Json = { ...SCHEMAS };
  for (const n of used) schemas[n] ??= { type: 'object', additionalProperties: true, description: `See spec §6 for the shape of ${n}` };
  return {
    openapi: '3.1.0',
    info: {
      title: 'Trim API', version: '0.1.0',
      description: 'REST API of the Trim salon platform. Success: `{data, meta?}`. Error: `{error:{code,message,details?}}`. Money = integer paise; times = ISO-8601 UTC; phones = E.164. GENERATED from the route registry by `npm run openapi` - do not edit by hand.',
    },
    servers: [{ url: '/v1' }],
    security: [{ bearerAuth: [] }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } }, schemas },
    paths,
  };
}
