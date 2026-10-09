/* Order-management browser tests for the Admin/ERP app, against a LOCAL test database loaded with
   database/test/order-fixtures.mjs (never Supabase). Started by tests/run-e2e.mjs with BASE, KITSYUU_DB_URL and
   INVITES (one-time links for: sales, support, accountant, inventory = inventory_manager). */
import fs from 'node:fs';
import pg from 'pg';
import {launch} from '../../website/tests/cdp.mjs';
import {assertLocalOwnerUrl} from './local-only.mjs';

const {BASE, KITSYUU_DB_URL} = process.env;
const INVITES = JSON.parse(process.env.INVITES);
const out = []; const ok = (n, p, x = '') => out.push(`${p ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`);
const w = ms => new Promise(r => setTimeout(r, ms));
const PW = 'orders e2e passphrase';
const pool = new pg.Pool({connectionString: assertLocalOwnerUrl(KITSYUU_DB_URL), max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;

const b = await launch(9391);
const ev = e => b.eval(e);
/** Polls a page condition. A condition that throws (e.g. a broken expression) or never holds is reported on stderr, so a
    slow or silently broken wait is visible; some checks expect a timeout ("x never appears"). */
const until = async (expr, ms = 10000) => {
  let last = null;
  for (let t = 0; t < ms; t += 100) { try { if (await ev(expr)) return true; last = null; } catch (e) { last = e; } await w(100); }
  if (process.env.WAIT_TRACE) console.error(`WAIT TIMEOUT ${ms}ms: ${String(expr).slice(0, 140)}${last ? ` — throws: ${String(last.message ?? last).split(String.fromCharCode(10))[0]}` : ""}`);
  return false;
};
const fill = (sel, v) => ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)throw new Error('no field ' + ${JSON.stringify(sel)});
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,${JSON.stringify(v)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
const submit = async formSel => {
  const sel = JSON.stringify(formSel), start = await ev('location.pathname + location.search');
  // Wait until React has hydrated the form (its handlers are attached); a click before that is a plain browser submission.
  await until(`(()=>{const f=document.querySelector(${sel});return !!f && Object.keys(f).some(k=>k.startsWith('__reactProps'))})()`, 20000);
  // A MutationObserver set up before the click records that the form went busy, however briefly: a fast (or late) answer
  // is never mistaken for "nothing happened yet".
  await ev(`(()=>{const f=document.querySelector(${sel}),btn=document.querySelector(${JSON.stringify(formSel + ' button[type=submit]')});if(!btn)throw new Error('no submit button for ' + ${sel});
    window.__busySeen=false;if(f)new MutationObserver(()=>{if(f.matches('[aria-busy=true]'))window.__busySeen=true}).observe(f,{attributes:true,attributeFilter:['aria-busy']});btn.click();return true})()`);
  await until(`window.__busySeen === true || !!document.querySelector(${sel})?.matches('[aria-busy=true]') || (location.pathname + location.search) !== ${JSON.stringify(start)}`, 3000);
  if (!(await until(`!document.querySelector(${sel})?.matches('[aria-busy=true]')`, 20000))) throw new Error(`submission of ${formSel} did not finish`);
};
const F = '#order-status-form';
const message = () => ev(`document.querySelector('${F} [data-form-message]')?.innerText ?? ''`);
const fieldError = name => ev(`document.querySelector('${F} [name=${name}]')?.closest('.field')?.querySelector('.field-error')?.innerText ?? ''`);
const exists = sel => ev(`!!document.querySelector(${JSON.stringify(sel)})`);
const rows = () => ev(`[...document.querySelectorAll('[data-order-row]')].map(r=>r.dataset.orderRow)`);
const allErrors = [];
// Ready = the page's content has streamed in (the (erp)/loading.tsx skeleton also sits inside main).
const visit = async (p, ready = '!!document.querySelector("main") && !document.querySelector("[data-loading]")') => { await b.goto(BASE + p, ready); allErrors.push(...b.errors.filter(e => !/http 40[34]/.test(e))); };
/* Confirmations are an in-page dialog (components/confirm.tsx): accept each one as it opens and record its question. */
const autoConfirm = () => ev(`window.__q=[];window.__acObs?.disconnect();window.__acObs=new MutationObserver(()=>{const d=document.querySelector('[data-confirm-dialog]:not([data-auto])');if(d){d.setAttribute('data-auto','1');window.__q.push(d.querySelector('[data-confirm-text]').textContent);d.querySelector('[data-confirm-accept]').click();}});window.__acObs.observe(document.body,{childList:true,subtree:true});true`);
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
  await until(`!!document.querySelector('[data-kpi="Orders"] dd')`, 20000);   // figures stream in after the page shell
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
  // 2026-10-07: the order is the control centre: one header, seven tabs, only the selected tab's content.
  await visit(`/orders/${o2}`, '!!document.querySelector("[data-entity=order]")');
  ok('order page: tabs Overview · Items · Payment · Fulfilment · Returns · Invoice · Activity (no Customer tab)', (await ev(`[...document.querySelectorAll('[data-entity-tabs] [data-entity-tab]')].map(a=>a.dataset.entityTab).join()`)) === 'overview,items,payment,fulfilment,returns,invoice,activity');
  ok('order header: number, stage, payment state, total, customer, channel and date', /KTS-TEST-0002/.test(await ev(`document.querySelector('.ent-head h1').innerText`)) && (await exists('.ent-head [data-order-status=paid]')) && (await exists('.ent-head [data-payment-status=paid]'))
    && /Total[\s\S]*₹[\s\S]*Customer[\s\S]*Channel[\s\S]*Online[\s\S]*Placed/.test(await ev(`document.querySelector('[data-order-facts]').innerText`)));
  ok('order header: ONE primary next action for a paid order (Start packing), the rest under More', (await exists('[data-order-actions=paid] #quick-processing-form')) && (await ev(`document.querySelectorAll('[data-order-actions] form').length`)) === 1 && (await exists('[data-order-actions] [data-more-menu]')));
  ok('overview: progress and the next step in words', (await exists('[data-order-flow]')) && /Payment is confirmed/.test(await ev(`document.querySelector('[data-next-step=paid]').innerText`)));
  ok('detail: customer contact and shipping address', /asha\.fixture@test\.local/.test(await ev(`document.querySelector('[data-section=customer]').innerText`)) && /Coimbatore/.test(await ev(`document.querySelector('[data-section=customer]').innerText`)));
  ok('overview shows only the overview (no items table, no status form)', !(await exists('[data-items-table]')) && !(await exists('#order-status-form')));
  await visit(`/orders/${o2}?tab=items`, '!!document.querySelector("[data-items-table]")');
  const [sum] = await q(`select subtotal_paise s, total_paise t, (select count(*)::int from order_items where order_id = $1) n from orders where id = $1`, [o2]);
  ok('detail: order lines with SKU, size, unit price, qty and line total', (await ev(`document.querySelectorAll('[data-item]').length`)) === sum.n);
  const money = p => '₹' + (Math.trunc(p / 100)).toLocaleString('en-IN') + '.' + String(p % 100).padStart(2, '0');
  ok('detail: subtotal and total as recorded', (await ev(`document.querySelector('[data-subtotal]').innerText`)) === money(sum.s) && (await ev(`document.querySelector('[data-order-total]').innerText`)) === money(sum.t));
  ok('detail: amounts integrity check passes', await exists('[data-integrity=ok]'));
  await visit(`/orders/${o2}?tab=activity`, '!!document.querySelector("[data-history]")');
  ok('detail: history lists placed → paid', (await ev(`[...document.querySelectorAll('[data-history-row]')].map(r=>r.dataset.historyRow).join()`)) === 'pending_payment,paid');
  await visit(`/orders/${o2}?tab=payment`, '!!document.querySelector("[data-section=billing]")');
  ok('detail: sales (no billing.read) sees the payment summary but no attempts or refunds', (await exists('[data-readonly=billing]')) && (await exists('[data-payment-summary]')) && !(await exists('[data-attempts-table]')));
  await visit(`/orders/${o2}?tab=invoice`, '!!document.querySelector("[data-state=denied]")');
  ok('detail: sales (no billing.read) cannot see the invoice', !(await exists('[data-invoices]')));
  await visit(`/orders/${o2}?tab=fulfilment`, `!!document.querySelector('${F}')`);
  ok('detail: only the allowed next status is offered', (await ev(`[...document.querySelectorAll('${F} [name=toStatus] option')].map(o=>o.value).filter(Boolean).join()`)) === 'processing');

  // ---------- successful transition ----------
  await autoConfirm();
  await fill(`${F} [name=toStatus]`, 'processing'); await fill(`${F} [name=note]`, 'Packing today');
  await submit(F);
  ok('transition asks for confirmation', /Mark order KTS-TEST-0002 as Processing/.test((await confirms())[0] ?? ''));
  ok('transition: success message', (await message()) === 'KTS-TEST-0002: Paid → Processing.', await message());
  ok('transition: saved', (await statusOf('KTS-TEST-0002')) === 'processing');
  ok('transition: page shows the new status and next step', await until(`document.querySelector('[data-order-status]')?.dataset.orderStatus==='processing'`) && await until(`[...document.querySelectorAll('${F} [name=toStatus] option')].map(o=>o.value).includes('shipped')`));
  await visit(`/orders/${o2}?tab=activity`, '!!document.querySelector("[data-history]")');
  ok('history shows who made the change and the note', /Confirmed → Being packed[\s\S]*ord\.sales@test\.local[\s\S]*Packing today/.test(await ev(`document.querySelector('[data-history]').innerText`)));
  const [au] = await q(`select a.before_data, a.after_data, s.email from audit_logs a join staff_users s on s.id = a.staff_id where a.action = 'order.status_update' and a.entity_id = $1 order by a.id desc limit 1`, [o2]);
  ok('audit record: staff, before and after', au?.email === 'ord.sales@test.local' && au.before_data.status === 'paid' && au.after_data.status === 'processing');

  // ---------- invalid transition (forged in the page) is refused by the server ----------
  await visit(`/orders/${o2}?tab=fulfilment`, `!!document.querySelector('${F}')`);
  ok('order header follows the state: processing offers Mark as packed', (await exists('[data-order-actions=processing] #quick-packed-form')) && !(await exists('#quick-processing-form')));
  // the forged option is added only once React has taken over the form (a re-render before that would drop it)
  await until(`(()=>{const f=document.querySelector('${F}');return !!f && Object.keys(f).some(k=>k.startsWith('__reactProps'))})()`, 20000);
  await ev(`(()=>{const s=document.querySelector('${F} [name=toStatus]');const o=document.createElement('option');o.value='delivered';o.textContent='Delivered';s.appendChild(o);return true})()`);
  await fill(`${F} [name=toStatus]`, 'delivered');
  await submit(F);
  ok('invalid transition refused by the server (processing → delivered)', /cannot go from processing to delivered/.test(await fieldError('toStatus')) && (await statusOf('KTS-TEST-0002')) === 'processing', await fieldError('toStatus'));

  // ---------- stale change (someone else changed the order after the page loaded) ----------
  const o3 = await id('KTS-TEST-0003');
  await visit(`/orders/${o3}?tab=fulfilment`, `!!document.querySelector('${F}')`);
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
  await visit(`/orders/${o1}?tab=fulfilment`, `!!document.querySelector('${F}')`);
  ok('unpaid order: no primary action (waiting for the customer); Cancel is under More', (await ev(`document.querySelectorAll('[data-order-actions] form').length`)) === 0 && (await exists('[data-order-actions=pending_payment] [data-more-menu]')));
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
  ok('cancelled order: no further changes offered', await until(`!!document.querySelector('[data-final=status]')`) && (await ev(`document.querySelectorAll('[data-order-actions] form').length`)) === 0);
  await visit(`/orders/${o1}?tab=items`, '!!document.querySelector("[data-items-table]")');
  ok('cancel: stock effect shows the returned units and who returned them', await until(`/\\+2[\\s\\S]*cancel[\\s\\S]*ord\\.sales@test\\.local/.test(document.querySelector('[data-order-stock]')?.innerText ?? '')`));

  // ---------- captured/authorised payment blocks cancellation ----------
  const o8 = await id('KTS-TEST-0008');
  await visit(`/orders/${o8}?tab=fulfilment`, `!!document.querySelector('${F}')`);
  await autoConfirm();
  await fill(`${F} [name=toStatus]`, 'cancelled'); await fill(`${F} [name=note]`, 'try');
  await submit(F);
  ok('an order with an authorised payment cannot be cancelled here', /needs the refund flow/.test(await message()) && (await statusOf('KTS-TEST-0008')) === 'pending_payment', await message());

  // ---------- payment-failed order can be cancelled ----------
  await visit(`/orders/${await id('KTS-TEST-0007')}?tab=fulfilment`, `!!document.querySelector('${F}')`);
  await autoConfirm();
  await fill(`${F} [name=toStatus]`, 'cancelled'); await fill(`${F} [name=note]`, 'Payment never completed');
  await submit(F);
  ok('payment-failed order cancelled, its unit returned', /Returned 1 unit/.test(await message()), await message());

  await visit(`/orders/${await id('KTS-TEST-0005')}?tab=fulfilment`, '!!document.querySelector("[data-section=status]")');
  ok('delivered order: no primary action in the header', (await ev(`document.querySelectorAll('[data-order-actions=delivered] form').length`)) === 0);
  ok('delivered order: final, no status controls', (await exists('[data-final=status]')) && !(await exists(`${F} [name=toStatus]`)) && !(await exists(`${F} button[type=submit]`)));
  await visit('/orders/00000000-0000-4000-8000-000000000000');
  ok('unknown order id → not found page', /Not found/.test(await ev('document.body.innerText')));
  await visit('/orders/not-a-uuid');
  ok('malformed order id → not found page', /Not found/.test(await ev('document.body.innerText')));

  // shipped order: Mark delivered is the one primary action
  await visit(`/orders/${await id('KTS-TEST-0004')}`, '!!document.querySelector("[data-entity=order]")');
  ok('shipped order: the primary action is Mark delivered', (await exists('[data-order-actions=shipped] #quick-delivered-form')) && (await ev(`document.querySelectorAll('[data-order-actions] form').length`)) === 1);
  // tabs change the address (?tab=) and keep the header
  await ev(`document.querySelector('[data-entity-tab=fulfilment]').click(),true`);
  ok('tab click: the address carries the tab and only that tab is shown', await until(`location.search==='?tab=fulfilment' && !!document.querySelector('[data-tab-panel=fulfilment] [data-section=fulfilment]')`) && (await exists('.ent-head [data-order-status=shipped]')) && !(await exists('[data-section=customer]')));
  // keyboard: status select is labelled and reachable
  await visit(`/orders/${o2}?tab=fulfilment`, `!!document.querySelector('${F}')`);
  await ev(`document.querySelector('${F} [name=toStatus]').focus(),true`);
  ok('keyboard: status select focusable and labelled', await ev(`document.activeElement.name==='toStatus' && !!document.querySelector('label[for="'+document.activeElement.id+'"]')`));
  await b.shot('orders-detail.png', true);

  // ================= accountant: billing yes, status no =================
  ok('accountant signs in', await signIn('accountant', 'Accounts E2E'));
  await visit(`/orders/${o2}`, '!!document.querySelector("[data-section=billing]")');
  // 2026-10-07: the payment is the order's Payment tab; the overview shows a summary that opens it.
  ok('accountant sees the payment summary (paid) with a link to the Payment tab', /PAID/i.test(await ev(`document.querySelector('[data-payment-summary]')?.innerText ?? ''`)) && await exists(`[data-section=billing] a[data-link=view-payment][href="/orders/${o2}?tab=payment"]`));
  await visit(`/orders/${o2}?tab=payment`, '!!document.querySelector("[data-payment-screen]")');
  ok('order → Payment tab: the captured attempt, refunds and the payment timeline', /CAPTURED/i.test(await ev(`document.querySelector('[data-attempts-table]')?.innerText ?? ''`)) && (await exists('[data-section=refunds]')) && (await exists('[data-payment-timeline]')) && (await exists('.ent-head [data-order-status]')));
  await visit(`/payments/${o2}`, '!!document.querySelector("[data-payment-screen]")');
  ok('old payment address opens the same order on its Payment tab', (await ev('location.pathname + location.search')) === `/orders/${o2}?tab=payment` && (await exists('[data-entity=order][data-tab=payment]')));
  await visit('/payments', '!!document.querySelector("[data-order-payments]")');
  ok('payments queue: a row opens its order on the Payment tab', (await ev(`document.querySelector('[data-payment-of="KTS-TEST-0002"] a.row-link')?.getAttribute('href')`)) === `/orders/${o2}?tab=payment`);
  await ev(`document.querySelector('[data-payment-of="KTS-TEST-0002"] a.row-link').click(),true`);
  ok('payment → order → payment: the click lands on the order, Payment tab selected', await until(`location.pathname + location.search === '/orders/${o2}?tab=payment' && !!document.querySelector('[data-payment-screen]')`, 20000)
    && (await ev(`document.querySelector('[data-entity-tab=payment]').getAttribute('aria-current')`)) === 'page');
  await visit('/payments', '!!document.querySelector("[data-order-payments]")');
  ok('payments list: one line per order, filter by status', (await ev(`document.querySelectorAll('[data-payment-of]').length`)) === 8);
  await visit('/payments?state=failed', '!!document.querySelector("[data-payments-tabs]")');
  ok('payments list: failed only', (await ev(`[...document.querySelectorAll('[data-payment-of]')].map(r=>r.dataset.paymentOf).join()`)) === 'KTS-TEST-0007');
  await visit(`/orders/${o2}?tab=invoice`, '!!document.querySelector("[data-section=invoice]")');
  ok('accountant sees the issued invoice number', /KTS\/26-27\/\d{5}/.test(await ev(`document.querySelector('[data-invoices]')?.innerText ?? ''`)));
  await visit(`/orders/${o2}?tab=fulfilment`, '!!document.querySelector("[data-section=status]")');
  ok('accountant (no orders.update_status): no action in the header', (await ev(`document.querySelectorAll('[data-order-actions] form').length`)) === 0);
  ok('accountant cannot change status (no form, read-only note)', !(await exists(F)) && (await exists('[data-readonly=status]')));

  // ================= support: read-only =================
  ok('support signs in', await signIn('support', 'Support E2E'));
  await visit(`/orders/${o2}?tab=fulfilment`, '!!document.querySelector("[data-section=status]")');
  ok('support sees the order but cannot change it', (await exists('[data-entity=order]')) && !(await exists(F)) && (await exists('[data-readonly=status]')) && (await ev(`document.querySelectorAll('[data-order-actions] form').length`)) === 0);
  await visit(`/orders/${o2}?tab=returns`, '!!document.querySelector("[data-tab-panel=returns]")');
  ok('support (returns.read, no returns.manage): Returns tab without the start form', !(await exists('#start-return-form')) && !(await exists('[data-state=denied]')));

  // ================= inventory manager: no orders.read =================
  ok('inventory manager signs in', await signIn('inventory', 'Inventory E2E'));
  ok('inventory manager menu has no Orders', !/Orders/.test(await ev(`[...document.querySelectorAll('.nav a')].map(a=>a.textContent).join('|')`)));
  for (const p of ['/orders', `/orders/${o2}`]) {
    await visit(p);
    ok(`inventory manager gets "not permitted" on ${p.replace(o2, ':id')} (server-side, no data)`, (await exists('[data-gate=forbidden]')) && !(await exists('[data-orders-table],[data-items-table]')));
  }

  const [ship] = await q(`select s.id from shipments s join orders o on o.id = s.order_id where o.order_number = 'KTS-TEST-0002'`);
  if (ship) {
    await visit(`/shipping/shipments/${ship.id}`, '!!document.querySelector("[data-section=shipment]")');
    ok('inventory manager (shipping.read, no orders.read): the shipment opens on its own page, not the order', (await ev('location.pathname')) === `/shipping/shipments/${ship.id}` && !(await exists('[data-entity=order]')));
  }

  // ================= integrity after the run =================
  const amountsAfter = await q(`select order_number, subtotal_paise, total_paise from orders order by order_number`);
  ok('no order amount was changed by any of this', JSON.stringify(amountsAfter) === JSON.stringify(amountsBefore));
  const [inv] = await q(`select (select count(*)::int from product_variants v where v.stock_qty <> (select coalesce(sum(m.delta),0) from inventory_movements m where m.variant_id = v.id)) mismatch,
    (select count(*)::int from orders) orders`);
  ok('stock still equals the ledger for every size; no orders created or deleted', inv.mismatch === 0 && inv.orders === 8);

  await b.viewport(390, 844, true);
  for (const p of ['/orders', `/orders/${o2}`, `/orders/${o2}?tab=items`, `/orders/${o2}?tab=payment`, `/orders/${o2}?tab=fulfilment`, `/orders/${o2}?tab=returns`, `/orders/${o2}?tab=invoice`, `/orders/${o2}?tab=activity`]) {
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
