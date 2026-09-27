/* Development / test payment provider. No money moves and nothing leaves the server.
   It plays the provider's part itself: simulate() — called by the server, with the amount taken from the order in the
   database — produces a result signed with a server-side secret, exactly like a real provider's signed callback.
   verifyClientResult() accepts only results with a valid signature for that session, so the browser still cannot mark an
   order paid (or change the amount) on its own. It keeps no state, so it cannot list payments for a session: expiry treats
   an unconfirmed simulated payment as never made.
   Refused in production unless explicitly allowed (PAYMENTS_ALLOW_TEST_PROVIDER=on, for automated tests of a production build). */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PaymentProvider, ProviderPayment } from './provider.ts';

export interface TestPaymentProvider extends PaymentProvider {
  /** The simulated provider's answer for a session, with the amount the SERVER supplies. */
  simulate(sessionRef: string, amountPaise: number, currency: string, outcome: 'success' | 'failure'): Record<string, string>;
}

export function testPaymentProvider(opts: { secret?: string; production?: boolean; allowInProduction?: boolean } = {}): TestPaymentProvider {
  if (opts.production && !opts.allowInProduction) throw new Error('The test payment provider is not available in production.');
  const secret = opts.secret || randomBytes(32).toString('hex');
  const sign = (f: Record<string, string>) =>
    createHmac('sha256', secret).update([f.session_ref, f.payment_id, f.status, f.amount, f.currency].join('|')).digest('hex');

  return {
    code: 'test',
    label: 'Test payment (no money is taken)',
    async createSession(order) {
      const sessionRef = `test_${randomBytes(8).toString('hex')}`;
      return { sessionRef, client: { provider: 'test', sessionRef, amountPaise: order.amountPaise, currency: order.currency } };
    },
    simulate(sessionRef, amountPaise, currency, outcome) {
      const f: Record<string, string> = { session_ref: sessionRef, payment_id: `testpay_${randomBytes(8).toString('hex')}`,
        status: outcome === 'success' ? 'captured' : 'failed', amount: String(amountPaise), currency };
      return { ...f, signature: sign(f) };
    },
    async verifyClientResult(sessionRef, r) {
      if (r.session_ref !== sessionRef || !/^testpay_[a-f0-9]{16}$/.test(r.payment_id ?? '') || !/^[a-f0-9]{64}$/.test(r.signature ?? '')) return null;
      if (!['captured', 'failed'].includes(r.status) || !/^\d{1,12}$/.test(r.amount ?? '') || !/^[A-Z]{3}$/.test(r.currency ?? '')) return null;
      if (!timingSafeEqual(Buffer.from(sign(r), 'hex'), Buffer.from(r.signature, 'hex'))) return null;
      const p: ProviderPayment = { id: r.payment_id, sessionRef, amountPaise: Number(r.amount), currency: r.currency,
        status: r.status as 'captured' | 'failed', method: 'test', failureReason: r.status === 'failed' ? 'Declined (test payment)' : null };
      return p;
    },
    async listPayments() { return []; },
  };
}
