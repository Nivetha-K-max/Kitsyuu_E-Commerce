/* Demo data for showing the admin dashboard: sample customers, orders (every stage), shipments, payments, vendors,
   materials, purchase orders and production orders. Everything is clearly marked and can be removed in one command:
     customers  …@demo.kitsyuu.test      orders  KTS-DEMO-…      payments  provider "demo"
     vendors    "Demo …"                 materials  DEMO-…       purchase orders PO-DEMO-…   production MO-DEMO-…
   It never changes stock (no stock movements; demo orders did not really take pieces), never creates logins (demo
   customers have no password and no Supabase Auth user) and never publishes anything on the store (no reviews, no
   content). Dates are relative to today, so the dashboard's 30-day trends have data.
   Usage (repo root):
     node --env-file=apps/website/.env.local database/scripts/demo-data.mjs --status    counts only (read-only)
     node --env-file=apps/website/.env.local database/scripts/demo-data.mjs --apply     add (refused if demo data exists)
     node --env-file=apps/website/.env.local database/scripts/demo-data.mjs --remove    delete every demo row
   Target: the Supabase database (SUPABASE_DB_URL, with SUPABASE_DB_POOLER_HOST on IPv4 networks), or KITSYUU_DB_URL for a
   local test database. Prints counts only. */
import {connect} from './lib/connection.mjs';

const MODE = ['--status', '--apply', '--remove'].find(m => process.argv.includes(m));
if (!MODE) { console.error('Usage: demo-data --status | --apply | --remove'); process.exit(1); }

const CUSTOMERS = [
  ['aarav', 'Aarav Mehta', '+91 98400 10001', 'Chennai', 'Tamil Nadu', '600017', 58],
  ['diya', 'Diya Raman', '+91 98400 10002', 'Coimbatore', 'Tamil Nadu', '641004', 51],
  ['kabir', 'Kabir Nair', '+91 98400 10003', 'Kochi', 'Kerala', '682016', 44],
  ['meera', 'Meera Iyer', '+91 98400 10004', 'Bengaluru', 'Karnataka', '560034', 33],
  ['rohan', 'Rohan Das', '+91 98400 10005', 'Hyderabad', 'Telangana', '500032', 21],
  ['sara', 'Sara Thomas', '+91 98400 10006', 'Mumbai', 'Maharashtra', '400050', 12],
  ['vikram', 'Vikram Rao', '+91 98400 10007', 'Pune', 'Maharashtra', '411001', 6],
];
// [customer, status, days ago, lines [[product index in catalogue order, size index, qty]], shipment: packing state / tracking]
const ORDERS = [
  ['aarav', 'delivered', 52, [[1, 1, 1]]], ['diya', 'delivered', 47, [[4, 2, 1], [11, 1, 1]]], ['kabir', 'delivered', 41, [[7, 0, 2]]],
  ['aarav', 'delivered', 36, [[14, 2, 1]]], ['meera', 'delivered', 31, [[2, 1, 1], [17, 2, 1]]], ['diya', 'delivered', 27, [[20, 1, 1]]],
  ['rohan', 'delivered', 22, [[9, 2, 1]]], ['meera', 'delivered', 18, [[5, 1, 2]]], ['kabir', 'delivered', 15, [[12, 0, 1], [3, 2, 1]]],
  ['sara', 'shipped', 11, [[6, 1, 1]], 'DLV40291877'], ['aarav', 'shipped', 9, [[18, 2, 1]], 'DLV40291902'], ['rohan', 'shipped', 7, [[0, 1, 1]], null],
  ['meera', 'processing', 5, [[13, 1, 1]], 'packed'], ['vikram', 'processing', 4, [[8, 2, 1], [15, 1, 1]], 'packing'], ['sara', 'processing', 3, [[10, 0, 1]], 'not_started'],
  ['diya', 'paid', 2, [[16, 1, 1]]], ['vikram', 'paid', 1, [[19, 2, 2]]],
  ['kabir', 'pending_payment', 1, [[21, 1, 1]]], ['rohan', 'pending_payment', 0, [[1, 2, 1]]],
  ['sara', 'payment_failed', 3, [[4, 1, 1]]], ['aarav', 'cancelled', 26, [[7, 1, 1]]], ['meera', 'cancelled', 8, [[11, 2, 1]]],
];
const PATH = {
  delivered: ['pending_payment', 'paid', 'processing', 'shipped', 'delivered'], shipped: ['pending_payment', 'paid', 'processing', 'shipped'],
  processing: ['pending_payment', 'paid', 'processing'], paid: ['pending_payment', 'paid'], pending_payment: ['pending_payment'],
  payment_failed: ['pending_payment', 'payment_failed'], cancelled: ['pending_payment', 'cancelled'],
};
const VENDORS = [
  ['Demo Tiruppur Knits', 'Selvi K', 'orders@tiruppurknits.demo.kitsyuu.test', '+91 94430 20001', '33ABCDE1234F1Z5'],
  ['Demo Surat Denim Mills', 'Harsh P', 'sales@suratdenim.demo.kitsyuu.test', '+91 94430 20002', '24ABCDE1234F1Z6'],
  ['Demo Chennai Trims & Hardware', 'Imran S', 'hello@chennaitrims.demo.kitsyuu.test', '+91 94430 20003', null],
];
const MATERIALS = [['DEMO-TWILL-OLV', 'Cotton twill, olive', 'm', 40], ['DEMO-DENIM-12OZ', '12 oz denim, washed black', 'm', 60],
  ['DEMO-JERSEY-GRY', 'Heavy jersey, grey', 'm', 30], ['DEMO-HOOK-STEEL', 'Steel hook closures', 'pcs', 200]];

const at = daysAgo => `now() - make_interval(days => ${Number(daysAgo)}) - make_interval(hours => ${3 + (daysAgo % 7)})`;

const c = await connect();
try {
  const count = async () => (await c.query(`select
      (select count(*) from customers where email like '%@demo.kitsyuu.test')::int customers,
      (select count(*) from orders where order_number like 'KTS-DEMO-%')::int orders,
      (select count(*) from vendors where name like 'Demo %')::int vendors,
      (select count(*) from materials where code like 'DEMO-%')::int materials,
      (select count(*) from purchase_orders where po_number like 'PO-DEMO-%')::int purchase_orders,
      (select count(*) from production_orders where number like 'MO-DEMO-%')::int production_orders`)).rows[0];

  if (MODE === '--status') { console.log('demo data:', JSON.stringify(await count())); process.exit(0); }

  if (MODE === '--remove') {
    await c.query('begin');
    const demoOrders = `select id from orders where order_number like 'KTS-DEMO-%'`;
    const moved = (await c.query(`select count(*)::int n from inventory_movements where order_id in (${demoOrders})`)).rows[0].n;
    if (moved) throw new Error(`refusing: ${moved} stock movements point at demo orders (this script never creates any)`);
    for (const t of ['order_status_history', 'order_items', 'payments', 'shipments']) await c.query(`delete from ${t} where order_id in (${demoOrders})`);
    await c.query(`delete from payment_events where order_id in (${demoOrders})`);
    await c.query(`delete from orders where order_number like 'KTS-DEMO-%'`);
    await c.query(`delete from customer_notes where customer_id in (select id from customers where email like '%@demo.kitsyuu.test')`);
    await c.query(`delete from addresses where customer_id in (select id from customers where email like '%@demo.kitsyuu.test')`);
    await c.query(`delete from customers where email like '%@demo.kitsyuu.test'`);
    await c.query(`delete from production_inputs where production_order_id in (select id from production_orders where number like 'MO-DEMO-%')`);
    await c.query(`delete from production_orders where number like 'MO-DEMO-%'`);
    await c.query(`delete from purchase_order_lines where purchase_order_id in (select id from purchase_orders where po_number like 'PO-DEMO-%')`);
    await c.query(`delete from purchase_orders where po_number like 'PO-DEMO-%'`);
    await c.query(`delete from materials where code like 'DEMO-%'`);
    await c.query(`delete from vendors where name like 'Demo %'`);
    await c.query('commit');
    console.log('removed; now:', JSON.stringify(await count()));
    process.exit(0);
  }

  // --apply
  const before = await count();
  if (Object.values(before).some(n => n > 0)) throw new Error(`demo data already present ${JSON.stringify(before)}; run --remove first`);
  await c.query('begin');
  const stock = (await c.query(`select coalesce(sum(stock_qty), 0)::int n from product_variants`)).rows[0].n;
  const products = (await c.query(`select p.id, p.name, p.price_paise,
      (select storage_path from product_images i where i.product_id = p.id order by is_primary desc, sort_order limit 1) img
    from products p where p.status = 'active' order by p.sku`)).rows;
  if (products.length < 22) throw new Error(`expected the 22-piece catalogue, found ${products.length} active products`);

  const cust = {};
  for (const [key, name, phone, city, state, pin, daysAgo] of CUSTOMERS) {
    const email = `${key}@demo.kitsyuu.test`;
    const {rows: [r]} = await c.query(`insert into customers (email, full_name, phone, email_verified_at, created_at, updated_at)
      values ($1, $2, $3, ${at(daysAgo)}, ${at(daysAgo)}, ${at(daysAgo)}) returning id`, [email, name, phone]);
    cust[key] = {id: r.id, name, email, phone, address: {full_name: name, line1: `${10 + daysAgo} Demo Street`, city, state, pin, country: 'India'}};
  }

  let n = 0;
  for (const [who, status, daysAgo, lines, ship] of ORDERS) {
    n++;
    const number = `KTS-DEMO-${String(n).padStart(4, '0')}`, k = cust[who];
    const priced = [];
    for (const [pi, si, qty] of lines) {
      const p = products[pi];
      const {rows: [v]} = await c.query(`select id, sku, size, coalesce(price_paise, $2) price from product_variants where product_id = $1 order by sort_order offset $3 limit 1`, [p.id, p.price_paise, si]);
      priced.push({p, v, qty, line: v.price * qty});
    }
    const subtotal = priced.reduce((s, l) => s + l.line, 0);
    const paid = ['paid', 'processing', 'shipped', 'delivered'].includes(status);
    const payStatus = paid ? 'paid' : status === 'payment_failed' ? 'failed' : status === 'cancelled' ? 'unpaid' : 'pending';
    const {rows: [o]} = await c.query(`insert into orders (order_number, customer_id, status, payment_status, subtotal_paise, total_paise, contact, shipping_address, paid_at, created_at, updated_at)
      values ($1, $2, $3, $4, $5, $5, $6, $7, ${paid ? at(daysAgo) : 'null'}, ${at(daysAgo)}, ${at(daysAgo)}) returning id`,
      [number, k.id, status, payStatus, subtotal, JSON.stringify({name: k.name, email: k.email, phone: k.phone}), JSON.stringify(k.address)]);
    for (const l of priced)
      await c.query(`insert into order_items (order_id, product_id, variant_id, sku, name, size, image_path, unit_price_paise, qty, line_total_paise) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [o.id, l.p.id, l.v.id, l.v.sku, l.p.name, l.v.size, l.p.img, l.v.price, l.qty, l.line]);
    const path = PATH[status];
    for (let i = 0; i < path.length; i++)
      await c.query(`insert into order_status_history (order_id, from_status, to_status, note, created_at) values ($1, $2, $3, $4, ${at(daysAgo)} + make_interval(hours => ${i * 20}))`,
        [o.id, i ? path[i - 1] : null, path[i], i === 0 ? 'Demo order' : null]);
    if (paid || status === 'payment_failed')
      await c.query(`insert into payments (order_id, provider, provider_payment_id, amount_paise, status, method, failure_reason, captured_at)
        values ($1, 'demo', $2, $3, $4, $5, $6, ${paid ? at(daysAgo) : 'null'})`,
        [o.id, `demo_${number.slice(-4)}`, subtotal, paid ? 'captured' : 'failed', ['upi', 'card', 'netbanking'][n % 3], paid ? null : 'Declined by bank (demo)']);
    if (['processing', 'shipped', 'delivered'].includes(status)) {
      const packing = status === 'processing' ? ship : 'packed';
      const tracking = status === 'delivered' ? `DLV4029${1000 + n}` : status === 'shipped' ? ship : null;
      await c.query(`insert into shipments (order_id, carrier_code, tracking_number, packing_state, shipped_at, delivered_at, created_at, updated_at)
        values ($1, 'manual', $2, $3, ${status === 'processing' ? 'null' : at(Math.max(0, daysAgo - 1))}, ${status === 'delivered' ? at(Math.max(0, daysAgo - 3)) : 'null'}, ${at(daysAgo)}, ${at(daysAgo)})`,
        [o.id, tracking, packing]);
    }
  }

  const vend = [];
  for (const [name, contact, email, phone, gstin] of VENDORS)
    vend.push((await c.query(`insert into vendors (name, contact, email, phone, gstin, address, notes) values ($1,$2,$3,$4,$5,'Demo address','Demo vendor') returning id`,
      [name, contact, email, phone, gstin])).rows[0].id);
  const mat = [];
  for (const [code, name, unit, reorder] of MATERIALS)
    mat.push((await c.query(`insert into materials (code, name, unit, stock_qty, reorder_level, notes) values ($1,$2,$3,0,$4,'Demo material') returning id`, [code, name, unit, reorder])).rows[0].id);
  const po = async (number, vendor, status, daysAgo, lines) => {
    const {rows: [r]} = await c.query(`insert into purchase_orders (po_number, vendor_id, status, expected_on, notes, ordered_at, created_at, updated_at)
      values ($1, $2, $3, (now() + interval '9 days')::date, 'Demo purchase order', ${status === 'draft' ? 'null' : at(daysAgo)}, ${at(daysAgo)}, ${at(daysAgo)}) returning id`, [number, vendor, status]);
    for (const [m, qty, cost] of lines) await c.query(`insert into purchase_order_lines (purchase_order_id, material_id, qty_ordered, unit_cost_paise) values ($1,$2,$3,$4)`, [r.id, m, qty, cost]);
  };
  await po('PO-DEMO-0001', vend[1], 'ordered', 4, [[mat[1], 120, 38000]]);
  await po('PO-DEMO-0002', vend[0], 'ordered', 2, [[mat[0], 80, 26000], [mat[2], 60, 31000]]);
  await po('PO-DEMO-0003', vend[2], 'draft', 1, [[mat[3], 500, 1800]]);
  const variant = async pi => (await c.query(`select id from product_variants where product_id = $1 order by sort_order limit 1`, [products[pi].id])).rows[0].id;
  await c.query(`insert into production_orders (number, variant_id, qty_planned, status, due_on, notes, created_at, updated_at)
    values ('MO-DEMO-0001', $1, 40, 'planned', (now() + interval '14 days')::date, 'Demo production order', ${at(2)}, ${at(2)})`, [await variant(1)]);
  await c.query(`insert into production_orders (number, variant_id, qty_planned, status, due_on, notes, started_at, created_at, updated_at)
    values ('MO-DEMO-0002', $1, 25, 'in_progress', (now() + interval '6 days')::date, 'Demo production order', ${at(3)}, ${at(5)}, ${at(3)})`, [await variant(18)]);

  const after = (await c.query(`select coalesce(sum(stock_qty), 0)::int n from product_variants`)).rows[0].n;
  if (after !== stock) throw new Error('stock changed; rolling back');
  await c.query('commit');
  console.log('added:', JSON.stringify(await count()), `| stock unchanged (${after} units)`);
} catch (e) {
  await c.query('rollback').catch(() => {});
  console.error('demo-data:', e.message);
  process.exitCode = 1;
} finally {
  await c.end();
}
