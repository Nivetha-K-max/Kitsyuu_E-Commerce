/* Admin navigation. Each item names the permission it needs; the shell shows only items the signed-in staff member
   holds, and every page checks the same permission on the server (hiding a link is never the protection). */
export interface NavItem { href: string; label: string; permission: string; group: string }

export const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', permission: 'dashboard.read', group: 'Overview' },
  { href: '/products', label: 'Products', permission: 'products.read', group: 'Catalogue' },
  { href: '/categories', label: 'Categories', permission: 'categories.read', group: 'Catalogue' },
  { href: '/attributes', label: 'Attributes', permission: 'categories.read', group: 'Catalogue' },
  { href: '/inventory', label: 'Inventory', permission: 'inventory.read', group: 'Catalogue' },
  { href: '/orders', label: 'Orders', permission: 'orders.read', group: 'Commerce' },
  { href: '/customers', label: 'Customers', permission: 'customers.read', group: 'Commerce' },
  { href: '/payments', label: 'Payments', permission: 'billing.read', group: 'Commerce' },
  { href: '/staff', label: 'Staff', permission: 'staff.read', group: 'System' },
  { href: '/roles', label: 'Roles', permission: 'roles.read', group: 'System' },
  { href: '/audit', label: 'Audit', permission: 'audit.read', group: 'System' },
  { href: '/settings', label: 'Settings', permission: 'settings.read', group: 'System' },
  { href: '/system', label: 'System', permission: 'system.read', group: 'System' },
];
