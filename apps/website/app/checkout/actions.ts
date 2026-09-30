'use server';
/* Checkout and payment actions (M7). Each re-checks the session; the services re-price, re-check stock and verify payments
   with the configured provider. Nothing the browser sends about money is trusted. */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { randomUUID } from 'node:crypto';
import { couponInput, DomainError, orderNumberInput, paymentResultInput, placeOrderInput, type ActionState } from '@kitsyuu/contracts';
import { cancelOrderByCustomer, checkoutRateLimit, currentPaymentSession, placeOrder, setCartCoupon, submitPaymentResult, type PaymentOutcome } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { sendOrderConfirmation } from '@/lib/order-mail';
import { commerceConfig, paymentProvider, testProvider } from '@/lib/commerce';
import { db, requestContext, requireCustomer } from '@/lib/server';

export async function placeOrderAction(_: ActionState, form: FormData): Promise<ActionState> {
  const me = await requireCustomer('/checkout');
  // Cash on delivery needs no online payment (second pass); the server decides whether it is available for this order.
  const cod = form.get('paymentMethod') === 'cod';
  if (!paymentProvider() && !cod) return { ok: false, message: 'Online payment is not set up yet, so orders cannot be placed.' };
  // M9: abuse limit in front of checkout (the M7 checkout itself is unchanged).
  if (!(await checkoutRateLimit(db(), me.customerId)).allowed) return { ok: false, message: 'Too many orders were started from this account in the last hour. Please try again later.' };
  let orderNumber = '', placedCod = false;
  const result = await handle(placeOrderInput, form, async input => {
    const r = await placeOrder(db(), me, input, await requestContext(), commerceConfig());
    orderNumber = r.orderNumber; placedCod = r.cod;
    if (r.cod && !r.reused) await sendOrderConfirmation(r.orderNumber);    // a COD order is confirmed now (nothing to pay online)
  });
  if (orderNumber && placedCod) { revalidatePath('/account', 'layout'); redirect(`/checkout/complete/${encodeURIComponent(orderNumber)}`); }
  if (orderNumber) redirect(`/checkout/pay/${encodeURIComponent(orderNumber)}`);
  return result;
}

export type PaymentReply = { ok: boolean; outcome?: PaymentOutcome; message?: string };

async function paymentReply(orderNumber: string, work: () => Promise<PaymentOutcome>): Promise<PaymentReply> {
  try {
    const outcome = await work();
    if (outcome === 'paid') await sendOrderConfirmation(orderNumber);      // only the call that made it paid sends it
    revalidatePath('/account', 'layout');
    return { ok: outcome === 'paid' || outcome === 'already_paid', outcome };
  } catch (e) {
    if (e instanceof DomainError) return { ok: false, message: e.message };
    const ref = randomUUID().slice(0, 8);
    console.error(`[payment action] ref=${ref}`, e);
    return { ok: false, message: `We could not confirm the payment just now. If money was taken, your order is updated automatically. (Reference ${ref})` };
  }
}

/** The payment provider's browser widget finished: its result is verified by the provider on the server. */
export async function submitPaymentResultAction(raw: unknown): Promise<PaymentReply> {
  const input = paymentResultInput.safeParse(raw);
  if (!input.success) return { ok: false, message: 'We could not verify this payment.' };
  const me = await requireCustomer(`/account/orders/${encodeURIComponent(input.data.orderNumber)}`);
  const provider = paymentProvider();
  if (!provider) return { ok: false, message: 'Online payment is not set up yet.' };
  return paymentReply(input.data.orderNumber, async () => submitPaymentResult(db(), provider, me, input.data, await requestContext()));
}

/** Development test provider only: the simulated provider answers on the server (amount from the order in the database),
    and the answer goes through the same verification as a real provider's. */
export async function testPaymentAction(raw: unknown, outcome: 'success' | 'failure'): Promise<PaymentReply> {
  const input = orderNumberInput.safeParse(raw);
  const provider = testProvider();
  if (!input.success || !provider || (outcome !== 'success' && outcome !== 'failure')) return { ok: false, message: 'Test payments are not available.' };
  const me = await requireCustomer(`/account/orders/${encodeURIComponent(input.data.orderNumber)}`);
  return paymentReply(input.data.orderNumber, async () => {
    const o = await db().selectFrom('orders').select(['id', 'total_paise', 'currency']).where('order_number', '=', input.data.orderNumber)
      .where('customer_id', '=', me.customerId).executeTakeFirst();
    const session = o && await currentPaymentSession(db(), o.id, provider.code, o.total_paise);
    if (!o || !session) throw new DomainError('invalid', 'Start the payment again from your order.');
    const result = provider.simulate(session.sessionRef, o.total_paise, o.currency, outcome);
    return submitPaymentResult(db(), provider, me, { orderNumber: input.data.orderNumber, result }, await requestContext());
  });
}

export async function cancelOrderAction(_: ActionState, form: FormData): Promise<ActionState> {
  const me = await requireCustomer('/account/orders');
  return handle(orderNumberInput, form, async input => {
    const r = await cancelOrderByCustomer(db(), me, input.orderNumber, await requestContext());
    revalidatePath('/account', 'layout');
    return { ok: true, message: r.released ? 'Your order is cancelled and its items are back in stock. Nothing was charged.' : 'Your order is cancelled.' };
  });
}

/** ERP module 1: apply a coupon code to the cart (checked on the server; whether it applies is shown with the totals). */
export async function applyCouponAction(_: ActionState, form: FormData): Promise<ActionState> {
  const me = await requireCustomer('/checkout');
  const r = await handle(couponInput, form, async input => {
    if (!input.code) return { ok: false, fieldErrors: { code: 'Enter a coupon code.' }, message: 'Enter a coupon code.' };
    await setCartCoupon(db(), me, input.code);
    return { ok: true, message: 'Coupon added.' };
  });
  if (r.ok) revalidatePath('/checkout');
  return r;
}

export async function removeCouponAction(_: ActionState): Promise<ActionState> {
  const me = await requireCustomer('/checkout');
  await setCartCoupon(db(), me, null);
  revalidatePath('/checkout');
  return { ok: true, message: 'Coupon removed.' };
}
