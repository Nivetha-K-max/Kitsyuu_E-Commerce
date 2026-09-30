/* Order pricing (M7): one function works out every amount, the same way for the cart, the checkout page and order creation.
   The three business inputs are pluggable and NOT invented here:
   - tax: the active row of tax_rates (configured data; today one tax-inclusive 0 % prototype rate);
   - shipping: a ShippingProvider (none is configured yet: no charge is added and the quote says so);
   - discounts: DiscountRule[] (no rules exist yet).
   A snapshot of how the amounts were worked out is stored on the order (orders.pricing). */
import { sql, type Queryable } from '@kitsyuu/db';

export interface PriceableLine { productId: string; variantId: string; qty: number; unitPaise: number; lineTotalPaise: number }
export interface ShipTo { state: string; pin: string; country: string }

export interface ShippingQuote {
  amountPaise: number; method: string; label: string; configured: boolean;
  /** Set when the order cannot be delivered to this address with the configured rates (checkout is refused with this text). */
  unavailable?: string; estimate?: string | null;
}
/** Works out the shipping charge for an order. Real carriers / rate tables plug in here. */
export interface ShippingProvider {
  readonly code: string;
  quote(input: { lines: PriceableLine[]; subtotalPaise: number; shipTo: ShipTo | null }): Promise<ShippingQuote>;
}
/** No shipping method is configured: nothing is charged, and pages say shipping is not set up. */
export const unconfiguredShipping: ShippingProvider = {
  code: 'none',
  quote: async () => ({ amountPaise: 0, method: 'none', label: 'Not set up yet', configured: false }),
};

export interface DiscountLine { code: string; label: string; amountPaise: number; /** discounts.id when it came from the database */ discountId?: string }
/** A discount rule (coupon, sale, customer group…). Returns the amount off, or 0 when it does not apply. */
export interface DiscountRule {
  readonly code: string;
  readonly label: string;
  evaluate(input: { lines: PriceableLine[]; subtotalPaise: number; customerId: string | null }): Promise<number>;
}

export interface TaxRate { code: string; label: string; rateBp: number; inclusive: boolean }
/** The store-wide tax rate in force today (tax_rates), or null if none is configured. Per-product rates (HSN) come later. */
export async function currentTaxRate(q: Queryable): Promise<TaxRate | null> {
  const today = sql<Date>`(now() at time zone 'Asia/Kolkata')::date`;
  const r = await q.selectFrom('tax_rates').select(['code', 'label', 'rate_bp', 'is_inclusive'])
    .where('is_active', '=', true).where('valid_from', '<=', today)
    .where(eb => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>=', today)]))
    .orderBy('valid_from', 'desc').limit(1).executeTakeFirst();
  return r ? { code: r.code, label: r.label, rateBp: r.rate_bp, inclusive: r.is_inclusive } : null;
}

/** The state of a coupon code on the cart: applied, or why not (shown to the customer). */
export interface CouponState { code: string; applied: boolean; message: string | null }
/** Discounts that come from data (ERP module 1: the discounts table). Given the priced lines, returns the discount lines
    that apply (already chosen according to the business's stacking setting) and the state of the cart's coupon. */
export interface DiscountSource {
  evaluate(q: Queryable, input: { lines: PriceableLine[]; subtotalPaise: number; customerId: string | null; cartId: string | null })
    : Promise<{ discounts: DiscountLine[]; coupon: CouponState | null }>;
}

export interface CommerceConfig { shipping: ShippingProvider; discounts: DiscountRule[]; discountSource?: DiscountSource }
export const defaultCommerceConfig: CommerceConfig = { shipping: unconfiguredShipping, discounts: [] };

export interface CartTotals {
  units: number; subtotalPaise: number; discountPaise: number; shippingPaise: number; taxPaise: number; totalPaise: number;
  pricesIncludeTax: boolean;
  shipping: ShippingQuote; discounts: DiscountLine[]; tax: (TaxRate & { configured: true }) | { configured: false };
  coupon?: CouponState | null;
}

export async function priceOrder(q: Queryable, lines: PriceableLine[], opts: { config?: CommerceConfig; customerId?: string | null; shipTo?: ShipTo | null; cartId?: string | null } = {}): Promise<CartTotals> {
  const config = opts.config ?? defaultCommerceConfig;
  const subtotalPaise = lines.reduce((n, l) => n + l.lineTotalPaise, 0);
  const discounts: DiscountLine[] = [];
  for (const rule of config.discounts) {
    const amount = Math.max(0, Math.floor(await rule.evaluate({ lines, subtotalPaise, customerId: opts.customerId ?? null })));
    if (amount > 0) discounts.push({ code: rule.code, label: rule.label, amountPaise: amount });
  }
  let coupon: CouponState | null = null;
  if (config.discountSource) {
    const r = await config.discountSource.evaluate(q, { lines, subtotalPaise, customerId: opts.customerId ?? null, cartId: opts.cartId ?? null });
    for (const d of r.discounts) if (d.amountPaise > 0) discounts.push({ ...d, amountPaise: Math.floor(d.amountPaise) });
    coupon = r.coupon;
  }
  const discountPaise = Math.min(subtotalPaise, discounts.reduce((n, d) => n + d.amountPaise, 0));
  const shipping = await config.shipping.quote({ lines, subtotalPaise, shipTo: opts.shipTo ?? null });
  const rate = await currentTaxRate(q);
  const taxable = subtotalPaise - discountPaise;            // goods after discounts; how shipping is taxed is not decided yet
  const taxPaise = !rate ? 0 : rate.inclusive ? Math.round(taxable * rate.rateBp / (10_000 + rate.rateBp)) : Math.round(taxable * rate.rateBp / 10_000);
  const pricesIncludeTax = rate ? rate.inclusive : true;
  return {
    units: lines.reduce((n, l) => n + l.qty, 0), subtotalPaise, discountPaise, shippingPaise: shipping.amountPaise, taxPaise,
    totalPaise: taxable + shipping.amountPaise + (pricesIncludeTax ? 0 : taxPaise), pricesIncludeTax,
    shipping, discounts, tax: rate ? { ...rate, configured: true } : { configured: false },
    ...(config.discountSource ? { coupon } : {}),
  };
}
