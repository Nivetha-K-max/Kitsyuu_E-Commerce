import 'server-only';
/* Order emails (M7): sent AFTER the payment is committed, once — the order becomes 'paid' exactly once (whether the
   browser callback or the provider's webhook got there first), and since 2026-10-01 the notification log guards it too
   (sendOrderPlacedEmail: one "order confirmed" email per order, sent / failed logged). A failed send never undoes the payment. */
import { sendOrderPlacedEmail } from '@kitsyuu/core';
import { getReturnsPolicy } from './content';
import { db, mailer, siteUrl } from './server';

export async function sendOrderConfirmation(orderNumber: string): Promise<void> {
  try {
    await sendOrderPlacedEmail(db(), mailer(), orderNumber, { orderUrl: siteUrl(`/account/orders/${encodeURIComponent(orderNumber)}`), policy: await getReturnsPolicy() });
  } catch (e) {
    console.error(`[order mail] confirmation for ${orderNumber} was not sent:`, (e as Error).message);
  }
}
