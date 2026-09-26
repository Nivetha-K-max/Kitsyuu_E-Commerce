/* Order-management browser tests for the Admin/ERP app, against a LOCAL test database loaded with
   database/test/order-fixtures.mjs (never Supabase). Started by tests/run-e2e.mjs with BASE, KITSYUU_DB_URL and
   INVITES (one-time links for: sales, support, accountant, inventory = inventory_manager). */
import fs from 'node:fs';
import pg from 'pg';
import {launch} from '../../website/tests/cdp.mjs';

const {BASE, KITSYUU_DB_URL} = process.env;
const INVITES = JSON.parse(process.env.INVITES);
const out = []; const ok = (n, p, x = '') => out.push(`${p ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`);
const w = ms => new Promise(r => setTimeout(r, ms));
const PW = 'orders e2e passphrase';
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;

const b = await launch(9391);
const ev = e => b.eval(e);
const until = async (expr, ms = 10000) => { for (let t = 0; t < ms; t += 100) { if (await ev(expr).catch(() => false)) return true; await w(100); } return false; };
const fill = (sel, v) => ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)throw new Error('no field ' + ${JSON.stringify(sel)});
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,${JSON.stringify(v)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
const submit = async formSel => {
  const sel = JSON.stringify(formSel), start = await ev('location.pathname + location.search');
  await ev(`(()=>{const btn=document.querySelector(${JSON.stringify(formSel + ' button[type=submit]')});if(!btn)throw new Error('no submit button for ' + ${sel});btn.click();return true})()`);
  await until(`!!document.querySelector(${sel})?.matches('[aria-busy=true]') || (location.pathname + location.search) !== ${JSON.stringify(start)}`, 3000);
  if (!(await until(`!document.querySelector(${sel})?.matches('[aria-busy=true]')`, 20000))) throw new Error(`submission of ${formSel} did not finish`);
};
const F = '#order-status-form';
const message = () => ev(`document.querySelector('${F} [data-form-message]')?.innerText ?? ''`);
const fieldError = name => ev(`document.querySelector('${F} [name=${name}]')?.closest('.field')?.querySelector('.field-error')?.innerText ?? ''`);
const exists = sel => ev(`!!document.querySelector(${JSON.stringify(sel)})`);
const rows = () => ev(`[...document.querySelectorAll('[data-order-row]')].map(r=>r.dataset.orderRow)`);
const allErrors = [];
const visit = async (p, ready = '!!document.querySelector("main")') => { await b.goto(BASE + p, ready); allErrors.push(...b.errors.filter(e => !/http 40[34]/.test(e))); };
const autoConfirm = () => ev(`window.__q=[];window.confirm=q=>{window.__q.push(q);return true};true`);
const confirms = () => ev('window.__q ?? []');
const id = async num => (await q(`select id from orders where order_number = $1`, [num]))[0].id;
const statusOf = async num => (await q(`select status from orders where order_number = $1`, [num]))[0].status;

async function signIn(key, name) {
  await b.send('Network.clearBrowserCookies');
  const link = fs.readFileSync(INVITES[key], 'utf8').match(/accept-invite\?token=[A-Za-z0-9_-]{43}/)[0];
  await visit('/' + link, '!!document.querySelector("input[name=password]")');
  await fill('main input[name=fullName]', name); await fill('main input[name=password]', PW); await fill('main input[name=confirm]', PW);
  await submit('main form');
  return until(`location.pathname==='/dashboard'`);
}

try {
  await b.viewport(1440, 900);
  const amountsBefore = await q(`select order_number, subtotal_paise, total_paise from orders order by order_number`);

  // ================= sales: can view and change status =================
  ok('sales signs in', await signIn('sales', 'Sales E2E'));
  ok('menu has Orders under Sales', /Orders/.test(await ev(`[...document.querySelectorAll('.nav a')].map(a=>a.textContent).join('|')`)));
  ok('dashboard counts the orders from the database', (await ev(`document.querySelector('[data-kpi="Orders"] dd')?.innerText ?? ''`)).startsWith('8'));

  // ---------- list, filters, search ----------
  await visit('/orders', '!!document.querySelector("[data-orders-table]")');
  const list = await rows();
  ok('orders list shows all 8 orders, newest first', list.length === 8 && list[0] === 'KTS-TEST-0007', list.join(','));
  ok('list shows total in ₹ and statuses', /₹[\d,]+\.\d\d/.test(await ev(`document.querySelector('[data-order-row="KTS-TEST-0002"] [data-total]').innerText`))
    && /PAID/i.test(await ev(`document.querySelector('[data-order-row="KTS-TEST-0002"]').innerText`)));
  await visit('/orders?status=open');
  ok('filter: open orders', JSON.stringify((await rows()).sort()) === JSON.stringify(['KTS-TEST-0001', 'KTS-TEST-0002', 'KTS-TEST-0003', 'KTS-TEST-0004', 'KTS-TEST-0008']));
  await visit('/orders?payment=failed');
  ok('filter: payment failed', (await rows()).join() === 'KTS-TEST-0007');
  await visit('/orders?q=ravi.fixture');
  ok('search by customer email', (await rows()).length === 3);
  await visit('/orders?q=KTS-TEST-0004');
  ok('search by order number', (await rows()).join() === 'KTS-TEST-0004');
  await visit('/orders?from=2026-09-20&to=2026-09-21');
  ok('filter: date range (IST, inclusive)', JSON.stringify((await rows()).sort()) === JSON.stringify(['KTS-TEST-0002', 'KTS-TEST-0003']));
  await visit('/orders?q=no-such-order');
  ok('empty state when nothing matches', await exists('[data-empty=orders]'));
  await visit('/orders?from=not-a-date');
  ok('invalid filter: explained, list still shown', /not valid/.test(await ev(`document.querySelector('main [role=alert]')?.innerText ?? ''`)) && (await rows()).length === 8);

  // ---------- detail ----------
  const o2 = await id('KTS-TEST-0002');
  await visit(`/orders/${o2}`, '!!document.querySelector("[data-items-table]")');
  const [sum] = await q(`select subtotal_paise s, total_paise t, (select count(*)::int from order_items where order_id = $1) n from orders where id = $1`, [o2]);
  ok('detail: order lines with SKU, size, unit price, qty and line total', (await ev(`document.querySelectorAll('[data-item]').length`)) === sum.n);
  const money = p => '₹' + (Math.trunc(p / 100)).toLocaleString('en-IN') + '.' + String(p % 100).padStart(2, '0');
  ok('detail: subtotal and total as recorded', (await ev(`document.querySelector('[data-subtotal]').innerText`)) === money(sum.s) && (await ev(`document.querySelector('[data-order-total]').innerText`)) === money(sum.t));
  ok('detail: amounts integrity check passes', await exists('[data-integrity=ok]'));
  ok('detail: customer contact and shipping address', /asha\.fixture@test\.local/.test(await ev(`document.querySelector('[data-section=customer]').innerText`)) && /Coimbatore/.test(await ev(`document.querySelector('[data-section=customer]').innerText`)));
  ok('detail: history lists placed → paid', (await ev(`[...document.querySelectorAll('[data-history-row]')].map(r=>r.dataset.historyRow).join()`)) === 'pending_payment,paid');
  ok('detail: sales (no billing.read) sees no payments or invoices', (await exists('[data-readonly=billing]')) && !(await exists('[data-payments-table]')));
  ok('detail: only the allowed next status is offered', (await ev(`[...document.querySelectorAll('${F} [name=toStatus] option')].map(o=>o.value).filter(Boolean).join()`)) === 'processing');

  // ---------- successful transition ----------
  await autoConfirm();
  await fill(`${F} [name=toStatus]`, 'processing'); await fill(`${F} [name=note]`, 'Packing today');
  await submit(F);
  ok('transition asks for confirmation', /Mark order KTS-TEST-0002 as Processing/.test((await confirms())[0] ?? ''));
  ok('transition: success message', (await message()) === 'KTS-TEST-0002: Paid → Processing.', await message());
  ok('transition: saved', (await statusOf('KTS-TEST-0002')) === 'processing');
  ok('transition: page shows the new status and next step', await until(`document.querySelector('[data-order-status]')?.dataset.orderStatus==='processing'`) && await until(`[...document.querySelectorAll('${F} [name=toStatus] option')].map(o=>o.value).includes('shipped')`));
  ok('history shows who made the change and the note', /Paid → Processing[\s\S]*ord\.sales@test\.local[\s\S]*Packing today/.test(await ev(`document.querySelector('[data-history]').innerText`)));
  const [au] = await q(`select a.before_data, a.after_data, s.email from audit_logs a join staff_users s on s.id = a.staff_id where a.action = 'order.status_update' and a.entity_id = $1 order by a.id desc limit 1`, [o2]);
  ok('audit record: staff, before and after', au?.email === 'ord.sales@test.local' && au.before_data.status === 'paid' && au.after_data.status === 'processing');

  // ---------- invalid transition (forged in the page) is refused by the server ----------
  await ev(`(()=>{const s=document.querySelector('${F} [name=toStatus]');const o=document.createElement('option');o.value='delivered';o.textContent='Delivered';s.appendChild(o);return true})()`);
  await fill(`${F} [name=toStatus]`, 'delivered');
  await submit(F);
  ok('invalid transition refused by the server (processing → delivered)', /cannot go from processing to delivered/.test(await fieldError('toStatus')) && (await statusOf('KTS-TEST-0002')) === 'processing', await fieldError('toStatus'));

  // ---------- stale change (someone else changed the order after the page loaded) ----------
  const o3 = await id('KTS-TEST-0003');
  await visit(`/orders/${o3}`, `!!document.querySelector('${F}')`);
  await q(`update orders set status = 'shipped' where id = $1`, [o3]);            // another session, simulated directly in the LOCAL test DB
  await q(`insert into order_status_history (order_id, from_status, to_status, note) values ($1, 'processing', 'shipped', 'other session (test)')`, [o3]);
  await autoConfirm();
  await fill(`${F} [name=toStatus]`, 'shipped');
  await submit(F);
  ok('stale change refused with an explanation', /changed to "shipped" since you opened it/.test(await message()), await message());
  const [h3] = await q(`select count(*)::int n from order_status_history where order_id = $1 and to_status = 'shipped'`, [o3]);
  ok('stale change wrote nothing', h3.n === 1);

  // ---------- cancellation: reason required, stock returned ----------
  const o1 = await id('KTS-TEST-0001');
  const [v1] = await q(`select v.id, v.stock_qty from order_items i join product_variants v on v.id = i.variant_id where i.order_id = $1`, [o1]);
  await visit(`/orders/${o1}`, `!!document.querySelector('${F}')`);
  await autoConfirm();
  await fill(`${F} [name=toStatus]`, 'cancelled');
  await submit(F);
  ok('cancel without a reason: field error, nothing changed', /Give a reason/.test(await fieldError('note')) && (await statusOf('KTS-TEST-0001')) === 'pending_payment', await fieldError('note'));
  await fill(`${F} [name=note]`, 'Customer asked to cancel');
  await submit(F);
  ok('cancel asks for confirmation (stock returned, cannot be undone)', /Cancel order KTS-TEST-0001\?.*cannot be undone/.test((await confirms()).at(-1) ?? ''));
  ok('cancel: success message reports stock returned', /Awaiting payment → Cancelled\. Returned 2 unit/.test(await message()), await message());
  const [v1after] = await q(`select stock_qty from product_variants where id = $1`, [v1.id]);
  ok('cancel: the 2 held units are back in stock', v1after.stock_qty === v1.stock_qty + 2);
  ok('cancel: stock effect shows the returned units and who returned them', await until(`/\\+2[\\s\\S]*cancel[\\s\\S]*ord\\.sales@test\\.local/.test(document.querySelector('[data-order-stock]')?.innerText ?? '')`));
  ok('cancelled order: no further changes offered', await until(`!!document.querySelector('[data-final=status]')`));

  // ---------- captured/authorised payment blocks cancellation ----------
  const o8 = await id('KTS-TEST-0008');
  await visit(`/orders/${o8}`, `!!document.querySelector('${F}')`);
  await autoConfirm();
  await fill(`${F} [name=toStatus]`, 'cancelled'); await fill(`${F} [name=note]`, 'try');
  await submit(F);
  ok('an order with an authorised payment cannot be cancelled here', /needs the refund flow/.test(await message()) && (await statusOf('KTS-TEST-0008')) === 'pending_payment', await message());

  // ---------- payment-failed order can be cancelled ----------
  await visit(`/orders/${await id('KTS-TEST-0007')}`, `!!document.querySelector('${F}')`);
  await autoConfirm();
  await fill(`${F} [name=toStatus]`, 'cancelled'); await fill(`${F} [name=note]`, 'Payment never completed');
  await submit(F);
  ok('payment-failed order cancelled, its unit returned', /Returned 1 unit/.test(await message()), await message());

  await visit(`/orders/${await id('KTS-TEST-0005')}`, '!!document.querySelector("[data-section=status]")');
  ok('delivered order: final, no status controls', (await exists('[data-final=status]')) && !(await exists(`${F} [name=toStatus]`)) && !(await exists(`${F} button[type=submit]`)));
  await visit('/orders/00000000-0000-4000-8000-000000000000');
  ok('unknown order id → not found page', /Not found/.test(await ev('document.body.innerText')));
  await visit('/orders/not-a-uuid');
  ok('malformed order id → not found page', /Not found/.test(await ev('document.body.innerText')));

  // keyboard: status select is labelled and reachable
  await visit(`/orders/${o2}`, `!!document.querySelector('${F}')`);
  await ev(`document.querySelector('${F} [name=toStatus]').focus(),true`);
  ok('keyboard: status select focusable and labelled', await ev(`document.activeElement.name==='toStatus' && !!document.querySelector('label[for="'+document.activeElement.id+'"]')`));
  await b.shot('orders-detail.png', true);

  // ================= accountant: billing yes, status no =================
  ok('accountant signs in', await signIn('accountant', 'Accounts E2E'));
  await visit(`/orders/${o2}`, '!!document.querySelector("[data-section=billing]")');
  ok('accountant sees the captured payment', /CAPTURED/i.test(await ev(`document.querySelector('[data-payments-table]')?.innerText ?? ''`)));
  ok('accountant sees the issued invoice number', /KTS\/26-27\/\d{5}/.test(await ev(`document.querySelector('[data-invoices]')?.innerText ?? ''`)));
  ok('accountant cannot change status (no form, read-only note)', !(await exists(F)) && (await exists('[data-readonly=status]')));

  // ================= support: read-only =================
  ok('support signs in', await signIn('support', 'Support E2E'));
  await visit(`/orders/${o2}`, '!!document.querySelector("[data-section=status]")');
  ok('support sees the order but cannot change it', (await exists('[data-items-table]')) && !(await exists(F)) && (await exists('[data-readonly=status]')));

  // ================= inventory manager: no orders.read =================
  ok('inventory manager signs in', await signIn('inventory', 'Inventory E2E'));
  ok('inventory manager menu has no Orders', !/Orders/.test(await ev(`[...document.querySelectorAll('.nav a')].map(a=>a.textContent).join('|')`)));
  for (const p of ['/orders', `/orders/${o2}`]) {
    await visit(p);
    ok(`inventory manager gets "not permitted" on ${p.replace(o2, ':id')} (server-side, no data)`, (await exists('[data-gate=forbidden]')) && !(await exists('[data-orders-table],[data-items-table]')));
  }

  // ================= integrity after the run =================
  const amountsAfter = await q(`select order_number, subtotal_paise, total_paise from orders order by order_number`);
  ok('no order amount was changed by any of this', JSON.stringify(amountsAfter) === JSON.stringify(amountsBefore));
  const [inv] = await q(`select (select count(*)::int from product_variants v where v.stock_qty <> (select coalesce(sum(m.delta),0) from inventory_movements m where m.variant_id = v.id)) mismatch,
    (select count(*)::int from orders) orders`);
  ok('stock still equals the ledger for every size; no orders created or deleted', inv.mismatch === 0 && inv.orders === 8);

  await b.viewport(390, 844, true);
  for (const p of ['/orders', `/orders/${o2}`]) {
    await visit(p);
    ok(`no horizontal page scroll at 390px: ${p.replace(o2, ':id')}`, await ev('document.documentElement.scrollWidth <= innerWidth + 1'));
  }
  ok('no page errors during the run', allErrors.length === 0, allErrors.slice(0, 3).join(' | '));
} catch (e) {
  ok('run completed', false, e.stack?.split('\n').slice(0, 3).join(' '));
} finally { b.close(); await pool.end(); }

console.log(out.join('\n'));
const failed = out.filter(l => l.startsWith('FAIL')).length;
console.log(`\n${out.length - failed} PASS, ${failed} FAIL`);
process.exitCode = failed ? 1 : 0;
