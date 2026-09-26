import type { Metadata } from 'next';
import { can } from '@kitsyuu/auth';
import { listCategoryTree } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, Select } from '@/components/forms';
import { Forbidden, PageHead } from '@/components/ui';
import { db, requireActor } from '@/lib/server';
import { createCategoryAction, moveCategoryAction, setCategoryActiveAction, updateCategoryAction } from './actions';

export const metadata: Metadata = { title: 'Categories' };
type Node = Awaited<ReturnType<typeof listCategoryTree>>[number];
type Leaf = Node['children'][number];

export default async function CategoriesPage() {
  const actor = await requireActor();
  if (!can(actor, 'categories.read')) return <><PageHead section="Catalogue" title="Categories" /><Forbidden permission="categories.read" /></>;
  const tree = await listCategoryTree(db(), actor);
  const write = can(actor, 'categories.write');

  const row = (c: Node | Leaf, i: number, siblings: number, child: boolean) => (
    <tr key={c.id} className={child ? 'cat-child' : 'cat-parent'} data-category-row={c.id} data-active={c.is_active ? 'yes' : 'no'}>
      <td className="cat-name">
        <span className="cat-label">{c.label}</span>
        {!child && 'children' in c && <span className="cat-count">{c.children.length} subcategor{c.children.length === 1 ? 'y' : 'ies'}</span>}
        <div className="note mono">{c.id}</div>{c.description && <div className="note">{c.description}</div>}
      </td>
      <td className="num">{c.active_products}<div className="note">{c.products} total</div></td>
      <td><span className={`badge ${c.is_active ? 'active' : 'disabled'}`}>{c.is_active ? 'Active' : 'Inactive'}</span></td>
      {write && (
        <td>
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
            {i > 0 && <ActionForm action={moveCategoryAction} submitLabel="↑" variant="ghost" className="inline-form" id={`cat-up-${c.id}`} label={`Move ${c.label} up`}>
              <Hidden name="categoryId" value={c.id} /><Hidden name="direction" value="up" /></ActionForm>}
            {i < siblings - 1 && <ActionForm action={moveCategoryAction} submitLabel="↓" variant="ghost" className="inline-form" id={`cat-down-${c.id}`} label={`Move ${c.label} down`}>
              <Hidden name="categoryId" value={c.id} /><Hidden name="direction" value="down" /></ActionForm>}
          </div>
        </td>
      )}
    </tr>
  );

  return (
    <>
      <PageHead section="Catalogue" title="Categories" eyebrow={`${tree.length} top-level · ${tree.reduce((n, p) => n + p.children.length, 0)} subcategories`} />
      <p className="note lead-note">Category ids are fixed once created (the store uses them in links). Inactive categories are hidden from the store;
        a category cannot be deactivated while active products use it.</p>
      <div className="table-wrap"><table className="cat-tree" data-categories-table>
        <thead><tr><th>Category</th><th className="num">Active products</th><th>Status</th>{write && <th>Actions</th>}</tr></thead>
        <tbody>{tree.flatMap((p, i) => [row(p, i, tree.length, false), ...p.children.map((c, j) => row(c, j, p.children.length, true))])}</tbody>
      </table></div>
      {write ? (
        <section className="card form-panel" data-section="new-category" aria-labelledby="nc-h">
          <h2 id="nc-h">New category</h2>
          <ActionForm action={createCategoryAction} submitLabel="Create category" id="create-category-form" label="Create category" resetOnSuccess>
            <Select name="parentId" label="Parent" options={[{ value: '', label: 'None (top-level)' }, ...tree.map(p => ({ value: p.id, label: p.label }))]} />
            <Field name="slug" label="Id part" autoComplete="off" required hint="e.g. jackets → the id becomes outerwear.jackets under Outerwear. Cannot be changed later." />
            <Field name="label" label="Name" autoComplete="off" required />
            <Field name="description" label="Description (optional)" autoComplete="off" />
          </ActionForm>
        </section>
      ) : <p className="note section-foot" data-readonly="categories">Changing categories needs the categories.write permission.</p>}
    </>
  );
}
