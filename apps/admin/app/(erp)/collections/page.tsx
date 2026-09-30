import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listCollectionGroups, listCollections } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, Select } from '@/components/forms';
import { Forbidden, PageHead } from '@/components/ui';
import { db, requireActor } from '@/lib/server';
import { createCollectionAction, createCollectionGroupAction, moveCollectionAction } from './actions';

export const metadata: Metadata = { title: 'Collections' };
type SP = Promise<Record<string, string | string[] | undefined>>;

/* M11 + client change request: curated product lists, grouped for staff as Men, Women and Sale (more groups can be
   added). A collection is not a category: a product keeps its category and can be in several collections. Active
   collections appear in the store menu in this order and at /shop?collection=… ; new ones start hidden so they can be
   filled first. The Sale collection is chosen by staff; it is not the sale price (Pricing). */
export default async function CollectionsPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'categories.read')) return <><PageHead section="Catalogue" title="Collections" /><Forbidden permission="categories.read" /></>;
  const [list, groups] = await Promise.all([listCollections(db(), actor), listCollectionGroups(db(), actor)]);
  const write = can(actor, 'categories.write');
  const sp = await searchParams;
  const want = typeof sp.group === 'string' ? sp.group : 'all';
  const tabs = [...groups.map(g => ({ id: g.id, label: g.label })), { id: 'other', label: 'Other' }];
  const current = tabs.some(t => t.id === want) ? want : 'all';
  const inTab = (id: string) => list.filter(c => (id === 'other' ? !c.groupId || !groups.some(g => g.id === c.groupId) : c.groupId === id));
  const shown = current === 'all' ? tabs : tabs.filter(t => t.id === current);
  const order = new Map(list.map((c, i) => [c.id, i]));

  return (
    <>
      <PageHead section="Catalogue" title="Collections" eyebrow={`${list.length} collection${list.length === 1 ? '' : 's'} · ${list.filter(c => c.isActive).length} in the store menu`} />
      <p className="note lead-note">Collections are the store&apos;s curated lists (Men, Women, Sale, New Arrivals…). They are separate from categories: a product keeps its
        category and can be in several collections. Active collections appear in the store menu. A new collection starts hidden: add its products, then show it.</p>
      <nav className="group-tabs" aria-label="Collection groups" data-group-tabs>
        <Link className="group-tab" href="/collections" aria-current={current === 'all' ? 'page' : undefined}>All <small>{list.length}</small></Link>
        {tabs.map(t => <Link key={t.id} className="group-tab" href={`/collections?group=${t.id}`} aria-current={current === t.id ? 'page' : undefined} data-group-tab={t.id}>
          {t.label} <small>{inTab(t.id).length}</small></Link>)}
      </nav>
      {shown.map(t => {
        const cols = inTab(t.id);
        if (current === 'all' && t.id === 'other' && !cols.length) return null;
        return (
          <section key={t.id} className="card" aria-labelledby={`grp-${t.id}`} data-group={t.id}>
            <h2 id={`grp-${t.id}`}>{t.label}</h2>
            {!cols.length ? <p className="note">No collection in this group yet.{write ? ' Create one below.' : ''}</p> : (
              <div className="col-cards">{cols.map(c => (
                <article key={c.id} className="card col-card" data-collection={c.id} data-active={c.isActive ? 'yes' : 'no'}>
                  <h3>{c.label} <span className={`badge ${c.isActive ? 'active' : 'disabled'}`}>{c.isActive ? 'In store' : 'Hidden'}</span></h3>
                  <dl data-collection-counts>
                    <dt>Products</dt><dd>{c.products}</dd>
                    <dt>Active</dt><dd>{c.activeProducts}</dd>
                    <dt>Draft</dt><dd>{c.draftProducts}</dd>
                  </dl>
                  <div className="actions row-actions">
                    <Link className="btn ghost sm" href={`/products?collection=${c.id}`} data-view-products>View products</Link>
                    <Link className="btn sm" href={`/collections/${c.id}`} data-edit-collection>Edit collection</Link>
                    {write && order.get(c.id)! > 0 && <ActionForm action={moveCollectionAction} submitLabel="↑" variant="ghost" className="inline-form" id={`col-up-${c.id}`} label={`Move ${c.label} earlier in the store menu`}>
                      <Hidden name="collectionId" value={c.id} /><Hidden name="direction" value="up" /></ActionForm>}
                    {write && order.get(c.id)! < list.length - 1 && <ActionForm action={moveCollectionAction} submitLabel="↓" variant="ghost" className="inline-form" id={`col-down-${c.id}`} label={`Move ${c.label} later in the store menu`}>
                      <Hidden name="collectionId" value={c.id} /><Hidden name="direction" value="down" /></ActionForm>}
                  </div>
                </article>
              ))}</div>
            )}
          </section>
        );
      })}
      {write && (
        <div className="grid two">
          <section className="card form-panel" data-section="new-collection" aria-labelledby="nc-h">
            <h2 id="nc-h">New collection</h2>
            <ActionForm action={createCollectionAction} submitLabel="Create collection" id="create-collection-form" label="Create collection">
              <Field name="label" label="Collection name" autoComplete="off" required hint="e.g. Monsoon Edit" />
              <Select name="groupId" label="Group" defaultValue={current !== 'all' && current !== 'other' ? current : ''}
                options={[{ value: '', label: 'No group (Other)' }, ...groups.map(g => ({ value: g.id, label: g.label }))]} />
              <details className="advanced"><summary className="note">Link (optional)</summary>
                <Field name="id" label="Link id" autoComplete="off" hint="Made from the name when empty, e.g. monsoon-edit → /shop?collection=monsoon-edit. Cannot be changed later." />
              </details>
            </ActionForm>
          </section>
          <section className="card form-panel" data-section="new-group" aria-labelledby="ng-h">
            <h2 id="ng-h">New group</h2>
            <p className="note">Groups organise collections here (e.g. Kids). They do not change the store.</p>
            <ActionForm action={createCollectionGroupAction} submitLabel="Add group" id="create-group-form" label="Add a collection group" resetOnSuccess>
              <Field name="label" label="Group name" autoComplete="off" required />
            </ActionForm>
          </section>
        </div>
      )}
    </>
  );
}
