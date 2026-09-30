/* Carriers (couriers) that deliver orders (M8; ERP module 2). The built-in manual courier: staff hand the parcel to a
   courier of their choice and may type the tracking number in. Couriers the business adds under Shipping → Couriers
   (the couriers table) are resolved here too; a courier with a tracking-URL template ("https://…{tracking}…") gets a
   tracking link. A courier API that books pickups or reports tracking plugs in as another CarrierProvider; its keys come
   from the deployment environment, never from the database. Nothing else in fulfilment names a specific carrier. */
import type { Queryable } from '@kitsyuu/db';

export interface CarrierProvider {
  /** Stored in shipments.carrier_code. */
  readonly code: string;
  /** Shown to staff and customers. */
  readonly label: string;
  /** A public tracking page for a tracking number, when the carrier has one. */
  trackingUrl(trackingNumber: string): string | null;
}

export const manualCarrier: CarrierProvider = { code: 'manual', label: 'Manual courier', trackingUrl: () => null };

const CARRIERS: Record<string, CarrierProvider> = { [manualCarrier.code]: manualCarrier };

export const carrierFor = (code: string): CarrierProvider | null => CARRIERS[code] ?? null;
export const availableCarriers = (): CarrierProvider[] => Object.values(CARRIERS);

/** Fills a tracking-URL template with an (encoded) tracking number. */
export const trackingFromTemplate = (template: string | null, tracking: string) => (template ? template.replace('{tracking}', encodeURIComponent(tracking)) : null);

/** A courier by code: from the couriers table (active ones, unless includeInactive), else the built-in list. */
export async function resolveCarrier(q: Queryable, code: string, opts: { includeInactive?: boolean } = {}): Promise<CarrierProvider | null> {
  try {
    let query = q.selectFrom('couriers').select(['code', 'name', 'tracking_url_template']).where('code', '=', code);
    if (!opts.includeInactive) query = query.where('is_active', '=', true);
    const row = await query.executeTakeFirst();
    if (row) return { code: row.code, label: row.name, trackingUrl: t => trackingFromTemplate(row.tracking_url_template, t) };
    if (!opts.includeInactive && await q.selectFrom('couriers').select('code').where('code', '=', code).executeTakeFirst()) return null;   // switched off
  } catch { /* couriers table not readable by this role: fall back to the built-in list */ }
  return carrierFor(code);
}

/** Couriers staff can choose now (active rows; the built-in manual courier when the table has none). */
export async function listActiveCarriers(q: Queryable): Promise<CarrierProvider[]> {
  const rows = await q.selectFrom('couriers').select(['code', 'name', 'tracking_url_template']).where('is_active', '=', true).orderBy('name').execute();
  return rows.length ? rows.map(r => ({ code: r.code, label: r.name, trackingUrl: (t: string) => trackingFromTemplate(r.tracking_url_template, t) })) : availableCarriers();
}
