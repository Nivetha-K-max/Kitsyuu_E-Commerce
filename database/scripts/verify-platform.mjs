/* Verifies the M2 platform foundation in the live database: structure, seeds, security (RLS, grants, app roles,
   append-only audit log), the stock function and ledger, invoice numbering, reporting views, and that the public API
   (publishable key) cannot reach any of the new tables, views or functions.
   Everything that writes runs inside ONE transaction that is rolled back at the end, so this leaves no data behind
   (checked at the end). Usage (repo root): npm run db:verify-platform */
import {connect} from './lib/connection.mjs';

const out = [];
const ok = (name, pass, extra = '') => out.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
const NEW_TABLES = ['staff_users', 'roles', 'permissions', 'role_permissions', 'staff_user_roles', 'staff_sessions', 'customers', 'customer_sessions',
  'auth_tokens', 'auth_attempts', 'inventory_reasons', 'carts', 'wishlists', 'tax_rates', 'payments', 'refunds', 'invoices', 'invoice_items',
  'document_sequences', 'settings', 'site_content', 'audit_logs'];
const VIEWS = ['v_sales_daily', 'v_inventory_status', 'v_low_stock', 'v_customer_summary'];
const FUNCS = ['adjust_stock(uuid,integer,text,uuid,text,uuid)', 'next_document_number(text,text,date)', 'financial_year_of(date)', 'guard_stock_qty()', 'audit_logs_block_change()'];
const ROLES = ['super_admin', 'admin', 'manager', 'inventory_manager', 'sales', 'accountant', 'support'];
const EMPTY = ['staff_users', 'staff_user_roles', 'staff_sessions', 'customer_sessions', 'auth_tokens', 'auth_attempts', 'carts', 'wishlists',
  'payments', 'refunds', 'invoices', 'invoice_items', 'document_sequences', 'site_content', 'audit_logs'];

const c = await connect();
const one = async (sql, p) => (await c.query(sql, p)).rows[0];
const val = async (sql, p) => Object.values(await one(sql, p))[0];
let sp = 0;
// Runs sql expecting it to fail with the given SQLSTATE; a savepoint keeps the outer transaction usable.
async function expectError(name, sql, code, p) {
  const s = `s${++sp}`; await c.query(`savepoint ${s}`);
  try { await c.query(sql, p); await c.query(`release savepoint ${s}`); ok(name, false, 'statement succeeded'); }
  catch (e) { await c.query(`rollback to savepoint ${s}`); ok(name, e.code === code, `${e.code}: ${e.message.slice(0, 90)}`); }
}
async function asRole(role, fn) { await c.query(`set local role ${role}`); try { await fn(); } finally { await c.query('reset role'); } }

try {
  const before = await one(`select (select coalesce(sum(stock_qty),0)::int from public.product_variants) stock, (select count(*)::int from public.inventory_movements) moves`);
  await c.query('begin');

  // ---------- structure ----------
  const tables = (await c.query(`select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname = any($1)`, [NEW_TABLES])).rows;
  ok(`all ${NEW_TABLES.length} new tables exist`, tables.length === NEW_TABLES.length, `${tables.length} found`);
  ok('RLS is enabled on every new table', tables.every(t => t.relrowsecurity), tables.filter(t => !t.relrowsecurity).map(t => t.relname).join(',') || 'all enabled');
  ok('all 4 reporting views exist', (await val(`select count(*)::int from pg_views where schemaname = 'public' and viewname = any($1)`, [VIEWS])) === 4);
  ok('reporting views run with the caller\'s privileges (security_invoker)', (await val(`select count(*)::int from pg_class where relname = any($1) and 'security_invoker=true' = any(reloptions)`, [VIEWS])) === 4);
  const leaks = (await c.query(`select r.rolname, x.obj, p.priv from unnest($1::text[]) x(obj) cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p(priv)
    cross join (values ('anon'), ('authenticated')) r(rolname) where has_table_privilege(r.rolname, 'public.' || x.obj, p.priv)`, [[...NEW_TABLES, ...VIEWS]])).rows;
  ok('anon / authenticated have NO privileges on any new table or view', leaks.length === 0, leaks.slice(0, 3).map(l => `${l.rolname}:${l.priv}:${l.obj}`).join(' ') || '0 grants');
  const fnLeaks = (await c.query(`select r, f from unnest($1::text[]) f cross join unnest(array['anon','authenticated','public']) r where has_function_privilege(r, 'public.' || f, 'EXECUTE')`, [FUNCS])).rows;
  ok('anon / authenticated / public cannot EXECUTE the new functions', fnLeaks.length === 0, fnLeaks.map(l => `${l.r}:${l.f}`).join(' ') || '0 grants');
  const cols = (await c.query(`select table_name || '.' || column_name c from information_schema.columns where table_schema = 'public' and (table_name, column_name) in
    (('inventory_movements','staff_id'), ('inventory_movements','balance_after'), ('product_variants','reorder_level'), ('orders','customer_id'),
     ('orders','payment_status'), ('cart_items','cart_id'), ('wishlist_items','wishlist_id'))`)).rows;
  ok('7 new columns on existing tables (all nullable)', cols.length === 7, cols.map(x => x.c).join(', '));
  ok('new columns on existing tables are nullable (no rows rewritten)', (await val(`select count(*)::int from information_schema.columns where table_schema = 'public' and is_nullable = 'NO' and (table_name, column_name) in
    (('inventory_movements','staff_id'), ('inventory_movements','balance_after'), ('product_variants','reorder_level'), ('orders','customer_id'), ('orders','payment_status'), ('cart_items','cart_id'), ('wishlist_items','wishlist_id'))`)) === 0);
  ok('stock reason: CHECK list replaced by FK to inventory_reasons', (await val(`select count(*)::int from pg_constraint where conrelid = 'public.inventory_movements'::regclass and conname = 'inventory_movements_reason_fkey'`)) === 1
    && (await val(`select count(*)::int from pg_constraint where conname = 'inventory_movements_reason_check'`)) === 0);
  const dbRoles = (await c.query(`select rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreaterole from pg_roles where rolname in ('kitsyuu_website','kitsyuu_admin') order by 1`)).rows;
  ok('app DB roles exist, NOLOGIN, no superuser / bypassrls / createrole', dbRoles.length === 2 && dbRoles.every(r => !r.rolcanlogin && !r.rolsuper && !r.rolbypassrls && !r.rolcreaterole), dbRoles.map(r => r.rolname).join(', '));

  // ---------- seeds and existing data ----------
  const roles = (await c.query(`select code from public.roles order by code`)).rows.map(r => r.code);
  ok('7 roles seeded', roles.length === 7 && ROLES.every(r => roles.includes(r)), roles.join(', '));
  const perms = await val(`select count(*)::int from public.permissions`);
  ok('permissions seeded (incl. inventory.adjust, products.write, orders.read, staff.manage)', perms >= 20 && (await val(`select count(*)::int from public.permissions where code in ('inventory.adjust','products.write','orders.read','staff.manage')`)) === 4, `${perms} permissions`);
  const per = (await c.query(`select r.code, count(rp.permission_code)::int n from public.roles r left join public.role_permissions rp on rp.role_id = r.id group by r.code`)).rows;
  const n = Object.fromEntries(per.map(r => [r.code, r.n]));
  ok('super_admin holds every permission; admin all but roles.manage; every role has some', n.super_admin === perms && n.admin === perms - 1 && per.every(r => r.n > 0), JSON.stringify(n));
  const cust = await one(`select count(*)::int n, bool_and(c.id = p.id and c.id = u.id and c.legacy_auth_user_id = c.id and c.email = lower(u.email)) same_ids, bool_and(c.password_hash is null) no_pw
    from public.customers c join public.profiles p on p.id = c.id join auth.users u on u.id = c.id`);
  ok('2 existing accounts copied to customers with the SAME UUID as Supabase Auth', cust.n === 2 && cust.same_ids && (await val('select count(*)::int from public.customers')) === 2, JSON.stringify(cust));
  ok('no passwords copied yet (that is M6)', cust.no_pw);
  const counts = (await c.query(EMPTY.map(t => `select '${t}' t, count(*)::int n from public.${t}`).join(' union all '))).rows.filter(r => r.n !== 0);
  ok(`${EMPTY.length} new data tables start empty (no staff, sessions, tokens, carts, payments, invoices, audit events)`, counts.length === 0, counts.map(r => `${r.t}=${r.n}`).join(' ') || 'all 0');
  const tax = await one(`select count(*)::int n, max(rate_bp) bp, bool_and(is_inclusive) incl from public.tax_rates`);
  ok('one tax rate: 0 %, tax-inclusive', tax.n === 1 && tax.bp === 0 && tax.incl, JSON.stringify(tax));
  ok('settings seeded', (await val(`select count(*)::int from public.settings`)) === 12);
  const legacy = await one(`select count(*)::int n, count(balance_after)::int with_balance, count(staff_id)::int with_staff from public.inventory_movements`);
  ok('existing 110 stock-history rows untouched (new columns null)', legacy.n === 110 && legacy.with_balance === 0 && legacy.with_staff === 0, JSON.stringify(legacy));

  // ---------- reporting views (real data) ----------
  ok('v_sales_daily: no rows, i.e. revenue 0 (there are no orders)', (await val(`select count(*)::int from public.v_sales_daily`)) === 0);
  const inv = await one(`select count(*)::int n, sum(stock_qty)::int stock, count(*) filter (where stock_status = 'in_stock')::int in_stock, count(*) filter (where stock_status = 'low_stock')::int low, count(*) filter (where stock_status = 'out_of_stock')::int out from public.v_inventory_status`);
  ok('v_inventory_status covers all 110 variants and matches real stock', inv.n === 110 && inv.stock === before.stock, JSON.stringify(inv));
  const low = await val(`select count(*)::int from public.v_low_stock`);
  const lowDirect = await val(`select count(*)::int from public.product_variants v join public.products p on p.id = v.product_id where v.is_active and p.status = 'active' and v.stock_qty <= coalesce(v.reorder_level, 3)`);
  ok('v_low_stock matches a direct count', low === lowDirect, `${low} low/out-of-stock sellable variants`);
  const cs = await one(`select count(*)::int n, sum(orders_count)::int orders, sum(lifetime_value_paise)::int ltv from public.v_customer_summary`);
  ok('v_customer_summary: 2 real customers, 0 orders, 0 lifetime value', cs.n === 2 && cs.orders === 0 && cs.ltv === 0, JSON.stringify(cs));

  // ---------- stock function and guard (rolled back) ----------
  const v = await one(`select id, stock_qty from public.product_variants where is_active order by sku limit 1`);
  const a1 = await one(`select * from public.adjust_stock($1, 2, 'restock', null, 'M2 verification (rolled back)')`, [v.id]);
  const m1 = await one(`select delta, reason, balance_after from public.inventory_movements where id = $1`, [a1.movement_id]);
  ok('adjust_stock(+2, restock) updates stock and writes the ledger row together', a1.balance_after === v.stock_qty + 2 && m1.balance_after === v.stock_qty + 2 && m1.delta === 2
    && (await val(`select stock_qty from public.product_variants where id = $1`, [v.id])) === v.stock_qty + 2, JSON.stringify(m1));
  const a2 = await one(`select * from public.adjust_stock($1, -2, 'correction')`, [v.id]);
  ok('adjust_stock(-2, correction) returns to the original quantity', a2.balance_after === v.stock_qty);
  await expectError('direct UPDATE of stock_qty is rejected (even for the table owner)', `update public.product_variants set stock_qty = stock_qty + 1 where id = $1`, '42501', [v.id]);
  await expectError('adjust_stock rejects a reason used in the wrong direction', `select public.adjust_stock($1, -1, 'restock')`, '22023', [v.id]);
  await expectError('adjust_stock rejects an unknown reason', `select public.adjust_stock($1, 1, 'free_stuff')`, '22023', [v.id]);
  await expectError('adjust_stock rejects a zero change', `select public.adjust_stock($1, 0, 'correction')`, '22023', [v.id]);
  await expectError('adjust_stock rejects going below zero', `select public.adjust_stock($1, -100000, 'correction')`, '23514', [v.id]);
  await expectError('adjust_stock rejects an unknown / inactive staff id', `select public.adjust_stock($1, 1, 'restock', gen_random_uuid())`, '42501', [v.id]);

  // ---------- numbering (rolled back) ----------
  ok('financial year: 31 Mar 2026 → 2025-26, 1 Apr 2026 → 2026-27', (await val(`select public.financial_year_of('2026-03-31')`)) === '2025-26' && (await val(`select public.financial_year_of('2026-04-01')`)) === '2026-27');
  const n1 = await val(`select public.next_document_number('invoice', 'KTS', '2026-09-25')`), n2 = await val(`select public.next_document_number('invoice', 'KTS', '2026-09-25')`);
  ok('invoice numbers are sequential per FY and ≤ 16 characters (GST)', n1 === 'KTS/26-27/00001' && n2 === 'KTS/26-27/00002' && n1.length <= 16, `${n1}, ${n2}`);

  // ---------- app roles (membership granted inside this transaction only) ----------
  await c.query(`grant kitsyuu_admin, kitsyuu_website to current_user with set true`);
  await asRole('kitsyuu_admin', async () => {
    ok('kitsyuu_admin can read staff, customers and audit log', (await val(`select count(*)::int from public.customers`)) === 2 && (await val(`select count(*)::int from public.audit_logs`)) >= 0);
    const id = await val(`insert into public.audit_logs (actor_type, action, entity_type, entity_id, metadata) values ('system', 'verify.append', 'audit_logs', null, '{"rolled_back": true}') returning id`);
    ok('kitsyuu_admin can append to the audit log', Number(id) > 0);
    await expectError('kitsyuu_admin cannot UPDATE audit history', `update public.audit_logs set action = 'x.y' where id = $1`, '42501', [id]);
    await expectError('kitsyuu_admin cannot DELETE audit history', `delete from public.audit_logs where id = $1`, '42501', [id]);
    await expectError('kitsyuu_admin cannot TRUNCATE audit history', `truncate public.audit_logs`, '42501');
    await expectError('kitsyuu_admin cannot UPDATE stock_qty directly (column not granted)', `update public.product_variants set stock_qty = stock_qty where id = $1`, '42501', [v.id]);
    const b = await one(`select * from public.adjust_stock($1, 1, 'restock')`, [v.id]);
    ok('kitsyuu_admin can change stock through adjust_stock()', b.balance_after === v.stock_qty + 1);
    await c.query(`update public.product_variants set price_paise = price_paise where id = $1`, [v.id]);
    ok('kitsyuu_admin can edit other variant columns (price)', true);
  });
  await expectError('audit log rejects UPDATE even for the table owner (trigger)', `update public.audit_logs set action = 'x.y'`, '42501');
  await expectError('audit log rejects DELETE even for the table owner (trigger)', `delete from public.audit_logs`, '42501');
  await expectError('audit log rejects TRUNCATE even for the table owner (trigger)', `truncate public.audit_logs`, '42501');
  ok('service_role has no UPDATE / DELETE / TRUNCATE on audit_logs', !(await val(`select has_table_privilege('service_role', 'public.audit_logs', 'UPDATE') or has_table_privilege('service_role', 'public.audit_logs', 'DELETE') or has_table_privilege('service_role', 'public.audit_logs', 'TRUNCATE')`)));
  await asRole('kitsyuu_website', async () => {
    ok('kitsyuu_website reads the catalogue (22 active products, 110 variants)', (await val(`select count(*)::int from public.products`)) === 22 && (await val(`select count(*)::int from public.product_variants`)) === 110);
    ok('kitsyuu_website sees only public settings', (await val(`select bool_and(is_public) from public.settings`)) === true);
    await expectError('kitsyuu_website cannot read staff_users', `select 1 from public.staff_users`, '42501');
    await expectError('kitsyuu_website cannot read roles / permissions', `select 1 from public.role_permissions`, '42501');
    await expectError('kitsyuu_website cannot read the audit log', `select 1 from public.audit_logs`, '42501');
    await expectError('kitsyuu_website cannot write the audit log', `insert into public.audit_logs (actor_type, action, entity_type) values ('system', 'x.y', 'z')`, '42501');
    await expectError('kitsyuu_website cannot change products', `update public.products set name = name`, '42501');
    await expectError('kitsyuu_website cannot change stock (no adjust_stock)', `select public.adjust_stock($1, 1, 'restock')`, '42501', [v.id]);
    await expectError('kitsyuu_website cannot read reporting views', `select 1 from public.v_customer_summary`, '42501');
  });
} catch (e) {
  ok('verification ran to completion', false, e.message);
} finally {
  await c.query('rollback').catch(() => {});
}

// ---------- nothing persisted ----------
const after = await one(`select (select coalesce(sum(stock_qty),0)::int from public.product_variants) stock, (select count(*)::int from public.inventory_movements) moves,
  (select count(*)::int from public.audit_logs) audit, (select count(*)::int from public.document_sequences) seqs,
  (select count(*)::int from pg_auth_members m join pg_roles r on r.oid = m.roleid where r.rolname like 'kitsyuu%' and m.member = (select oid from pg_roles where rolname = current_user) and m.set_option) memberships`);
ok('after rollback: stock total 1100, 110 movements, 0 audit rows, 0 sequences, no role memberships kept', after.stock === 1100 && after.moves === 110 && after.audit === 0 && after.seqs === 0 && after.memberships === 0, JSON.stringify(after));
await c.end();

// ---------- public API (publishable key, exactly what a browser can do) ----------
const base = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const api = async (path, init = {}) => {
  const r = await fetch(`${base}/rest/v1/${path}`, {...init, headers: {apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {})}});
  const body = await r.text(); let rows = null; try { const j = JSON.parse(body); rows = Array.isArray(j) ? j.length : null; } catch {}
  return {status: r.status, rows};
};
for (const t of ['staff_users', 'customers', 'customer_sessions', 'auth_tokens', 'audit_logs', 'settings', 'payments', 'v_customer_summary', 'v_inventory_status', 'role_permissions']) {
  const r = await api(`${t}?select=*&limit=1`);
  ok(`public API cannot read ${t}`, r.status >= 400 || r.rows === 0, `HTTP ${r.status}${r.rows !== null ? `, ${r.rows} rows` : ''}`);
}
const rpc = await api('rpc/adjust_stock', {method: 'POST', body: JSON.stringify({p_variant_id: '00000000-0000-0000-0000-000000000000', p_delta: 1, p_reason: 'restock'})});
ok('public API cannot call adjust_stock()', rpc.status >= 400, `HTTP ${rpc.status}`);
const ins = await api('audit_logs', {method: 'POST', body: JSON.stringify({actor_type: 'system', action: 'x.y', entity_type: 'z'})});
ok('public API cannot write the audit log', ins.status >= 400, `HTTP ${ins.status}`);
const cat = await api('products?select=id');
ok('public API still reads the 22 catalogue products (existing RLS unchanged)', cat.status === 200 && cat.rows === 22, `HTTP ${cat.status}, ${cat.rows} rows`);

console.log(out.join('\n'));
const failed = out.filter(l => l.startsWith('FAIL')).length;
console.log(`\n${out.length - failed}/${out.length} platform checks passed`);
process.exitCode = failed ? 1 : 0;
