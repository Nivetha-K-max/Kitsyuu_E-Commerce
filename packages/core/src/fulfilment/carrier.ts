/* Carriers (couriers) that deliver orders (M8). Only the manual courier exists: staff hand the parcel to a courier of their
   choice and may type the tracking number in. A real carrier (an API that books pickups or reports tracking) plugs in here
   as another CarrierProvider; nothing else in fulfilment names a specific carrier. */
export interface CarrierProvider {
  /** Stored in shipments.carrier_code. */
  readonly code: string;
  /** Shown to staff. */
  readonly label: string;
  /** A public tracking page for a tracking number, when the carrier has one. */
  trackingUrl(trackingNumber: string): string | null;
}

export const manualCarrier: CarrierProvider = { code: 'manual', label: 'Manual courier', trackingUrl: () => null };

const CARRIERS: Record<string, CarrierProvider> = { [manualCarrier.code]: manualCarrier };

export const carrierFor = (code: string): CarrierProvider | null => CARRIERS[code] ?? null;
export const availableCarriers = (): CarrierProvider[] => Object.values(CARRIERS);
