import 'server-only';
/* Order emails (M7): sent AFTER the payment is committed, once — the order becomes 'paid' exactly once (whether the
   browser callback or the provider's webhook got there first). A failed send is logged and never undoes the payment. */
import { orderConfirmationEmail } from '@kitsyuu/core';
import { RETURNS_POLICY } from './store-policy';
import { db, mailer, siteUrl } from './server';

export async function sendOrderConfirmation(orderNumber: string): Promise<void> {
  try {
    const message = await orderConfirmationEmail(db(), orderNumber, { orderUrl: siteUrl(`/account/orders/${encodeURIComponent(orderNumber)}`), policy: RETURNS_POLICY });
    if (message) await mailer().send(message);
  } catch (e) {
    console.error(`[order mail] confirmation for ${orderNumber} was not sent:`, (e as Error).message);
  }
}
