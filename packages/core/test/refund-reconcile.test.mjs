/* Pending provider refunds settled from the provider's own status (2026-10-14), against the LOCAL test database only.
   The provider here is a fake that only answers listRefunds(); its refund() fails the test if it is ever called, because
   reconciliation must never ask for a refund. Pinned behaviour:
     · processed / failed at the provider → the same outcome as a recorded answer, made once (a second run and two runs at
       the same moment change nothing more), audited as the system;
     · still pending, not found, ambiguous, another amount, a provider error, too recent, another provider → left pending
       (staff alerted once where a person has to look);
     · a refund whose answer was never recorded is matched by the platform's refund id sent in the notes.
   Fixtures only: no stock moves. Run by apps/admin/tests/run-e2e.mjs, or:
   node --env-file=apps/admin/tests/.output/test.env --test packages/core/test/refund-reconcile.test.mjs */
import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {razorpayProvider, reconcilePendingRefunds, refundReturn} from '@kitsyuu/core';
import {startFakeRazorpay, TEST_KEY_ID} from './fake-razorpay.mjs';

const {ADMIN_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const admin = createDb({connectionString: ADMIN_DATABASE_URL, max: 8});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 2});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 2});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'refund-reconcile.test', requestId: 'test'};

/** The fake provider: what it holds per payment id, and how often it was asked. */
const held = new Map(); let lookups = 0; const failing = new Set();
const fakepay = {
  code: 'fakepay', label: 'Fake pay',
  async listRefunds(paymentId) { lookups++; if (failing.has(paymentId)) throw new Error('provider down'); return held.get(paymentId) ?? []; },
  async refund() { throw new Error('reconciliation must never request a refund'); },
  async createSession() { throw new Error('not used'); }, async verifyClientResult() { return null; }, async listPayments() { return null; },
};

let root, customer, n = 0;
before(async () => {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', 'super_admin').executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email: 'recon.root@test.local', status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  root = await validateStaffSession(admin, (await acceptStaffInvite(admin, {token, password: 'refund reconcile passphrase', fullName: 'root'}, ctx)).token);
  [customer] = await q(`insert into customers (email, full_name, email_verified_at) values ('recon.buyer@test.local', 'Recon Buyer', now()) returning id`);
});
after(async () => { await admin.destroy(); await owner.destroy(); await pool.end(); });

/** A delivered order paid through `provider`, one line, a return waiting for its refund, and a provider refund left
    'pending' `minutes` ago (with the provider's id when its answer was recorded). History rows only. */
async function stuck({amount = 500_00, refund = amount, minutes = 30, providerRefundId = null, provider = 'fakepay'} = {}) {
  const num = `KTS-RECON-${++n}`;
  const [o] = await q(`insert into orders (order_number, customer_id, status, payment_status, subtotal_paise, total_paise, contact, shipping_address)
    values ($1, $2, 'delivered', 'paid', $3, $3, '{}', '{}') returning id`, [num, customer.id, amount]);
  const [item] = await q(`insert into order_items (order_id, sku, name, size, unit_price_paise, qty, line_total_paise) values ($1, $2, 'Recon piece', 'M', $3, 1, $3) returning id`, [o.id, `RECON-${n}`, amount]);
  const [pay] = await q(`insert into payments (order_id, provider, provider_payment_id, amount_paise, status, captured_at) values ($1, $2, $3, $4, 'captured', now()) returning id, provider_payment_id`,
    [o.id, provider, `pay_recon${n}`, amount]);
  const [ret] = await q(`insert into return_requests (order_id, customer_id, status, resolution, reason_code, received_at, inspection_result) values ($1, $2, 'refund_pending', 'refund', 'size_fit', now(), 'ok') returning id`,
    [o.id, customer.id]);
  await q(`insert into return_items (return_id, order_item_id, qty) values ($1, $2, 1)`, [ret.id, item.id]);
  const [f] = await q(`insert into refunds (payment_id, order_id, return_id, amount_paise, reason, status, method, provider_refund_id, requested_by, created_at)
    values ($1, $2, $3, $4, 'Return refund', 'pending', 'provider', $5, $6, now() - make_interval(mins => $7)) returning id`, [pay.id, o.id, ret.id, refund, providerRefundId, root.staffId, minutes]);
  return {orderId: o.id, number: num, paymentId: pay.id, providerPaymentId: pay.provider_payment_id, returnId: ret.id, refundId: f.id, amount: refund};
}
const state = async s => (await q(`select (select status from refunds where id = $1) refund, (select provider_refund_id from refunds where id = $1) rid,
  (select status from return_requests where id = $2) ret, (select payment_status from orders where id = $3) paid, (select status from payments where id = $4) payment`,
  [s.refundId, s.returnId, s.orderId, s.paymentId]))[0];
const audits = async refundId => (await q(`select actor_type, staff_id, before_data, after_data, metadata from audit_logs where action = 'refund.reconciled' and entity_id = $1`, [refundId]));
const alerts = async refundId => (await q(`select title, dedupe_key from staff_notifications where dedupe_key like $1`, [`%${refundId}`]));
const run = (opts) => reconcilePendingRefunds(admin, fakepay, opts);

test('processed at the provider → refund, payment, order and return move on, once; a second run changes nothing', async () => {
  const s = await stuck({providerRefundId: 'rfnd_recon_ok'});
  held.set(s.providerPaymentId, [{id: 'rfnd_recon_ok', amountPaise: s.amount, status: 'processed'}]);
  const r1 = await run();
  assert.equal(r1.processed, 1); assert.deepEqual(r1.refundedReturnIds, [s.returnId]);
  assert.deepEqual(await state(s), {refund: 'processed', rid: 'rfnd_recon_ok', ret: 'refunded', paid: 'refunded', payment: 'refunded'});
  const [a] = await audits(s.refundId);
  assert.deepEqual([a.actor_type, a.staff_id, a.before_data.status, a.after_data, a.metadata.source], ['system', null, 'pending', {status: 'processed', provider_refund_id: 'rfnd_recon_ok'}, 'provider_check']);
  assert.equal((await q(`select count(*)::int n from return_events where return_id = $1 and to_status = 'refunded'`, [s.returnId]))[0].n, 1);
  const r2 = await run();
  assert.equal(r2.processed, 0, 'nothing pending any more');
  assert.equal((await audits(s.refundId)).length, 1, 'audited once');
  held.delete(s.providerPaymentId);
});

test('two runs at the same moment record one outcome', async () => {
  const s = await stuck({providerRefundId: 'rfnd_recon_race'});
  held.set(s.providerPaymentId, [{id: 'rfnd_recon_race', amountPaise: s.amount, status: 'processed'}]);
  const [a, b] = await Promise.all([run(), run()]);
  assert.equal(a.processed + b.processed, 1);
  assert.equal((await audits(s.refundId)).length, 1);
  assert.equal((await q(`select count(*)::int n from return_events where return_id = $1 and to_status = 'refunded'`, [s.returnId]))[0].n, 1);
  assert.deepEqual((await state(s)).refund, 'processed');
  held.delete(s.providerPaymentId);
});

test('an answer that was never recorded is matched by the platform refund id in the notes', async () => {
  const s = await stuck();
  held.set(s.providerPaymentId, [{id: 'rfnd_other', amountPaise: 1_00, status: 'processed', notes: {}},
    {id: 'rfnd_recon_notes', amountPaise: s.amount, status: 'processed', notes: {kitsyuu_refund_id: s.refundId}}]);
  assert.equal((await run()).processed, 1);
  assert.deepEqual(await state(s), {refund: 'processed', rid: 'rfnd_recon_notes', ret: 'refunded', paid: 'refunded', payment: 'refunded'});
  held.delete(s.providerPaymentId);
});

test('failed at the provider → failed, the return still waits, the money can be refunded again; staff alerted', async () => {
  const s = await stuck({providerRefundId: 'rfnd_recon_fail'});
  held.set(s.providerPaymentId, [{id: 'rfnd_recon_fail', amountPaise: s.amount, status: 'failed'}]);
  assert.equal((await run()).failed, 1);
  assert.deepEqual(await state(s), {refund: 'failed', rid: 'rfnd_recon_fail', ret: 'refund_pending', paid: 'paid', payment: 'captured'});
  assert.match((await q(`select failure_reason from refunds where id = $1`, [s.refundId]))[0].failure_reason, /reported the refund as failed/);
  assert.equal((await alerts(s.refundId)).length, 1);
  assert.deepEqual(await refundReturn(admin, root, null, {returnId: s.returnId, mode: 'manual', amount: s.amount, reference: 'UTR-RECON', note: 'Paid by bank transfer'}, ctx),
    {status: 'processed', number: (await q(`select number from return_requests where id = $1`, [s.returnId]))[0].number});
  held.delete(s.providerPaymentId);
});

test('left pending (staff alerted once where needed): still pending, not found, ambiguous, another amount, provider error, too recent, another provider', async () => {
  const still = await stuck({providerRefundId: 'rfnd_recon_wait'});
  held.set(still.providerPaymentId, [{id: 'rfnd_recon_wait', amountPaise: still.amount, status: 'pending'}]);
  const missing = await stuck();
  const twice = await stuck();
  held.set(twice.providerPaymentId, [1, 2].map(i => ({id: `rfnd_twice_${i}`, amountPaise: twice.amount, status: 'processed', notes: {kitsyuu_refund_id: twice.refundId}})));
  const amount = await stuck({providerRefundId: 'rfnd_recon_amt'});
  held.set(amount.providerPaymentId, [{id: 'rfnd_recon_amt', amountPaise: amount.amount - 1, status: 'processed'}]);
  const down = await stuck({providerRefundId: 'rfnd_recon_down'}); failing.add(down.providerPaymentId);
  const fresh = await stuck({providerRefundId: 'rfnd_recon_fresh', minutes: 0});
  held.set(fresh.providerPaymentId, [{id: 'rfnd_recon_fresh', amountPaise: fresh.amount, status: 'processed'}]);
  const other = await stuck({providerRefundId: 'rfnd_recon_other', provider: 'otherpay'});
  held.set(other.providerPaymentId, [{id: 'rfnd_recon_other', amountPaise: other.amount, status: 'processed'}]);

  for (let i = 0; i < 2; i++) {
    const r = await run();
    assert.deepEqual([r.checked, r.processed, r.failed, r.stillPending, r.needsStaff, r.errors], [5, 0, 0, 1, 3, 1], `run ${i + 1}`);
  }
  for (const s of [still, missing, twice, amount, down, fresh, other]) {
    assert.deepEqual((await state(s)).refund, 'pending');
    assert.equal((await audits(s.refundId)).length, 0);
  }
  for (const s of [missing, twice, amount]) assert.equal((await alerts(s.refundId)).length, 1, 'one alert, however often it runs');
  for (const s of [still, down, fresh, other]) assert.equal((await alerts(s.refundId)).length, 0);
  failing.clear();
});

test('through the Razorpay adapter (local fake): a refund answered "pending" is settled once Razorpay reports it processed', async () => {
  const rzpFake = await startFakeRazorpay({keySecret: 'k'.repeat(24)});
  try {
    const rzp = razorpayProvider({keyId: TEST_KEY_ID, keySecret: 'k'.repeat(24), apiBase: rzpFake.url, timeoutMs: 3000});
    const session = await rzp.createSession({orderId: 'x', orderNumber: 'KTS-RECON-RZP', amountPaise: 700_00, currency: 'INR', contact: {name: null, email: null, phone: null}});
    const {payment} = rzpFake.pay(session.sessionRef, 'success');
    const s = await stuck({amount: 700_00, provider: 'razorpay'});
    await q(`update payments set provider_payment_id = $1 where id = $2`, [payment.id, s.paymentId]);
    // The refund request itself is made by refundReturn; here it is made directly, answered 'pending', with the platform id in its notes.
    rzpFake.state.refundStatus = 'pending';
    const answer = await rzp.refund({paymentId: payment.id, amountPaise: s.amount, currency: 'INR', notes: {kitsyuu_refund_id: s.refundId}});
    assert.equal(answer.status, 'pending');
    const refundsBefore = rzpFake.refunds.size;
    let r = await reconcilePendingRefunds(admin, rzp);
    assert.deepEqual([r.checked, r.stillPending, r.processed], [1, 1, 0], 'still pending at Razorpay: left as it is');
    rzpFake.refunds.get(answer.id).status = 'processed';
    r = await reconcilePendingRefunds(admin, rzp);
    assert.equal(r.processed, 1);
    assert.deepEqual(await state(s), {refund: 'processed', rid: answer.id, ret: 'refunded', paid: 'refunded', payment: 'refunded'});
    assert.equal(rzpFake.refunds.size, refundsBefore, 'reconciliation never asked Razorpay for a refund');
  } finally { await rzpFake.close(); }
});

test('no refund provider (or one that cannot list refunds) → nothing is checked', async () => {
  const before = lookups;
  assert.deepEqual(await reconcilePendingRefunds(admin, null), {checked: 0, processed: 0, failed: 0, stillPending: 0, needsStaff: 0, errors: 0, refundedReturnIds: []});
  const {listRefunds, ...noList} = fakepay;
  assert.equal((await reconcilePendingRefunds(admin, noList)).checked, 0);
  assert.equal(lookups, before);
});
