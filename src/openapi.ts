import { z, type ZodType } from 'zod';
import type { RouteDef } from './http/api.js';
import { ERROR_REASONS, SCHEMAS as RESPONSE_SCHEMAS } from './schemas.js';

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
          code: { type: 'string', enum: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'SLOT_TAKEN', 'HOLD_EXPIRED', 'ALREADY_CHECKED_IN', 'VERSION_MISMATCH', 'OUT_OF_WINDOW', 'PLAN_LIMIT', 'SUBSCRIPTION_INACTIVE', 'RATE_LIMITED', 'OVERLOADED', 'TIMEOUT', 'INTERNAL'] },
          message: str,
          details: { description: 'Array of {field, issue} for VALIDATION_FAILED; object (e.g. {limit}) for PLAN_LIMIT', oneOf: [{ type: 'array', items: obj({ field: str, issue: str }) }, { type: 'object' }] },
          reason: { type: 'string', description: 'Stable machine-readable sub-reason for CONFLICT/FORBIDDEN (see x-error-reasons). For a missing salon permission it is the permission key, e.g. billing.void.', enum: [...Object.keys(ERROR_REASONS), 'booking.view', 'booking.create', 'booking.update', 'booking.cancel', 'checkin.scan', 'billing.view', 'billing.create', 'billing.void', 'services.view', 'services.edit', 'staff.view', 'staff.manage', 'roles.manage', 'analytics.view', 'settings.edit', 'payments.configure', 'reviews.reply', 'customers.view'] },
        },
        ['code', 'message'],
      ),
    },
    ['error'],
  ),
};

const PARAM_FORMAT: Record<string, Json> = { code: str, customerKey: str };

function toSchema(s: ZodType, io: 'input' | 'output' = 'input'): Json {
  const j = z.toJSONSchema(s, { io, unrepresentable: 'any' }) as Json;
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
      const returns = m.returns ?? (r.path === '/webhooks/razorpay' ? 'WebhookAck' : 'Ok');
      used.add(returns.replace('[]', ''));
      const schema = ref(returns);
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
  for (const [name, zs] of Object.entries(RESPONSE_SCHEMAS)) schemas[name] = toSchema(zs, 'output');
  const missing = [...used].filter((n) => !schemas[n]);
  if (missing.length) throw new Error(`openapi: routes return unknown schemas: ${missing.join(', ')}`);
  return {
    openapi: '3.1.0',
    info: {
      title: 'Trim API', version: '0.1.0',
      description: 'REST API of the Trim salon platform. Success: `{data, meta?}`. Error: `{error:{code,message,details?}}`. Money = integer paise; times = ISO-8601 UTC; phones = E.164. GENERATED from the route registry and src/schemas.ts by `npm run openapi` - do not edit by hand.',
      'x-error-reasons': ERROR_REASONS,
    },
    servers: [{ url: '/v1' }],
    security: [{ bearerAuth: [] }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } }, schemas },
    paths,
  };
}
