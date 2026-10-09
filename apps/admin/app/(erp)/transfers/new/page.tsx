import type { Metadata } from 'next';
import { can } from '@kitsyuu/auth';
import { getLocationStock, listLocations } from '@kitsyuu/core';
import { ActionForm, Field, Hidden } from '@/components/forms';
import { Empty, Forbidden, PageHead, SectionTitle } from '@/components/ui';
import { db, requireActor } from '@/lib/server';
import { createTransferAction } from '../actions';

export const metadata: Metadata = { title: 'New transfer' };
type Search = Promise<{ from?: string; to?: string; q?: string }>;

/* Step 1 (a GET form): choose the two locations and, optionally, search. Step 2: a quantity for each size to send,
   from what the sending location holds. */
export default async function NewTransferPage({ searchParams }: { searchParams: Search }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/transfers', label: 'Transfers' }];
  if (!can(actor, 'inventory.transfer')) return <><PageHead section="Catalogue" title="New transfer" crumbs={crumbs} /><Forbidden permission="inventory.transfer" /></>;
  const sp = await searchParams, q = (sp.q ?? '').trim().slice(0, 80);
  const locations = await listLocations(db(), actor, { activeOnly: true });
  const from = locations.find(l => l.id === sp.from), to = locations.find(l => l.id === sp.to);
  const ready = from && to && from.id !== to.id;
  const stock = ready ? await getLocationStock(db(), actor, { locationId: from.id, q: q || undefined, inStockOnly: true }) : null;
  // 2026-10-09: inside the module's frame (the form, its two steps and its action are unchanged).
  return (
    <div className="ord ws" data-workspace="new-transfer">
      <PageHead section="Catalogue" title="New transfer" crumbs={crumbs} eyebrow="Choose where the stock goes from and to, then the quantities. Saving makes a draft; nothing moves until it is sent." />
      {locations.length < 2 ? <Empty title="Two active locations are needed">Add another location under Locations first.</Empty> : (
        <form className="toolbar" method="get" aria-label="Choose locations" data-transfer-locations>
          <label className="field-inline">From <select className="input" name="from" defaultValue={from?.id ?? ''} required>
            <option value="">Choose…</option>{locations.map(l => <option key={l.id} value={l.id}>{l.name} ({l.units})</option>)}</select></label>
          <label className="field-inline">To <select className="input" name="to" defaultValue={to?.id ?? ''} required>
            <option value="">Choose…</option>{locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
          <input className="input" name="q" defaultValue={q} placeholder="Product name or SKU (optional)" aria-label="Product name or SKU" />
          <button className="btn ghost" type="submit">Show stock</button>
        </form>
      )}
      {from && to && from.id === to.id && <p className="msg error" role="alert">Choose two different locations.</p>}
      {ready && stock && (
        <section className="card" aria-labelledby="tl-h" data-section="transfer-lines">
          <SectionTitle id="tl-h">{`From ${from.name} to ${to.name}`}</SectionTitle>
          {stock.rows.length === 0 ? <Empty compact title={q ? 'Nothing matches' : `No stock at ${from.name}`} /> : (
            <ActionForm action={createTransferAction} submitLabel="Save as draft" id="new-transfer-form" label="New transfer">
              <Hidden name="fromLocationId" value={from.id} />
              <Hidden name="toLocationId" value={to.id} />
              <div className="table-wrap"><table data-transfer-pick>
                <thead><tr><th>Piece</th><th>SKU</th><th className="num">At {from.name}</th><th className="num">Send</th></tr></thead>
                <tbody>{stock.rows.map(r => (
                  <tr key={r.variant_id} data-sku={r.sku}>
                    <td>{r.label}</td>
                    <td className="mono">{r.sku}</td>
                    <td className="num">{r.qty}</td>
                    <td className="num"><input className="input qty-input" name={`qty:${r.variant_id}`} inputMode="numeric" aria-label={`Send ${r.sku}`} /></td>
                  </tr>
                ))}</tbody>
              </table></div>
              <Field name="note" label="Note (optional)" hint="e.g. Weekend restock" />
              <p className="note">Saving makes a draft; nothing moves until the transfer is sent.</p>
            </ActionForm>
          )}
        </section>
      )}
    </div>
  );
}
