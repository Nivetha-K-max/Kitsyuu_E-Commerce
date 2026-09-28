/* M18: one search box for the admin. Each group is searched only if the person holds that area's read permission, so
   search never reveals what a page would not. Plain case-insensitive substring matching (no index needed at this size),
   at most 8 results per group. */
import { sql, type Db } from '@kitsyuu/db';
import { can, type StaffPrincipal } from '@kitsyuu/auth';

export type SearchHit = { href: string; title: string; detail: string };
export type SearchGroup = { key: string; label: string; hits: SearchHit[] };
const LIMIT = 8;

export async function globalSearch(db: Db, actor: StaffPrincipal, term: string): Promise<SearchGroup[]> {
  const t = term.trim().slice(0, 80);
  if (t.length < 2) return [];
  const like = `%${t.replace(/[\\%_]/g, m => '\\' + m)}%`;
  const has = (s: unknown) => sql<boolean>`${s} ilike ${like}`;
  const jobs: Promise<SearchGroup>[] = [];
  if (can(actor, 'products.read')) jobs.push(db.selectFrom('products').select(['id', 'sku', 'name', 'status'])
    .where(eb => eb.or([has(sql.ref('name')), has(sql.ref('sku')), has(sql.ref('id'))])).orderBy('sku').limit(LIMIT).execute()
    .then(r => ({ key: 'products', label: 'Products', hits: r.map(p => ({ href: `/products/${p.id}`, title: p.name, detail: `${p.sku} · ${p.status}` })) })));
  if (can(actor, 'orders.read')) jobs.push(db.selectFrom('orders').select(['id', 'order_number', 'status', 'created_at', sql<string | null>`contact->>'email'`.as('email')])
    .where(eb => eb.or([has(sql.ref('order_number')), has(sql`contact->>'email'`), has(sql`contact->>'name'`)])).orderBy('created_at', 'desc').limit(LIMIT).execute()
    .then(r => ({ key: 'orders', label: 'Orders', hits: r.map(o => ({ href: `/orders/${o.id}`, title: o.order_number, detail: `${o.status.replace('_', ' ')}${o.email ? ` · ${o.email}` : ''}` })) })));
  if (can(actor, 'customers.read')) jobs.push(db.selectFrom('customers').select(['id', 'email', 'full_name', 'status'])
    .where(eb => eb.or([has(sql.ref('email')), has(sql.ref('full_name'))])).orderBy('email').limit(LIMIT).execute()
    .then(r => ({ key: 'customers', label: 'Customers', hits: r.map(c => ({ href: `/customers/${c.id}`, title: c.full_name || c.email, detail: `${c.email} · ${c.status}` })) })));
  if (can(actor, 'procurement.read')) {
    jobs.push(db.selectFrom('vendors').select(['id', 'name', 'email']).where(eb => eb.or([has(sql.ref('name')), has(sql.ref('email'))])).orderBy('name').limit(LIMIT).execute()
      .then(r => ({ key: 'vendors', label: 'Vendors', hits: r.map(v => ({ href: '/vendors', title: v.name, detail: v.email ?? 'vendor' })) })));
    jobs.push(db.selectFrom('purchase_orders as p').innerJoin('vendors as v', 'v.id', 'p.vendor_id').select(['p.id', 'p.po_number', 'p.status', 'v.name as vendor'])
      .where(eb => eb.or([has(sql.ref('p.po_number')), has(sql.ref('v.name'))])).orderBy('p.created_at', 'desc').limit(LIMIT).execute()
      .then(r => ({ key: 'purchase-orders', label: 'Purchase orders', hits: r.map(p => ({ href: `/purchase-orders/${p.id}`, title: p.po_number, detail: `${p.vendor} · ${p.status.replace('_', ' ')}` })) })));
    jobs.push(db.selectFrom('materials').select(['id', 'code', 'name']).where(eb => eb.or([has(sql.ref('code')), has(sql.ref('name'))])).orderBy('code').limit(LIMIT).execute()
      .then(r => ({ key: 'materials', label: 'Materials', hits: r.map(m => ({ href: '/materials', title: m.name, detail: m.code })) })));
  }
  if (can(actor, 'production.read')) jobs.push(db.selectFrom('production_orders as o').innerJoin('product_variants as v', 'v.id', 'o.variant_id').innerJoin('products as p', 'p.id', 'v.product_id')
    .select(['o.id', 'o.number', 'o.status', 'p.name', 'v.size']).where(eb => eb.or([has(sql.ref('o.number')), has(sql.ref('p.name')), has(sql.ref('p.sku'))]))
    .orderBy('o.created_at', 'desc').limit(LIMIT).execute()
    .then(r => ({ key: 'production', label: 'Production', hits: r.map(o => ({ href: `/production/${o.id}`, title: o.number, detail: `${o.name} · ${o.size} · ${o.status.replace('_', ' ')}` })) })));
  return (await Promise.all(jobs)).filter(g => g.hits.length);
}
