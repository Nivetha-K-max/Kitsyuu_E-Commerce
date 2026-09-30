/* M10: delivery charge chosen by the business in admin Settings (shipping.method / shipping.flat_rate_paise /
   shipping.free_from_paise). It plugs into the existing ShippingProvider adapter (pricing.ts, M7); checkout and pricing
   are unchanged. Until a method is chosen, or when the flat rate is missing, it behaves exactly like the unconfigured
   provider: nothing is charged and the quote says "Not set up yet". Carrier rate tables can replace it later. */
import type { Queryable } from '@kitsyuu/db';
import { unconfiguredShipping, type ShippingProvider, type ShippingQuote, type ShipTo } from './pricing.ts';

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
      const q = getQueryable();
      const s = await readShippingSettings(q);
      if (s.method === 'zones') return quoteFromZones(q, input.subtotalPaise, input.shipTo);
      return quoteFromSettings(s, input.subtotalPaise) ?? unconfiguredShipping.quote(input);
    },
  };
}

// ---------------------------------------------------------------- ERP module 2: zone-based rates
export type ZoneRate = {
  zoneId: string; zoneName: string; states: string[]; pinPrefixes: string[]; zoneSort: number;
  rateId: string; name: string; amountPaise: number; freeFromPaise: number | null; minOrderPaise: number | null; maxOrderPaise: number | null;
  estMin: number | null; estMax: number | null; rateSort: number;
};

/** The zone for an address: the longest matching PIN prefix wins; otherwise a zone listing the state. Pure. */
export function matchZone<T extends { zoneId: string; states: string[]; pinPrefixes: string[]; zoneSort: number }>(zones: T[], shipTo: ShipTo): T | null {
  const pin = (shipTo.pin ?? '').replace(/\s/g, '');
  let best: T | null = null, bestLen = 0;
  for (const z of zones) for (const p of z.pinPrefixes) if (pin.startsWith(p) && p.length > bestLen) { best = z; bestLen = p.length; }
  if (best) return best;
  const state = (shipTo.state ?? '').trim().toLowerCase();
  return [...zones].sort((a, b) => a.zoneSort - b.zoneSort).find(z => z.states.some(s => s.toLowerCase() === state)) ?? null;
}

/** The quote for an order under the zone rates (pure; shared by the provider, the admin rate checker and the tests). */
export function quoteFromZoneRates(rates: ZoneRate[], subtotalPaise: number, shipTo: ShipTo | null): ShippingQuote {
  if (!shipTo) return { amountPaise: 0, method: 'zones', label: 'Calculated at checkout', configured: true };
  const zones = [...new Map(rates.map(r => [r.zoneId, r])).values()];
  const zone = matchZone(zones, shipTo);
  const unavailable = 'We do not deliver to this address yet. Choose another address or contact us.';
  if (!zone) return { amountPaise: 0, method: 'zones', label: 'Not available', configured: true, unavailable };
  const eligible = rates.filter(r => r.zoneId === zone.zoneId)
    .filter(r => (r.minOrderPaise === null || subtotalPaise >= r.minOrderPaise) && (r.maxOrderPaise === null || subtotalPaise < r.maxOrderPaise))
    .sort((a, b) => a.rateSort - b.rateSort || a.amountPaise - b.amountPaise);
  if (!eligible.length) return { amountPaise: 0, method: 'zones', label: 'Not available', configured: true, unavailable: 'Delivery is not available for this order value to this address.' };
  const describe = (rate: ZoneRate) => {
    const estimate = rate.estMin !== null && rate.estMax !== null ? `${rate.estMin}–${rate.estMax} days` : rate.estMax !== null ? `up to ${rate.estMax} days` : null;
    const free = rate.freeFromPaise !== null && subtotalPaise >= rate.freeFromPaise;
    return { rateId: rate.rateId, label: free ? `Free delivery (${rate.name})` : rate.name, amountPaise: free ? 0 : rate.amountPaise, estimate };
  };
  const options = eligible.map(describe);
  // The customer's choice if it is one of the options for this address and order value; otherwise the first option.
  const chosen = options.find(o => o.rateId === shipTo.deliveryRateId) ?? options[0];
  return { amountPaise: chosen.amountPaise, method: 'zones', label: chosen.label, configured: true, estimate: chosen.estimate, options, rateId: chosen.rateId };
}

export async function activeZoneRates(q: Queryable): Promise<ZoneRate[]> {
  const rows = await q.selectFrom('shipping_rates as r').innerJoin('shipping_zones as z', 'z.id', 'r.zone_id')
    .select(['z.id as zone_id', 'z.name as zone_name', 'z.states', 'z.pin_prefixes', 'z.sort_order as zone_sort', 'r.id as rate_id', 'r.name', 'r.amount_paise',
      'r.free_from_paise', 'r.min_order_paise', 'r.max_order_paise', 'r.est_days_min', 'r.est_days_max', 'r.sort_order as rate_sort'])
    .where('z.is_active', '=', true).where('r.is_active', '=', true).execute();
  return rows.map(r => ({ zoneId: r.zone_id, zoneName: r.zone_name, states: r.states, pinPrefixes: r.pin_prefixes, zoneSort: r.zone_sort, rateId: r.rate_id,
    name: r.name, amountPaise: r.amount_paise, freeFromPaise: r.free_from_paise, minOrderPaise: r.min_order_paise, maxOrderPaise: r.max_order_paise,
    estMin: r.est_days_min, estMax: r.est_days_max, rateSort: r.rate_sort }));
}

export async function quoteFromZones(q: Queryable, subtotalPaise: number, shipTo: ShipTo | null): Promise<ShippingQuote> {
  const rates = await activeZoneRates(q);
  if (!rates.length) return unconfiguredShipping.quote({ lines: [], subtotalPaise, shipTo });
  return quoteFromZoneRates(rates, subtotalPaise, shipTo);
}
