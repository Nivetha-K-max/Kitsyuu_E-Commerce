/* Checkout and payments (M7), provider-neutral.

   Flow: cart → placeOrder (one transaction: re-price the cart from the database, check stock, create the order and its
   lines, take the stock through the ledger) → preparePayment (a session with the configured PaymentProvider) → the customer
   pays in the provider's widget → submitPaymentResult (the provider verifies it) or the provider's signed webhook → paid.

   Rules:
   - Nothing from the browser is trusted: prices, stock and totals are recomputed; a payment counts only when the provider
     confirms it (see payments/provider.ts). The browser saying "paid" changes nothing.
   - Idempotent: the checkout form's key returns the same order when submitted twice; a provider payment id is stored once
     (payments unique key); an order is marked paid once; each webhook event id is processed once (payment_events).
   - Every payment result for an order is applied with the order row locked, so the browser callback and the webhook cannot
     both apply it.
   - Stock: an order takes its stock when it is created (two customers cannot buy the last unit) and keeps it while unpaid.
     A cancelled or replaced unpaid order returns it through the ledger ('cancel'). If a payment hold time is configured
     (checkout.payment_window_minutes), unpaid orders past it are cancelled too; with no value, they never expire on their own.
   - Status changes go through applyOrderTransition(); what is allowed is asked of the workflow (canTransitionAs). */
import { recordAudit, sql, type Db, type Queryable, type Tx } from '@kitsyuu/db';
import { canTransitionAs, ConflictError, DomainError, NotFoundError, UNPAID_ORDER_STATUSES, type PaymentResultInput, type PlaceOrderInput } from '@kitsyuu/contracts';
import type { CustomerPrincipal, RequestContext } from '@kitsyuu/auth';
import { lineProblemText, lockActiveCart, priceCart } from './cart.ts';
import { applyOrderTransition, lockOrder, releaseOrderStock } from './order-state.ts';
import type { CommerceConfig } from './pricing.ts';
import type { PaymentProvider, ProviderPayment } from './payments/provider.ts';

type Order = NonNullable<Awaited<ReturnType<typeof lockOrder>>>;
const ctxAudit = (ctx?: RequestContext) => ({ ip: ctx?.ip ?? null, userAgent: ctx?.userAgent ?? null, requestId: ctx?.requestId ?? null });
const NOT_VERIFIED = 'We could not verify this payment. Check your order before trying again.';

/** Checkout settings. Values nobody has decided stay null (no invented defaults). */
export async function checkoutSettings(q: Queryable): Promise<{ paymentWindowMinutes: number | null }> {
  const row = await q.selectFrom('settings').select('value').where('key', '=', 'checkout.payment_window_minutes').executeTakeFirst();
  const minutes = Number(row?.value);
  return { paymentWindowMinutes: row && Number.isInteger(minutes) && minutes > 0 ? minutes : null };
}

/** The customer's order (by number) with its row locked, or NotFoundError: other customers' orders do not exist for them. */
async function lockOwnOrder(tx: Tx, p: CustomerPrincipal, orderNumber: string): Promise<Order> {
  const row = await tx.selectFrom('orders').select('id').where('order_number', '=', orderNumber).where('customer_id', '=', p.customerId).executeTakeFirst();
  const o = row && await lockOrder(tx, { id: row.id });
  if (!o) throw new NotFoundError('Order not found.');
  return o;
}

async function hasMoneyInFlight(q: Queryable, orderId: string) {
  const r = await q.selectFrom('payments').select(sql<number>`count(*)::int`.as('n'))
    .where('order_id', '=', orderId).where('status', 'in', ['authorized', 'captured']).executeTakeFirstOrThrow();
  return r.n > 0;
}

/** Cancels an unpaid order and returns its stock (system: replaced / expired; customer: cancelled by them). */
async function cancelUnpaid(tx: Tx, o: Order, actor: 'system' | 'customer', note: string, audit: { action: string; customerId?: string; ctx?: RequestContext }) {
  const t = await applyOrderTransition(tx, o, 'cancelled', { actor, note });
  const released = await releaseOrderStock(tx, o.id, `Order ${o.order_number}: ${note}`);
  await recordAudit(tx, { actorType: actor, customerId: audit.customerId ?? null, action: audit.action, entityType: 'orders', entityId: o.id,
    before: { status: t.from }, after: { status: 'cancelled' }, metadata: { order_number: o.order_number, units_released: released, note }, ...ctxAudit(audit.ctx) });
  return released;
}

const isExpired = (o: { payment_expires_at: unknown }) => !!o.payment_expires_at && (o.payment_expires_at as Date) <= new Date();

/** What the customer may do with an order now — asked of the workflow, not decided by status names in the UI. */
export function customerOrderActions(o: { status: string; customer_id: string | null; payment_expires_at: unknown }, paymentsAvailable: boolean) {
  const s = o.status as Order['status'];
  return {
    canPay: paymentsAvailable && !!o.customer_id && canTransitionAs('system', s, 'paid') && !isExpired(o),
    canCancel: !!o.customer_id && canTransitionAs('customer', s, 'cancelled'),
  };
}

// ======================= order creation =======================

export async function placeOrder(db: Db, p: CustomerPrincipal, input: PlaceOrderInput, ctx: RequestContext, config?: CommerceConfig)
  : Promise<{ orderNumber: string; reused: boolean }> {
  await expireUnpaidOrders(db, {}, { customerId: p.customerId }).catch(e => console.error('[checkout] expiry sweep failed', e));
  const { paymentWindowMinutes } = await checkoutSettings(db);
  try {
    return await db.transaction().execute(async tx => {
      const cartId = await lockActiveCart(tx, p.customerId);          // one checkout at a time per customer
      const same = await tx.selectFrom('orders').select('order_number')
        .where('customer_id', '=', p.customerId).where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
      if (same) return { orderNumber: same.order_number, reused: true };

      const address = await tx.selectFrom('addresses').select(['full_name', 'phone', 'line1', 'line2', 'city', 'state', 'pin', 'country'])
        .where('id', '=', input.addressId!).where('customer_id', '=', p.customerId).executeTakeFirst();
      if (!address) throw new NotFoundError('Choose one of your delivery addresses.');
      const cart = await priceCart(tx, cartId, { config, customerId: p.customerId, shipTo: { state: address.state, pin: address.pin, country: address.country } });
      if (!cart.lines.length) throw new ConflictError('Your cart is empty.');
      const problems = cart.lines.filter(l => l.problem).map(lineProblemText);
      if (problems.length) throw new ConflictError(`${problems.join(' ')} Update your cart and try again.`);
      const t = cart.totals;
      if (t.totalPaise !== input.expectedTotalPaise)
        throw new ConflictError('Prices or quantities in your cart changed since this page was opened. Review your order and try again.');
      const me = await tx.selectFrom('customers').select(['email', 'full_name', 'phone']).where('id', '=', p.customerId).executeTakeFirstOrThrow();

      // A newer checkout of the same cart replaces an older unpaid one (its stock is returned first).
      const open = await tx.selectFrom('orders').select('id').where('cart_id', '=', cartId).where('status', 'in', [...UNPAID_ORDER_STATUSES]).execute();
      for (const { id } of open) {
        const o = (await lockOrder(tx, { id }))!;
        if (await hasMoneyInFlight(tx, o.id))
          throw new ConflictError(`A payment for order ${o.order_number} is being processed. Check your orders before paying again.`);
        await cancelUnpaid(tx, o, 'system', 'Replaced by a newer checkout', { action: 'order.replaced', customerId: p.customerId, ctx });
      }

      const order = await tx.insertInto('orders').values({
        customer_id: p.customerId, cart_id: cartId, idempotency_key: input.idempotencyKey,
        status: 'pending_payment', payment_status: 'pending', currency: 'INR',
        subtotal_paise: t.subtotalPaise, discount_paise: t.discountPaise, shipping_paise: t.shippingPaise, tax_paise: t.taxPaise,
        total_paise: t.totalPaise, prices_include_tax: t.pricesIncludeTax,
        pricing: JSON.stringify({ tax: t.tax, shipping: t.shipping, discounts: t.discounts }),
        contact: JSON.stringify({ name: me.full_name ?? address.full_name, email: me.email, phone: me.phone ?? address.phone }),
        shipping_address: JSON.stringify({ name: address.full_name, phone: address.phone, line1: address.line1, line2: address.line2,
          city: address.city, state: address.state, pin: address.pin, country: address.country }),
        payment_expires_at: paymentWindowMinutes ? sql<Date>`now() + make_interval(mins => ${paymentWindowMinutes})` : null,
      }).returning(['id', 'order_number']).executeTakeFirstOrThrow();
      await tx.insertInto('order_items').values(cart.lines.map(l => ({
        order_id: order.id, product_id: l.productId, variant_id: l.variantId, sku: l.sku, name: l.name, size: l.size,
        image_path: l.imagePath, unit_price_paise: l.unitPaise, qty: l.qty, line_total_paise: l.lineTotalPaise,
      }))).execute();
      await tx.insertInto('order_status_history').values({ order_id: order.id, from_status: null, to_status: 'pending_payment', note: 'Order placed' }).execute();
      await sql`select public.reserve_order_stock(${order.id}::uuid)`.execute(tx);
      await recordAudit(tx, { actorType: 'customer', customerId: p.customerId, action: 'order.placed', entityType: 'orders', entityId: order.id,
        after: { status: 'pending_payment', total_paise: t.totalPaise },
        metadata: { order_number: order.order_number, lines: cart.lines.length, units: t.units }, ...ctxAudit(ctx) });
      return { orderNumber: order.order_number, reused: false };
    });
  } catch (e) {
    // adjust_stock refused (another customer bought the last units a moment ago): nothing was written.
    if ((e as { code?: string })?.code === '23514') throw new ConflictError('Part of your order just sold out. Review your cart and try again.');
    throw e;
  }
}

// ======================= payment =======================

/** The order's current payment session with a provider (its reference and the browser data), or null. A session accepts
    further attempts after a declined one, so retries and page reloads reuse it instead of opening another provider order. */
export async function currentPaymentSession(q: Queryable, orderId: string, providerCode: string, amountPaise: number)
  : Promise<{ sessionRef: string; client: Record<string, unknown> } | null> {
  const row = await q.selectFrom('payments').select(['provider_order_id', 'raw']).where('order_id', '=', orderId).where('provider', '=', providerCode)
    .where('amount_paise', '=', amountPaise).where('provider_order_id', 'is not', null).where(sql<boolean>`raw ? 'session'`)
    .orderBy('created_at', 'desc').executeTakeFirst();
  const client = (row?.raw as { session?: Record<string, unknown> } | undefined)?.session;
  return row && client ? { sessionRef: row.provider_order_id!, client } : null;
}

export interface PaymentStart { orderNumber: string; provider: string; label: string; amountPaise: number; currency: string; client: Record<string, unknown> }

/** Starts (or resumes) the payment of an unpaid order of this customer with the given provider. */
export async function preparePayment(db: Db, provider: PaymentProvider, p: CustomerPrincipal, orderNumber: string): Promise<PaymentStart> {
  const expired = await db.transaction().execute(async tx => {
    const o = await lockOwnOrder(tx, p, orderNumber);
    if (!canTransitionAs('system', o.status, 'paid')) return null;
    if (isExpired(o) && !(await hasMoneyInFlight(tx, o.id))) {
      await cancelUnpaid(tx, o, 'system', 'Payment time ran out', { action: 'order.expired' });
      return true;
    }
    return false;
  });
  if (expired === null) throw new ConflictError('This order is no longer waiting for payment.');
  if (expired) throw new ConflictError('The time to pay for this order has run out and its items were released. Your cart is unchanged; you can check out again.');

  return db.transaction().execute(async tx => {
    const o = await lockOwnOrder(tx, p, orderNumber);                 // held while the session is created: one session per order
    if (!canTransitionAs('system', o.status, 'paid')) throw new ConflictError('This order is no longer waiting for payment.');
    const start = (client: Record<string, unknown>) => ({ orderNumber: o.order_number, provider: provider.code, label: provider.label,
      amountPaise: o.total_paise, currency: o.currency, client });
    const open = await currentPaymentSession(tx, o.id, provider.code, o.total_paise);
    if (open) return start(open.client);
    const c = (await tx.selectFrom('orders').select('contact').where('id', '=', o.id).executeTakeFirstOrThrow()).contact as Record<string, string> ?? {};
    const session = await provider.createSession({ orderId: o.id, orderNumber: o.order_number, amountPaise: o.total_paise, currency: o.currency,
      contact: { name: c.name ?? null, email: c.email ?? null, phone: c.phone ?? null } });
    await tx.insertInto('payments').values({ order_id: o.id, provider: provider.code, provider_order_id: session.sessionRef,
      amount_paise: o.total_paise, currency: o.currency, status: 'created', raw: JSON.stringify({ session: session.client }) }).execute();
    return start(session.client);
  });
}

export type PaymentOutcome = 'paid' | 'already_paid' | 'failed' | 'authorized' | 'not_this_order' | 'amount_mismatch' | 'needs_refund' | 'duplicate_capture';
const RANK: Record<string, number> = { created: 0, failed: 1, authorized: 2, captured: 3, refunded: 4, partially_refunded: 4 };

/** Applies a payment AS THE PROVIDER REPORTED IT (verified result or signed webhook) to a LOCKED order. Idempotent. */
export async function applyPaymentResult(tx: Tx, o: Order, providerCode: string, pay: ProviderPayment,
  meta: { source: 'customer' | 'webhook' | 'expiry'; customerId?: string; ctx?: RequestContext }): Promise<PaymentOutcome> {
  const audit = (action: string, extra: Record<string, unknown> = {}) => recordAudit(tx, {
    actorType: meta.source === 'customer' && meta.customerId ? 'customer' : 'system', customerId: meta.customerId ?? null,
    action, entityType: 'orders', entityId: o.id,
    metadata: { order_number: o.order_number, provider: providerCode, payment_id: pay.id, amount_paise: pay.amountPaise, source: meta.source, ...extra }, ...ctxAudit(meta.ctx) });

  // The payment must belong to a session started for THIS order.
  const session = await tx.selectFrom('payments').select('id').where('order_id', '=', o.id).where('provider', '=', providerCode)
    .where('provider_order_id', '=', pay.sessionRef).executeTakeFirst();
  if (!session) { await audit('payment.order_mismatch', { session_ref: pay.sessionRef }); return 'not_this_order'; }

  const status = pay.status;
  const failure = status === 'failed' ? (pay.failureReason ?? 'Payment failed') : null;
  const row = await tx.selectFrom('payments').select(['id', 'status']).where('provider', '=', providerCode).where('provider_payment_id', '=', pay.id).executeTakeFirst();
  const isNew = !row;
  if (row) {
    if (RANK[status] > RANK[row.status])                            // statuses only move forward (a late "failed" never undoes "captured")
      await tx.updateTable('payments').set({ status, method: pay.method, failure_reason: failure, captured_at: status === 'captured' ? new Date() : undefined }).where('id', '=', row.id).execute();
  } else {
    const placeholder = await tx.selectFrom('payments').select('id').where('order_id', '=', o.id).where('provider', '=', providerCode)
      .where('provider_order_id', '=', pay.sessionRef).where('provider_payment_id', 'is', null).executeTakeFirst();
    const values = { provider_payment_id: pay.id, amount_paise: pay.amountPaise, currency: pay.currency, status, method: pay.method,
      failure_reason: failure, captured_at: status === 'captured' ? new Date() : null };
    // The session row records its first attempt; it keeps the session details so the session can be reused.
    if (placeholder) await tx.updateTable('payments').set({ ...values, raw: sql`raw || jsonb_build_object('payment', ${JSON.stringify(pay.raw ?? {})}::jsonb)` })
      .where('id', '=', placeholder.id).execute();
    else await tx.insertInto('payments').values({ order_id: o.id, provider: providerCode, provider_order_id: pay.sessionRef, ...values, raw: JSON.stringify(pay.raw ?? {}) }).execute();
  }

  if (status === 'captured') {
    if (pay.amountPaise !== o.total_paise || pay.currency !== o.currency) { if (isNew) await audit('payment.amount_mismatch', { expected_paise: o.total_paise }); return 'amount_mismatch'; }
    if (canTransitionAs('system', o.status, 'paid')) {
      await applyOrderTransition(tx, o, 'paid', { actor: 'system', note: `Payment ${pay.id} confirmed by ${providerCode}`, set: { payment_status: 'paid', paid_at: new Date() } });
      if (o.cart_id) await tx.updateTable('carts').set({ status: 'converted' }).where('id', '=', o.cart_id).where('status', '=', 'active').execute();
      await audit('payment.captured');
      return 'paid';
    }
    if (o.status === 'cancelled') {                                 // money arrived after the order was cancelled: staff must refund it
      if (o.payment_status !== 'paid') await tx.updateTable('orders').set({ payment_status: 'paid' }).where('id', '=', o.id).execute();
      if (isNew) await audit('payment.captured_after_cancel');
      return 'needs_refund';
    }
    const others = await tx.selectFrom('payments').select(sql<number>`count(*)::int`.as('n')).where('order_id', '=', o.id)
      .where('status', '=', 'captured').where('provider_payment_id', '!=', pay.id).executeTakeFirstOrThrow();
    if (others.n > 0) { if (isNew) await audit('payment.duplicate_capture'); return 'duplicate_capture'; }
    return 'already_paid';
  }
  if (status === 'failed') {
    if (canTransitionAs('system', o.status, 'payment_failed'))
      await applyOrderTransition(tx, o, 'payment_failed', { actor: 'system', note: failure, set: { payment_status: 'failed' } });
    if (isNew) await audit('payment.failed', { reason: failure });
    return canTransitionAs('system', o.status, 'paid') ? 'failed' : 'already_paid';
  }
  if (status === 'authorized' && canTransitionAs('system', o.status, 'paid') && o.payment_status !== 'authorized')
    await tx.updateTable('orders').set({ payment_status: 'authorized' }).where('id', '=', o.id).execute();
  return canTransitionAs('system', o.status, 'paid') ? 'authorized' : 'already_paid';
}

/** The provider's browser widget finished (success or failure). The provider verifies the result; only then is it applied. */
export async function submitPaymentResult(db: Db, provider: PaymentProvider, p: CustomerPrincipal, input: PaymentResultInput, ctx: RequestContext): Promise<PaymentOutcome> {
  const owned = await db.selectFrom('orders').select('id').where('order_number', '=', input.orderNumber).where('customer_id', '=', p.customerId).executeTakeFirst();
  if (!owned) throw new NotFoundError('Order not found.');
  const sessions = await db.selectFrom('payments').select('provider_order_id').distinct().where('order_id', '=', owned.id)
    .where('provider', '=', provider.code).where('provider_order_id', 'is not', null).execute();
  let pay: ProviderPayment | null = null;
  for (const s of sessions) if ((pay = await provider.verifyClientResult(s.provider_order_id!, input.result))) break;
  if (!pay) {
    await recordAudit(db, { actorType: 'customer', customerId: p.customerId, action: 'payment.not_verified', entityType: 'orders', entityId: owned.id,
      metadata: { order_number: input.orderNumber, provider: provider.code }, ...ctxAudit(ctx) });
    throw new DomainError('invalid', NOT_VERIFIED);
  }
  const verified = pay;
  return db.transaction().execute(async tx => applyPaymentResult(tx, (await lockOrder(tx, { id: owned.id }))!, provider.code, verified, { source: 'customer', customerId: p.customerId, ctx }));
}

// ======================= cancellation and expiry =======================

export async function cancelOrderByCustomer(db: Db, p: CustomerPrincipal, orderNumber: string, ctx: RequestContext): Promise<{ released: number }> {
  return db.transaction().execute(async tx => {
    const o = await lockOwnOrder(tx, p, orderNumber);
    if (!canTransitionAs('customer', o.status, 'cancelled'))
      throw new ConflictError(o.status === 'cancelled' ? 'This order is already cancelled.' : 'This order can no longer be cancelled here. Contact us and we will help.');
    if (await hasMoneyInFlight(tx, o.id)) throw new ConflictError('A payment for this order is being processed, so it cannot be cancelled right now. Check again in a few minutes.');
    return { released: await cancelUnpaid(tx, o, 'customer', 'Cancelled by the customer', { action: 'order.cancelled_by_customer', customerId: p.customerId, ctx }) };
  });
}

/** Cancels unpaid orders whose payment hold time (if one is configured) has passed, and returns their stock. Each order's
    payment provider is asked first: an order that was in fact paid is marked paid instead; if the provider cannot be
    asked (not available here, or not answering) the order is left for the next run. */
export async function expireUnpaidOrders(db: Db, providers: Record<string, PaymentProvider>, opts: { customerId?: string; limit?: number } = {}) {
  let q = db.selectFrom('orders').select('id').where('status', 'in', [...UNPAID_ORDER_STATUSES])
    .where('payment_expires_at', 'is not', null).where('payment_expires_at', '<=', sql<Date>`now()`);
  if (opts.customerId) q = q.where('customer_id', '=', opts.customerId);
  const due = await q.orderBy('payment_expires_at').limit(opts.limit ?? 50).execute();
  const result = { expired: 0, paid: 0, skipped: 0 };
  for (const { id } of due) {
    const sessions = await db.selectFrom('payments').select(['provider', 'provider_order_id']).distinct()
      .where('order_id', '=', id).where('provider_order_id', 'is not', null).execute();
    const known: { code: string; pay: ProviderPayment }[] = [];
    let unknown = false;
    for (const s of sessions) {
      const provider = providers[s.provider];
      const list = provider ? await provider.listPayments(s.provider_order_id!).catch(() => null) : null;
      if (list === null) { unknown = true; break; }
      known.push(...list.map(pay => ({ code: s.provider, pay })));
    }
    if (unknown) { result.skipped++; continue; }
    await db.transaction().execute(async tx => {
      const o = await lockOrder(tx, { id });
      if (!o || !canTransitionAs('system', o.status, 'cancelled') || !isExpired(o)) return;
      const captured = known.find(k => k.pay.status === 'captured');
      if (captured) { if ((await applyPaymentResult(tx, o, captured.code, captured.pay, { source: 'expiry' })) === 'paid') result.paid++; return; }
      if (known.some(k => k.pay.status === 'authorized') || await hasMoneyInFlight(tx, o.id)) { result.skipped++; return; }
      await cancelUnpaid(tx, o, 'system', 'Payment time ran out', { action: 'order.expired' });
      result.expired++;
    });
  }
  return result;
}

// ======================= provider notifications (webhooks) =======================

/** A provider's notification. Authenticated by the provider; each event id is stored once (a repeated delivery is
    acknowledged without doing anything); a payment in it is applied to the locked order. */
export async function handlePaymentWebhook(db: Db, provider: PaymentProvider, rawBody: string, header: (name: string) => string | null)
  : Promise<{ status: 200 | 401 | 404; outcome: string; orderNumber?: string }> {
  if (!provider.parseWebhook) return { status: 404, outcome: 'not_supported' };
  const event = provider.parseWebhook(rawBody, header);
  if (!event) return { status: 401, outcome: 'not_verified' };
  const eventKey = `${provider.code}:${event.eventId}`;
  return db.transaction().execute(async tx => {
    const stored = await tx.insertInto('payment_events').values({ id: eventKey, provider: provider.code, type: event.type, payload: rawBody })
      .onConflict(oc => oc.column('id').doNothing()).returning('id').executeTakeFirst();
    if (!stored) return { status: 200 as const, outcome: 'duplicate' };
    let outcome = 'ignored', orderId: string | null = null, orderNumber: string | undefined;
    if (event.payment) {
      const s = await tx.selectFrom('payments').select('order_id').where('provider', '=', provider.code).where('provider_order_id', '=', event.payment.sessionRef).executeTakeFirst();
      const o = s && await lockOrder(tx, { id: s.order_id });
      if (!o) outcome = 'unknown_order';
      else { orderId = o.id; orderNumber = o.order_number; outcome = await applyPaymentResult(tx, o, provider.code, event.payment, { source: 'webhook' }); }
    }
    await tx.updateTable('payment_events').set({ processed_at: new Date(), outcome, order_id: orderId }).where('id', '=', eventKey).execute();
    return { status: 200 as const, outcome, orderNumber };
  });
}
