/* M8 browser tests for the Admin/ERP app: customers, payments, settings, fulfilment on the order page, order export and
   dashboard figures. LOCAL test database only (never Supabase), after tests/orders.mjs has run on the order fixtures:
   KTS-TEST-0001/0006/0007 cancelled, 0002 processing, 0003/0004 shipped, 0005 delivered, 0008 awaiting payment.
   Started by tests/run-e2e.mjs with BASE, KITSYUU_DB_URL and INVITES (admin, accountant, support, manager, inventory). */
import fs from 'node:fs';
import pg from 'pg';
import {launch} from '../../website/tests/cdp.mjs';
import {assertLocalOwnerUrl} from './local-only.mjs';

const {BASE, KITSYUU_DB_URL} = process.env;
const INVITES = JSON.parse(process.env.INVITES);
const out = []; const ok = (n, p, x = '') => out.push(`${p ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`);
const w = ms => new Promise(r => setTimeout(r, ms));
const PW = 'm8 e2e passphrase';
const pool = new pg.Pool({connectionString: assertLocalOwnerUrl(KITSYUU_DB_URL), max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;

const b = await launch(9392);
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
  await until(`(()=>{const f=document.querySelector(${sel});return !!f && Object.keys(f).some(k=>k.startsWith('__reactProps'))})()`, 20000);
  await ev(`(()=>{const f=document.querySelector(${sel}),btn=document.querySelector(${JSON.stringify(formSel + ' button[type=submit]')});if(!btn)throw new Error('no submit button for ' + ${sel});
    window.__busySeen=false;if(f)new MutationObserver(()=>{if(f.matches('[aria-busy=true]'))window.__busySeen=true}).observe(f,{attributes:true,attributeFilter:['aria-busy']});btn.click();return true})()`);
  await until(`window.__busySeen === true || !!document.querySelector(${sel})?.matches('[aria-busy=true]') || (location.pathname + location.search) !== ${JSON.stringify(start)}`, 3000);
  if (!(await until(`!document.querySelector(${sel})?.matches('[aria-busy=true]')`, 20000))) throw new Error(`submission of ${formSel} did not finish`);
};
const message = f => ev(`document.querySelector('${f} [data-form-message]')?.innerText ?? ''`);
const fieldError = (f, name) => ev(`document.querySelector('${f} [name=${name}]')?.closest('.field')?.querySelector('.field-error')?.innerText ?? ''`);
const exists = sel => ev(`!!document.querySelector(${JSON.stringify(sel)})`);
const text = sel => ev(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
const navText = () => ev(`[...document.querySelectorAll('.nav a')].map(a=>a.textContent).join('|')`);
const allErrors = [];
const visit = async (p, ready = '!!document.querySelector("main") && !document.querySelector("[data-loading]")') => { await b.goto(BASE + p, ready); allErrors.push(...b.errors.filter(e => !/http 40[34]/.test(e))); };
/* Confirmations are an in-page dialog (components/confirm.tsx): accept each one as it opens and record its question. */
const autoConfirm = () => ev(`window.__q=[];window.__acObs?.disconnect();window.__acObs=new MutationObserver(()=>{const d=document.querySelector('[data-confirm-dialog]:not([data-auto])');if(d){d.setAttribute('data-auto','1');window.__q.push(d.querySelector('[data-confirm-text]').textContent);d.querySelector('[data-confirm-accept]').click();}});window.__acObs.observe(document.body,{childList:true,subtree:true});true`);
const confirms = () => ev('window.__q ?? []');
const id = async num => (await q(`select id from orders where order_number = $1`, [num]))[0].id;
const statusOf = async num => (await q(`select status from orders where order_number = $1`, [num]))[0].status;
const SECRETS = /password_hash|token_hash|passwordHash|tokenHash|\$argon2|\$scrypt/;
const fetchText = p => ev(`fetch(${JSON.stringify(p)}).then(async r=>({status:r.status,type:r.headers.get('content-type'),rows:r.headers.get('x-export-rows'),body:await r.text()}))`);

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
  const [ravi] = await q(`select id, email from customers where email like 'ravi%'`);
  await q(`insert into customer_sessions (customer_id, token_hash, idle_expires_at, expires_at, ip, user_agent)
    values ($1, sha256('m8-e2e-session'::bytea), now() + interval '1 day', now() + interval '30 days', '10.9.9.9', 'secret-agent-e2e')`, [ravi.id]);

  // ================= admin =================
  ok('admin signs in', await signIn('admin', 'Admin M8'));
  const nav = await navText();
  ok('menu: Customers and Payments under Commerce, Configuration under System', /Customers/.test(nav) && /Payments/.test(nav) && /Configuration/.test(nav), nav);
  await until(`!!document.querySelector('[data-kpi="Awaiting fulfilment"]')`, 20000);   // figures stream in after the page shell
  for (const k of ['Awaiting fulfilment', 'Shipped', 'Delivered', 'Pending payments', 'Payment exceptions'])
    ok(`dashboard shows "${k}"`, await exists(`[data-kpi="${k}"]`));
  ok('dashboard: awaiting fulfilment = 1 (KTS-TEST-0002 processing)', (await text('[data-kpi="Awaiting fulfilment"] dd')).startsWith('1'));
  ok('dashboard: shipped = 2, delivered = 1', (await text('[data-kpi="Shipped"] dd')).startsWith('2') && (await text('[data-kpi="Delivered"] dd')).startsWith('1'));
  ok('dashboard: customers show disabled count', /0 disabled/.test(await text('[data-kpi="Customers"]')));

  // ---------- customers ----------
  await visit('/customers', '!!document.querySelector("[data-customers-table]")');
  ok('customers list: both fixture customers', (await ev(`document.querySelectorAll('[data-customer-row]').length`)) === 2);
  ok('customers list: order count and lifetime value', (await text(`[data-customer-row="${ravi.email}"] [data-orders-count]`)) === '3'
    && /₹/.test(await text(`[data-customer-row="${ravi.email}"] [data-lifetime-value]`)));
  await visit('/customers?q=ravi');
  ok('customers search', (await ev(`[...document.querySelectorAll('[data-customer-row]')].map(r=>r.dataset.customerRow).join()`)) === ravi.email);
  await visit('/customers?status=disabled');
  ok('customers filter: empty state', await exists('[data-empty=customers]'));
  await visit(`/customers/${ravi.id}`, '!!document.querySelector("[data-section=profile]")');
  // 2026-10-07: the customer is a control centre on the shared entity frame: header + seven tabs, only the selected tab's content.
  ok('customer page: tabs Overview · Orders · Payments · Returns · Loyalty · Support · Activity', (await ev(`[...document.querySelectorAll('[data-entity=customer] [data-entity-tab]')].map(a=>a.dataset.entityTab).join()`)) === 'overview,orders,payments,returns,loyalty,support,activity');
  ok('customer header: name, status, email, joined, orders and lifetime value', (await exists('.ent-head [data-customer-status=active]')) && /Email[\s\S]*ravi[\s\S]*Joined[\s\S]*Orders[\s\S]*3[\s\S]*Lifetime value[\s\S]*₹/.test(await text('[data-customer-facts]')));
  ok('customer overview: contact, account, order summary, addresses and notes; no tables of other records', (await exists('[data-section=account]')) && (await exists('[data-customer-kpis]')) && (await exists('[data-section=addresses]')) && (await exists('[data-section=notes]')) && !(await exists('[data-tab-panel=overview] table')));
  ok('customer detail: 1 active session', (await text('[data-active-sessions]')) === '1');
  const html = await ev('document.documentElement.outerHTML');
  ok('customer detail: no secrets, IP addresses or user agents in the page', !SECRETS.test(html) && !/10\.9\.9\.9|secret-agent-e2e/.test(html));
  await visit(`/customers/${ravi.id}?tab=orders`, '!!document.querySelector("[data-customer-orders]")');
  ok('customer → Orders tab: every order links to the order page', (await ev(`document.querySelectorAll('[data-customer-orders] tbody tr').length`)) === 3 && await ev(`[...document.querySelectorAll('[data-customer-orders] a.row-link')].every(a=>/^\\/orders\\/[0-9a-f-]{36}$/.test(a.getAttribute('href')))`));
  await visit(`/customers/${ravi.id}?tab=payments`, '!!document.querySelector("[data-customer-payments]")');
  ok('customer → Payments tab: every row opens Order → Payment; no form in the customer page', await ev(`[...document.querySelectorAll('[data-customer-payments] tbody tr a')].every(a=>/^\\/orders\\/[0-9a-f-]{36}\\?tab=payment/.test(a.getAttribute('href')))`) && !(await exists('[data-tab-panel] form')));
  await ev(`document.querySelector('[data-customer-payments] a.row-link').click(),true`);
  ok('customer → payment → order → Payment tab', await until(`/^\\/orders\\//.test(location.pathname) && location.search === '?tab=payment' && !!document.querySelector('[data-payment-screen]')`, 20000));
  await visit(`/customers/${ravi.id}?tab=returns`, '!!document.querySelector("[data-tab-panel=returns]")');
  ok('customer → Returns tab: empty state when there are none', await exists('[data-state=empty]'));
  await visit(`/customers/${ravi.id}?tab=activity`, '!!document.querySelector("[data-sessions-table]")');
  ok('customer → Activity tab: timeline, sign-in history and audit', (await exists('[data-customer-activity]')) && (await exists('[data-section=audit]')) && !SECRETS.test(await ev('document.documentElement.outerHTML')) && !/10\.9\.9\.9|secret-agent-e2e/.test(await ev('document.documentElement.outerHTML')));
  await visit(`/customers/${ravi.id}`, '!!document.querySelector("[data-section=profile]")');
  await until(`(()=>{const t=document.querySelector('[data-drawer-open=status]');return !!t && Object.keys(t).some(k=>k.startsWith('__reactProps'))})()`, 20000);
  await ev(`document.querySelector('[data-drawer-open=status]').click(),true`);
  await until(`!!document.querySelector('[data-drawer=status] form')`);

  const S = '#customer-status-form';
  await autoConfirm();
  await submit(S);
  ok('disable without a reason: field error, nothing changed', !!(await fieldError(S, 'note')) && (await q(`select status from customers where id = $1`, [ravi.id]))[0].status === 'active');
  await fill(`${S} [name=note]`, 'Suspicious orders (test)');
  await submit(S);
  ok('disable asks for confirmation', /Disable .*signed out everywhere/.test((await confirms()).at(-1) ?? ''));
  ok('disable: message reports sessions ended', /Account disabled\. 1 session/.test(await message(S)), await message(S));
  const [rv] = await q(`select status, (select count(*)::int from customer_sessions where customer_id = $1 and revoked_at is null) live from customers where id = $1`, [ravi.id]);
  ok('disable: saved and every session ended', rv.status === 'disabled' && rv.live === 0);
  const [ad] = await q(`select a.metadata, s.email from audit_logs a join staff_users s on s.id = a.staff_id where a.action = 'customer.disable' and a.entity_id = $1`, [ravi.id]);
  ok('disable: audited with staff and reason', ad?.email === 'm8.admin@test.local' && ad.metadata.note === 'Suspicious orders (test)');
  ok('disable: page shows Disabled and offers Enable', await until(`document.querySelector('[data-customer-status]')?.dataset.customerStatus==='disabled'`)
    && await until(`/Enable account/.test(document.querySelector('${S} button[type=submit]')?.innerText ?? '')`));
  await fill(`${S} [name=note]`, 'Cleared (test)');
  await submit(S);
  ok('enable: saved', /Account enabled/.test(await message(S)) && (await q(`select status from customers where id = $1`, [ravi.id]))[0].status === 'active');

  const C = '#customer-contact-form';
  await b.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27}); await w(400);
  await until(`(()=>{const t=document.querySelector('[data-drawer-open=contact]');return !!t && Object.keys(t).some(k=>k.startsWith('__reactProps'))})()`, 20000);
  await ev(`document.querySelector('[data-drawer-open=contact]').click(),true`);
  await until(`!!document.querySelector('[data-drawer=contact] form')`);
  await fill(`${C} [name=phone]`, '12');
  await submit(C);
  ok('contact: invalid mobile rejected', !!(await fieldError(C, 'phone')));
  await fill(`${C} [name=phone]`, '9123456780');
  await submit(C);
  ok('contact: saved and audited', /Contact details saved/.test(await message(C))
    && (await q(`select phone from customers where id = $1`, [ravi.id]))[0].phone === '9123456780'
    && (await q(`select count(*)::int n from audit_logs where action = 'customer.update_contact' and entity_id = $1`, [ravi.id]))[0].n === 1);

  // ---------- fulfilment on the order page ----------
  const o2 = await id('KTS-TEST-0002');
  await visit(`/orders/${o2}?tab=fulfilment`, '!!document.querySelector("[data-section=fulfilment]")');
  ok('order page links the customer account', await exists('[data-customer-link]'));
  ok('fulfilment: packing not started', /Not started/i.test(await text('[data-packing-state]')));
  const P = '#packing-form';
  await fill(`${P} [name=packingState]`, 'packed');
  await submit(P);
  ok('packing saved and audited', /packing is packed/.test(await message(P))
    && (await q(`select packing_state from shipments where order_id = $1`, [o2]))[0]?.packing_state === 'packed');
  ok('order status unchanged by packing', (await statusOf('KTS-TEST-0002')) === 'processing');
  const F = '#order-status-form';
  ok('status form offers courier and tracking when shipping is next', await until(`!!document.querySelector('${F} [data-shipping-fields] [name=carrierCode]')`));
  await autoConfirm();
  await fill(`${F} [name=toStatus]`, 'shipped');
  await submit(F);
  ok('shipped without a tracking number', (await statusOf('KTS-TEST-0002')) === 'shipped', await message(F));
  ok('fulfilment shows "Tracking not provided" and the manual courier', await until(`/Tracking not provided/.test(document.querySelector('[data-tracking]')?.innerText ?? '')`)
    && /Manual courier/.test(await text('[data-courier]')));
  const T = '#tracking-form';
  await until(`!!document.querySelector('${T}')`);
  await fill(`${T} [name=trackingNumber]`, 'bad<tracking>');
  await submit(T);
  ok('tracking: invalid characters rejected', !!(await fieldError(T, 'trackingNumber')));
  await fill(`${T} [name=trackingNumber]`, 'AWB-E2E-1');
  await submit(T);
  ok('tracking added later and shown', /tracking details saved/.test(await message(T)) && await until(`/AWB-E2E-1/.test(document.querySelector('[data-tracking]')?.innerText ?? '')`));
  await fill(`${F} [name=toStatus]`, 'delivered');
  await submit(F);
  ok('delivered: time recorded', (await statusOf('KTS-TEST-0002')) === 'delivered'
    && !!(await q(`select delivered_at from shipments where order_id = $1`, [o2]))[0].delivered_at);

  // ---------- export ----------
  const csv = await fetchText('/orders/export?status=delivered');
  ok('export: CSV download of the filtered list', csv.status === 200 && /text\/csv/.test(csv.type) && csv.rows === '2' && /KTS-TEST-0002/.test(csv.body) && /AWB-E2E-1/.test(csv.body), `${csv.status} ${csv.rows}`);
  ok('export: no addresses or payment references', !/Coimbatore|pay_TEST/i.test(csv.body));
  await visit('/orders', '!!document.querySelector("[data-export-orders]")');
  ok('orders list has an Export CSV link', await exists('a[data-export-orders][href^="/orders/export"]'));

  // ---------- 2026-10-07: the order is the control centre; the queues open the same order on the matching tab ----------
  const o4 = await id('KTS-TEST-0004');
  await visit(`/orders/${o4}`, '!!document.querySelector("[data-entity=order]")');
  ok('shipped order: header offers Mark delivered as the one primary action', (await exists('[data-order-actions=shipped] #quick-delivered-form')) && (await ev(`document.querySelectorAll('[data-order-actions] form').length`)) === 1);
  await autoConfirm();
  await submit('#quick-delivered-form');
  ok('Mark delivered from the header: saved, the header follows', (await statusOf('KTS-TEST-0004')) === 'delivered' && await until(`document.querySelector('[data-order-status]')?.dataset.orderStatus==='delivered' && document.querySelectorAll('[data-order-actions] form').length===0`));
  // Shipping → Order → Fulfilment
  const [sh] = await q(`select id from shipments where order_id = $1`, [o2]);
  await visit('/shipping?status=all', '!!document.querySelector("[data-shipments-table]")');
  ok('shipping queue: the row says the state and the next step; no form in the queue', /Delivered/.test(await text('[data-shipment="KTS-TEST-0002"]')) && /View/.test(await text('[data-shipment="KTS-TEST-0002"] [data-next-step]')) && !(await exists('[data-shipments-table] form')));
  ok('shipping queue: a row opens its order on the Fulfilment tab', (await ev(`document.querySelector('[data-shipment="KTS-TEST-0002"] a.row-link')?.getAttribute('href')`)) === `/orders/${o2}?tab=fulfilment`);
  await ev(`document.querySelector('[data-shipment="KTS-TEST-0002"] a.row-link').click(),true`);
  ok('shipping → order → fulfilment: lands on the order, Fulfilment tab selected', await until(`location.pathname + location.search === '/orders/${o2}?tab=fulfilment' && !!document.querySelector('[data-section=fulfilment]')`, 20000)
    && /AWB-E2E-1/.test(await text('[data-tracking]')) && (await exists('[data-shipment-events]')));
  await visit(`/shipping/shipments/${sh.id}`, '!!document.querySelector("[data-section=fulfilment]")');
  ok('old shipment address opens the same order on its Fulfilment tab', (await ev('location.pathname + location.search')) === `/orders/${o2}?tab=fulfilment`);
  // Order → Returns (returns switched on in this LOCAL test database only, and switched off again below)
  await visit(`/orders/${o2}?tab=returns`, '!!document.querySelector("[data-tab-panel=returns]")');
  ok('returns off: the Returns tab says so and offers no start form', /all sales are final/.test(await text('[data-tab-panel=returns]')) && !(await exists('#start-return-form')));
  await q(`insert into settings (key, value, description, is_public) values ('returns.enabled', '"on"', 'e2e', false), ('returns.window_days', '7', 'e2e', false) on conflict (key) do update set value = excluded.value`);
  await visit(`/orders/${o2}`, '!!document.querySelector("[data-entity=order]")');
  ok('delivered order inside the return window: header offers Start return / exchange', await exists(`[data-order-actions=delivered] a[data-next=start-return][href="/orders/${o2}?tab=returns#start-return"]`));
  await visit(`/orders/${o2}?tab=returns`, '!!document.querySelector("#start-return-form")');
  const SR = '#start-return-form';
  await submit(SR);
  ok('start return without a quantity: explained, nothing created', /quantity being returned/.test(await message(SR)) && (await q(`select count(*)::int n from return_requests`))[0].n === 0, await message(SR));
  const [line] = await q(`select id from order_items where order_id = $1 order by name limit 1`, [o2]);
  await fill(`${SR} [name="qty_${line.id}"]`, '1');
  await submit(SR);
  ok('order → returns: the return opens on the same order, Returns tab', await until(`location.pathname === '/orders/${o2}' && /tab=returns&return=/.test(location.search) && !!document.querySelector('[data-return-status=requested]')`, 20000));
  const [rt] = await q(`select id, number, status from return_requests where order_id = $1`, [o2]);
  ok('the return is the existing return record (staff-opened, requested)', rt?.status === 'requested' && (await q(`select count(*)::int n from audit_logs where action = 'return.staff_create' and entity_id = $1`, [rt.id]))[0].n === 1);
  ok('return steps offered are the workflow\'s own for "requested"', (await ev(`[...document.querySelectorAll('[data-section=return-actions] [data-step]')].map(d=>d.dataset.step).sort().join()`)) === 'approve,cancel,reject,request_info,review');
  await ev(`document.querySelector('[data-step=approve]').open = true`);
  await submit('#step-approve');
  ok('approve on the Returns tab: saved through the existing return action', (await q(`select status, resolution from return_requests where id = $1`, [rt.id]))[0].status === 'approved' && await until(`!!document.querySelector('[data-return-status=approved]')`));
  await visit(`/orders/${o2}`, '!!document.querySelector("[data-entity=order]")');
  ok('order with an open return: the primary action is Continue return; the Returns tab shows 1', (await exists(`[data-order-actions] a[data-next=return][href="/orders/${o2}?tab=returns&return=${rt.id}"]`)) && /1/.test(await text('[data-entity-tab=returns]')));
  // Returns → Order → Returns
  await visit('/returns?status=all', '!!document.querySelector("[data-returns-table]")');
  ok('returns queue: the row says the state and the next step; no form in the queue', (await exists(`[data-return="${rt.number}"][data-return-state=approved]`)) && /Schedule pickup or receive/.test(await text(`[data-return="${rt.number}"] [data-next-step]`)) && !(await exists('[data-returns-table] form')));
  ok('returns queue: status chips are the existing statuses with counts', (await ev(`[...document.querySelectorAll('[data-return-status-chip]')].map(c=>c.dataset.returnStatusChip).join()`)) === 'open,approved,all');
  ok('returns queue: a row opens its order on the Returns tab', (await ev(`document.querySelector('[data-return="${rt.number}"] a.row-link')?.getAttribute('href')`)) === `/orders/${o2}?tab=returns&return=${rt.id}`);
  await ev(`document.querySelector('[data-return="${rt.number}"] a.row-link').click(),true`);
  ok('returns → order → returns: lands on the order, Returns tab selected, that return shown', await until(`location.pathname === '/orders/${o2}' && !!document.querySelector('[data-tab-panel=returns] [data-return="${rt.number}"]')`, 20000));
  await visit(`/returns/${rt.id}`, '!!document.querySelector("[data-return]")');
  ok('old return address opens the same order on its Returns tab', (await ev('location.pathname + location.search')) === `/orders/${o2}?tab=returns&return=${rt.id}`);
  await ev(`document.querySelector('[data-step=cancel]').open = true`);
  await submit('#step-cancel');
  ok('the return is cancelled again (test clean-up through the workflow)', (await q(`select status from return_requests where id = $1`, [rt.id]))[0].status === 'cancelled');
  await q(`delete from settings where key in ('returns.enabled', 'returns.window_days')`);
  // Order → Payment (admin: billing.read)
  await visit(`/orders/${o2}?tab=payment`, '!!document.querySelector("[data-payment-screen]")');
  ok('order → Payment tab: method, status, attempts and timeline of the same order', (await exists('[data-payment-facts]')) && (await exists('[data-attempts-table]')) && (await exists('[data-payment-timeline]')));

  // ---------- payments ----------
  const o6 = await id('KTS-TEST-0006');
  await q(`insert into payments (order_id, provider, provider_payment_id, amount_paise, status, captured_at) values ($1, 'razorpay', 'pay_E2ELATE', 49900, 'captured', now())`, [o6]);
  await q(`insert into payment_events (id, provider, type, payload, order_id, outcome, processed_at) values ('razorpay:evt_e2e', 'razorpay', 'payment.captured', '{"secret":"hidden-e2e"}', $1, 'applied', now())`, [o6]);
  await visit('/payments?view=exceptions', '!!document.querySelector("[data-payments-tabs]")');
  ok('payments: exceptions queue lists the payment received after cancellation', await exists('[data-exception="captured_after_cancel"][data-exception-order="KTS-TEST-0006"]'));
  // 2026-10-07 (queues are doorways): nothing is recorded in the queue; the row opens the order's Payment tab, where the existing action is taken.
  ok('exceptions queue: no form in the queue; the next step opens Order → Payment', !(await exists('[data-exceptions-table] form')) && (await ev(`document.querySelector('[data-exception-order="KTS-TEST-0006"] [data-next-step] a')?.getAttribute('href')`)) === `/orders/${o6}?tab=payment#exc-h`
    && /Record manual refund/.test(await text('[data-exception-order="KTS-TEST-0006"] [data-next-step]')));
  await ev(`document.querySelector('[data-exception-order="KTS-TEST-0006"] [data-next-step] a').click(),true`);
  ok('exception → order → Payment tab with the exception and its handling', await until(`location.pathname === '/orders/${o6}' && location.search === '?tab=payment' && !!document.querySelector('[data-section=payment-exception] form')`, 20000));
  const R = '[data-section=payment-exception] form';
  await autoConfirm();
  await submit(R);
  ok('manual refund without a note: field error', !!(await ev(`document.querySelector('${R} .field-error')?.innerText ?? ''`)));
  await ev(`(()=>{const el=document.querySelector('${R} [name=note]');Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,'Bank transfer ref E2E');el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  await submit(R);
  ok('manual refund asks for confirmation (nothing sent to the provider)', /Nothing is sent to the payment provider/.test((await confirms()).at(-1) ?? ''));
  const [rf] = await q(`select r.status, s.email from refunds r join staff_users s on s.id = r.requested_by where r.order_id = $1`, [o6]);
  ok('manual refund recorded (requested) and audited', rf?.status === 'requested' && rf.email === 'm8.admin@test.local'
    && (await q(`select count(*)::int n from audit_logs where action = 'payment.manual_refund_recorded' and entity_id = $1`, [o6]))[0].n === 1);
  ok('Payment tab shows it as recorded, the form is gone', await until(`/Manual refund recorded/.test(document.querySelector('[data-section=payment-exception] [data-exception-handling]')?.innerText ?? '') && !document.querySelector('[data-section=payment-exception] form')`));
  await visit('/payments?view=exceptions', '!!document.querySelector("[data-exceptions-table]")');
  ok('queue shows it as recorded', await until(`/Manual refund recorded/.test(document.querySelector('[data-exception-order="KTS-TEST-0006"] [data-exception-handling]')?.innerText ?? '')`) && /View/.test(await text('[data-exception-order="KTS-TEST-0006"] [data-next-step]')));
  ok('payment and order records untouched', (await q(`select status from payments where provider_payment_id = 'pay_E2ELATE'`))[0].status === 'captured' && (await statusOf('KTS-TEST-0006')) === 'cancelled');
  await visit(`/orders/${o6}`, '!!document.querySelector("[data-section=billing]")');
  ok('order page: Cancelled · paid, manual refund recorded', await exists('[data-cancelled-money="cancelled_paid_refund_recorded"]'));
  await visit(`/orders/${await id('KTS-TEST-0001')}`, '!!document.querySelector("[data-section=billing]")');
  ok('order page: Cancelled · unpaid', await exists('[data-cancelled-money="cancelled_unpaid"]'));
  await visit('/payments?view=attempts', '!!document.querySelector("[data-payments-list]")');
  ok('payment attempts list with exception column', (await exists('[data-payment-row="pay_E2ELATE"]')) && /Paid after cancel/i.test(await text('[data-payment-row="pay_E2ELATE"]')));
  await visit('/payments?view=attempts&status=failed');
  ok('payment attempts filter by status', (await ev(`[...document.querySelectorAll('[data-payment-row]')].map(r=>r.dataset.paymentRow).join()`)) === 'pay_TEST0007');
  await visit('/payments?view=events', '!!document.querySelector("[data-events-table]")');
  ok('provider notifications listed without their content', (await exists('[data-event-row="razorpay:evt_e2e"]')) && !/hidden-e2e/.test(await ev('document.documentElement.outerHTML')));

  // ---------- settings ----------
  await visit('/settings', '!!document.querySelector("[data-settings-table]")');
  // Client change request (2026-10-03): Settings is the Configuration area, with an index of areas over the same registry.
  ok('configuration: the page is titled Configuration and lists Company, Locations, Billing, Tax, POS and Orders',
    /Configuration/.test(await text('h1')) && await ev(`[...document.querySelectorAll('[data-config-area]')].map(d => d.dataset.configArea).join()`) === 'Company,Locations,Billing,Tax,POS,Orders');
  ok('configuration: every in-page area link points at a settings group on the page', await ev(`(() => { const a = [...document.querySelectorAll('[data-config-areas] a[href^="#"]')]; return a.length > 0 && a.every(x => !!document.getElementById(x.getAttribute('href').slice(1))); })()`));
  ok('settings: unpaid-order hold time locked, 14400 minutes', (await exists('[data-setting="checkout.payment_window_minutes"][data-editable=no] [data-locked]'))
    && /14400 minutes/.test(await text('[data-setting="checkout.payment_window_minutes"] [data-setting-value]')));
  ok('settings: tax and account security locked', (await exists('[data-setting="billing.prices_include_tax"] [data-locked]')) && (await exists('[data-setting="auth.login_max_failures"] [data-locked]')));
  // M10 made company details and the delivery charge editable too; business rules (tax, hold time, security) stay locked.
  const editable = await ev(`[...document.querySelectorAll('[data-settings-table] form')].map(f=>f.closest('[data-setting]').dataset.setting).sort().join()`);
  ok('settings: forms only for safe settings (low stock, company, delivery); no free-form editor', editable.split(',').filter(k => !k.startsWith('alerts.')).join() === ['carts.abandon_after_hours','checkout.abandoned_after_hours','checkout.cart_refresh_minutes','company.address','company.gstin','company.legal_name','company.phone','company.state','company.support_email','discounts.enabled','discounts.stacking','inventory.low_stock_threshold',
    'loyalty.earn_points_per_100','loyalty.earn_when','loyalty.enabled','loyalty.expiry_months','loyalty.max_redeem_points','loyalty.min_redeem_points','loyalty.point_value_paise',
    'notifications.abandoned_cart','notifications.abandoned_checkout','notifications.order_cancelled','notifications.order_delivered','notifications.order_shipped','notifications.refund_processed','notifications.return_status','notifications.support_reply',
    'payments.cod_discount','payments.cod_enabled','payments.cod_max_order','payments.cod_min_order','pricing.max_sale_discount_percent','returns.enabled','returns.window_days','reviews.eligibility','shipping.flat_rate_paise','shipping.free_from_paise','shipping.method',
    // commerce workflows (2026-10-01)
    'discounts.staff_max_percent','emails.cart_reminder_intro','emails.cart_reminder_subject','notifications.abandoned_cart_auto','notifications.order_packed','notifications.order_tracking','notifications.payment_request',   // order_tracking: Phase 6 (2026-10-08)
    'payments.cod_discount_min_order','payments.cod_discount_percent','payments.cod_discount_with_other',
    ].sort().join(), editable);   // ERP modules add business switches (all off) and staff alert switches
  ok('settings: returns/refunds policy shown as none', /Returns and refunds[\s\S]*None/.test(await text('[data-policies]')));
  const L = '[data-setting="inventory.low_stock_threshold"] form';
  const [orig] = await q(`select value from settings where key = 'inventory.low_stock_threshold'`);
  await fill(`${L} [name=value]`, '5000');
  await submit(L);
  ok('settings: out-of-range value refused', /from 0 to 1000/.test(await ev(`document.querySelector('${L} [data-form-message]')?.innerText ?? ''`)));
  await fill(`${L} [name=value]`, '4');
  await submit(L);
  ok('settings: low-stock level saved and audited', (await q(`select value from settings where key = 'inventory.low_stock_threshold'`))[0].value === 4
    && (await q(`select count(*)::int n from audit_logs where action = 'settings.update'`))[0].n === 1);
  await fill(`${L} [name=value]`, String(orig.value));
  await submit(L);
  ok('settings: restored', (await q(`select value from settings where key = 'inventory.low_stock_threshold'`))[0].value === orig.value);
  ok('hold time still 14400', (await q(`select value from settings where key = 'checkout.payment_window_minutes'`))[0].value === 14400);
  await b.shot('m8-settings.png', true);

  // ================= manager: settings read-only =================
  ok('manager signs in', await signIn('manager', 'Manager M8'));
  await visit('/settings', '!!document.querySelector("[data-settings-table]")');
  ok('manager sees settings without any form', (await ev(`document.querySelectorAll('[data-settings-table] form').length`)) === 0);
  await visit('/payments', '!!document.querySelector("[data-payments-tabs]")');
  ok('manager (billing.read, no refunds.create) sees payments', await exists('[data-payments-tabs]'));
  await visit(`/customers/${ravi.id}`, '!!document.querySelector("[data-section=profile]")');
  ok('manager (customers.read) cannot change customers', (await exists('[data-readonly=customer]')) && !(await exists('#customer-status-form')) && !(await exists('[data-drawer-open=status]')) && !(await exists('[data-drawer-open=contact]')));

  // ================= support =================
  ok('support signs in', await signIn('support', 'Support M8'));
  const snav = await navText();
  ok('support menu: Customers yes; Payments and Configuration no', /Customers/.test(snav) && !/Payments/.test(snav) && !/Configuration|Settings/.test(snav), snav);
  for (const p of ['/payments', '/settings']) {
    await visit(p);
    ok(`support gets "not permitted" on ${p}`, await exists('[data-gate=forbidden]'));
  }
  await visit(`/orders/${o6}`, '!!document.querySelector("[data-section=billing]")');
  ok('support: no payment-exception details on the order page', !(await exists('[data-cancelled-money]')) && !(await exists('[data-order-exceptions]')));
  ok('support can export orders (orders.read)', (await fetchText('/orders/export')).status === 200);

  // ================= inventory manager: no customers, no orders =================
  ok('inventory manager signs in', await signIn('inventory', 'Inventory M8'));
  ok('inventory manager menu has no Customers', !/Customers/.test(await navText()));
  await visit('/customers');
  ok('inventory manager gets "not permitted" on /customers', (await exists('[data-gate=forbidden]')) && !(await exists('[data-customers-table]')));
  await visit(`/customers/${ravi.id}`);
  ok('inventory manager gets "not permitted" on a customer page', (await exists('[data-gate=forbidden]')) && !/ravi/i.test(await text('main')));
  ok('inventory manager cannot export orders (403)', (await fetchText('/orders/export')).status === 403);

  // ================= integrity =================
  ok('no order amount was changed', JSON.stringify(await q(`select order_number, subtotal_paise, total_paise from orders order by order_number`)) === JSON.stringify(amountsBefore));
  ok('stock still equals the ledger', (await q(`select count(*)::int n from product_variants v where v.stock_qty <> (select coalesce(sum(m.delta),0) from inventory_movements m where m.variant_id = v.id)`))[0].n === 0);

  // The invitation link works only once: sign in again through the login page.
  await b.send('Network.clearBrowserCookies');
  await visit('/login', '!!document.querySelector("input[name=email]")');
  await fill('main input[name=email]', 'm8.admin@test.local'); await fill('main input[name=password]', PW);
  await submit('main form');
  ok('admin signs in again', await until(`location.pathname==='/dashboard'`));

  // ================= M10: company details, delivery charge, packing slip =================
  await visit('/settings');
  ok('M10 settings: Company and Shipping groups are editable', (await exists('[data-setting="company.legal_name"] form')) && (await exists('[data-setting="shipping.method"] select')));
  await fill('[data-setting="company.legal_name"] input[name=value]', 'KITSYUU E2E Pvt Ltd'); await submit('[data-setting="company.legal_name"] form');
  await visit('/settings');
  ok('M10 settings: company name saved and shown', /KITSYUU E2E Pvt Ltd/.test(await text('[data-setting="company.legal_name"] [data-setting-value]')));
  await visit(`/orders/${o2}/packing-slip`, '!!document.querySelector("[data-packing-slip]")');
  const slip = await text('[data-packing-slip]');
  ok('M10 packing slip: company, order number and items, no prices', /KITSYUU E2E Pvt Ltd/.test(slip) && (await exists('[data-slip-items] tbody tr')) && !/₹/.test(slip), slip.slice(0, 120));
  await b.viewport(390, 844, true);
  for (const p of ['/customers', `/customers/${ravi.id}`, `/customers/${ravi.id}?tab=orders`, `/customers/${ravi.id}?tab=payments`, `/customers/${ravi.id}?tab=activity`, '/payments', '/payments?view=attempts', '/settings', `/orders/${o2}`, `/orders/${o2}?tab=payment`, `/orders/${o2}?tab=fulfilment`, `/orders/${o2}?tab=returns`, '/dashboard']) {
    await visit(p);
    ok(`no horizontal page scroll at 390px: ${p.replace(ravi.id, ':id').replace(o2, ':id')}`, await ev('document.documentElement.scrollWidth <= innerWidth + 1'));
  }
  ok('no page errors during the run', allErrors.length === 0, allErrors.slice(0, 3).join(' | '));
} catch (e) {
  ok('run completed', false, e.stack?.split('\n').slice(0, 3).join(' '));
} finally { b.close(); await pool.end(); }

console.log(out.join('\n'));
const failed = out.filter(l => l.startsWith('FAIL')).length;
console.log(`\n${out.length - failed} PASS, ${failed} FAIL`);
process.exitCode = failed ? 1 : 0;
