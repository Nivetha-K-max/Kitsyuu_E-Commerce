import 'server-only';
/* ERP module 3: the payment provider the admin uses to REFUND (nothing else). From configuration only, off by default:
   - PAYMENT_PROVIDER unset → no provider refunds; staff refund outside the platform and record it with the reference.
   - PAYMENT_PROVIDER=razorpay → the Razorpay adapter with RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET (the same account as the
     store; a LIVE key is refused unless RAZORPAY_LIVE_MODE=on is also set). A provider that cannot start is logged and off.
   - PAYMENT_PROVIDER=test → the development test provider (refunds of test payments only; refused in production).
   Credentials are never stored in the database and never shown in the admin. */
import { notifyReturn, razorpayProvider, reconcilePendingRefunds, testPaymentProvider, type PaymentProvider, type RefundReconcileRun } from '@kitsyuu/core';
import { db, mailer } from './server';

const g = globalThis as unknown as { __kitsyuuAdminPayment?: PaymentProvider | null; __kitsyuuRefundCheckAt?: number };

function select(): PaymentProvider | null {
  const code = (process.env.PAYMENT_PROVIDER || '').trim();
  if (!code) return null;
  try {
    if (code === 'razorpay') return razorpayProvider({ keyId: (process.env.RAZORPAY_KEY_ID ?? '').trim(), keySecret: process.env.RAZORPAY_KEY_SECRET ?? '',
      apiBase: process.env.RAZORPAY_API_BASE || undefined, allowLive: process.env.RAZORPAY_LIVE_MODE === 'on' });
    if (code === 'test') {
      if (process.env.NODE_ENV === 'production' && process.env.PAYMENTS_ALLOW_TEST_PROVIDER !== 'on') { console.error('[payments] test provider refused in production'); return null; }
      return testPaymentProvider({ secret: process.env.PAYMENTS_TEST_SECRET });
    }
    console.error(`[payments] PAYMENT_PROVIDER "${code}" is not supported for refunds.`);
  } catch (e) {
    console.error(`[payments] refund provider "${code}" could not start: ${(e as Error).message}`);
  }
  return null;
}

/** The provider refunds go through, or null (refunds are then recorded manually). */
export function refundProvider(): PaymentProvider | null {
  if (g.__kitsyuuAdminPayment === undefined) g.__kitsyuuAdminPayment = select();
  return g.__kitsyuuAdminPayment;
}

/** 2026-10-14: settles provider refunds left pending from what the provider reports (read only: no refund is ever
    requested here), then emails the customers whose return refund was confirmed, as a refund made by staff does.
    Nothing to do (and no provider call) when no refund provider is configured. */
export async function checkPendingRefunds(): Promise<RefundReconcileRun | null> {
  const provider = refundProvider();
  if (!provider?.listRefunds) return null;
  const run = await reconcilePendingRefunds(db(), provider);
  for (const id of run.refundedReturnIds)
    await notifyReturn(db(), mailer(), id, 'refund', { storeUrl: process.env.STORE_URL || null }).catch(e => console.error('[refunds] email failed', (e as Error).message));
  return run;
}

/** At most once every 5 minutes per server instance, for running after a staff page has answered. Never throws. */
export async function checkPendingRefundsThrottled(everyMs = 5 * 60_000): Promise<void> {
  const now = Date.now();
  if (g.__kitsyuuRefundCheckAt && now - g.__kitsyuuRefundCheckAt < everyMs) return;
  g.__kitsyuuRefundCheckAt = now;
  try { await checkPendingRefunds(); } catch (e) { console.error('[refunds] pending refund check failed:', (e as Error).message); }
}
