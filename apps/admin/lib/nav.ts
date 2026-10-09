/* Admin navigation (order-centric architecture, approved 2026-10-07).

     SIDEBAR MODULE → MODULE WORKSPACE → INTERNAL VIEWS → ENTITY DETAIL → ENTITY TABS

   The sidebar lists MODULES only, flat, ordered by how often staff use them. A module's pages are its VIEWS: they are
   shown as one row of buttons inside the module (components/ModuleViews), never as extra sidebar items.
   Each view names the permission it needs. A module is shown when the signed-in staff member holds the permission of
   at least one of its views, and opens on the first view they may see. Every page still checks its own permission on
   the server: hiding a link is never the protection. */
export interface NavView { href: string; label: string; permission: string }
export interface NavModule {
  id: string; label: string; icon: string;
  /** Plain caption in the sidebar (not a collapsible group). */
  group: string;
  /** The module's views; the first one the person may open is where the module opens. */
  views: NavView[];
  /** Other addresses that belong to this module (its record pages), for "where am I". */
  also?: string[];
}

const one = (id: string, label: string, icon: string, group: string, href: string, permission: string, also?: string[]): NavModule =>
  ({ id, label, icon, group, views: [{ href, label, permission }], also });

export const MODULES: NavModule[] = [
  one('dashboard', 'Dashboard', 'dashboard', 'Overview', '/dashboard', 'dashboard.read', ['/notifications', '/search']),
  // ---- Work: where staff spend the day
  one('orders', 'Orders', 'orders', 'Work', '/orders', 'orders.read', ['/drafts']),
  one('pos', 'POS billing', 'pos', 'Work', '/pos', 'pos.access'),
  { id: 'customers', label: 'Customers', icon: 'customers', group: 'Work', views: [
    { href: '/customers', label: 'Customers', permission: 'customers.read' },
    { href: '/carts', label: 'Carts & wishlists', permission: 'carts.read' },
    { href: '/loyalty', label: 'Loyalty', permission: 'loyalty.read' },
  ] },
  one('products', 'Products', 'products', 'Work', '/products', 'products.read'),
  { id: 'inventory', label: 'Inventory', icon: 'inventory', group: 'Work', views: [
    { href: '/inventory', label: 'Stock', permission: 'inventory.read' },
    { href: '/inventory/movements', label: 'Movements', permission: 'inventory.read' },
    { href: '/locations', label: 'Locations', permission: 'inventory.read' },
    { href: '/transfers', label: 'Transfers', permission: 'inventory.read' },
    { href: '/stock-counts', label: 'Stock counts', permission: 'inventory.read' },
    { href: '/stock-value', label: 'Stock value', permission: 'costs.read' },
  ] },
  // ---- Queues: everything of one kind that needs someone, across all orders (a row opens the order it belongs to)
  one('payments', 'Payments', 'payments', 'Queues', '/payments', 'billing.read'),
  one('returns', 'Returns', 'returns', 'Queues', '/returns', 'returns.read'),
  one('shipping', 'Shipping', 'shipping', 'Queues', '/shipping', 'shipping.read'),
  one('reviews', 'Reviews', 'reviews', 'Queues', '/reviews', 'reviews.read'),
  one('support', 'Support', 'support', 'Queues', '/support', 'support.read'),
  // ---- Supply
  { id: 'purchasing', label: 'Purchasing', icon: 'purchase', group: 'Supply', views: [
    { href: '/purchase-orders', label: 'Purchase orders', permission: 'procurement.read' },
    { href: '/vendors', label: 'Vendors', permission: 'procurement.read' },
    { href: '/materials', label: 'Materials', permission: 'procurement.read' },
  ] },
  one('production', 'Production', 'production', 'Supply', '/production', 'production.read'),
  // ---- Growth
  one('pricing', 'Pricing & discounts', 'pricing', 'Growth', '/pricing', 'pricing.read'),
  one('marketing', 'Marketing', 'marketing', 'Growth', '/marketing', 'marketing.read'),
  one('content', 'Store content', 'content', 'Growth', '/content', 'content.manage'),
  // ---- Business
  one('finance', 'Finance', 'finance', 'Business', '/finance', 'finance.read'),
  one('reports', 'Reports', 'reports', 'Business', '/reports', 'reports.read'),
  // ---- Setup
  { id: 'catalogue', label: 'Catalogue setup', icon: 'categories', group: 'Setup', views: [
    { href: '/categories', label: 'Categories', permission: 'categories.read' },
    { href: '/collections', label: 'Collections', permission: 'categories.read' },
    { href: '/attributes', label: 'Attributes', permission: 'categories.read' },
    { href: '/size-charts', label: 'Size charts', permission: 'products.read' },
  ] },
  { id: 'team', label: 'Team & access', icon: 'staff', group: 'Setup', views: [
    { href: '/staff', label: 'Staff', permission: 'staff.read' },
    { href: '/roles', label: 'Roles', permission: 'roles.read' },
    { href: '/audit', label: 'Audit log', permission: 'audit.read' },
  ] },
  one('configuration', 'Configuration', 'settings', 'Setup', '/settings', 'settings.read'),
  one('system', 'System', 'system', 'Setup', '/system', 'system.read'),
];

export interface NavItem { id: string; href: string; label: string; group: string; icon: string; match: string[] }
type Can = (permission: string) => boolean;

/** The views of a module this person may open. */
export const moduleViews = (id: string, can: Can): NavView[] => MODULES.find(m => m.id === id)?.views.filter(v => can(v.permission)) ?? [];

/** The sidebar for this person: modules with at least one view they may open. */
export function navFor(can: Can): NavItem[] {
  return MODULES.flatMap(m => {
    const views = m.views.filter(v => can(v.permission));
    if (!views.length) return [];
    return [{ id: m.id, href: views[0]!.href, label: m.label, group: m.group, icon: m.icon, match: [...m.views.map(v => v.href), ...(m.also ?? [])] }];
  });
}

/** Every page this person may jump to from the command menu (modules and their views). */
export function pagesFor(can: Can): { href: string; label: string; group: string; icon: string }[] {
  return MODULES.flatMap(m => m.views.filter(v => can(v.permission)).map(v => ({ href: v.href, label: m.views.length > 1 && v.label !== m.label ? `${m.label} › ${v.label}` : m.label, group: m.group, icon: m.icon })));
}

/** True when `path` is one of the addresses in `match` or below one of them. */
export const inModule = (path: string, match: string[]) => match.some(h => path === h || path.startsWith(h + '/'));
