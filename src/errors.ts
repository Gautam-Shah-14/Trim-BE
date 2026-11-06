export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'SLOT_TAKEN'
  | 'HOLD_EXPIRED'
  | 'ALREADY_CHECKED_IN'
  | 'VERSION_MISMATCH'
  | 'OUT_OF_WINDOW'
  | 'PLAN_LIMIT'
  | 'SUBSCRIPTION_INACTIVE'
  | 'RATE_LIMITED'
  | 'OVERLOADED'
  | 'UPSTREAM_ERROR'
  | 'METHOD_NOT_ALLOWED'
  | 'TIMEOUT'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  SLOT_TAKEN: 409,
  HOLD_EXPIRED: 409,
  ALREADY_CHECKED_IN: 409,
  VERSION_MISMATCH: 409,
  OUT_OF_WINDOW: 409,
  PLAN_LIMIT: 403,
  SUBSCRIPTION_INACTIVE: 403,
  RATE_LIMITED: 429,
  OVERLOADED: 503,
  UPSTREAM_ERROR: 502,
  METHOD_NOT_ALLOWED: 405,
  TIMEOUT: 504,
  INTERNAL: 500,
};

export interface FieldIssue {
  field: string;
  issue: string;
}

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: FieldIssue[] | Record<string, unknown>,
    /** extra machine-readable reason for generic CONFLICT / FORBIDDEN errors */
    readonly reason?: string,
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

export const E = {
  validation: (message: string, details?: FieldIssue[]) => new AppError('VALIDATION_FAILED', message, details),
  unauth: (message = 'Authentication required') => new AppError('UNAUTHENTICATED', message),
  forbidden: (message = 'You do not have permission to do this', reason?: string) =>
    new AppError('FORBIDDEN', message, undefined, reason),
  notFound: (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found`),
  conflict: (message: string, reason?: string) => new AppError('CONFLICT', message, undefined, reason),
  planLimit: (message: string, limit: string, extra: Record<string, unknown> = {}) =>
    new AppError('PLAN_LIMIT', message, { limit, ...extra }),
  inactive: (message = 'Subscription is inactive; the salon is in read-only mode') =>
    new AppError('SUBSCRIPTION_INACTIVE', message),
};
