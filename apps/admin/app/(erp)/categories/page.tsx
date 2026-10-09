/* Catalogue setup → Categories (2026-10-08: on the shared workspace frame, like Products and Orders).
   The store's two-level menu. A row shows the category, how many products use it (the count opens Products filtered by
   that category: membership is looked at there, and changed on the product), whether the store shows it, and the
   existing actions. The rules are unchanged: ids are fixed once created; a category cannot be deactivated while
   published products use it; every change is checked and audited in core. */
import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listCategoryTree } from '@kitsyuu/core';
import FilterForm from '@/components/FilterForm';
import ModuleViews from '@/components/ModuleViews';
import { ActionForm, Field, Hidden, Select } from '@/components/forms';
import { StateBlock, Workspace } from '@/components/frame';
import { FilterLink } from '@/components/NavFrame';
import { Drawer } from '@/components/overlays';
import { Forbidden, PageHead } from '@/components/ui';
import { formatNumber } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { createCategoryAction, moveCategoryAction, setCategoryActiveAction, updateCategoryAction } from './actions';

export const metadata: Metadata = { title: 'Categories' };
type SP = Promise<Record<string, string | string[] | undefined>>;
type Node = Awaited<ReturnType<typeof listCategoryTree>>[number];
type Leaf = Node['children'][number];

export default async function CategoriesPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'categories.read')) return <><PageHead section="Catalogue" title="Categories" /><Forbidden permission="categories.read" /></>;
  const [tree, sp] = await Promise.all([listCategoryTree(db(), actor), searchParams]);
  const write = can(actor, 'categories.write'), seeProducts = can(actor, 'products.read');
  const q = (typeof sp.q === 'string' ? sp.q : '').trim().toLowerCase().slice(0, 60);
  const status = sp.status === 'active' || sp.status === 'inactive' ? sp.status : 'all';
  const filtered = !!q || status !== 'all';
  // Search matches a category's name or id; a parent stays listed when one of its subcategories matches.
  const hit = (c: Node | Leaf) => (!q || c.label.toLowerCase().includes(q) || c.id.includes(q)) && (status === 'all' || (status === 'active') === c.is_active);
  const shown = tree.map(p => ({ parent: p, self: hit(p), children: p.children.filter(hit) })).filter(x => x.self || x.children.length > 0);
  const subcategories = tree.reduce((n, p) => n + p.children.length, 0);
  const inactive = tree.reduce((n, p) => n + (p.is_active ? 0 : 1) + p.children.filter(c => !c.is_active).length, 0);

  const row = (c: Node | Leaf, i: number, siblings: number, child: boolean) => (
    <tr key={c.id} className={child ? 'cat-child' : 'cat-parent'} data-category-row={c.id} data-active={c.is_active ? 'yes' : 'no'}>
      <td className="cat-name ord-who">
        <span className="cat-label">{c.label}</span>
        {!child && 'children' in c && c.children.length > 0 && <span className="cat-count">{c.children.length} subcategor{c.children.length === 1 ? 'y' : 'ies'}</span>}
        <div className="ord-no">{c.id}</div>{c.description && <div className="note">{c.description}</div>}
      </td>
      <td className="num ord-extra" data-label="Published products" data-category-products>
        {seeProducts && c.products > 0
          ? <Link href={`/products?category=${encodeURIComponent(c.id)}`} data-link="category-products" aria-label={`Products in ${c.label}`}>{formatNumber(c.active_products)}</Link>
          : formatNumber(c.active_products)}
        <div className="note">{formatNumber(c.products)} in all</div>
      </td>
      <td className="ord-stage"><span className={`badge ${c.is_active ? 'active' : 'disabled'}`}>{c.is_active ? 'Active' : 'Inactive'}</span></td>
      {write && (
        <td className="ord-next">
          <div className="actions row-actions">
            <details className="row-edit">
              <summary className="btn ghost sm" aria-label={`Edit ${c.label}`}>Edit</summary>
              <ActionForm action={updateCategoryAction} submitLabel="Save changes" className="form compact row-edit-form" id={`cat-edit-${c.id}`} label={`Edit ${c.label}`}>
                <Hidden name="categoryId" value={c.id} /><Hidden name="expectedLabel" value={c.label} />
                <Field name="label" label="Name" defaultValue={c.label} required />
                <Field name="description" label="Description" defaultValue={c.description} />
              </ActionForm>
            </details>
            <ActionForm action={setCategoryActiveAction} submitLabel={c.is_active ? 'Deactivate' : 'Activate'} variant={c.is_active ? 'danger' : 'ghost'} className="inline-form"
              id={`cat-active-${c.id}`} label={`${c.is_active ? 'Deactivate' : 'Activate'} ${c.label}`}
              confirmText={c.is_active ? `Deactivate ${c.label}? It will be hidden from the store.` : undefined}>
              <Hidden name="categoryId" value={c.id} /><Hidden name="active" value={c.is_active ? 'false' : 'true'} /><Hidden name="expectedActive" value={c.is_active ? 'true' : 'false'} />
            </ActionForm>
            {/* The order is the store menu's order among siblings: shown only on the whole list, where "up" and "down" mean what they say. */}
            {!filtered && i > 0 && <ActionForm action={moveCategoryAction} submitLabel="↑" variant="ghost" className="inline-form" id={`cat-up-${c.id}`} label={`Move ${c.label} up`}>
              <Hidden name="categoryId" value={c.id} /><Hidden name="direction" value="up" /></ActionForm>}
            {!filtered && i < siblings - 1 && <ActionForm action={moveCategoryAction} submitLabel="↓" variant="ghost" className="inline-form" id={`cat-down-${c.id}`} label={`Move ${c.label} down`}>
              <Hidden name="categoryId" value={c.id} /><Hidden name="direction" value="down" /></ActionForm>}
          </div>
        </td>
      )}
    </tr>
  );

  return (
    <Workspace name="categories" title="Categories"
      summary={`${tree.length} top-level · ${subcategories} subcategor${subcategories === 1 ? 'y' : 'ies'}${inactive ? ` · ${inactive} inactive` : ''}`}
      actions={write ? (
        <Drawer trigger="New category" name="new-category" scope="ord" title="New category"
          description="The id is fixed once created (the store uses it in links). A new category is active unless its parent is inactive.">
          <ActionForm action={createCategoryAction} submitLabel="Create category" id="create-category-form" label="Create category" resetOnSuccess>
            <Select name="parentId" label="Parent" options={[{ value: '', label: 'None (top-level)' }, ...tree.map(p => ({ value: p.id, label: p.label }))]} />
            <Field name="slug" label="Id part" autoComplete="off" required hint="e.g. jackets → the id becomes outerwear.jackets under Outerwear. Cannot be changed later." />
            <Field name="label" label="Name" autoComplete="off" required />
            <Field name="description" label="Description (optional)" autoComplete="off" />
          </ActionForm>
        </Drawer>
      ) : undefined}>
      <ModuleViews module="catalogue" label="Catalogue setup" current="/categories" />
      <div className="ord-toolbar">
        <FilterForm debounce={200} role="search" aria-label="Filter categories" data-category-filters>
          <label className="sr-only" htmlFor="cat-q">Search categories</label>
          <input id="cat-q" name="q" className="input" placeholder="Search name or id" defaultValue={q} />
          <label className="sr-only" htmlFor="cat-s">Status</label>
          <select id="cat-s" name="status" className="input" defaultValue={status}><option value="all">Active and inactive</option><option value="active">Active</option><option value="inactive">Inactive</option></select>
          <button className="btn ghost sr-only" type="submit">Apply</button>
        </FilterForm>
        {filtered && <FilterLink className="btn link" group="clear" current={false} href="/categories" data-clear-filters>Clear</FilterLink>}
      </div>
      {shown.length === 0 ? (
        <StateBlock title={filtered ? 'No matching categories' : 'No categories yet'} name="categories"
          action={filtered ? <Link className="btn ghost sm" href="/categories">Clear filters</Link> : undefined}>
          {filtered ? 'Nothing matches this search or status.' : 'Create the first category to place products in the store menu.'}
        </StateBlock>
      ) : (
        <div className="table-wrap ord-table" data-fresh key={`${q}|${status}`}><table className="cat-tree" data-categories-table>
          <thead><tr><th>Category</th><th className="num">Published products</th><th>Status</th>{write && <th>Actions</th>}</tr></thead>
          <tbody>{shown.flatMap(({ parent: p, children }) => [row(p, tree.indexOf(p), tree.length, false), ...children.map(c => row(c, p.children.indexOf(c), p.children.length, true))])}</tbody>
        </table></div>
      )}
      <p className="note section-foot">{write
        ? 'A product is placed in a category on its own page (Product → Merchandising). Inactive categories are hidden from the store; a category cannot be deactivated while published products use it.'
        : <span data-readonly="categories">Changing categories needs the categories.write permission.</span>}</p>
    </Workspace>
  );
}
