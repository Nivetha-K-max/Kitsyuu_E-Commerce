import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listPosSales, posContext } from '@kitsyuu/core';
import { ActionForm, Field, Select } from '@/components/forms';
import { Empty, Forbidden, PageHead } from '@/components/ui';
import { formatDateTime, formatPaise } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { openSessionAction } from './actions';
import PosCounter from './PosCounter';
import { Workspace } from '@/components/frame';

export const metadata: Metadata = { title: 'POS billing' };

export default async function PosPage() {
  const actor = await requireActor();
  if (!can(actor, 'pos.access')) return <><PageHead title="POS billing" /><Forbidden permission="pos.access" /></>;
  const c = await posContext(db(), actor);
  const nav = (
    <div className="pos-nav">
      <Link className="btn ghost" href="/pos/sessions">Sessions</Link>
      {c.can.reports && <Link className="btn ghost" href="/pos/report">POS report</Link>}
    </div>
  );
  if (!c.session) {
    const recent = await listPosSales(db(), actor, { limit: 10 });
    return (
      <Workspace name="pos" title="POS billing" summary="Counter sales at a branch" actions={<div className="ord-head-actions">{nav}</div>}>
        {!c.can.sell ? <p className="msg">You can see POS sales and bills; ringing up sales needs the “POS: sell” permission.</p>
          : c.locations.length === 0 ? <Empty title="No branch yet" action={<Link className="btn" href="/locations">Add a retail location</Link>}>POS sales are made at a retail branch (Locations).</Empty>
          : (
            <section className="card pos-open" aria-labelledby="open-h" data-pos-open>
              <h2 id="open-h">Open a cashier session</h2>
              <p className="note">Choose the store you are billing at and count the cash in the drawer. Stock is taken from this store only.</p>
              <ActionForm action={openSessionAction} submitLabel="Open session" id="pos-open-form">
                <Select name="locationId" label="Store / branch" options={c.locations.map(l => ({ value: l.id, label: `${l.name} (${l.code})` }))} />
                <Field name="openingCash" label="Opening cash in drawer (₹)" defaultValue="0" />
              </ActionForm>
            </section>
          )}
        {recent.length > 0 && (
          <section className="card" aria-labelledby="recent-h">
            <h2 id="recent-h">Recent POS sales</h2>
            <div className="table-wrap"><table>
              <thead><tr><th>Bill</th><th>Branch</th><th>When</th><th>Payment</th><th className="num">Total</th><th>Status</th></tr></thead>
              <tbody>{recent.map(s => (
                <tr key={s.id}><td><Link href={`/pos/sale/${s.id}`}>{s.pos_number}</Link></td><td>{s.location_name}</td><td>{formatDateTime(s.created_at as Date)}</td>
                  <td>{s.payment_method?.toUpperCase()}</td><td className="num">{formatPaise(s.total_paise)}</td><td>{s.status === 'cancelled' ? 'Voided' : 'Paid'}</td></tr>
              ))}</tbody>
            </table></div>
          </section>
        )}
      </Workspace>
    );
  }
  const s = c.session;
  return (
    <Workspace name="pos" title="POS billing" summary={`${s.location_name} · session ${s.number} · ${actor.email}`}
      actions={<div className="ord-head-actions">{nav}<Link className="btn ghost" href="/pos/sessions#close" data-pos-close-link>Close session</Link></div>}>
      <PosCounter session={{ id: s.id, number: s.number, location_id: s.location_id, location_name: s.location_name }} maxDiscountBp={c.maxDiscountBp} canDiscount={c.can.discount} />
    </Workspace>
  );
}
