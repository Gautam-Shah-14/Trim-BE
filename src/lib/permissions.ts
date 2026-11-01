export const PERMISSIONS = {
  'booking.view': 'View bookings',
  'booking.create': 'Create walk-in bookings',
  'booking.update': 'Reschedule, complete, mark no-show',
  'booking.cancel': 'Cancel bookings',
  'checkin.scan': 'Scan QR codes to check customers in',
  'billing.view': 'View invoices',
  'billing.create': 'Create invoices',
  'billing.void': 'Void invoices',
  'services.view': 'View services',
  'services.edit': 'Edit services and prices',
  'staff.view': 'View staff and roles',
  'staff.manage': 'Add, edit and deactivate staff',
  'roles.manage': 'Create and edit roles',
  'analytics.view': 'View analytics',
  'settings.edit': 'Edit salon settings, hours and branding',
  'payments.configure': 'Configure accepted payment methods',
  'reviews.reply': 'Reply to reviews',
  'customers.view': 'View customer list',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export function isPermission(p: string): p is Permission {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, p);
}

export const SYSTEM_ROLE_NAMES = ['owner', 'manager', 'receptionist', 'stylist'] as const;
export type SystemRoleName = (typeof SYSTEM_ROLE_NAMES)[number];

export const DEFAULT_ROLE_PERMISSIONS: Record<SystemRoleName, Permission[]> = {
  owner: [...ALL_PERMISSIONS],
  manager: ALL_PERMISSIONS.filter((p) => p !== 'roles.manage'),
  receptionist: [
    'booking.view',
    'booking.create',
    'booking.update',
    'booking.cancel',
    'checkin.scan',
    'billing.view',
    'billing.create',
    'services.view',
    'customers.view',
  ],
  stylist: ['booking.view', 'checkin.scan', 'services.view'],
};
