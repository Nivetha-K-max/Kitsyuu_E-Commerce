import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError } from '@kitsyuu/contracts';
import { getCollection, listCollectionGroups } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, Select, TextArea } from '@/components/forms';
import { Forbidden, PageHead, SectionTitle, StatusBadge } from '@/components/ui';
import { db, requireActor } from '@/lib/server';
import { addCollectionMemberAction, moveCollectionMemberAction, removeCollectionMemberAction, setCollectionActiveAction, updateCollectionAction } from '../actions';

export const metadata: Metadata = { title: 'Collection' };
type Params = Promise<{ id: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function CollectionPage({ params, searchParams }: { params: Params; searchParams: SP }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/collections', label: 'Collections' }];
  if (!can(actor, 'categories.read')) return <><PageHead section="Catalogue" title="Collection" crumbs={crumbs} /><Forbidden permission="categories.read" /></>;
  const { id } = await params;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) notFound();
  const { collection: c, members, candidates } = await getCollection(db(), actor, id).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const write = can(actor, 'categories.write');
  const groups = await listCollectionGroups(db(), actor);
  const created = (await searchParams).notice === 'created';
  return (
    <>
      <PageHead section="Catalogue" title={c.label} crumbs={crumbs} eyebrow={`/shop?collection=${c.id} · ${members.length} product${members.length === 1 ? '' : 's'}`}>
        <span className={`badge ${c.isActive ? 'active' : 'disabled'}`} data-collection-status>{c.isActive ? 'In store' : 'Hidden'}</span>
      </PageHead>
      {created && <p className="msg ok" role="status" data-notice="created">Collection created (hidden). Add products, then show it in the store.</p>}
      <div className="grid two">
        <section className="card" aria-labelledby="m-h" data-section="members">
          <SectionTitle id="m-h">Products, in store order</SectionTitle>
          {members.length ? <div className="table-wrap"><table data-members-table>
            <thead><tr><th>Product</th><th>Status</th>{write && <th>Actions</th>}</tr></thead>
            <tbody>{members.map((m, i) => (
              <tr key={m.id} data-member={m.sku}>
                <td><Link href={`/products/${m.id}`}>{m.name}</Link><div className="note mono">{m.sku}</div></td>
                <td><StatusBadge status={m.status} /></td>
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
          </table></div> : <p className="note" data-empty="members">No products yet.</p>}
          {write && candidates.length > 0 && (
            <ActionForm action={addCollectionMemberAction} submitLabel="Add product" className="form compact" id="add-member-form" label="Add a product" resetOnSuccess>
              <Hidden name="collectionId" value={c.id} />
              <Select name="productId" label="Product" options={candidates.map(p => ({ value: p.id, label: `${p.sku} · ${p.name}${p.status !== 'active' ? ` (${p.status})` : ''}` }))} />
            </ActionForm>
          )}
        </section>
        {write && (
          <aside className="side-panels">
            <section className="card" aria-labelledby="s-h" data-section="visibility">
              <SectionTitle id="s-h">Store visibility</SectionTitle>
              <p className="note">{c.isActive ? 'Shown in the store menu and at its link.' : 'Hidden from the store. It needs at least one active product to be shown.'}</p>
              <ActionForm action={setCollectionActiveAction} submitLabel={c.isActive ? 'Hide from store' : 'Show in store'} variant={c.isActive ? 'danger' : undefined}
                id="collection-active-form" label="Store visibility" confirmText={c.isActive ? `Hide ${c.label} from the store?` : undefined}>
                <Hidden name="collectionId" value={c.id} /><Hidden name="active" value={c.isActive ? 'false' : 'true'} /><Hidden name="expectedActive" value={c.isActive ? 'true' : 'false'} />
              </ActionForm>
            </section>
            <section className="card" aria-labelledby="n-h" data-section="name">
              <SectionTitle id="n-h">Collection details</SectionTitle>
              <ActionForm action={updateCollectionAction} submitLabel="Save" id="collection-name-form" label="Collection details">
                <Hidden name="collectionId" value={c.id} /><Hidden name="expectedLabel" value={c.label} />
                <Field name="label" label="Name" defaultValue={c.label} required />
                <Select name="groupId" label="Group" defaultValue={c.groupId ?? ''} options={[{ value: '', label: 'No group (Other)' }, ...groups.map(g => ({ value: g.id, label: g.label }))]} />
                <p className="note">Link: <span className="mono">/shop?collection={c.id}</span> (fixed).</p>
                <Field name="seoTitle" label="Search-engine title (optional)" defaultValue={c.seoTitle ?? ''} hint="Up to 70 characters. Empty: the collection name." />
                <TextArea name="seoDescription" label="Search-engine description (optional)" defaultValue={c.seoDescription ?? ''} rows={3} hint="Up to 160 characters. Empty: the store's default text." />
              </ActionForm>
            </section>
          </aside>
        )}
      </div>
    </>
  );
}
