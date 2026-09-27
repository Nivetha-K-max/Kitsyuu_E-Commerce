'use server';
/* Checkout and payment actions (M7). Each re-checks the session; the services re-price, re-check stock and verify payments
   with the configured provider. Nothing the browser sends about money is trusted. */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { randomUUID } from 'node:crypto';
import { DomainError, orderNumberInput, paymentResultInput, placeOrderInput, type ActionState } from '@kitsyuu/contracts';
import { cancelOrderByCustomer, currentPaymentSession, placeOrder, submitPaymentResult, type PaymentOutcome } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { commerceConfig, paymentProvider, testProvider } from '@/lib/commerce';
import { db, requestContext, requireCustomer } from '@/lib/server';

export async function placeOrderAction(_: ActionState, form: FormData): Promise<ActionState> {
  const me = await requireCustomer('/checkout');
  if (!paymentProvider()) return { ok: false, message: 'Online payment is not set up yet, so orders cannot be placed.' };
  let orderNumber = '';
  const result = await handle(placeOrderInput, form, async input => {
    orderNumber = (await placeOrder(db(), me, input, await requestContext(), commerceConfig())).orderNumber;
  });
  if (orderNumber) redirect(`/checkout/pay/${encodeURIComponent(orderNumber)}`);
  return result;
}

export type PaymentReply = { ok: boolean; outcome?: PaymentOutcome; message?: string };

async function paymentReply(work: () => Promise<PaymentOutcome>): Promise<PaymentReply> {
  try {
    const outcome = await work();
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
  return paymentReply(async () => submitPaymentResult(db(), provider, me, input.data, await requestContext()));
}

/** Development test provider only: the simulated provider answers on the server (amount from the order in the database),
    and the answer goes through the same verification as a real provider's. */
export async function testPaymentAction(raw: unknown, outcome: 'success' | 'failure'): Promise<PaymentReply> {
  const input = orderNumberInput.safeParse(raw);
  const provider = testProvider();
  if (!input.success || !provider || (outcome !== 'success' && outcome !== 'failure')) return { ok: false, message: 'Test payments are not available.' };
  const me = await requireCustomer(`/account/orders/${encodeURIComponent(input.data.orderNumber)}`);
  return paymentReply(async () => {
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
