/* Razorpay adapter for the PaymentProvider interface — ready to plug in, not enabled until Razorpay credentials are
   provided (PAYMENT_PROVIDER=razorpay). The key secret and webhook secret never leave the server; the browser receives only
   the public key id and the Razorpay order id.
   - Checkout handler result: the signature HMAC-SHA256(order_id|payment_id, key secret) is checked, then the payment is
     read back from Razorpay's API (and captured if only authorised). A failure report is accepted only as Razorpay's API
     describes that payment.
   - Webhooks: signature HMAC-SHA256(raw body, webhook secret), event id from the x-razorpay-event-id header.
   Live keys (rzp_live_…) are refused unless allowLive is set explicitly (the apps set it only from RAZORPAY_LIVE_MODE=on).
   With requireWebhookSecret the adapter does not start without a webhook secret: the store asks for that in live mode, so a
   payment whose browser never came back is still confirmed by Razorpay's signed notification. */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { UnavailableError } from '@kitsyuu/contracts';
import type { PaymentProvider, ProviderPayment } from './provider.ts';

export interface RazorpayConfig {
  keyId: string; keySecret: string; webhookSecret?: string;
  apiBase?: string; checkoutScriptUrl?: string; allowLive?: boolean; requireWebhookSecret?: boolean; timeoutMs?: number;
}

const UNAVAILABLE = 'The payment service is not responding right now. Your order is saved; please try paying again in a moment.';

function hmacMatches(secret: string, payload: string, signature: string): boolean {
  if (!secret || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  return timingSafeEqual(createHmac('sha256', secret).update(payload).digest(), Buffer.from(signature, 'hex'));
}

export function razorpayProvider(cfg: RazorpayConfig): PaymentProvider {
  if (!/^rzp_(test|live)_[A-Za-z0-9]{6,}$/.test(cfg.keyId)) throw new Error('RAZORPAY_KEY_ID is not a Razorpay key id.');
  if (cfg.keyId.startsWith('rzp_live_') && !cfg.allowLive) throw new Error('Refusing a live Razorpay key: live payments are not switched on (RAZORPAY_LIVE_MODE).');
  if (!cfg.keySecret || /^REPLACE|^</.test(cfg.keySecret)) throw new Error('RAZORPAY_KEY_SECRET is not set.');
  if (cfg.webhookSecret && /^REPLACE|^</.test(cfg.webhookSecret)) throw new Error('RAZORPAY_WEBHOOK_SECRET is a placeholder.');
  if (cfg.requireWebhookSecret && !cfg.webhookSecret) throw new Error('RAZORPAY_WEBHOOK_SECRET is not set (needed for live payments).');
  const base = (cfg.apiBase || 'https://api.razorpay.com').replace(/\/$/, '');
  const auth = 'Basic ' + Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString('base64');
  const scriptUrl = cfg.checkoutScriptUrl || 'https://checkout.razorpay.com/v1/checkout.js';

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(base + path, {
        method, signal: AbortSignal.timeout(cfg.timeoutMs ?? 10_000),
        headers: { authorization: auth, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      console.error('[razorpay] request failed', method, path, (e as Error).name);
      throw new UnavailableError(UNAVAILABLE);
    }
    const text = await res.text();
    if (res.status >= 500 || res.status === 429) { console.error('[razorpay]', method, path, res.status); throw new UnavailableError(UNAVAILABLE); }
    if (!res.ok) { console.error('[razorpay]', method, path, res.status, text.slice(0, 300)); throw new Error(`Razorpay ${method} ${path} → ${res.status}`); }
    return JSON.parse(text) as T;
  }
  const toPayment = (p: Record<string, unknown>): ProviderPayment => ({
    id: String(p.id), sessionRef: String(p.order_id ?? ''), amountPaise: Number(p.amount), currency: String(p.currency),
    status: p.status as ProviderPayment['status'], method: (p.method as string) ?? null,
    failureReason: (p.error_description as string) ?? null, raw: p,
  });
  const fetchPayment = async (id: string) => toPayment(await call('GET', `/v1/payments/${encodeURIComponent(id)}`));

  return {
    code: 'razorpay',
    label: 'Razorpay',
    async createSession(order) {
      const o = await call<{ id: string; amount: number; currency: string }>('POST', '/v1/orders', {
        amount: order.amountPaise, currency: order.currency, receipt: order.orderNumber, payment_capture: 1,
        notes: { order_id: order.orderId, order_number: order.orderNumber },
      });
      if (o.amount !== order.amountPaise || o.currency !== order.currency) throw new Error(`Razorpay order ${o.id}: amount/currency mismatch`);
      return { sessionRef: o.id, client: { provider: 'razorpay', keyId: cfg.keyId, scriptUrl, razorpayOrderId: o.id, amountPaise: o.amount,
        currency: o.currency, prefill: { name: order.contact.name, email: order.contact.email, contact: order.contact.phone } } };
    },
    async verifyClientResult(sessionRef, r) {
      const paymentId = r.razorpay_payment_id;
      if (!/^pay_[A-Za-z0-9]{6,40}$/.test(paymentId ?? '')) return null;
      if (r.razorpay_signature) {
        if (r.razorpay_order_id !== sessionRef || !hmacMatches(cfg.keySecret, `${sessionRef}|${paymentId}`, r.razorpay_signature)) return null;
      }
      let p = await fetchPayment(paymentId);
      if (p.sessionRef !== sessionRef) return null;
      if (!r.razorpay_signature && p.status !== 'failed') return null;        // an unsigned report only ever records a failure
      if (p.status === 'authorized') p = toPayment(await call('POST', `/v1/payments/${encodeURIComponent(p.id)}/capture`, { amount: p.amountPaise, currency: p.currency }));
      return p;
    },
    async refund(input) {
      const r = await call<Record<string, unknown>>('POST', `/v1/payments/${encodeURIComponent(input.paymentId)}/refund`, { amount: input.amountPaise, notes: input.notes });
      if (Number(r.amount) !== input.amountPaise) throw new Error(`Razorpay refund ${String(r.id)}: amount mismatch`);
      const status = r.status === 'processed' ? 'processed' : r.status === 'failed' ? 'failed' : 'pending';
      return { id: String(r.id), amountPaise: Number(r.amount), status, raw: r };
    },
    async listPayments(sessionRef) {
      return ((await call<{ items: Record<string, unknown>[] }>('GET', `/v1/orders/${encodeURIComponent(sessionRef)}/payments`)).items ?? []).map(toPayment);
    },
    parseWebhook(rawBody, header) {
      if (!hmacMatches(cfg.webhookSecret ?? '', rawBody, header('x-razorpay-signature') ?? '')) return null;
      const eventId = header('x-razorpay-event-id') ?? '';
      let body: { event?: string; payload?: { payment?: { entity?: Record<string, unknown> } } };
      try { body = JSON.parse(rawBody); } catch { return null; }
      if (!/^[A-Za-z0-9_-]{6,64}$/.test(eventId) || typeof body.event !== 'string') return null;
      const e = body.payload?.payment?.entity;
      return { eventId, type: body.event, payment: e && typeof e.order_id === 'string' ? toPayment(e) : null };
    },
  };
}
