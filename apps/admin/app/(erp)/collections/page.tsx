import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listCollections } from '@kitsyuu/core';
import { ActionForm, Field, Hidden } from '@/components/forms';
import { Forbidden, PageHead } from '@/components/ui';
import { db, requireActor } from '@/lib/server';
import { createCollectionAction, moveCollectionAction } from './actions';

export const metadata: Metadata = { title: 'Collections' };

/* M11: curated product lists (New Arrivals, seasonal edits…). Active collections appear in the store menu in this
   order; new ones start hidden so they can be filled first. */
export default async function CollectionsPage() {
  const actor = await requireActor();
  if (!can(actor, 'categories.read')) return <><PageHead section="Catalogue" title="Collections" /><Forbidden permission="categories.read" /></>;
  const list = await listCollections(db(), actor);
  const write = can(actor, 'categories.write');
  return (
    <>
      <PageHead section="Catalogue" title="Collections" eyebrow={`${list.length} collection${list.length === 1 ? '' : 's'} · ${list.filter(c => c.isActive).length} in the store menu`} />
      <p className="note lead-note">Active collections appear in the store menu, in this order, and at /shop?collection=… . A new collection starts hidden:
        add its products, then show it.</p>
      <div className="table-wrap"><table data-collections-table>
        <thead><tr><th>Collection</th><th className="num">Products</th><th>Status</th>{write && <th>Order</th>}</tr></thead>
        <tbody>{list.map((c, i) => (
          <tr key={c.id} data-collection={c.id} data-active={c.isActive ? 'yes' : 'no'}>
            <td><Link href={`/collections/${c.id}`}>{c.label}</Link><div className="note mono">{c.id}</div></td>
            <td className="num">{c.products}</td>
            <td><span className={`badge ${c.isActive ? 'active' : 'disabled'}`}>{c.isActive ? 'In store' : 'Hidden'}</span></td>
            {write && <td><div className="actions row-actions">
              {i > 0 && <ActionForm action={moveCollectionAction} submitLabel="↑" variant="ghost" className="inline-form" id={`col-up-${c.id}`} label={`Move ${c.label} up`}>
                <Hidden name="collectionId" value={c.id} /><Hidden name="direction" value="up" /></ActionForm>}
              {i < list.length - 1 && <ActionForm action={moveCollectionAction} submitLabel="↓" variant="ghost" className="inline-form" id={`col-down-${c.id}`} label={`Move ${c.label} down`}>
                <Hidden name="collectionId" value={c.id} /><Hidden name="direction" value="down" /></ActionForm>}
            </div></td>}
          </tr>
        ))}</tbody>
      </table></div>
      {write && (
        <section className="card form-panel" data-section="new-collection" aria-labelledby="nc-h">
          <h2 id="nc-h">New collection</h2>
          <ActionForm action={createCollectionAction} submitLabel="Create collection" id="create-collection-form" label="Create collection">
            <Field name="label" label="Name" autoComplete="off" required hint="e.g. Monsoon Edit" />
            <Field name="id" label="Link id" autoComplete="off" required hint="e.g. monsoon-edit → /shop?collection=monsoon-edit. Cannot be changed later." />
          </ActionForm>
        </section>
      )}
    </>
  );
}
