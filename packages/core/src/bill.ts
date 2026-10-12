/* The bill (2026-10-12): ONE description of what an order costs, for every place a bill is shown: the POS counter while
   it is being rung up, the POS receipt, the order page, the tax invoice and the invoice email.

     items subtotal  −  each discount (staff, offer, coupon, cash-on-delivery, loyalty points)  +  delivery  +  COD fee
     +  tax (or "included in the prices")  =  total payable

   Nothing is calculated here that the pricing did not already decide: the amounts are the ones priceOrder worked out
   (pricing.ts) and the order stored when it was created (orders.* and orders.pricing, never edited afterwards). This file
   only puts them in one order with one set of labels, and says whether they add up (`consistent`), so two screens can
   never show the same order differently. Pure: no database, no permissions (the caller already holds the order). */
import type { CartTotals } from './pricing.ts';

export type BillLineKind = 'subtotal' | 'staff_discount' | 'offer' | 'coupon' | 'cod_discount' | 'loyalty' | 'discount' | 'delivery' | 'cod_fee' | 'tax' | 'total';
export interface BillLine {
  kind: BillLineKind; label: string; amountPaise: number;
  /** −1: taken off the bill; +1: added to it; 0: shown for information (tax already inside the prices, the subtotal, the total). */
  effect: -1 | 0 | 1;
  /** The discount's own code (STAFF, LOYALTY, COD, a coupon code, auto:…) where the line is a discount. */
  code?: string;
}
export interface Bill {
  lines: BillLine[];
  subtotalPaise: number; discountPaise: number; totalPaise: number; pricesIncludeTax: boolean;
  /** Loyalty points used on this bill and what they took off (null when none). */
  points: { used: number; valuePaise: number } | null;
  /** The coupon code used on this bill (null when none). */
  coupon: string | null;
  /** The lines add up to the total. False only for a record whose stored amounts disagree (shown, never corrected here). */
  consistent: boolean;
}

interface BillAmounts {
  subtotalPaise: number; discountPaise: number; shippingPaise: number; taxPaise: number; totalPaise: number; pricesIncludeTax: boolean; codFeePaise: number;
  discounts: { code: string; label: string; amountPaise: number }[];
  tax: { label: string | null; configured: boolean; split?: { type?: string; cgst?: number; sgst?: number; igst?: number } | null };
  delivery: { label: string; pickup: boolean; inStore: boolean } | null;
  pointsUsed: number;
}

const kindOf = (code: string): BillLineKind => (code === 'STAFF' ? 'staff_discount' : code === 'LOYALTY' ? 'loyalty' : code === 'COD' ? 'cod_discount' : code.startsWith('auto:') ? 'offer' : 'coupon');

export function buildBill(a: BillAmounts): Bill {
  const lines: BillLine[] = [{ kind: 'subtotal', label: 'Items subtotal', amountPaise: a.subtotalPaise, effect: 0 }];
  const named = a.discounts.filter(d => d.amountPaise > 0);
  // The discount lines kept with the order say what each discount was. When they do not add up to the discount the order
  // was charged (an order from before discount lines were kept), the one amount that was charged is shown instead.
  if (a.discountPaise > 0) {
    if (named.reduce((n, d) => n + d.amountPaise, 0) === a.discountPaise) for (const d of named) lines.push({ kind: kindOf(d.code), label: d.label, amountPaise: d.amountPaise, effect: -1, code: d.code });
    else lines.push({ kind: 'discount', label: 'Discounts', amountPaise: a.discountPaise, effect: -1 });
  }
  if (a.shippingPaise > 0 || (a.delivery && !a.delivery.inStore))
    lines.push({ kind: 'delivery', label: a.delivery ? `${a.delivery.pickup ? 'Store pickup' : 'Delivery'}: ${a.delivery.label}` : 'Delivery', amountPaise: a.shippingPaise, effect: 1 });
  if (a.codFeePaise > 0) lines.push({ kind: 'cod_fee', label: 'Cash on delivery fee', amountPaise: a.codFeePaise, effect: 1 });
  if (a.tax.configured || a.taxPaise > 0) {
    const effect = a.pricesIncludeTax ? 0 : 1, inc = a.pricesIncludeTax ? ' (included in the prices)' : '', s = a.tax.split;
    if (s?.type === 'intra') lines.push({ kind: 'tax', label: `CGST${inc}`, amountPaise: s.cgst ?? 0, effect }, { kind: 'tax', label: `SGST${inc}`, amountPaise: s.sgst ?? 0, effect });
    else if (s?.type === 'inter') lines.push({ kind: 'tax', label: `IGST${inc}`, amountPaise: s.igst ?? 0, effect });
    else lines.push({ kind: 'tax', label: `${a.tax.label ?? 'Tax'}${inc}`, amountPaise: a.taxPaise, effect });
  }
  lines.push({ kind: 'total', label: 'Total payable', amountPaise: a.totalPaise, effect: 0 });
  const loyalty = named.find(d => d.code === 'LOYALTY');
  const coupon = named.find(d => kindOf(d.code) === 'coupon');
  return {
    lines, subtotalPaise: a.subtotalPaise, discountPaise: a.discountPaise, totalPaise: a.totalPaise, pricesIncludeTax: a.pricesIncludeTax,
    points: loyalty && a.pointsUsed > 0 ? { used: a.pointsUsed, valuePaise: loyalty.amountPaise } : null,
    coupon: coupon?.code ?? null,
    consistent: a.subtotalPaise - a.discountPaise + a.shippingPaise + a.codFeePaise + (a.pricesIncludeTax ? 0 : a.taxPaise) === a.totalPaise,
  };
}

const deliveryOf = (s: { label?: string; method?: string; configured?: boolean; pickup?: boolean } | null | undefined) =>
  (s && s.configured && s.label ? { label: s.label, pickup: !!s.pickup, inStore: s.method === 'in_store' } : null);

/** The bill of a cart or counter sale being priced now (the totals priceOrder returned). */
export function billFromTotals(t: CartTotals): Bill {
  return buildBill({
    subtotalPaise: t.subtotalPaise, discountPaise: t.discountPaise, shippingPaise: t.shippingPaise, taxPaise: t.taxPaise, totalPaise: t.totalPaise,
    pricesIncludeTax: t.pricesIncludeTax, codFeePaise: t.codFeePaise, discounts: t.discounts,
    tax: { label: t.tax.configured ? t.tax.label : null, configured: t.tax.configured }, delivery: deliveryOf(t.shipping),
    pointsUsed: t.payment?.loyalty?.usedPoints ?? 0,
  });
}

/** The amounts an order (or its invoice) stored, as rows come from the database. */
export interface StoredBill {
  subtotal_paise: number; discount_paise: number; shipping_paise: number; tax_paise: number; total_paise: number; prices_include_tax: boolean;
  cod_fee_paise?: number | null; loyalty_points_used?: number | null; pricing?: unknown;
}

/** The bill of an order that exists, from what it stored. `taxSplit` (an invoice's CGST / SGST / IGST) splits the tax line. */
export function billFromOrder(o: StoredBill, opts: { taxSplit?: { type?: string; cgst?: number; sgst?: number; igst?: number } | null } = {}): Bill {
  const p = (o.pricing ?? {}) as { discounts?: { code?: unknown; label?: unknown; amountPaise?: unknown }[]; tax?: { configured?: boolean; label?: string };
    shipping?: { label?: string; method?: string; configured?: boolean; pickup?: boolean } };
  const discounts = (Array.isArray(p.discounts) ? p.discounts : []).flatMap(d => (typeof d?.code === 'string' && typeof d.label === 'string' && Number.isInteger(d.amountPaise)
    ? [{ code: d.code, label: d.label, amountPaise: d.amountPaise as number }] : []));
  // An invoice has no COD-fee column of its own: its total is the order's, so the fee is what the other amounts leave over.
  const codFee = o.cod_fee_paise ?? Math.max(0, o.total_paise - (o.subtotal_paise - o.discount_paise + o.shipping_paise + (o.prices_include_tax ? 0 : o.tax_paise)));
  return buildBill({
    subtotalPaise: o.subtotal_paise, discountPaise: o.discount_paise, shippingPaise: o.shipping_paise, taxPaise: o.tax_paise, totalPaise: o.total_paise,
    pricesIncludeTax: o.prices_include_tax, codFeePaise: codFee, discounts,
    tax: { label: p.tax?.configured ? p.tax.label ?? null : null, configured: !!p.tax?.configured, split: opts.taxSplit ?? null }, delivery: deliveryOf(p.shipping),
    pointsUsed: o.loyalty_points_used ?? 0,
  });
}

/** How a bill is paid, in words (one wording for the receipt, the invoice and the invoice email). */
export const PAYMENT_METHOD_LABEL: Record<string, string> = { online: 'Online payment', cod: 'Cash on delivery', cash: 'Cash in store', card: 'Card in store', upi: 'UPI in store' };
export const paymentMethodLabel = (m: string | null | undefined) => (m ? PAYMENT_METHOD_LABEL[m] ?? m : 'Online payment');
