/* One collection (2026-10-08: on the shared entity frame, like a product or an order).

     header (name, store visibility, link, group, how many products; the one main action: show in / hide from the store)
     tabs   Products · Details

   Products is the collection's membership in store order: add, remove and reorder with the existing actions. A product
   opens on its own page (Merchandising), where its other collections and its category are. Details is the name, group
   and search-engine text. The rules are core's and unchanged (a collection needs a published product to be shown). */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError } from '@kitsyuu/contracts';
import { getCollection, listCollectionGroups } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, Select, TextArea } from '@/components/forms';
import { Entity, Facts, Section, StateBlock } from '@/components/frame';
import { NavLink } from '@/components/NavFrame';
import { ProductStatusPill } from '@/components/StatusPill';
import { Forbidden, PageHead } from '@/components/ui';
import { formatNumber } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { addCollectionMemberAction, moveCollectionMemberAction, removeCollectionMemberAction, setCollectionActiveAction, updateCollectionAction } from '../actions';

export const metadata: Metadata = { title: 'Collection' };
type Params = Promise<{ id: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;
const TABS = [['products', 'Products'], ['details', 'Details']] as const;
type Tab = (typeof TABS)[number][0];

export default async function CollectionPage({ params, searchParams }: { params: Params; searchParams: SP }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/collections', label: 'Collections' }];
  if (!can(actor, 'categories.read')) return <><PageHead section="Catalogue" title="Collection" crumbs={crumbs} /><Forbidden permission="categories.read" /></>;
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) notFound();
  const { collection: c, members, candidates } = await getCollection(db(), actor, id).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const write = can(actor, 'categories.write'), seeProducts = can(actor, 'products.read');
  const groups = await listCollectionGroups(db(), actor);
  const tab: Tab = TABS.find(t => t[0] === sp.tab)?.[0] ?? 'products';
  const self = `/collections/${c.id}`;
  const href = (t: string) => (t === 'products' ? self : `${self}?tab=${t}`);
  const published = members.filter(m => m.status === 'active').length;
  const group = groups.find(g => g.id === c.groupId)?.label ?? 'Other';

  return (
    <Entity module={{ href: '/collections', label: 'Collections' }} name="collection" title={c.label}
      status={<span className={`badge ${c.isActive ? 'active' : 'disabled'}`} data-collection-status>{c.isActive ? 'In store' : 'Hidden'}</span>}
      factsAttr="data-collection-facts"
      facts={[
        { label: 'Store link', value: <span className="mono">/shop?collection={c.id}</span> },
        { label: 'Group', value: group },
        { label: 'Products', value: <>{formatNumber(members.length)}<span className="note"> · {formatNumber(published)} published</span></>, attr: 'products' },
      ]}
      actions={<div className="ord-head-actions" data-collection-actions={c.isActive ? 'shown' : 'hidden'}>
        {seeProducts && members.length > 0 && <Link className="btn ghost sm" href={`/products?collection=${encodeURIComponent(c.id)}`} data-view-products>View in Products</Link>}
        {write && (
          <ActionForm action={setCollectionActiveAction} submitLabel={c.isActive ? 'Hide from store' : 'Show in store'} variant={c.isActive ? 'ghost' : undefined} className="inline-form ent-quick"
            id="collection-active-form" label="Store visibility" confirmText={c.isActive ? `Hide ${c.label} from the store?` : undefined}>
            <Hidden name="collectionId" value={c.id} /><Hidden name="active" value={c.isActive ? 'false' : 'true'} /><Hidden name="expectedActive" value={c.isActive ? 'true' : 'false'} />
          </ActionForm>
        )}
      </div>}
      tabs={TABS.map(([tid, label]) => ({ id: tid, label, count: tid === 'products' ? members.length : undefined }))} current={tab} tabHref={href}
      notice={sp.notice === 'created' ? <p className="msg ok" role="status" data-notice="created">Collection created (hidden). Add products, then show it in the store.</p> : undefined}>

      {tab === 'products' && <>
        <Section id="m-h" title="Products, in store order" name="members" wide meta={members.length ? `${members.length}` : undefined}
          hint={c.isActive ? 'Shown in the store menu and at its link, in this order.' : 'Hidden from the store. It needs at least one published product to be shown.'}>
          {members.length === 0 ? <StateBlock title="No products yet" name="members">{write ? 'Add the first product below. A product can also be put in collections on its own page.' : 'This collection has no products.'}</StateBlock> : (
            <div className="table-wrap"><table data-members-table>
              <thead><tr><th>Product</th><th>Status</th>{write && <th>Actions</th>}</tr></thead>
              <tbody>{members.map((m, i) => (
                <tr key={m.id} data-member={m.sku}>
                  <td>{seeProducts ? <NavLink className="row-link" href={`/products/${m.id}?tab=merchandising`}>{m.name}</NavLink> : m.name}<div className="note mono">{m.sku}</div></td>
                  <td><ProductStatusPill status={m.status} /></td>
                  {write && <td><div className="actions row-actions">
                    {i > 0 && <ActionForm action={moveCollectionMemberAction} submitLabel="↑" variant="ghost" className="inline-form" id={`mem-up-${m.id}`} label={`Move ${m.name} up`}>
                      <Hidden name="collectionId" value={c.id} /><Hidden name="productId" value={m.id} /><Hidden name="direction" value="up" /></ActionForm>}
                    {i < members.length - 1 && <ActionForm action={moveCollectionMemberAction} submitLabel="↓" variant="ghost" className="inline-form" id={`mem-down-${m.id}`} label={`Move ${m.name} down`}>
                      <Hidden name="collectionId" value={c.id} /><Hidden name="productId" value={m.id} /><Hidden name="direction" value="down" /></ActionForm>}
                    <ActionForm action={removeCollectionMemberAction} submitLabel="Remove" variant="danger" className="inline-form" id={`mem-rm-${m.id}`} label={`Remove ${m.name}`}>
                      <Hidden name="collectionId" value={c.id} /><Hidden name="productId" value={m.id} /></ActionForm>
                  </div></td>}
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Section>
        {write ? (
          <Section id="add-h" title="Add a product" name="add-member" hint="Any product that is not archived. A draft can be added before it is published; only published products show in the store.">
            {candidates.length > 0 ? (
              <ActionForm action={addCollectionMemberAction} submitLabel="Add product" className="form compact" id="add-member-form" label="Add a product" resetOnSuccess>
                <Hidden name="collectionId" value={c.id} />
                <Select name="productId" label="Product" options={candidates.map(p => ({ value: p.id, label: `${p.sku} · ${p.name}${p.status !== 'active' ? ` (${p.status === 'review' ? 'pending approval' : p.status})` : ''}` }))} />
              </ActionForm>
            ) : <p className="note">Every product that can be added is already in this collection.</p>}
          </Section>
        ) : <p className="note" data-readonly="collection">Changing a collection needs the categories.write permission.</p>}
      </>}

      {tab === 'details' && (write ? (
        <Section id="n-h" title="Collection details" name="name" hint="The link is fixed once created. The search-engine text is optional.">
          <ActionForm action={updateCollectionAction} submitLabel="Save" id="collection-name-form" label="Collection details">
            <Hidden name="collectionId" value={c.id} /><Hidden name="expectedLabel" value={c.label} />
            <Field name="label" label="Name" defaultValue={c.label} required />
            <Select name="groupId" label="Group" defaultValue={c.groupId ?? ''} options={[{ value: '', label: 'No group (Other)' }, ...groups.map(g => ({ value: g.id, label: g.label }))]} />
            <Field name="seoTitle" label="Search-engine title (optional)" defaultValue={c.seoTitle ?? ''} hint="Up to 70 characters. Empty: the collection name." />
            <TextArea name="seoDescription" label="Search-engine description (optional)" defaultValue={c.seoDescription ?? ''} rows={3} hint="Up to 160 characters. Empty: the store's default text." />
          </ActionForm>
        </Section>
      ) : (
        <Section id="n-h" title="Collection details" name="name">
          <Facts items={[{ label: 'Name', value: c.label }, { label: 'Group', value: group }, { label: 'Store link', value: <span className="mono">/shop?collection={c.id}</span> },
            { label: 'Search-engine title', value: c.seoTitle ?? '—' }, { label: 'Search-engine description', value: c.seoDescription ?? '—' }]} />
          <p className="note" data-readonly="collection">Changing a collection needs the categories.write permission.</p>
        </Section>
      ))}
    </Entity>
  );
}
