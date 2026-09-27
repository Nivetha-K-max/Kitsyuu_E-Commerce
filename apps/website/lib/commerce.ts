import 'server-only';
/* Commerce wiring for the website (M7): which providers are plugged in, from configuration. Nothing is assumed:
   - PAYMENT_PROVIDER: 'test' (development; refused in production unless PAYMENTS_ALLOW_TEST_PROVIDER=on) or 'razorpay'
     (once credentials exist). Unset → no online payment: checkout explains that orders cannot be paid yet.
   - Shipping and discounts: none are configured yet (core defaults: no charge, no rules). A shipping provider or discount
     rules are added here when they are decided.
   See apps/website/.env.example. */
import type { StoreCart } from './types';
import { defaultCommerceConfig, razorpayProvider, testPaymentProvider, type CommerceConfig, type PaymentProvider, type PricedCart, type TestPaymentProvider } from '@kitsyuu/core';

const g = globalThis as unknown as { __kitsyuuPayment?: PaymentProvider | null };

/** The configured payment provider, or null when none is set up. */
export function paymentProvider(): PaymentProvider | null {
  if (g.__kitsyuuPayment !== undefined) return g.__kitsyuuPayment;
  const code = (process.env.PAYMENT_PROVIDER || '').trim();
  let p: PaymentProvider | null = null;
  if (code === 'test') {
    p = testPaymentProvider({ secret: process.env.PAYMENTS_TEST_SECRET, production: process.env.NODE_ENV === 'production',
      allowInProduction: process.env.PAYMENTS_ALLOW_TEST_PROVIDER === 'on' });
  } else if (code === 'razorpay') {
    p = razorpayProvider({ keyId: process.env.RAZORPAY_KEY_ID ?? '', keySecret: process.env.RAZORPAY_KEY_SECRET ?? '',
      webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET, apiBase: process.env.RAZORPAY_API_BASE || undefined,
      checkoutScriptUrl: process.env.RAZORPAY_CHECKOUT_URL || undefined });
  } else if (code) {
    throw new Error(`PAYMENT_PROVIDER "${code}" is not supported. See apps/website/.env.example.`);
  }
  return (g.__kitsyuuPayment = p);
}
export const testProvider = (): TestPaymentProvider | null => {
  const p = paymentProvider();
  return p?.code === 'test' ? (p as TestPaymentProvider) : null;
};
/** Providers by code, for work on orders that may have been started with any of them (expiry). */
export const paymentProviders = (): Record<string, PaymentProvider> => { const p = paymentProvider(); return p ? { [p.code]: p } : {}; };

export function commerceConfig(): CommerceConfig { return defaultCommerceConfig; }

/** The cart as the browser receives it: display values only (never ids of other rows, never stock counts beyond "available"). */
export function clientCart(c: PricedCart, problemText: (l: PricedCart['lines'][number]) => string): StoreCart {
  return {
    lines: c.lines.map(l => ({ id: l.productId, sku: l.sku, name: l.name, size: l.size, qty: l.qty, price: l.unitPaise / 100,
      lineTotal: l.lineTotalPaise / 100, available: l.available, problem: l.problem ? problemText(l) : null })),
    totals: { units: c.totals.units, subtotal: c.totals.subtotalPaise / 100, discount: c.totals.discountPaise / 100, shipping: c.totals.shippingPaise / 100,
      shippingLabel: c.totals.shipping.configured ? c.totals.shipping.label : null, tax: c.totals.taxPaise / 100,
      pricesIncludeTax: c.totals.pricesIncludeTax, total: c.totals.totalPaise / 100 },
    canCheckout: c.canCheckout, removed: c.removed,
  };
}
