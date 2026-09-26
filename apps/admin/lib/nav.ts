/* Admin navigation. Each item names the permission it needs; the shell shows only items the signed-in staff member
   holds, and every page checks the same permission on the server (hiding a link is never the protection). */
export interface NavItem { href: string; label: string; permission: string; group: string }

export const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', permission: 'dashboard.read', group: 'Overview' },
  { href: '/orders', label: 'Orders', permission: 'orders.read', group: 'Sales' },
  { href: '/products', label: 'Products', permission: 'products.read', group: 'Catalogue' },
  { href: '/inventory', label: 'Stock', permission: 'inventory.read', group: 'Catalogue' },
  { href: '/categories', label: 'Categories', permission: 'categories.read', group: 'Catalogue' },
  { href: '/staff', label: 'Staff', permission: 'staff.read', group: 'Access' },
  { href: '/roles', label: 'Roles & permissions', permission: 'roles.read', group: 'Access' },
  { href: '/audit', label: 'Audit log', permission: 'audit.read', group: 'Access' },
];
