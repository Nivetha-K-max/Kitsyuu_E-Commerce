import 'server-only';
/* Commerce wiring for the website (M7): which providers are plugged in, from configuration. Nothing is assumed, and a
   missing or wrong configuration fails SAFE (online payment off, checkout says so and refuses orders), never open:
   - PAYMENT_PROVIDER unset (the default) → no online payment.
   - PAYMENT_PROVIDER=test → the development test provider, explicitly opted into. In a production build it is refused
     (logged as an error, payment off) unless PAYMENTS_ALLOW_TEST_PROVIDER=on, which only automated tests of a production
     build may set; that case logs a loud warning.
   - PAYMENT_PROVIDER=razorpay → the Razorpay adapter (needs its credentials; a provider that cannot start is logged and off).
   - Shipping: the delivery charge chosen in admin Settings (M10; "Not set up yet" and no charge until then).
   - Discounts (ERP module 1): the discounts set up in the admin, applied only while the admin switch discounts.enabled
     is on (off at launch, so nothing changes until the business decides).
   See apps/website/.env.example. */
import type { StoreCart } from './types';
import { db } from './server';
import { databaseDiscounts, defaultCommerceConfig, razorpayProvider, settingsShipping, testPaymentProvider, type CommerceConfig, type PaymentProvider, type PricedCart, type TestPaymentProvider } from '@kitsyuu/core';

const g = globalThis as unknown as { __kitsyuuPayment?: PaymentProvider | null };

function selectPaymentProvider(): PaymentProvider | null {
  const code = (process.env.PAYMENT_PROVIDER || '').trim();
  if (!code) return null;
  const production = process.env.NODE_ENV === 'production';
  try {
    if (code === 'test') {
      if (production && process.env.PAYMENTS_ALLOW_TEST_PROVIDER !== 'on') {
        console.error('[payments] ERROR: PAYMENT_PROVIDER=test is refused in production (it takes no money). Online payment is OFF. '
          + 'Configure a real payment provider, or leave PAYMENT_PROVIDER unset.');
        return null;
      }
      if (production) console.warn('[payments] WARNING: the TEST payment provider is enabled in a production build (PAYMENTS_ALLOW_TEST_PROVIDER=on). '
        + 'Orders can be marked paid without any money. For automated tests only, never for a real store.');
      return testPaymentProvider({ secret: process.env.PAYMENTS_TEST_SECRET, production, allowInProduction: process.env.PAYMENTS_ALLOW_TEST_PROVIDER === 'on' });
    }
    if (code === 'razorpay') {
      return razorpayProvider({ keyId: process.env.RAZORPAY_KEY_ID ?? '', keySecret: process.env.RAZORPAY_KEY_SECRET ?? '',
        webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET, apiBase: process.env.RAZORPAY_API_BASE || undefined,
        checkoutScriptUrl: process.env.RAZORPAY_CHECKOUT_URL || undefined });
    }
    console.error(`[payments] ERROR: PAYMENT_PROVIDER "${code}" is not supported. Online payment is OFF. See apps/website/.env.example.`);
  } catch (e) {
    console.error(`[payments] ERROR: payment provider "${code}" could not start: ${(e as Error).message} Online payment is OFF.`);
  }
  return null;
}

/** The configured payment provider, or null when none is set up (or its configuration is not usable). */
export function paymentProvider(): PaymentProvider | null {
  if (g.__kitsyuuPayment === undefined) g.__kitsyuuPayment = selectPaymentProvider();
  return g.__kitsyuuPayment;
}
export const testProvider = (): TestPaymentProvider | null => {
  const p = paymentProvider();
  return p?.code === 'test' ? (p as TestPaymentProvider) : null;
};
/** Providers by code, for work on orders that may have been started with any of them (expiry). */
export const paymentProviders = (): Record<string, PaymentProvider> => { const p = paymentProvider(); return p ? { [p.code]: p } : {}; };

/** Delivery charge from admin Settings (M10; "Not set up" until the business chooses one); discounts from the admin (off by default). */
export function commerceConfig(): CommerceConfig { return { ...defaultCommerceConfig, shipping: settingsShipping(() => db()), discountSource: databaseDiscounts }; }

/** The cart as the browser receives it: display values only (never ids of other rows, never stock counts beyond "available"). */
export function clientCart(c: PricedCart, problemText: (l: PricedCart['lines'][number]) => string): StoreCart {
  return {
    lines: c.lines.map(l => ({ id: l.productId, sku: l.sku, name: l.name, size: l.size, colour: l.colour, colourLabel: l.colourLabel, qty: l.qty, price: l.unitPaise / 100,
      lineTotal: l.lineTotalPaise / 100, available: l.available, problem: l.problem ? problemText(l) : null })),
    totals: { units: c.totals.units, subtotal: c.totals.subtotalPaise / 100, discount: c.totals.discountPaise / 100, shipping: c.totals.shippingPaise / 100,
      shippingLabel: c.totals.shipping.configured ? c.totals.shipping.label : null, tax: c.totals.taxPaise / 100,
      pricesIncludeTax: c.totals.pricesIncludeTax, total: c.totals.totalPaise / 100 },
    canCheckout: c.canCheckout, removed: c.removed,
  };
}
