/* Returns / refunds / exchanges: gaps found in the 2026-10-12 audit, against the LOCAL test database only.
   Each test reproduces one verified defect and pins the corrected behaviour:
     1. Two returns of the same order refunded at the same moment could together refund more than was paid (each checked
        what was left before the other's refund existed). Refunds on one order are now made one at a time.
     2. The same order line listed twice in one return request ended in a database error instead of a clear refusal.
     3. A refund the payment provider left 'pending' (or whose answer was never recorded) had no way out and blocked the
        return for good. Staff can now settle it with what the provider shows; no provider is called by the test or the code.
   Manual refunds only: no payment provider is called and no provider refund is simulated.
   Run by apps/admin/tests/run-e2e.mjs, or: node --env-file=apps/admin/tests/.output/test.env --test packages/core/test/returns-gaps.test.mjs */
import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {ConflictError, DomainError, ForbiddenError, NotFoundError, settleRefundInput} from '@kitsyuu/contracts';
import {createStaffReturn, refundReturn, requestReturn, settlePendingRefund} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, WEBSITE_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !WEBSITE_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, WEBSITE_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const admin = createDb({connectionString: ADMIN_DATABASE_URL, max: 8});
const web = createDb({connectionString: WEBSITE_DATABASE_URL, max: 2});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 2});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 2});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'returns-gaps.test', requestId: 'test'};

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(admin, (await acceptStaffInvite(admin, {token, password: 'returns gaps passphrase', fullName: role}, ctx)).token);
}

let root, support, customer;
/** A delivered order paid online (one captured payment of `paid` paise) with `lines` lines of one unit each. History rows only: no stock moves. */
async function paidOrder(number, paid, lines) {
  const [o] = await q(`insert into orders (order_number, customer_id, status, payment_status, subtotal_paise, total_paise, contact, shipping_address)
    values ($1, $2, 'delivered', 'paid', $3, $3, '{}', '{}') returning id, order_number`, [number, customer.customerId, paid]);
  await q(`insert into order_status_history (order_id, from_status, to_status) values ($1, 'shipped', 'delivered')`, [o.id]);
  const items = [];
  for (let i = 0; i < lines; i++) items.push((await q(`insert into order_items (order_id, sku, name, size, unit_price_paise, qty, line_total_paise) values ($1, $2, 'Gap test piece', 'M', $3, 1, $3) returning id`,
    [o.id, `GAP-${number}-${i}`, Math.floor(paid / lines)]))[0].id);
  const [pay] = await q(`insert into payments (order_id, provider, provider_payment_id, amount_paise, status, captured_at) values ($1, 'offline', $2, $3, 'captured', now()) returning id`, [o.id, `gap-${number}`, paid]);
  return {...o, items, paymentId: pay.id};
}
/** A return of one line, already inspected and waiting for its refund. */
async function pendingReturn(order, itemId) {
  const [r] = await q(`insert into return_requests (order_id, customer_id, status, resolution, reason_code, received_at, inspection_result) values ($1, $2, 'refund_pending', 'refund', 'size_fit', now(), 'ok') returning id, number`,
    [order.id, customer.customerId]);
  await q(`insert into return_items (return_id, order_item_id, qty) values ($1, $2, 1)`, [r.id, itemId]);
  return r;
}
const refundedOf = async orderId => (await q(`select coalesce(sum(amount_paise), 0)::int n from refunds where order_id = $1 and status in ('requested', 'pending', 'processed')`, [orderId]))[0].n;

before(async () => {
  root = await staff('gaps.root@test.local', 'super_admin');
  support = await staff('gaps.support@test.local', 'support');                 // no refunds.create
  const [c] = await q(`insert into customers (email, full_name, email_verified_at) values ('gaps.buyer@test.local', 'Gap Buyer', now()) returning id`);
  customer = {customerId: c.id, email: 'gaps.buyer@test.local', fullName: 'Gap Buyer', emailVerified: true, sessionId: '00000000-0000-4000-8000-000000000000'};
});
after(async () => { await admin.destroy(); await web.destroy(); await owner.destroy(); await pool.end(); });

test('refunds on one order are made one at a time: returns refunded at the same moment never add up to more than was paid', async () => {
  // Several rounds: the defect was a race, so one lucky ordering must not be mistaken for a fix.
  for (let round = 0; round < 6; round++) {
    const order = await paidOrder(`KTS-GAP-R${round}`, 1000_00, 4);
    const returns = [];
    for (const item of order.items) returns.push(await pendingReturn(order, item));
    // Four returns of one order, each refunding ₹400 of a ₹1,000 payment, recorded by staff at the same moment: at most two fit.
    const results = await Promise.allSettled(returns.map((r, i) => refundReturn(admin, root, null, {returnId: r.id, mode: 'manual', amount: 400_00, reference: `UTR-${round}-${i}`, note: 'Refund by bank transfer'}, ctx)));
    const done = results.filter(r => r.status === 'fulfilled').length;
    const total = await refundedOf(order.id);
    assert.ok(total <= 1000_00, `round ${round}: ₹${total / 100} refunded on a ₹1,000 payment`);
    assert.equal(done, 2, `round ${round}: exactly the two refunds that fit were recorded`);
    assert.equal(total, 800_00);
    for (const r of results.filter(x => x.status === 'rejected')) assert.ok(r.reason instanceof ConflictError && /At most 200\.00 can be refunded/.test(r.reason.message), String(r.reason?.message));
    // What is left is exact, and the refused returns are still waiting (nothing half-recorded).
    assert.equal(1000_00 - await refundedOf(order.id), 200_00);
    assert.deepEqual((await q(`select status, count(*)::int n from return_requests where order_id = $1 group by 1 order by 1`, [order.id])), [{status: 'refund_pending', n: 2}, {status: 'refunded', n: 2}]);
    assert.deepEqual((await q(`select payment_status from orders where id = $1`, [order.id])), [{payment_status: 'partially_refunded'}]);
    assert.equal((await q(`select status from payments where id = $1`, [order.paymentId]))[0].status, 'partially_refunded');
  }
  // One refund alone still works exactly as before, up to the last paisa and no further.
  const order = await paidOrder('KTS-GAP-ONE', 500_00, 2);
  const [a, b] = [await pendingReturn(order, order.items[0]), await pendingReturn(order, order.items[1])];
  assert.deepEqual(await refundReturn(admin, root, null, {returnId: a.id, mode: 'manual', amount: 500_00, reference: 'UTR-ONE', note: 'Full refund'}, ctx), {status: 'processed', number: a.number});
  await assert.rejects(refundReturn(admin, root, null, {returnId: b.id, mode: 'manual', amount: 1, reference: 'UTR-TWO', note: 'Nothing left'}, ctx), /At most 0\.00 can be refunded/);
  assert.deepEqual((await q(`select payment_status from orders where id = $1`, [order.id])), [{payment_status: 'refunded'}]);
  await assert.rejects(refundReturn(admin, root, null, {returnId: a.id, mode: 'manual', amount: 1, reference: 'UTR-AGAIN', note: 'Twice'}, ctx), e => e instanceof ConflictError, 'a refunded return is not refunded again');
});

test('the same order line twice in one return request is refused clearly, by staff and by the customer', async () => {
  await q(`insert into settings (key, value) values ('returns.enabled', '"on"'), ('returns.window_days', '"7"') on conflict (key) do update set value = excluded.value`);
  const order = await paidOrder('KTS-GAP-DUP', 300_00, 1);
  const twice = [{orderItemId: order.items[0], qty: 1}, {orderItemId: order.items[0], qty: 1}];
  const clear = e => e instanceof DomainError && /listed twice/.test(e.message);
  await assert.rejects(createStaffReturn(admin, root, {orderId: order.id, reasonCode: 'size_fit', description: null, items: twice}, ctx), clear);
  await assert.rejects(requestReturn(web, customer, {orderNumber: order.order_number, reasonCode: 'size_fit', description: null, items: twice}, ctx), clear);
  assert.equal((await q(`select count(*)::int n from return_requests where order_id = $1`, [order.id]))[0].n, 0, 'nothing was created');
  // The ordinary request is unaffected.
  const r = await createStaffReturn(admin, root, {orderId: order.id, reasonCode: 'size_fit', description: null, items: [twice[0]]}, ctx);
  assert.match(r.number, /^RET-/);
  await assert.rejects(createStaffReturn(admin, root, {orderId: order.id, reasonCode: 'size_fit', description: null, items: [twice[0]]}, ctx), ConflictError, 'the unit is already in a return');
  await q(`delete from settings where key in ('returns.enabled', 'returns.window_days')`);
});

test('a refund left pending by the provider can be settled by staff, once, as refunded or as not refunded', async () => {
  /** A refund request that was recorded as sent to the provider `minutes` ago and never got its final answer. */
  const stuck = async (order, ret, amount, minutes, providerRefundId = null) => (await q(`insert into refunds (payment_id, order_id, return_id, amount_paise, reason, status, method, provider_refund_id, requested_by, created_at)
    values ($1, $2, $3, $4, 'Return refund', 'pending', 'provider', $5, $6, now() - make_interval(mins => $7)) returning id`, [order.paymentId, order.id, ret?.id ?? null, amount, providerRefundId, root.staffId, minutes]))[0].id;
  const settle = (actor, refundId, outcome, reference, note = 'Checked in the provider dashboard') => settlePendingRefund(admin, actor, {refundId, outcome, reference, note}, ctx);
  const state = async (order, refundId, ret) => (await q(`select (select status from refunds where id = $1) refund, (select status from return_requests where id = $2) ret,
    (select payment_status from orders where id = $3) paid, (select status from payments where id = $4) payment`, [refundId, ret.id, order.id, order.paymentId]))[0];

  // ---- the provider did NOT refund it ----
  const a = await paidOrder('KTS-GAP-SETA', 800_00, 1), ra = await pendingReturn(a, a.items[0]);
  const fa = await stuck(a, ra, 300_00, 45);
  await assert.rejects(refundReturn(admin, root, null, {returnId: ra.id, mode: 'manual', amount: 300_00, reference: 'UTR-X', note: 'Try again'}, ctx), /already in progress/, 'this is the dead end the audit found');
  await assert.rejects(settle(support, fa, 'failed', null), ForbiddenError);
  await assert.rejects(settle(root, fa, 'failed', null, '  '), DomainError, 'what was found must be written down');
  await assert.rejects(settle(root, fa, 'processed', null), DomainError, "refunded needs the provider's refund id");
  assert.equal(settleRefundInput.safeParse({refundId: fa, outcome: 'processed', note: 'seen'}).success, false);
  assert.equal(settleRefundInput.safeParse({refundId: fa, outcome: 'maybe', note: 'seen'}).success, false);
  await assert.rejects(settle(root, '00000000-0000-4000-8000-000000000000', 'failed', null), NotFoundError);
  assert.deepEqual(await state(a, fa, ra), {refund: 'pending', ret: 'refund_pending', paid: 'paid', payment: 'captured'}, 'refused attempts changed nothing');
  // Two people settling it at the same moment: one record.
  const both = await Promise.allSettled([settle(root, fa, 'failed', null, 'Provider shows no refund'), settle(root, fa, 'failed', null, 'Provider shows no refund')]);
  assert.deepEqual(both.map(r => r.status).sort(), ['fulfilled', 'rejected']);
  assert.ok(both.find(r => r.status === 'rejected').reason instanceof ConflictError);
  assert.deepEqual(await state(a, fa, ra), {refund: 'failed', ret: 'refund_pending', paid: 'paid', payment: 'captured'}, 'nothing was refunded; the return still waits');
  assert.match((await q(`select failure_reason from refunds where id = $1`, [fa]))[0].failure_reason, /Settled by staff as not refunded: Provider shows no refund/);
  await assert.rejects(settle(root, fa, 'processed', 'rfnd_late'), e => e instanceof ConflictError && /is failed/.test(e.message), 'settled once');
  // The way out works: the full amount is refundable again, and no more than that.
  await assert.rejects(refundReturn(admin, root, null, {returnId: ra.id, mode: 'manual', amount: 800_01, reference: 'UTR-A', note: 'Too much'}, ctx), /At most 800\.00/);
  assert.deepEqual(await refundReturn(admin, root, null, {returnId: ra.id, mode: 'manual', amount: 300_00, reference: 'UTR-A', note: 'Paid by bank transfer'}, ctx), {status: 'processed', number: ra.number});
  assert.equal(await refundedOf(a.id), 300_00);

  // ---- the provider DID refund it ----
  const b = await paidOrder('KTS-GAP-SETB', 500_00, 2), rb = await pendingReturn(b, b.items[0]), rb2 = await pendingReturn(b, b.items[1]);
  const fb = await stuck(b, rb, 500_00, 30, 'rfnd_known_1');
  // While it waits, its amount stays reserved: the other return cannot refund the same money.
  await assert.rejects(refundReturn(admin, root, null, {returnId: rb2.id, mode: 'manual', amount: 1, reference: 'UTR-B', note: 'Nothing left'}, ctx), /At most 0\.00/);
  await assert.rejects(settle(root, fb, 'processed', 'rfnd_other'), e => e instanceof ConflictError && /recorded for this refund is rfnd_known_1/.test(e.message), 'a different id than the one the provider gave is refused');
  assert.deepEqual(await settle(root, fb, 'processed', 'rfnd_known_1'), {status: 'processed', orderNumber: 'KTS-GAP-SETB', returnId: rb.id, returnNumber: rb.number});
  assert.deepEqual(await state(b, fb, rb), {refund: 'processed', ret: 'refunded', paid: 'refunded', payment: 'refunded'});
  assert.deepEqual((await q(`select refund_amount_paise, (select count(*)::int from return_events e where e.return_id = r.id and e.to_status = 'refunded') events from return_requests r where r.id = $1`, [rb.id]))[0], {refund_amount_paise: 500_00, events: 1});
  assert.equal((await q(`select s.email from refunds f join staff_users s on s.id = f.processed_by where f.id = $1`, [fb]))[0].email, 'gaps.root@test.local');
  await assert.rejects(settle(root, fb, 'failed', null), e => e instanceof ConflictError && /is processed/.test(e.message));
  await assert.rejects(refundReturn(admin, root, null, {returnId: rb2.id, mode: 'manual', amount: 1, reference: 'UTR-B', note: 'Nothing left'}, ctx), /At most 0\.00/, 'still nothing left to refund');

  // ---- what cannot be settled here ----
  const c = await paidOrder('KTS-GAP-SETC', 400_00, 1), rc = await pendingReturn(c, c.items[0]);
  const fresh = await stuck(c, rc, 100_00, 2);
  await assert.rejects(settle(root, fresh, 'failed', null), e => e instanceof ConflictError && /less than 10 minutes ago/.test(e.message), 'one that may still be on its way to the provider');
  assert.equal((await q(`select status from refunds where id = $1`, [fresh]))[0].status, 'pending');
  const [manual] = await q(`select id from refunds where order_id = $1 and method = 'manual' limit 1`, [a.id]);
  await assert.rejects(settle(root, manual.id, 'failed', null), ConflictError, 'a refund that is already recorded as made');
  // The same provider refund id cannot be recorded for two refunds.
  await q(`update refunds set created_at = now() - interval '20 minutes' where id = $1`, [fresh]);
  await assert.rejects(settle(root, fresh, 'processed', 'rfnd_known_1'), e => e instanceof ConflictError && /already recorded for another refund/.test(e.message));
  assert.equal((await q(`select status from refunds where id = $1`, [fresh]))[0].status, 'pending');

  // ---- audit ----
  const audits = await q(`select a.after_data, a.metadata, s.email from audit_logs a join staff_users s on s.id = a.staff_id where a.action = 'refund.settle_pending' order by a.id`);
  assert.equal(audits.length, 2, 'the two settlements that went through; refused ones left nothing');
  assert.deepEqual([audits[0].after_data.status, audits[0].metadata.order_number, audits[0].metadata.note, audits[0].email], ['failed', 'KTS-GAP-SETA', 'Provider shows no refund', 'gaps.root@test.local']);
  assert.deepEqual([audits[1].after_data.status, audits[1].after_data.provider_refund_id, audits[1].metadata.return_number], ['processed', 'rfnd_known_1', rb.number]);
});
