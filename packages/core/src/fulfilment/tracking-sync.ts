/* Automatic tracking updates (2026-10-01). For every shipment on its way (shipped / in transit) whose courier has a
   tracking API (CarrierProvider.track), asks the courier for the latest status and records it as a courier event on the
   shipment (shipments.status and the event list the customer sees). No courier is connected yet: with only the manual
   courier and template couriers, this checks nothing and changes nothing. Marking the ORDER delivered stays a staff step
   (it follows the order workflow); a "delivered" report is shown to staff on the shipment. Run by the admin job
   /api/jobs/sync-tracking (secret). */
import { sql, type Db } from '@kitsyuu/db';
import type { CarrierProvider } from './carrier.ts';

export type TrackingSyncRun = { providers: number; checked: number; updated: number; failed: number };

export async function syncShipmentTracking(db: Db, providers: CarrierProvider[], opts: { limit?: number } = {}): Promise<TrackingSyncRun> {
  const tracking = providers.filter(p => typeof p.track === 'function');
  if (!tracking.length) return { providers: 0, checked: 0, updated: 0, failed: 0 };
  const due = await db.selectFrom('shipments').select(['id', 'carrier_code', 'tracking_number', 'status'])
    .where('status', 'in', ['shipped', 'in_transit']).where('tracking_number', 'is not', null)
    .where('carrier_code', 'in', tracking.map(p => p.code)).orderBy('updated_at').limit(opts.limit ?? 100).execute();
  let updated = 0, failed = 0;
  for (const s of due) {
    const p = tracking.find(x => x.code === s.carrier_code)!;
    try {
      const u = await p.track!(s.tracking_number!);
      if (!u || u.status === s.status) continue;
      await db.transaction().execute(async tx => {
        await tx.updateTable('shipments').set({ status: u.status, updated_at: sql`now()`,
          ...(u.status === 'in_transit' ? { in_transit_at: u.at } : u.status === 'failed_delivery' ? { failed_at: u.at, failure_reason: u.note ?? null } : {}) })
          .where('id', '=', s.id).execute();
        await tx.insertInto('shipment_events').values({ shipment_id: s.id, status: u.status, note: u.note?.slice(0, 300) ?? null, source: 'courier' }).execute();
      });
      updated++;
    } catch (e) { failed++; console.error('[tracking-sync]', s.carrier_code, e); }
  }
  return { providers: tracking.length, checked: due.length, updated, failed };
}
