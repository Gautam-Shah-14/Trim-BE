export interface PlanRow {
  code: string;
  name: string;
  max_branches: number | null;
  max_staff: number | null;
  custom_roles: boolean;
  desktop_access: boolean;
  analytics_level: 'basic' | 'full';
  csv_export: boolean;
  bill_templates: boolean;
}

export interface SubscriptionRow {
  plan_code: string;
  status: 'trialing' | 'active' | 'past_due' | 'halted' | 'cancelled' | 'expired';
  trial_ends_at: Date | null;
  current_period_end: Date | null;
  comp_until: Date | null;
  past_due_since: Date | null;
}

export interface Entitlements {
  /** plan whose limits apply right now (trial and comp use the subscribed/Pro level, see decisions) */
  planCode: string;
  status: SubscriptionRow['status'];
  /** effective status after applying comp / trial expiry / grace */
  effectiveStatus: 'trialing' | 'active' | 'past_due' | 'halted' | 'cancelled' | 'expired' | 'comped';
  /** read-only mode: no new bookings/bills/services/staff. Check-in/complete/export still work */
  readOnly: boolean;
  /** discoverable by customers (status approved is checked elsewhere) */
  discoverable: boolean;
  graceEndsAt: Date | null;
  limits: {
    maxBranches: number | null;
    maxStaff: number | null;
    customRoles: boolean;
    desktopAccess: boolean;
    analyticsLevel: 'basic' | 'full';
    csvExport: boolean;
    billTemplates: boolean;
  };
}

export const PAST_DUE_GRACE_MS = 7 * 24 * 3600 * 1000;

/**
 * Pure entitlement computation. `plans` is the whole plans table keyed by code.
 * - comp_until in the future => full access at the subscription's plan level
 * - trialing with trial_ends_at in the future => Pro level
 * - trialing past trial_ends_at => treated as expired (read-only)
 * - past_due within 7 days of past_due_since => full access, afterwards read-only
 * - halted / cancelled / expired => read-only
 */
export function entitlements(sub: SubscriptionRow, plans: Record<string, PlanRow>, now: Date = new Date()): Entitlements {
  const t = now.getTime();
  const comped = !!sub.comp_until && sub.comp_until.getTime() > t;
  let eff: Entitlements['effectiveStatus'] = sub.status;
  let readOnly = false;
  let graceEndsAt: Date | null = null;
  let planCode = sub.plan_code;

  if (comped) {
    eff = 'comped';
  } else {
    switch (sub.status) {
      case 'trialing':
        if (sub.trial_ends_at && sub.trial_ends_at.getTime() > t) {
          planCode = 'pro';
        } else {
          eff = 'expired';
          readOnly = true;
        }
        break;
      case 'active':
        break;
      case 'past_due': {
        const since = sub.past_due_since ?? now;
        graceEndsAt = new Date(since.getTime() + PAST_DUE_GRACE_MS);
        if (graceEndsAt.getTime() <= t) readOnly = true;
        break;
      }
      default:
        readOnly = true;
    }
  }
  const plan = plans[planCode] ?? plans['starter'];
  if (!plan) throw new Error('plans table is empty; run migrations');
  return {
    planCode: plan.code,
    status: sub.status,
    effectiveStatus: eff,
    readOnly,
    discoverable: !readOnly,
    graceEndsAt,
    limits: {
      maxBranches: plan.max_branches,
      maxStaff: plan.max_staff,
      customRoles: plan.custom_roles,
      desktopAccess: plan.desktop_access,
      analyticsLevel: plan.analytics_level,
      csvExport: plan.csv_export,
      billTemplates: plan.bill_templates,
    },
  };
}
