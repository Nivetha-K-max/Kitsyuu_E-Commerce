/* Read-only fingerprint of the existing (pre-platform) data, for before/after comparisons around a migration.
   Records row counts and an md5 of every row of the original tables, using ONLY their original columns, so adding
   new columns does not change the fingerprint but any change to existing values does. Also fingerprints the existing
   Supabase Auth accounts, Storage objects, and the RLS policies / grants of the public API roles.
   Usage (repo root):  npm run db:snapshot -- <out.json>
                       npm run db:snapshot -- --compare <before.json> <after.json>
   Runs inside a READ ONLY transaction. Prints counts and hashes only, never row contents. */
import fs from 'node:fs';
import {connect} from './lib/connection.mjs';

const args = process.argv.slice(2);
if (args[0] === '--compare') {
  const [a, b] = args.slice(1).map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
  let diff = 0;
  for (const k of Object.keys(a)) {
    const same = JSON.stringify(a[k]) === JSON.stringify(b[k]);
    if (!same) diff++;
    console.log(`${same ? 'same   ' : 'CHANGED'}  ${k.padEnd(34)} ${JSON.stringify(a[k])}${same ? '' : `  →  ${JSON.stringify(b[k])}`}`);
  }
  console.log(`\n${Object.keys(a).length} fingerprints compared, ${diff} changed`);
  process.exit(diff ? 1 : 0);
}

const out = args[0];
if (!out) { console.error('Usage: db-snapshot <out.json> | --compare <a.json> <b.json>'); process.exit(1); }

// Original columns (Phase 4.2 migrations). Later migrations may add columns; these fingerprints ignore them.
const TABLES = {
  categories: ['id', 'label', 'parent_id', 'sort_order', 'created_at'],
  products: ['id', 'sku', 'slug', 'name', 'description', 'category_id', 'subcategory_id', 'price_paise', 'colour_label', 'colour_swatch',
    'features', 'is_featured', 'status', 'data_status', 'catalogue_ref', 'material', 'care', 'origin', 'review', 'created_at', 'updated_at'],
  product_variants: ['id', 'product_id', 'size', 'sku', 'sort_order', 'price_paise', 'stock_qty', 'stock_source', 'is_active', 'created_at', 'updated_at'],
  product_images: ['id', 'product_id', 'storage_path', 'width', 'height', 'alt', 'quality', 'zoom', 'is_primary', 'sort_order', 'created_at'],
  collections: ['id', 'label', 'data_status', 'note'],
  collection_products: ['collection_id', 'product_id', 'position'],
  product_relations: ['product_id', 'related_id', 'kind', 'position'],
  profiles: ['id', 'email', 'full_name', 'phone', 'role', 'created_at', 'updated_at'],
  addresses: ['id', 'user_id', 'full_name', 'phone', 'line1', 'line2', 'city', 'state', 'pin', 'country', 'is_default', 'created_at'],
  cart_items: ['id', 'user_id', 'variant_id', 'qty', 'created_at', 'updated_at'],
  wishlist_items: ['user_id', 'product_id', 'created_at'],
  orders: ['id', 'order_number', 'user_id', 'status', 'currency', 'subtotal_paise', 'total_paise', 'contact', 'shipping_address',
    'razorpay_order_id', 'razorpay_payment_id', 'paid_at', 'created_at', 'updated_at'],
  order_items: ['id', 'order_id', 'product_id', 'variant_id', 'sku', 'name', 'size', 'image_path', 'unit_price_paise', 'qty', 'line_total_paise'],
  order_status_history: ['id', 'order_id', 'from_status', 'to_status', 'changed_by', 'note', 'created_at'],
  inventory_movements: ['id', 'variant_id', 'delta', 'reason', 'order_id', 'created_by', 'note', 'created_at'],
  payment_events: ['id', 'type', 'payload', 'received_at', 'processed_at']
};
const EXISTING_TABLES = Object.keys(TABLES);
const fp = (from, cols, order) =>
  `select count(*)::int as n, md5(coalesce(string_agg(row(${cols.join(', ')})::text, E'\\n' order by ${order}), '')) as h from ${from}`;

const c = await connect();
const snap = {};
try {
  await c.query('begin read only');
  for (const [t, cols] of Object.entries(TABLES)) {
    const {n, h} = (await c.query(fp(`public.${t}`, cols.map(x => `"${x}"`), `row(${cols.map(x => `"${x}"`).join(', ')})::text`))).rows[0];
    snap[`rows: ${t}`] = {count: n, md5: h};
  }
  snap['stock: sum of stock_qty'] = (await c.query('select coalesce(sum(stock_qty), 0)::int as total from public.product_variants')).rows[0].total;
  const auth = (await c.query(fp('auth.users', ['id', 'email', 'encrypted_password', 'email_confirmed_at', 'created_at', 'role'], 'id'))).rows[0];
  snap['auth.users (id, email, password hash, confirmed)'] = {count: auth.n, md5: auth.h};
  const st = (await c.query(fp(`storage.objects where bucket_id = 'product-images'`, ['name', `metadata->>'eTag'`, `metadata->>'size'`], 'name'))).rows[0];
  snap['storage: product-images objects'] = {count: st.n, md5: st.h};
  const pol = (await c.query(fp(`pg_policies where not (roles && array['kitsyuu_admin','kitsyuu_website']::name[])`,
    ['schemaname', 'tablename', 'policyname', 'permissive', 'roles::text', 'cmd', 'qual', 'with_check'], 'schemaname, tablename, policyname'))).rows[0];
  snap['RLS policies (all except app roles)'] = {count: pol.n, md5: pol.h};
  const gr = (await c.query(fp(`information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon','authenticated','service_role') and table_name = any($1)`,
    ['grantee', 'table_name', 'privilege_type'], 'grantee, table_name, privilege_type'), [EXISTING_TABLES])).rows[0];
  snap['API-role grants on existing tables'] = {count: gr.n, md5: gr.h};
  const rls = (await c.query(`select string_agg(relname || '=' || relrowsecurity, ',' order by relname) as s from pg_class
    where relnamespace = 'public'::regnamespace and relname = any($1)`, [EXISTING_TABLES])).rows[0].s;
  snap['RLS enabled on existing tables'] = rls;
  const fn = (await c.query(`select md5(string_agg(proname || ':' || md5(prosrc), ',' order by proname)) as h from pg_proc
    where pronamespace = 'public'::regnamespace and proname in ('is_admin', 'handle_new_user', 'set_updated_at')`)).rows[0].h;
  snap['auth functions (is_admin, handle_new_user, set_updated_at)'] = fn;
  await c.query('rollback');
} finally { await c.end(); }

fs.writeFileSync(out, JSON.stringify(snap, null, 1));
for (const [k, v] of Object.entries(snap)) console.log(`${k.padEnd(34)} ${JSON.stringify(v)}`);
