// POS phase 2 (2026-10-13), against the LOCAL test database: several tenders on one bill, store credit (a ledger; the shop
// owes the customer), credit bills (the customer owes the shop), the customer profile and the order lookup at the counter.
// Money, store credit and credit are checked to stay apart; every concurrent case is run for real with two connections.
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {ConflictError, ForbiddenError, DomainError, settingUpdateInput} from '@kitsyuu/contracts';
import {
  adjustLocationStock, adjustStoreCredit, completePosSale, creditReconciliation, creditReport, findPosOrders, getCreditBill, getCustomerCredit, getStoreCredit,
  openPosSession, posContext, posCustomerProfile, posReport, posSessionSummary, quotePosSale, repayCreditBill, reverseStoreCreditEntry, saveLocation, setCreditAccount,
  storeCreditBalance, storeCreditReconciliation, storeCreditReport, voidPosSale, loyaltyBalance,
  getOrderForCounter, quoteCounterExchange, settleCounterExchange, updateSetting, POS_TENDER_METHODS,
} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const admin = createDb({connectionString: ADMIN_DATABASE_URL, max: 8});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 2});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 2});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'pos-phase2.test', requestId: 'test'};
const key = () => randomBytes(16).toString('hex');
const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(admin, (await acceptStaffInvite(admin, {token, password: 'pos phase two passphrase', fullName: role}, ctx)).token);
}
const variant = async sku => (await q(`select v.id, v.sku, p.price_paise from product_variants v join products p on p.id = v.product_id where v.sku = $1`, [sku]))[0];
const locQty = async (loc, v) => (await q(`select coalesce((select qty from location_stock where location_id = $1 and variant_id = $2), 0)::int n`, [loc, v]))[0].n;
const customer = async (email, name, phone) => (await owner.insertInto('customers').values({email, full_name: name, phone, email_verified_at: new Date()}).returning('id').executeTakeFirstOrThrow()).id;
const pays = id => q(`select provider, method, amount_paise, status from payments where order_id = $1 order by created_at, provider_payment_id`, [id]);

let root, manager, sales, accountant, store, V, W, meera, ravi, sRoot, sManager, sSales, unit;
/** A sale of `qty` of V for the server's total, settled by `tenders` (a function of the total) or one legacy payment. */
async function sell(actor, session, opts = {}) {
  const lines = opts.lines ?? [{variantId: V.id, qty: opts.qty ?? 1}];
  const total = (await quotePosSale(admin, actor, {locationId: store, lines, customerId: opts.customerId ?? null, discount: null})).totals.totalPaise;
  const tenders = opts.tenders ? opts.tenders(total) : null;
  return completePosSale(admin, actor, {sessionId: session.id, idempotencyKey: opts.key ?? key(), lines, customerId: opts.customerId ?? null, discount: null,
    payment: opts.payment ?? {method: 'cash', tenderedPaise: total}, tenders, expectedTotalPaise: opts.expected ?? total}, ctx);
}

before(async () => {
  root = await staff('p2.root@test.local', 'super_admin');
  manager = await staff('p2.manager@test.local', 'manager');
  sales = await staff('p2.sales@test.local', 'sales');
  accountant = await staff('p2.accountant@test.local', 'accountant');
  store = (await saveLocation(admin, root, {code: 'P2-S1', name: 'Phase Two Store', kind: 'retail', address: 'Chennai', active: true}, ctx)).id;
  [V, W] = await Promise.all(['KTS-TOP-001-M', 'KTS-BTM-001-L'].map(variant));
  for (const v of [V, W]) await adjustLocationStock(admin, manager, {locationId: store, variantId: v.id, delta: 60, reason: 'restock', note: 'Phase 2 test stock', expectedQty: 0}, ctx);
  meera = await customer('p2.meera@test.local', 'Meera Two', '9840055501');
  ravi = await customer('p2.ravi@test.local', 'Ravi Two', '9840055502');
  for (const a of [root, manager, sales]) await openPosSession(admin, a, {locationId: store, openingCashPaise: 100000}, ctx);
  sRoot = (await posContext(admin, root)).session; sManager = (await posContext(admin, manager)).session; sSales = (await posContext(admin, sales)).session;
  unit = (await quotePosSale(admin, sales, {locationId: store, lines: [{variantId: V.id, qty: 1}], discount: null})).totals.totalPaise;
  assert.ok(unit >= 100000, 'the test product costs at least ₹1,000');
});
after(async () => { await admin.destroy(); await owner.destroy(); await pool.end(); });

// ---------------------------------------------------------------- permissions as migrated
test('permissions: administrators hold the credit and store-credit permissions; a manager and a cashier hold none for credit', async () => {
  for (const p of ['pos.credit_sell', 'credit.manage', 'credit.repay', 'credit.adjust', 'store_credit.redeem', 'store_credit.issue', 'store_credit.adjust']) assert.ok(root.permissions.has(p), p);
  for (const a of [manager, sales]) {
    for (const p of ['pos.credit_sell', 'credit.manage', 'credit.repay', 'credit.adjust', 'store_credit.adjust']) assert.ok(!a.permissions.has(p), `${p} is not given to managers or cashiers`);
    assert.ok(a.permissions.has('store_credit.redeem') && a.permissions.has('store_credit.issue'));
  }
  assert.ok(!accountant.permissions.has('store_credit.adjust') && !accountant.permissions.has('credit.manage'));
});

// ---------------------------------------------------------------- split payments
test('split payment: cash + UPI and card + cash settle one bill; each tender is its own payment row; the bill is counted once', async () => {
  const a = await sell(sales, sSales, {tenders: t => [{method: 'cash', amountPaise: 50000, tenderedPaise: 60000}, {method: 'upi', amountPaise: t - 50000, reference: 'UPI-SPLIT-0001'}]});
  assert.equal(a.changePaise, 10000, 'change is worked out on the cash part only');
  assert.deepEqual((await pays(a.orderId)).map(p => [p.provider, p.method, p.amount_paise, p.status]), [['pos', 'cash', 50000, 'captured'], ['pos', 'upi', unit - 50000, 'captured']]);
  assert.deepEqual((await q(`select payment_method, payment_status, total_paise from orders where id = $1`, [a.orderId]))[0], {payment_method: 'split', payment_status: 'paid', total_paise: unit});
  const b = await sell(sales, sSales, {tenders: t => [{method: 'card', amountPaise: t - 30000, reference: 'CARD-SPLIT-01'}, {method: 'cash', amountPaise: 30000}]});
  assert.equal((await pays(b.orderId)).reduce((n, p) => n + p.amount_paise, 0), unit, 'the tenders add up to the bill');
  const sum = await posSessionSummary(admin, sSales.id);
  assert.equal(sum.transactions, 2, 'two bills, not four payment rows');
  assert.equal(sum.grossPaise, unit * 2);
  assert.equal(sum.expectedCashPaise, 100000 + 50000 + 30000, 'the drawer holds the opening cash and the cash parts only');
  assert.equal(sum.moneyReceivedPaise, unit * 2);
});

test('split payment: wrong totals, negative or repeated tenders and missing references are refused and nothing is saved', async () => {
  const before = (await q(`select count(*)::int n from orders where pos_session_id = $1`, [sSales.id]))[0].n, stock = await locQty(store, V.id);
  await assert.rejects(sell(sales, sSales, {tenders: t => [{method: 'cash', amountPaise: 10000}, {method: 'upi', amountPaise: t - 20000, reference: 'UPI-SHORT-01'}]}), e => e instanceof ConflictError && /add up to/.test(e.message));
  await assert.rejects(sell(sales, sSales, {tenders: t => [{method: 'cash', amountPaise: t}, {method: 'upi', amountPaise: 5000, reference: 'UPI-OVER-001'}]}), /add up to/);
  await assert.rejects(sell(sales, sSales, {tenders: t => [{method: 'cash', amountPaise: -500}, {method: 'upi', amountPaise: t + 500, reference: 'UPI-NEG-0001'}]}), DomainError);
  await assert.rejects(sell(sales, sSales, {tenders: t => [{method: 'cash', amountPaise: 100}, {method: 'cash', amountPaise: t - 100}]}), /used once/);
  await assert.rejects(sell(sales, sSales, {tenders: t => [{method: 'cash', amountPaise: 100}, {method: 'upi', amountPaise: t - 100}]}), /reference/);
  await assert.rejects(sell(sales, sSales, {tenders: t => [{method: 'gateway', amountPaise: t}]}), DomainError, 'no online gateway at the counter');
  await assert.rejects(sell(sales, sSales, {tenders: t => [{method: 'cash', amountPaise: 20000, tenderedPaise: 10000}, {method: 'upi', amountPaise: t - 20000, reference: 'UPI-CASH-0001'}]}), /cash received/);
  assert.deepEqual([(await q(`select count(*)::int n from orders where pos_session_id = $1`, [sSales.id]))[0].n, await locQty(store, V.id)], [before, stock]);
});

test('split payment: a retry with the same key is the same bill (no second payment rows); a different split under that key is refused', async () => {
  const k = key(), tenders = t => [{method: 'cash', amountPaise: 40000}, {method: 'upi', amountPaise: t - 40000, reference: 'UPI-RETRY-001'}];
  const a = await sell(sales, sSales, {key: k, tenders});
  const again = await sell(sales, sSales, {key: k, tenders});
  assert.deepEqual([again.replay, again.orderId], [true, a.orderId]);
  assert.equal((await pays(a.orderId)).length, 2);
  await assert.rejects(sell(sales, sSales, {key: k, tenders: t => [{method: 'cash', amountPaise: 30000}, {method: 'upi', amountPaise: t - 30000, reference: 'UPI-RETRY-001'}]}), /already paid as/);
});

// ---------------------------------------------------------------- store credit
test('store credit: only an authorised adjustment adds it; a refused attempt is audited; the ledger and the balance agree', async () => {
  await assert.rejects(adjustStoreCredit(admin, manager, {customerId: meera, amountPaise: 50000, reason: 'Goodwill', key: key()}, ctx), ForbiddenError);
  assert.equal((await q(`select count(*)::int n from audit_logs where action = 'store_credit.adjust_denied' and entity_id = $1 and staff_id = $2`, [meera, manager.staffId]))[0].n, 1);
  assert.equal(await storeCreditBalance(admin, meera), 0);
  await assert.rejects(adjustStoreCredit(admin, root, {customerId: meera, amountPaise: 50000, reason: '', key: key()}, ctx), /reason/);
  const k = key();
  const a = await adjustStoreCredit(admin, root, {customerId: meera, amountPaise: 50000, reason: 'Goodwill for a delayed order', key: k}, ctx);
  const again = await adjustStoreCredit(admin, root, {customerId: meera, amountPaise: 50000, reason: 'Goodwill for a delayed order', key: k}, ctx);
  assert.deepEqual([a.balancePaise, again.replay, again.entryId], [50000, true, a.entryId], 'the same request twice is one credit');
  await assert.rejects(adjustStoreCredit(admin, root, {customerId: meera, amountPaise: 70000, reason: 'Other amount, same key', key: k}, ctx), /different store-credit movement/);
  await assert.rejects(adjustStoreCredit(admin, root, {customerId: meera, amountPaise: -60000, reason: 'More than they hold', key: key()}, ctx), e => e instanceof ConflictError && /Only ₹500.00/.test(e.message));
  assert.equal(await storeCreditBalance(admin, meera), 50000);
  const [au] = await q(`select before_data as before, after_data as after, metadata from audit_logs where action = 'store_credit.adjust' and entity_id = $1`, [meera]);
  assert.deepEqual([au.before.balance_paise, au.after.balance_paise, au.metadata.amount_paise, au.metadata.reason], [0, 50000, 50000, 'Goodwill for a delayed order']);
  assert.ok((await storeCreditReconciliation(admin)).ok);
});

test('store credit at the counter: part of it with cash, then the rest; never more than the balance; it is not money received', async () => {
  await assert.rejects(sell(sales, sSales, {tenders: t => [{method: 'store_credit', amountPaise: 20000}, {method: 'cash', amountPaise: t - 20000}]}), /need a customer/);
  const a = await sell(sales, sSales, {customerId: meera, tenders: t => [{method: 'store_credit', amountPaise: 20000}, {method: 'cash', amountPaise: t - 20000}]});
  assert.equal(await storeCreditBalance(admin, meera), 30000, 'partial redemption');
  assert.deepEqual((await pays(a.orderId)).map(p => [p.provider, p.method, p.amount_paise]).sort(), [['pos', 'cash', unit - 20000], ['store_credit', 'store_credit', 20000]].sort());
  await assert.rejects(sell(sales, sSales, {customerId: meera, tenders: t => [{method: 'store_credit', amountPaise: 30001}, {method: 'cash', amountPaise: t - 30001}]}), e => e instanceof ConflictError && /Only ₹300.00 of store credit/.test(e.message));
  assert.equal(await storeCreditBalance(admin, meera), 30000, 'the refused sale left the balance alone');
  const b = await sell(sales, sSales, {customerId: meera, tenders: t => [{method: 'store_credit', amountPaise: 30000}, {method: 'upi', amountPaise: t - 30000, reference: 'UPI-SC-00001'}]});
  assert.equal(await storeCreditBalance(admin, meera), 0, 'full redemption');
  const rep = await posReport(admin, accountant, {from: today(), to: today()});
  assert.equal(rep.storeCreditPaise, 50000);
  assert.equal(rep.moneyReceivedPaise, rep.methods.reduce((n, m) => n + m.amountPaise, 0));
  assert.ok(!rep.methods.some(m => m.method === 'store_credit'), 'store credit is not a money method');
  const view = await getStoreCredit(admin, sales, meera);
  assert.deepEqual(view.entries.map(e => [e.kind, e.amount_paise]), [['redeem', -30000], ['redeem', -20000], ['adjustment', 50000]]);
  assert.equal(view.entries[0].pos_number, b.posNumber);
  assert.equal(await loyaltyBalance(admin, meera) >= 0, true); assert.equal((await getCustomerCredit(admin, sales, meera)).account, null, 'store credit is neither points nor a credit account');
});

test('store credit: a sale that fails after the debit rolls the debit back; two tills cannot spend the same balance', async () => {
  await adjustStoreCredit(admin, root, {customerId: ravi, amountPaise: 30000, reason: 'Test balance for the concurrency checks', key: key()}, ctx);
  // fails on the total check, which runs before the debit, and on stock, which fails after everything was priced
  await assert.rejects(sell(sales, sSales, {customerId: ravi, expected: unit + 1, tenders: () => [{method: 'store_credit', amountPaise: 30000}, {method: 'cash', amountPaise: unit - 29999}]}), /total changed/);
  const have = await locQty(store, W.id);
  await assert.rejects(sell(sales, sSales, {customerId: ravi, lines: [{variantId: W.id, qty: have + 1 > 10 ? 10 : have + 1}, {variantId: V.id, qty: 10}, {variantId: W.id, qty: 1}], tenders: t => [{method: 'store_credit', amountPaise: 30000}, {method: 'cash', amountPaise: t - 30000}]}));
  assert.equal(await storeCreditBalance(admin, ravi), 30000, 'no debit without a completed sale');
  assert.equal((await q(`select count(*)::int n from store_credit_entries where customer_id = $1 and kind = 'redeem'`, [ravi]))[0].n, 0);
  // two tills, the same ₹300, at the same moment
  const both = await Promise.allSettled([
    sell(sales, sSales, {customerId: ravi, tenders: t => [{method: 'store_credit', amountPaise: 30000}, {method: 'cash', amountPaise: t - 30000}]}),
    sell(manager, sManager, {customerId: ravi, tenders: t => [{method: 'store_credit', amountPaise: 30000}, {method: 'cash', amountPaise: t - 30000}]}),
  ]);
  assert.deepEqual(both.map(r => r.status).sort(), ['fulfilled', 'rejected'], 'exactly one of the two sales goes through');
  assert.match(both.find(r => r.status === 'rejected').reason.message, /store credit is available/);
  assert.equal(await storeCreditBalance(admin, ravi), 0);
  assert.equal((await q(`select count(*)::int n from store_credit_entries where customer_id = $1 and kind = 'redeem'`, [ravi]))[0].n, 1);
  assert.equal((await q(`select count(*)::int n from payments where provider = 'store_credit' and order_id in (select id from orders where customer_id = $1)`, [ravi]))[0].n, 1, 'no payment row without its debit');
  assert.ok((await storeCreditReconciliation(admin)).ok);
});

test('store credit: a mistake is undone with a compensating entry, once; history is kept; it never expires', async () => {
  const add = await adjustStoreCredit(admin, root, {customerId: ravi, amountPaise: 12000, reason: 'Entered for the wrong customer', key: key()}, ctx);
  await assert.rejects(reverseStoreCreditEntry(admin, manager, {entryId: add.entryId, reason: 'Wrong customer'}, ctx), ForbiddenError);
  const rev = await reverseStoreCreditEntry(admin, root, {entryId: add.entryId, reason: 'Wrong customer'}, ctx);
  assert.equal(rev.balancePaise, 0);
  await assert.rejects(reverseStoreCreditEntry(admin, root, {entryId: add.entryId, reason: 'Again'}, ctx), /already reversed/);
  await assert.rejects(reverseStoreCreditEntry(admin, root, {entryId: rev.entryId, reason: 'Undo the undo'}, ctx), /cannot itself be reversed/);
  const rows = await q(`select kind, amount_paise, reverses_id from store_credit_entries where customer_id = $1 order by created_at, id`, [ravi]);
  assert.equal(rows.length, 4, 'nothing was deleted: credit, spend, credit, reversal');
  assert.equal(rows.at(-1).reverses_id, add.entryId);
  await assert.rejects(admin.updateTable('store_credit_entries').set({reason: 'edited'}).where('id', '=', add.entryId).execute(), /permission denied/, 'the staff app cannot rewrite a ledger row');
  await assert.rejects(admin.deleteFrom('store_credit_entries').where('id', '=', add.entryId).execute(), /permission denied/);
  assert.equal((await q(`select count(*)::int n from information_schema.columns where table_name in ('store_credit_accounts', 'store_credit_entries') and column_name like '%expir%'`))[0].n, 0, 'no expiry field exists');
  const rep = await storeCreditReport(admin, accountant, {from: today(), to: today()});
  assert.ok(rep.reconciled); assert.equal(rep.liabilityPaise, 0);
  await assert.rejects(storeCreditReport(admin, sales, {from: today(), to: today()}), ForbiddenError);
});

// ---------------------------------------------------------------- credit bills
test('credit: nobody has credit by default; only an administrator approves an account; a refused attempt is audited', async () => {
  await q(`insert into role_permissions (role_id, permission_code) select id, 'pos.credit_sell' from roles where code = 'manager' on conflict do nothing`);
  const fresh = await q(`select count(*)::int n from credit_accounts`);
  assert.equal(fresh[0].n, 0);
  await assert.rejects(setCreditAccount(admin, manager, {customerId: meera, limitPaise: 500000, dueDays: 15, active: true, note: null}, ctx), ForbiddenError);
  assert.equal((await q(`select count(*)::int n from audit_logs where action = 'credit.account_denied' and entity_id = $1`, [meera]))[0].n, 1);
  await assert.rejects(setCreditAccount(admin, root, {customerId: meera, limitPaise: 0, dueDays: 15, active: true, note: null}, ctx), /limit above/);
  await assert.rejects(setCreditAccount(admin, root, {customerId: meera, limitPaise: 500000, dueDays: 0, active: true, note: null}, ctx), /due period/);
});

test('credit sale: refused without an account, for a cashier, over the limit and when switched off; allowed for a granted manager within the limit', async () => {
  const mgr = await principalOf('p2.manager@test.local');
  const onCredit = t => [{method: 'credit', amountPaise: t}];
  await assert.rejects(sell(root, sRoot, {customerId: meera, tenders: onCredit}), e => e instanceof ForbiddenError && /no approved credit account/.test(e.message));
  await assert.rejects(sell(root, sRoot, {tenders: onCredit}), /need a customer/);
  const limit = unit * 2 + 5000;
  await setCreditAccount(admin, root, {customerId: meera, limitPaise: limit, dueDays: 15, active: true, note: 'Regular customer, approved by the owner'}, ctx);
  await assert.rejects(sell(sales, sSales, {customerId: meera, tenders: onCredit}), ForbiddenError, 'a cashier without pos.credit_sell');
  const stock = await locQty(store, V.id);
  const a = await sell(mgr, sManager, {customerId: meera, tenders: onCredit});
  assert.equal(await locQty(store, V.id), stock - 1);
  const [o] = await q(`select status, payment_status, payment_method, paid_at from orders where id = $1`, [a.orderId]);
  assert.deepEqual(o, {status: 'delivered', payment_status: 'unpaid', payment_method: 'credit', paid_at: null}, 'handed over, nothing collected');
  assert.equal((await pays(a.orderId)).length, 0, 'a credit sale has no payment row');
  const [b] = await q(`select amount_paise, outstanding_paise, due_on::text, limit_paise_at_sale, due_days_at_sale, status, (due_on - (now() at time zone 'Asia/Kolkata')::date) days from credit_bills where order_id = $1`, [a.orderId]);
  assert.deepEqual([b.amount_paise, b.outstanding_paise, b.limit_paise_at_sale, b.due_days_at_sale, b.status, b.days], [unit, unit, limit, 15, 'open', 15]);
  assert.equal(a.creditDueOn, b.due_on);
  // part now, the rest on credit
  const p = await sell(mgr, sManager, {customerId: meera, tenders: t => [{method: 'cash', amountPaise: 20000}, {method: 'credit', amountPaise: t - 20000}]});
  assert.equal((await q(`select payment_status from orders where id = $1`, [p.orderId]))[0].payment_status, 'unpaid', 'not paid while anything is owed');
  assert.deepEqual((await pays(p.orderId)).map(x => [x.method, x.amount_paise]), [['cash', 20000]]);
  const owed = unit * 2 - 20000;
  assert.equal((await getCustomerCredit(admin, mgr, meera)).account.outstanding_paise, owed);
  await assert.rejects(sell(mgr, sManager, {customerId: meera, tenders: onCredit}), e => e instanceof ConflictError && /Over the credit limit/.test(e.message));
  // new terms apply to new bills only
  await setCreditAccount(admin, root, {customerId: meera, limitPaise: limit, dueDays: 30, active: false, note: 'Paused'}, ctx);
  assert.equal((await q(`select due_days_at_sale, due_on::text d from credit_bills where order_id = $1`, [a.orderId]))[0].d, b.due_on, 'an existing bill keeps its due date');
  await assert.rejects(sell(mgr, sManager, {customerId: meera, tenders: t => [{method: 'cash', amountPaise: t - 1000}, {method: 'credit', amountPaise: 1000}]}), /switched off/);
  await setCreditAccount(admin, root, {customerId: meera, limitPaise: limit, dueDays: 30, active: true, note: null}, ctx);
  const rep = await posReport(admin, accountant, {from: today(), to: today()});
  assert.equal(rep.onCreditPaise, owed, 'sold on credit is reported apart');
  assert.equal(rep.moneyReceivedPaise, rep.methods.reduce((n, m) => n + m.amountPaise, 0), 'and is not in the money received');
  assert.ok((await creditReconciliation(admin)).ok);
});

test('credit: two sales at the same moment cannot go over the limit together', async () => {
  const mgr = await principalOf('p2.manager@test.local');
  await setCreditAccount(admin, root, {customerId: ravi, limitPaise: unit + 100, dueDays: 7, active: true, note: null}, ctx);
  const both = await Promise.allSettled([
    sell(mgr, sManager, {customerId: ravi, tenders: t => [{method: 'credit', amountPaise: t}]}),
    sell(root, sRoot, {customerId: ravi, tenders: t => [{method: 'credit', amountPaise: t}]}),
  ]);
  assert.deepEqual(both.map(r => r.status).sort(), ['fulfilled', 'rejected']);
  assert.match(both.find(r => r.status === 'rejected').reason.message, /Over the credit limit/);
  const c = await getCustomerCredit(admin, root, ravi);
  assert.deepEqual([c.account.outstanding_paise, c.bills.length, c.availablePaise], [unit, 1, 100]);
  assert.ok((await creditReconciliation(admin)).ok);
});

test('credit repayment: part, then the rest; recorded once; never more than is owed; the order is paid only at the end', async () => {
  const [bill] = await q(`select b.id, b.order_id, b.amount_paise from credit_bills b where b.customer_id = $1 and b.status = 'open' order by b.created_at limit 1`, [meera]);
  await assert.rejects(repayCreditBill(admin, sales, {billId: bill.id, amountPaise: 1000, method: 'cash', reference: null, key: key()}, ctx), ForbiddenError);
  await assert.rejects(repayCreditBill(admin, root, {billId: bill.id, amountPaise: 0, method: 'cash', reference: null, key: key()}, ctx), /above ₹0/);
  await assert.rejects(repayCreditBill(admin, root, {billId: bill.id, amountPaise: bill.amount_paise + 1, method: 'cash', reference: null, key: key()}, ctx), e => e instanceof ConflictError && /is owed on this bill/.test(e.message));
  await assert.rejects(repayCreditBill(admin, root, {billId: bill.id, amountPaise: 1000, method: 'upi', reference: null, key: key()}, ctx), /reference/);
  await assert.rejects(repayCreditBill(admin, root, {billId: bill.id, amountPaise: 1000, method: 'cheque', reference: null, key: key()}, ctx), DomainError);
  const cashBefore = (await posSessionSummary(admin, sRoot.id)).expectedCashPaise;
  const k = key();
  const r1 = await repayCreditBill(admin, root, {billId: bill.id, amountPaise: 40000, method: 'cash', reference: null, sessionId: sRoot.id, key: k}, ctx);
  assert.match(r1.number, /^CRP\//);
  assert.deepEqual([r1.outstandingPaise, r1.paidOff], [bill.amount_paise - 40000, false]);
  const again = await repayCreditBill(admin, root, {billId: bill.id, amountPaise: 40000, method: 'cash', reference: null, sessionId: sRoot.id, key: k}, ctx);
  assert.deepEqual([again.replay, again.number, again.outstandingPaise], [true, r1.number, r1.outstandingPaise], 'a double submit is one repayment');
  await assert.rejects(repayCreditBill(admin, root, {billId: bill.id, amountPaise: 50000, method: 'cash', reference: null, key: k}, ctx), /different repayment/);
  assert.equal((await q(`select count(*)::int n from credit_repayments where bill_id = $1`, [bill.id]))[0].n, 1);
  assert.equal((await posSessionSummary(admin, sRoot.id)).expectedCashPaise, cashBefore + 40000, 'cash taken at a till is in that drawer');
  assert.equal((await q(`select payment_status from orders where id = $1`, [bill.order_id]))[0].payment_status, 'unpaid', 'still owed');
  const r2 = await repayCreditBill(admin, root, {billId: bill.id, amountPaise: r1.outstandingPaise, method: 'upi', reference: 'UPI-REPAY-001', key: key()}, ctx);
  assert.deepEqual([r2.outstandingPaise, r2.paidOff], [0, true]);
  const [o] = await q(`select payment_status, paid_at is not null paid from orders where id = $1`, [bill.order_id]);
  assert.deepEqual(o, {payment_status: 'paid', paid: true});
  assert.deepEqual((await q(`select status, outstanding_paise from credit_bills where id = $1`, [bill.id]))[0], {status: 'paid', outstanding_paise: 0});
  await assert.rejects(repayCreditBill(admin, root, {billId: bill.id, amountPaise: 100, method: 'cash', reference: null, key: key()}, ctx), /already fully repaid/);
  assert.deepEqual((await pays(bill.order_id)).map(p => [p.provider, p.method, p.amount_paise]), [['pos_credit', 'cash', 40000], ['pos_credit', 'upi', bill.amount_paise - 40000]]);
  const view = await getCreditBill(admin, root, bill.id);
  assert.equal(view.repayments.length, 2); assert.equal(view.bill.outstanding_paise, 0);
  const au = await q(`select metadata from audit_logs where action = 'credit.repayment' and entity_id = $1 order by occurred_at`, [bill.order_id]);
  assert.deepEqual(au.map(a => a.metadata.amount_paise), [40000, bill.amount_paise - 40000]);
  // reports: repayments are not new sales, and nothing is counted twice
  const rep = await posReport(admin, accountant, {from: today(), to: today()});
  assert.equal(rep.repaymentsPaise, bill.amount_paise);
  assert.equal(rep.transactions, (await q(`select count(*)::int n from orders where pos_number is not null`))[0].n, 'a repayment adds no sale');
  const cr = await creditReport(admin, accountant, {from: today(), to: today()});
  assert.ok(cr.reconciled);
  assert.equal(cr.outstandingPaise, (await q(`select coalesce(sum(outstanding_paise), 0)::int n from credit_bills where status = 'open'`))[0].n);
  assert.equal(cr.repaidPaise, bill.amount_paise);
  await assert.rejects(creditReport(admin, sales, {from: today(), to: today()}), ForbiddenError);
});

test('overdue: a bill past its due date is reported as overdue; debt never goes below zero in the database', async () => {
  const [b] = await q(`select id from credit_bills where status = 'open' and customer_id = $1 limit 1`, [ravi]);
  // the owner connection moves the due date into the past for this check (the staff app never changes a due date)
  await pool.query(`update credit_bills set due_on = (now() at time zone 'Asia/Kolkata')::date - 3 where id = $1`, [b.id]);
  const cr = await creditReport(admin, accountant, {from: today(), to: today()});
  assert.ok(cr.overdue.some(x => x.id === b.id) && cr.overduePaise >= unit);
  await assert.rejects(pool.query(`update credit_bills set outstanding_paise = -1 where id = $1`, [b.id]), /check/);
  await assert.rejects(pool.query(`update credit_accounts set outstanding_paise = -1 where customer_id = $1`, [ravi]), /check/);
  await assert.rejects(pool.query(`update store_credit_accounts set balance_paise = -1 where customer_id = $1`, [ravi]), /check/);
});

// ---------------------------------------------------------------- void
test('void: every tender is undone: money refunded, store credit given back by a reversal, a credit bill cancelled', async () => {
  const mgr = await principalOf('p2.manager@test.local');
  await adjustStoreCredit(admin, root, {customerId: ravi, amountPaise: 25000, reason: 'Balance for the void check', key: key()}, ctx);
  await setCreditAccount(admin, root, {customerId: ravi, limitPaise: unit * 3, dueDays: 7, active: true, note: null}, ctx);
  const owedBefore = (await getCustomerCredit(admin, root, ravi)).account.outstanding_paise, stock = await locQty(store, V.id);
  const s = await sell(mgr, sManager, {customerId: ravi, tenders: t => [{method: 'store_credit', amountPaise: 25000}, {method: 'cash', amountPaise: 30000}, {method: 'credit', amountPaise: t - 55000}]});
  assert.equal(await storeCreditBalance(admin, ravi), 0);
  const v = await voidPosSale(admin, mgr, {orderId: s.orderId, reason: 'Rung up for the wrong customer'}, ctx);
  assert.equal(v.refundedPaise, 30000, 'only the cash is money to hand back');
  assert.equal(await storeCreditBalance(admin, ravi), 25000, 'the store credit is back');
  assert.equal((await getCustomerCredit(admin, root, ravi)).account.outstanding_paise, owedBefore, 'the debt of the voided bill is gone');
  assert.deepEqual((await q(`select status, outstanding_paise from credit_bills where order_id = $1`, [s.orderId]))[0], {status: 'cancelled', outstanding_paise: 0});
  assert.equal(await locQty(store, V.id), stock);
  assert.deepEqual((await q(`select status, payment_status from orders where id = $1`, [s.orderId]))[0], {status: 'cancelled', payment_status: 'refunded'});
  await assert.rejects(voidPosSale(admin, mgr, {orderId: s.orderId, reason: 'again'}, ctx), /already voided/);
  assert.ok((await storeCreditReconciliation(admin)).ok && (await creditReconciliation(admin)).ok);
});

// ---------------------------------------------------------------- returns and exchanges at the counter
const item = async (orderId, sku) => (await q(`select id, qty, unit_price_paise from order_items where order_id = $1 and sku = $2`, [orderId, sku]))[0];
async function exchange(actor, session, orderId, items, replacements, extra = {}) {
  const quote = await quoteCounterExchange(admin, actor, {orderId, locationId: store, items, replacements});
  const r = await settleCounterExchange(admin, actor, {sessionId: session.id, orderId, items, reasonCode: 'size_fit', note: extra.note ?? 'Exchange at the counter', replacements,
    surplus: extra.surplus, tenders: extra.tenders ? extra.tenders(quote) : null, expected: extra.expected ?? {returnValuePaise: quote.returnValuePaise, replacementPaise: quote.replacementPaise}, key: extra.key ?? key()}, ctx);
  return {quote, r};
}

test('exchange: equal value settles with nothing more; the stock comes back once and the replacement leaves this branch', async () => {
  await updateSetting(admin, root, settingUpdateInput.parse({key: 'returns.enabled', value: 'on'}), ctx);
  await updateSetting(admin, root, settingUpdateInput.parse({key: 'returns.window_days', value: '7'}), ctx);
  const sale = await sell(manager, sManager, {customerId: meera, qty: 2});
  const it = await item(sale.orderId, V.sku);
  const [v0, payRows0] = [await locQty(store, V.id), (await q(`select count(*)::int n from payments`))[0].n];
  const k = key();
  const {quote, r} = await exchange(manager, sManager, sale.orderId, [{orderItemId: it.id, qty: 1, restock: true}], [{variantId: V.id, qty: 1}], {key: k});
  assert.deepEqual([quote.outcome, quote.duePaise, quote.surplusPaise, quote.returnValuePaise], ['even', 0, 0, unit]);
  assert.deepEqual([r.outcome, r.amountPaise], ['even', 0]);
  assert.equal(await locQty(store, V.id), v0, 'one back, one out');
  const [ret] = await q(`select status, resolution, settlement, settlement_paise, exchange_order_id, inspection_result from return_requests where id = $1`, [r.returnId]);
  assert.deepEqual(ret, {status: 'completed', resolution: 'exchange', settlement: 'even', settlement_paise: 0, exchange_order_id: r.replacementOrderId, inspection_result: 'ok'});
  assert.deepEqual((await q(`select exchange_return_id, total_paise, payment_status from orders where id = $1`, [r.replacementOrderId]))[0], {exchange_return_id: r.returnId, total_paise: unit, payment_status: 'paid'}, 'the replacement bill points back at the return');
  assert.deepEqual((await pays(r.replacementOrderId)).map(p => [p.provider, p.method, p.amount_paise]), [['exchange', 'exchange', unit]], 'no money, no store credit: the returned goods paid for it');
  assert.equal((await q(`select total_paise, status from orders where id = $1`, [sale.orderId]))[0].total_paise, unit * 2, 'the original bill is not rewritten');
  // the same request again is the same exchange: no second return, bill, payment or stock movement
  const again = await settleCounterExchange(admin, manager, {sessionId: sManager.id, orderId: sale.orderId, items: [{orderItemId: it.id, qty: 1, restock: true}], reasonCode: 'size_fit', note: null,
    replacements: [{variantId: V.id, qty: 1}], expected: {returnValuePaise: unit, replacementPaise: unit}, key: k}, ctx);
  assert.deepEqual([again.replay, again.returnId, again.replacementOrderId], [true, r.returnId, r.replacementOrderId]);
  assert.equal((await q(`select count(*)::int n from return_requests where order_id = $1`, [sale.orderId]))[0].n, 1);
  assert.equal(await locQty(store, V.id), v0);
  assert.equal((await q(`select count(*)::int n from payments`))[0].n, payRows0 + 1);
  // what was returned cannot be returned again
  await assert.rejects(exchange(manager, sManager, sale.orderId, [{orderItemId: it.id, qty: 2, restock: true}], []), e => e instanceof ConflictError && /Only 1 of/.test(e.message));
});

test('exchange: a dearer replacement collects exactly the difference; a cheaper one gives exactly the difference as store credit', async () => {
  const dear = (await quotePosSale(admin, manager, {locationId: store, lines: [{variantId: W.id, qty: 1}], discount: null})).totals.totalPaise;
  assert.notEqual(dear, unit, 'the two test products have different prices');
  const [hi, lo, hiV, loV] = dear > unit ? [dear, unit, W, V] : [unit, dear, V, W];
  // bought the cheaper one, takes the dearer one: pays the difference (part cash, part UPI)
  const s1 = await sell(manager, sManager, {customerId: meera, lines: [{variantId: loV.id, qty: 1}]});
  const it1 = await item(s1.orderId, loV.sku);
  await assert.rejects(exchange(manager, sManager, s1.orderId, [{orderItemId: it1.id, qty: 1, restock: true}], [{variantId: hiV.id, qty: 1}]), /choose how the customer pays the difference/);
  await assert.rejects(exchange(manager, sManager, s1.orderId, [{orderItemId: it1.id, qty: 1, restock: true}], [{variantId: hiV.id, qty: 1}], {tenders: () => [{method: 'cash', amountPaise: hi - lo - 100}]}), /add up to/);
  assert.equal((await q(`select count(*)::int n from return_requests where order_id = $1`, [s1.orderId]))[0].n, 0, 'a refused exchange saves nothing, not even the return');
  const up = await exchange(manager, sManager, s1.orderId, [{orderItemId: it1.id, qty: 1, restock: true}], [{variantId: hiV.id, qty: 1}], {tenders: qt => [{method: 'cash', amountPaise: 10000}, {method: 'upi', amountPaise: qt.duePaise - 10000, reference: 'UPI-EXCH-0001'}]});
  assert.deepEqual([up.quote.outcome, up.quote.duePaise, up.r.outcome, up.r.amountPaise], ['collect', hi - lo, 'collect', hi - lo]);
  assert.deepEqual((await pays(up.r.replacementOrderId)).map(p => [p.provider, p.amount_paise]).sort(), [['exchange', lo], ['pos', 10000], ['pos', hi - lo - 10000]].sort());
  // bought the dearer one, takes the cheaper one: the difference is store credit, never expiring, in the same ledger
  const before = await storeCreditBalance(admin, meera);
  const s2 = await sell(manager, sManager, {customerId: meera, lines: [{variantId: hiV.id, qty: 1}]});
  const it2 = await item(s2.orderId, hiV.sku);
  const down = await exchange(manager, sManager, s2.orderId, [{orderItemId: it2.id, qty: 1, restock: true}], [{variantId: loV.id, qty: 1}]);
  assert.deepEqual([down.quote.outcome, down.r.outcome, down.r.amountPaise], ['store_credit', 'store_credit', hi - lo]);
  assert.equal(await storeCreditBalance(admin, meera), before + hi - lo);
  const [e] = await q(`select kind, amount_paise, return_id, order_id from store_credit_entries where return_id = $1`, [down.r.returnId]);
  assert.deepEqual(e, {kind: 'return', amount_paise: hi - lo, return_id: down.r.returnId, order_id: s2.orderId});
  assert.equal((await q(`select count(*)::int n from refunds where order_id = $1`, [s2.orderId]))[0].n, 0, 'no money went back');
  assert.ok((await storeCreditReconciliation(admin)).ok);
});

test('return without a replacement: store credit by default; a money refund only for staff who may refund; damaged goods are not restocked', async () => {
  const s1 = await sell(manager, sManager, {customerId: ravi, qty: 2});
  const it = await item(s1.orderId, V.sku);
  const [v0, sc0] = [await locQty(store, V.id), await storeCreditBalance(admin, ravi)];
  // damaged: comes back but not onto the shelf
  const a = await exchange(manager, sManager, s1.orderId, [{orderItemId: it.id, qty: 1, restock: false}], []);
  assert.deepEqual([a.r.outcome, a.r.amountPaise, a.r.replacementOrderId], ['store_credit', unit, null]);
  assert.equal(await locQty(store, V.id), v0, 'a damaged piece is not put back on sale');
  assert.equal(await storeCreditBalance(admin, ravi), sc0 + unit);
  assert.deepEqual((await q(`select inspection_result, resolution from return_requests where id = $1`, [a.r.returnId]))[0], {inspection_result: 'damaged', resolution: 'refund'});
  assert.deepEqual((await q(`select restock, restocked_qty from return_items where return_id = $1`, [a.r.returnId]))[0], {restock: false, restocked_qty: 0});
  // a money refund instead: a manager holds returns.manage but not refunds.create
  await assert.rejects(exchange(manager, sManager, s1.orderId, [{orderItemId: it.id, qty: 1, restock: true}], [], {surplus: 'refund'}), ForbiddenError);
  const b = await exchange(root, sRoot, s1.orderId, [{orderItemId: it.id, qty: 1, restock: true}], [], {surplus: 'refund'});
  assert.deepEqual([b.r.outcome, b.r.amountPaise], ['refund', unit]);
  assert.equal(await locQty(store, V.id), v0 + 1);
  assert.deepEqual((await q(`select amount_paise, status, method, reference from refunds where return_id = $1`, [b.r.returnId]))[0], {amount_paise: unit, status: 'processed', method: 'manual', reference: `RETURN ${b.r.returnNumber}`});
  // nothing is left to return, and the money cannot be refunded a second time
  await assert.rejects(exchange(root, sRoot, s1.orderId, [{orderItemId: it.id, qty: 1, restock: true}], [], {surplus: 'refund'}), /already returned/);
  assert.equal((await q(`select coalesce(sum(amount_paise), 0)::int n from refunds where order_id = $1`, [s1.orderId]))[0].n, unit);
  // an anonymous sale: store credit needs an account, so it is refused with the way out named
  const walkIn = await sell(manager, sManager, {});
  const wi = await item(walkIn.orderId, V.sku);
  await assert.rejects(exchange(manager, sManager, walkIn.orderId, [{orderItemId: wi.id, qty: 1, restock: true}], []), /needs a customer account/);
  // a cashier without returns.manage cannot process a return at all
  await assert.rejects(quoteCounterExchange(admin, {...sales, permissions: new Set([...sales.permissions].filter(p => p !== 'returns.manage'))}, {orderId: walkIn.orderId, locationId: store, items: [{orderItemId: wi.id, qty: 1, restock: true}], replacements: []}), ForbiddenError);
});

test('exchange: two tills settling the same return at the same moment — exactly one succeeds; an online order can be exchanged in store', async () => {
  const s1 = await sell(manager, sManager, {customerId: ravi});
  const it = await item(s1.orderId, V.sku);
  const stock = await locQty(store, V.id), sc = await storeCreditBalance(admin, ravi);
  const input = (session, k) => ({sessionId: session.id, orderId: s1.orderId, items: [{orderItemId: it.id, qty: 1, restock: true}], reasonCode: 'size_fit', note: null, replacements: [], expected: {returnValuePaise: unit, replacementPaise: 0}, key: k});
  const both = await Promise.allSettled([settleCounterExchange(admin, manager, input(sManager, key()), ctx), settleCounterExchange(admin, root, input(sRoot, key()), ctx)]);
  assert.deepEqual(both.map(r => r.status).sort(), ['fulfilled', 'rejected']);
  assert.match(both.find(r => r.status === 'rejected').reason.message, /already returned/);
  assert.deepEqual([await locQty(store, V.id), await storeCreditBalance(admin, ravi)], [stock + 1, sc + unit], 'one restock, one credit');
  // a website order of the customer, delivered: found from the counter and exchanged at this branch (stock comes into the branch)
  const [on] = await q(`insert into orders (customer_id, status, payment_status, subtotal_paise, total_paise, contact, shipping_address, channel, payment_method)
    values ($1, 'delivered', 'paid', $2, $2, $3, $4, 'online', 'online') returning id, order_number`, [ravi, unit, JSON.stringify({name: 'Ravi Two', email: 'p2.ravi@test.local', phone: '9840055502'}), JSON.stringify({name: 'Ravi Two', line1: '2 Test Street', city: 'Chennai', state: 'Tamil Nadu', pin: '600002', country: 'India'})]);
  const [oi] = await q(`insert into order_items (order_id, product_id, variant_id, sku, name, size, unit_price_paise, qty, line_total_paise) select $1, v.product_id, v.id, v.sku, p.name, v.size, $2, 1, $2 from product_variants v join products p on p.id = v.product_id where v.id = $3 returning id`, [on.id, unit, V.id]);
  await q(`insert into order_status_history (order_id, from_status, to_status, note) values ($1, 'shipped', 'delivered', 'fixture')`, [on.id]);
  const seen = await getOrderForCounter(admin, sales, on.id);
  assert.deepEqual([seen.eligible, seen.lines[0].returnable, seen.lines[0].unitValuePaise, seen.can.refund], [true, 1, unit, false], 'an online order is not refunded in money at the counter');
  await assert.rejects(exchange(root, sRoot, on.id, [{orderItemId: oi.id, qty: 1, restock: true}], [], {surplus: 'refund'}), /not refunded in money at the counter/);
  const branch = await locQty(store, V.id), online = (await q(`select stock_qty n from product_variants where id = $1`, [V.id]))[0].n;
  const x = await exchange(manager, sManager, on.id, [{orderItemId: oi.id, qty: 1, restock: true}], [{variantId: V.id, qty: 1}]);
  assert.equal(x.r.outcome, 'even');
  assert.deepEqual([await locQty(store, V.id), (await q(`select stock_qty n from product_variants where id = $1`, [V.id]))[0].n], [branch, online], 'the branch took one back and gave one out; the online stock was not touched');
  assert.equal((await getOrderForCounter(admin, sales, on.id)).lines[0].returnable, 0);
  const au = await q(`select after_data, metadata from audit_logs where action = 'pos.exchange' and entity_id = $1`, [x.r.returnId]);
  assert.deepEqual([au.length, au[0].after_data.outcome, au[0].metadata.reason, au[0].metadata.items[0].qty], [1, 'even', 'size_fit', 1]);
  assert.ok((await storeCreditReconciliation(admin)).ok && (await creditReconciliation(admin)).ok);
});

// ---------------------------------------------------------------- customer profile and order lookup
test('customer profile at the counter: website and branch orders together, and three separate balances', async () => {
  // a website order of the same customer (fixture: the minimum an online order row needs)
  const [on] = await q(`insert into orders (customer_id, status, payment_status, subtotal_paise, total_paise, contact, shipping_address, channel, payment_method)
    values ($1, 'delivered', 'paid', 259900, 259900, $2, $3, 'online', 'online') returning id, order_number`,
    [meera, JSON.stringify({name: 'Meera Two', email: 'p2.meera@test.local', phone: '9840055501'}), JSON.stringify({name: 'Meera Two', line1: '1 Test Street', city: 'Chennai', state: 'Tamil Nadu', pin: '600001', country: 'India'})]);
  const p = await posCustomerProfile(admin, sales, meera);
  assert.equal(p.customer.email, 'p2.meera@test.local');
  assert.ok(p.orders.length <= 10 && p.orders.some(o => o.channel === 'online' && o.order_number === on.order_number) && p.orders.some(o => o.channel === 'retail' && o.location_name === 'Phase Two Store'));
  assert.deepEqual([p.counts.online, p.counts.retail > 0], [1, true]);
  assert.deepEqual([typeof p.points, p.storeCreditPaise, p.credit.owedPaise > 0, p.credit.account.limit_paise > 0], ['number', await storeCreditBalance(admin, meera), true, true], 'points, store credit and credit owed are three different numbers');
  assert.ok(p.credit.nextDueOn && p.credit.openBills.length >= 1);
  assert.deepEqual(p.can, {storeCredit: true, creditSale: false, repay: false});
  // found from the counter by order number, bill number, phone and email; unknown and unauthorised are safe
  const by = async t => (await findPosOrders(admin, sales, t)).map(o => o.order_number);
  assert.ok((await by(on.order_number)).includes(on.order_number));
  const [bill] = await q(`select order_number, pos_number from orders where customer_id = $1 and pos_number is not null limit 1`, [meera]);
  assert.ok((await by(bill.pos_number)).includes(bill.order_number));
  assert.ok((await by('98400 55501')).includes(on.order_number) && (await by('P2.MEERA@test.local')).includes(on.order_number));
  assert.deepEqual(await by('KTS-NO-SUCH-ORDER'), []); assert.deepEqual(await by('ab'), []);
  assert.ok((await findPosOrders(admin, sales, '9840055501')).length <= 20);
  const noOrders = {...sales, permissions: new Set([...sales.permissions].filter(x => x !== 'orders.read' && x !== 'returns.read'))};
  await assert.rejects(findPosOrders(admin, noOrders, on.order_number), ForbiddenError);
  const limited = await posCustomerProfile(admin, noOrders, meera);
  assert.deepEqual([limited.orders, limited.returns], [null, null], 'what the role may not see is not sent');
  await assert.rejects(posCustomerProfile(admin, {...sales, permissions: new Set()}, meera), ForbiddenError);
});

test('access: the store (website) database role cannot read or write store credit or credit data; no gateway tender exists', async () => {
  const {WEBSITE_DATABASE_URL} = process.env;
  assert.ok(WEBSITE_DATABASE_URL && /@(localhost|127\.0\.0\.1)[:/]/.test(WEBSITE_DATABASE_URL));
  const web = new pg.Pool({connectionString: WEBSITE_DATABASE_URL, max: 1});
  try {
    for (const t of ['store_credit_accounts', 'store_credit_entries', 'credit_accounts', 'credit_bills', 'credit_repayments']) {
      await assert.rejects(web.query(`select 1 from ${t} limit 1`), /permission denied/, `${t}: select`);
      assert.equal((await q(`select relrowsecurity r from pg_class where relname = $1 and relnamespace = 'public'::regnamespace`, [t]))[0].r, true, `${t}: row level security is on`);
      assert.deepEqual((await q(`select roles::text[] r from pg_policies where schemaname = 'public' and tablename = $1`, [t])).map(p => p.r.join()), ['kitsyuu_admin'], `${t}: one policy, for the staff role only`);
    }
    await assert.rejects(web.query(`insert into store_credit_accounts (customer_id, balance_paise) values ($1, 100000)`, [meera]), /permission denied/);
    await assert.rejects(web.query(`update store_credit_accounts set balance_paise = 999999`), /permission denied/);
  } finally { await web.end(); }
  // the staff role may add ledger rows but never change or remove them
  for (const t of ['store_credit_entries', 'credit_repayments']) {
    const g = (await q(`select privilege_type p from information_schema.role_table_grants where grantee = 'kitsyuu_admin' and table_schema = 'public' and table_name = $1`, [t])).map(r => r.p).sort();
    assert.deepEqual(g, ['INSERT', 'SELECT'], t);
  }
  assert.deepEqual([...POS_TENDER_METHODS], ['cash', 'card', 'upi', 'store_credit', 'credit'], 'no online gateway among the tenders');
  assert.equal((await q(`select count(*)::int n from payments where provider not in ('pos', 'store_credit', 'exchange', 'pos_credit')`))[0].n, 0, 'no gateway payment was recorded by any of these tests');
});

async function principalOf(email) {
  // The manager's session re-read, so a permission granted during the run is in force (permissions are loaded per request).
  const [s] = await q(`select s.id from staff_sessions s join staff_users u on u.id = s.staff_user_id where u.email = $1 and s.revoked_at is null order by s.created_at desc limit 1`, [email]);
  const perms = (await q(`select rp.permission_code c from role_permissions rp join staff_user_roles ur on ur.role_id = rp.role_id join staff_users u on u.id = ur.staff_user_id where u.email = $1`, [email])).map(r => r.c);
  const base = email === 'p2.manager@test.local' ? manager : sales;
  return {...base, sessionId: s?.id ?? base.sessionId, permissions: new Set(perms)};
}
