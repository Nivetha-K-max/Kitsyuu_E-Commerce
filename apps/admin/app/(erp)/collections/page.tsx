/* Catalogue setup → Collections (2026-10-08: on the shared workspace frame; a list, not a wall of cards).
   M11 + client change request: curated product lists, grouped for staff as Men, Women and Sale (more groups can be
   added). A collection is not a category: a product keeps its category and can be in several collections. Active
   collections appear in the store menu in this order and at /shop?collection=… ; new ones start hidden so they can be
   filled first. The Sale collection is chosen by staff; it is not the sale price (Pricing).
   A row opens the collection (its products in store order, visibility, details); the product count opens Products
   filtered by the collection. Nothing about how collections work has changed. */
import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listCollectionGroups, listCollections } from '@kitsyuu/core';
import ModuleViews from '@/components/ModuleViews';
import { ActionForm, Field, Hidden, Select } from '@/components/forms';
import { StateBlock, ViewTabs, Workspace } from '@/components/frame';
import { NavLink } from '@/components/NavFrame';
import { Drawer } from '@/components/overlays';
import { Forbidden, PageHead } from '@/components/ui';
import { formatNumber } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { createCollectionAction, createCollectionGroupAction, moveCollectionAction } from './actions';

export const metadata: Metadata = { title: 'Collections' };
type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function CollectionsPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'categories.read')) return <><PageHead section="Catalogue" title="Collections" /><Forbidden permission="categories.read" /></>;
  const [list, groups, sp] = await Promise.all([listCollections(db(), actor), listCollectionGroups(db(), actor), searchParams]);
  const write = can(actor, 'categories.write'), seeProducts = can(actor, 'products.read');
  const want = typeof sp.group === 'string' ? sp.group : 'all';
  const tabs = [...groups.map(g => ({ id: g.id, label: g.label })), { id: 'other', label: 'Other' }];
  const current = tabs.some(t => t.id === want) ? want : 'all';
  const inTab = (id: string) => list.filter(c => (id === 'other' ? !c.groupId || !groups.some(g => g.id === c.groupId) : c.groupId === id));
  // "Other" is offered only when a collection has no group; one group at a time, or every group under its name.
  const offered = tabs.filter(t => t.id !== 'other' || inTab('other').length > 0 || current === 'other');
  const shown = current === 'all' ? offered : tabs.filter(t => t.id === current);
  const order = new Map(list.map((c, i) => [c.id, i]));
  const views = [{ id: 'all', label: 'All collections', href: '/collections', count: list.length }, ...offered.map(t => ({ id: t.id, label: t.label, href: `/collections?group=${t.id}`, count: inTab(t.id).length }))];
  const cols = write ? 4 : 3;

  return (
    <Workspace name="collections" title="Collections"
      summary={`${list.length} collection${list.length === 1 ? '' : 's'} · ${list.filter(c => c.isActive).length} in the store menu`}
      actions={write ? <>
        <Drawer trigger="New group" triggerClass="btn ghost" name="new-group" scope="ord" title="New group" description="Groups organise collections here (e.g. Kids). They do not change the store.">
          <ActionForm action={createCollectionGroupAction} submitLabel="Add group" id="create-group-form" label="Add a collection group" resetOnSuccess>
            <Field name="label" label="Group name" autoComplete="off" required />
          </ActionForm>
        </Drawer>
        <Drawer trigger="New collection" name="new-collection" scope="ord" title="New collection" description="A new collection starts hidden: add its products, then show it in the store.">
          <ActionForm action={createCollectionAction} submitLabel="Create collection" id="create-collection-form" label="Create collection">
            <Field name="label" label="Collection name" autoComplete="off" required hint="e.g. Monsoon Edit" />
            <Select name="groupId" label="Group" defaultValue={current !== 'all' && current !== 'other' ? current : ''}
              options={[{ value: '', label: 'No group (Other)' }, ...groups.map(g => ({ value: g.id, label: g.label }))]} />
            <Field name="id" label="Link id (optional)" autoComplete="off" hint="Made from the name when empty, e.g. monsoon-edit → /shop?collection=monsoon-edit. Cannot be changed later." />
          </ActionForm>
        </Drawer>
      </> : undefined}>
      <ModuleViews module="catalogue" label="Catalogue setup" current="/collections" />
      <div data-group-tabs><ViewTabs label="Collection groups" items={views} current={current} /></div>
      {list.length === 0 ? (
        <StateBlock title="No collections yet" name="collections">{write ? 'Create a collection, add its products, then show it in the store.' : 'Collections appear here once they are created.'}</StateBlock>
      ) : (
        <div className="table-wrap ord-table" data-fresh key={current}><table data-collections-table>
          <thead><tr><th>Collection</th><th className="num">Products</th><th>Store</th>{write && <th>Store menu order</th>}</tr></thead>
          {shown.map(t => {
            const rows = inTab(t.id);
            return (
              <tbody key={t.id} data-group={t.id}>
                {current === 'all' && <tr className="group-row"><th colSpan={cols} scope="colgroup">{t.label}</th></tr>}
                {rows.length === 0 ? <tr><td colSpan={cols} className="note" data-empty="group">No collection in this group yet.</td></tr> : rows.map(c => (
                  <tr key={c.id} data-collection={c.id} data-active={c.isActive ? 'yes' : 'no'}>
                    <td className="ord-who"><NavLink className="row-link" href={`/collections/${c.id}`} data-edit-collection>{c.label}</NavLink><div className="ord-no">/shop?collection={c.id}</div></td>
                    <td className="num ord-extra" data-label="Products" data-collection-counts>
                      {seeProducts && c.products > 0 ? <Link href={`/products?collection=${encodeURIComponent(c.id)}`} data-view-products aria-label={`Products in ${c.label}`}>{formatNumber(c.products)}</Link> : formatNumber(c.products)}
                      <div className="note">{formatNumber(c.activeProducts)} published · {formatNumber(c.draftProducts)} draft</div>
                    </td>
                    <td className="ord-stage"><span className={`badge ${c.isActive ? 'active' : 'disabled'}`}>{c.isActive ? 'In store' : 'Hidden'}</span></td>
                    {write && <td className="ord-next"><div className="actions row-actions">
                      {order.get(c.id)! > 0 && <ActionForm action={moveCollectionAction} submitLabel="↑" variant="ghost" className="inline-form" id={`col-up-${c.id}`} label={`Move ${c.label} earlier in the store menu`}>
                        <Hidden name="collectionId" value={c.id} /><Hidden name="direction" value="up" /></ActionForm>}
                      {order.get(c.id)! < list.length - 1 && <ActionForm action={moveCollectionAction} submitLabel="↓" variant="ghost" className="inline-form" id={`col-down-${c.id}`} label={`Move ${c.label} later in the store menu`}>
                        <Hidden name="collectionId" value={c.id} /><Hidden name="direction" value="down" /></ActionForm>}
                    </div></td>}
                  </tr>
                ))}
              </tbody>
            );
          })}
        </table></div>
      )}
      <p className="note section-foot">{write
        ? 'Collections are separate from categories: a product keeps its category and can be in several collections. A product is added to a collection here (open the collection) or on its own page (Product → Merchandising).'
        : <span data-readonly="collections">Changing collections needs the categories.write permission.</span>}</p>
    </Workspace>
  );
}
