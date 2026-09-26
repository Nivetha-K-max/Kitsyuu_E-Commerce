/* Test orders for the LOCAL test database only (never Supabase): the website checkout does not write orders yet, so the
   admin order tools are exercised against these. Everything goes through the real schema: order lines are priced from
   the catalogue (line = unit × qty, subtotal = sum of lines), status histories are complete, payments/invoice use the
   M2 billing tables and numbering function, and stock is taken with adjust_stock('sale') so ledger and stock agree.
   Usage: import { createOrderFixtures } from '<repo>/database/test/order-fixtures.mjs'; await createOrderFixtures(connectionString) */
import pg from 'pg';

const DAY = d => `2026-09-${String(d).padStart(2, '0')} 10:00:00+05:30`;
const CUSTOMERS = [
  {key: 'asha', email: 'asha.fixture@test.local', name: 'Asha Fixture', phone: '+91 90000 00001',
    address: {full_name: 'Asha Fixture', line1: '12 Test Street', line2: 'Flat 3', city: 'Coimbatore', state: 'Tamil Nadu', pin: '641001', country: 'India'}},
  {key: 'ravi', email: 'ravi.fixture@test.local', name: 'Ravi Fixture', phone: '+91 90000 00002',
    address: {full_name: 'Ravi Fixture', line1: '7 Sample Road', city: 'Chennai', state: 'Tamil Nadu', pin: '600001', country: 'India'}},
];
// [number, customer, status, payment_status, placed day, lines [product, variant index, qty], payment status | null, history path, stock]
// stock: 'held' = sale movement kept; 'released' = sale then cancel (net 0); 'none' = never took stock
const ORDERS = [
  ['KTS-TEST-0001', 'asha', 'pending_payment', 'pending', 24, [['ky-proto-001', 0, 2]], null, ['pending_payment'], 'held'],
  ['KTS-TEST-0002', 'asha', 'paid', 'paid', 20, [['ky-proto-002', 0, 1], ['ky-proto-003', 0, 1]], 'captured', ['pending_payment', 'paid'], 'held'],
  ['KTS-TEST-0003', 'asha', 'processing', 'paid', 21, [['ky-proto-004', 1, 1]], 'captured', ['pending_payment', 'paid', 'processing'], 'held'],
  ['KTS-TEST-0004', 'ravi', 'shipped', 'paid', 15, [['ky-proto-005', 2, 3]], 'captured', ['pending_payment', 'paid', 'processing', 'shipped'], 'held'],
  ['KTS-TEST-0005', 'ravi', 'delivered', 'paid', 10, [['ky-proto-006', 0, 1]], 'captured', ['pending_payment', 'paid', 'processing', 'shipped', 'delivered'], 'held'],
  ['KTS-TEST-0006', 'ravi', 'cancelled', 'unpaid', 12, [['ky-proto-007', 0, 1]], null, ['pending_payment', 'cancelled'], 'released'],
  ['KTS-TEST-0007', 'asha', 'payment_failed', 'failed', 25, [['ky-proto-008', 0, 1]], 'failed', ['pending_payment', 'payment_failed'], 'held'],
  ['KTS-TEST-0008', 'asha', 'pending_payment', 'authorized', 23, [['ky-proto-009', 0, 1]], 'authorized', ['pending_payment'], 'held'],
];

export async function createOrderFixtures(connectionString) {
  const u = new URL(connectionString);
  if (!['localhost', '127.0.0.1'].includes(u.hostname)) throw new Error('order fixtures may only be created in a local test database');
  const c = new pg.Client({connectionString}); await c.connect();
  try {
    await c.query('begin');
    const cust = {};
    for (const k of CUSTOMERS) {
      const {rows: [a]} = await c.query(`insert into auth.users (email, email_confirmed_at) values ($1, now()) returning id`, [k.email]);
      await c.query(`insert into public.customers (id, email, full_name, phone, email_verified_at, legacy_auth_user_id) values ($1, $2, $3, $4, now(), $1)`, [a.id, k.email, k.name, k.phone]);
      cust[k.key] = {id: a.id, ...k};
    }
    const ids = {};
    let held = 0;
    for (const [number, who, status, paymentStatus, day, lines, payment, path, stock] of ORDERS) {
      const k = cust[who];
      const priced = [];
      for (const [pid, vIndex, qty] of lines) {
        const {rows: [v]} = await c.query(`select v.id, v.sku, v.size, p.name, p.price_paise, (select storage_path from product_images i where i.product_id = p.id order by is_primary desc limit 1) img
          from product_variants v join products p on p.id = v.product_id where p.id = $1 order by v.sort_order offset $2 limit 1`, [pid, vIndex]);
        priced.push({pid, v, qty, line: v.price_paise * qty});
      }
      const subtotal = priced.reduce((n, l) => n + l.line, 0);
      const {rows: [o]} = await c.query(`insert into public.orders (order_number, user_id, customer_id, status, payment_status, subtotal_paise, total_paise, contact, shipping_address, paid_at, created_at, updated_at)
        values ($1, $2, $2, $3, $4, $5, $5, $6, $7, $8, $9, $9) returning id`,
        [number, k.id, status, paymentStatus, subtotal, JSON.stringify({name: k.name, email: k.email, phone: k.phone}), JSON.stringify(k.address),
          ['paid', 'processing', 'shipped', 'delivered'].includes(status) ? DAY(day) : null, DAY(day)]);
      ids[number] = o.id;
      for (const l of priced)
        await c.query(`insert into public.order_items (order_id, product_id, variant_id, sku, name, size, image_path, unit_price_paise, qty, line_total_paise) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [o.id, l.pid, l.v.id, l.v.sku, l.v.name, l.v.size, l.v.img, l.v.price_paise, l.qty, l.line]);
      for (let i = 0; i < path.length; i++)
        await c.query(`insert into public.order_status_history (order_id, from_status, to_status, note, created_at) values ($1, $2, $3, $4, $5::timestamptz + make_interval(hours => $6))`,
          [o.id, i ? path[i - 1] : null, path[i], i === 0 ? 'Order placed (test fixture)' : null, DAY(day), i]);
      for (const l of priced) {
        if (stock === 'none') continue;
        await c.query(`select public.adjust_stock($1, $2, 'sale', null, $3, $4)`, [l.v.id, -l.qty, `Order ${number} (test fixture)`, o.id]);
        if (stock === 'released') await c.query(`select public.adjust_stock($1, $2, 'cancel', null, $3, $4)`, [l.v.id, l.qty, `Order ${number} cancelled (test fixture)`, o.id]);
        else held += l.qty;
      }
      if (payment) {
        await c.query(`insert into public.payments (order_id, provider, provider_payment_id, amount_paise, status, method, failure_reason, captured_at)
          values ($1, 'razorpay', $2, $3, $4, 'upi', $5, $6)`,
          [o.id, `pay_TEST${number.slice(-4)}`, subtotal, payment, payment === 'failed' ? 'Declined by bank (test fixture)' : null, payment === 'captured' ? DAY(day) : null]);
      }
      if (number === 'KTS-TEST-0002') {
        const {rows: [n]} = await c.query(`select public.next_document_number('invoice', 'KTS', $1::date) n`, [`2026-09-${day}`]);
        const {rows: [inv]} = await c.query(`insert into public.invoices (invoice_number, status, order_id, customer_id, financial_year, issued_at, subtotal_paise, tax_paise, total_paise, prices_include_tax)
          values ($1, 'issued', $2, $3, public.financial_year_of($4::date), $5, $6, 0, $6, true) returning id`, [n.n, o.id, k.id, `2026-09-${day}`, DAY(day), subtotal]);
        for (const [i, l] of priced.entries())
          await c.query(`insert into public.invoice_items (invoice_id, position, description, sku, qty, unit_price_paise, tax_rate_bp, tax_paise, line_total_paise) values ($1,$2,$3,$4,$5,$6,0,0,$7)`,
            [inv.id, i, `${l.v.name} (${l.v.size})`, l.v.sku, l.qty, l.v.price_paise, l.line]);
      }
    }
    await c.query('commit');
    return {orders: ORDERS.length, customers: CUSTOMERS.length, unitsHeld: held, ids, customers_: cust};
  } catch (e) { await c.query('rollback').catch(() => {}); throw e; }
  finally { await c.end(); }
}

// CLI: node database/test/order-fixtures.mjs  (uses KITSYUU_DB_URL; prints only counts)
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const r = await createOrderFixtures(process.env.KITSYUU_DB_URL);
  console.log(`order fixtures: ${r.orders} orders, ${r.customers} customers, ${r.unitsHeld} units taken from stock`);
}
