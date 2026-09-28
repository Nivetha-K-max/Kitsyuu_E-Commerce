/* M10: delivery charge chosen by the business in admin Settings (shipping.method / shipping.flat_rate_paise /
   shipping.free_from_paise). It plugs into the existing ShippingProvider adapter (pricing.ts, M7); checkout and pricing
   are unchanged. Until a method is chosen, or when the flat rate is missing, it behaves exactly like the unconfigured
   provider: nothing is charged and the quote says "Not set up yet". Carrier rate tables can replace it later. */
import type { Queryable } from '@kitsyuu/db';
import { unconfiguredShipping, type ShippingProvider, type ShippingQuote } from './pricing.ts';

export const SHIPPING_KEYS = ['shipping.method', 'shipping.flat_rate_paise', 'shipping.free_from_paise'] as const;

export type ShippingSettings = { method: string; flatRatePaise: number | null; freeFromPaise: number | null };

export async function readShippingSettings(q: Queryable): Promise<ShippingSettings> {
  const rows = await q.selectFrom('settings').select(['key', 'value']).where('key', 'in', [...SHIPPING_KEYS]).execute();
  const v = new Map(rows.map(r => [r.key, r.value]));
  const money = (x: unknown) => (Number.isInteger(x) && (x as number) >= 0 ? (x as number) : null);
  return { method: typeof v.get('shipping.method') === 'string' ? (v.get('shipping.method') as string) : 'none',
    flatRatePaise: money(v.get('shipping.flat_rate_paise')), freeFromPaise: money(v.get('shipping.free_from_paise')) };
}

/** The quote for a subtotal under the given settings (pure; shared by the provider and the tests). */
export function quoteFromSettings(s: ShippingSettings, subtotalPaise: number): ShippingQuote | null {
  if (s.method !== 'flat' || s.flatRatePaise === null) return null;
  if (s.freeFromPaise !== null && subtotalPaise >= s.freeFromPaise) return { amountPaise: 0, method: 'flat', label: 'Free delivery', configured: true };
  return { amountPaise: s.flatRatePaise, method: 'flat', label: 'Delivery', configured: true };
}

/** A ShippingProvider that reads the current settings on every quote (so a change in the admin applies to the next quote). */
export function settingsShipping(getQueryable: () => Queryable): ShippingProvider {
  return {
    code: 'settings',
    async quote(input) {
      return quoteFromSettings(await readShippingSettings(getQueryable()), input.subtotalPaise) ?? unconfiguredShipping.quote(input);
    },
  };
}
