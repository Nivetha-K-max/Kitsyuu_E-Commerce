import type { Metadata } from 'next';
import { can } from '@kitsyuu/auth';
import { listAttributes, type AttributeRow } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, Select } from '@/components/forms';
import FilterForm from '@/components/FilterForm';
import { Empty, Forbidden, PageHead } from '@/components/ui';
import { db, requireActor } from '@/lib/server';
import {
  addAttributeValueAction, createAttributeAction, deleteAttributeValueAction, moveAttributeAction, moveAttributeValueAction,
  renameAttributeValueAction, setAttributeActiveAction, setAttributeValueActiveAction, updateAttributeAction
} from './actions';

export const metadata: Metadata = { title: 'Attributes' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const SELECTION = [{ value: 'multi', label: 'Several values per product (e.g. Colour)' }, { value: 'single', label: 'One value per product (e.g. Fit)' }];

/* Product attributes as tags (client change request). Each attribute (Colour, Fabric, Fit, Occasion…) shows its values
   as chips; "+ Add value" adds one, a chip opens to rename it, deactivate / reactivate it or move it. Values are never
   deleted once products use them: deactivated, they stay on those products but are no longer offered. Names are unique
   whatever the letter case. Nothing is pre-filled: the business adds the attributes and values it wants and tags products
   on each product's page (or many at once in Bulk edit). An active attribute becomes a filter in the store. */
export default async function AttributesPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'categories.read')) return <><PageHead section="Catalogue" title="Attributes" /><Forbidden permission="categories.read" /></>;
  const all = await listAttributes(db(), actor);
  const write = can(actor, 'categories.write');
  const sp = await searchParams;
  const q = (typeof sp.q === 'string' ? sp.q : '').trim().toLowerCase().slice(0, 60);
  const status = sp.status === 'active' || sp.status === 'inactive' ? sp.status : 'all';
  // Search matches an attribute's name or any of its values; the status filter applies to values.
  const list = all.map(a => {
    const nameHit = !q || a.label.toLowerCase().includes(q);
    const values = a.values.filter(v => (status === 'all' || (status === 'active') === v.isActive) && (nameHit || v.label.toLowerCase().includes(q)));
    return { ...a, values, hidden: !nameHit && !values.length };
  }).filter(a => !a.hidden);
  const filtered = !!q || status !== 'all';

  const card = (a: AttributeRow, i: number) => (
    <section key={a.id} className="card attr-card" data-attribute={a.id} data-active={a.isActive ? 'yes' : 'no'} aria-labelledby={`attr-${a.id}`}>
      <header className="attr-head">
        <div>
          <h2 id={`attr-${a.id}`}>{a.label} <span className={`badge ${a.isActive ? 'active' : 'disabled'}`}>{a.isActive ? 'Shown in store' : 'Hidden'}</span></h2>
          <div className="note">{a.selection === 'single' ? 'One value per product' : 'Several values per product'} · {a.products} product{a.products === 1 ? '' : 's'} tagged</div>
          {a.description && <p className="note">{a.description}</p>}
        </div>
        {write && (
          <div className="actions row-actions">
            <details className="row-edit">
              <summary className="btn ghost sm">Edit</summary>
              <ActionForm action={updateAttributeAction} submitLabel="Save changes" className="form compact row-edit-form" id={`attr-edit-${a.id}`} label={`Edit ${a.label}`}>
                <Hidden name="attributeId" value={a.id} /><Hidden name="expectedLabel" value={a.label} />
                <Field name="label" label="Name" defaultValue={a.label} required />
                <Select name="selection" label="Values per product" defaultValue={a.selection} options={SELECTION} />
                <Field name="description" label="Description (staff only)" defaultValue={a.description} />
              </ActionForm>
            </details>
            <ActionForm action={setAttributeActiveAction} submitLabel={a.isActive ? 'Hide from store' : 'Show in store'} variant={a.isActive ? 'danger' : 'ghost'}
              className="inline-form" id={`attr-active-${a.id}`} label={`${a.isActive ? 'Hide' : 'Show'} ${a.label}`}
              confirmText={a.isActive ? `Hide ${a.label} from the store? Its filter disappears; product tags are kept.` : undefined}>
              <Hidden name="attributeId" value={a.id} /><Hidden name="active" value={a.isActive ? 'false' : 'true'} /><Hidden name="expectedActive" value={a.isActive ? 'true' : 'false'} />
            </ActionForm>
            {!filtered && i > 0 && <ActionForm action={moveAttributeAction} submitLabel="↑" variant="ghost" className="inline-form" id={`attr-up-${a.id}`} label={`Move ${a.label} up`}>
              <Hidden name="attributeId" value={a.id} /><Hidden name="direction" value="up" /></ActionForm>}
            {!filtered && i < list.length - 1 && <ActionForm action={moveAttributeAction} submitLabel="↓" variant="ghost" className="inline-form" id={`attr-down-${a.id}`} label={`Move ${a.label} down`}>
              <Hidden name="attributeId" value={a.id} /><Hidden name="direction" value="down" /></ActionForm>}
          </div>
        )}
      </header>
      <div className="value-chips" data-values>
        {a.values.map((v, j) => (
          <details key={v.slug} className={`value-chip${v.isActive ? '' : ' is-inactive'}`} data-value={v.slug} data-value-active={v.isActive ? 'yes' : 'no'}>
            <summary>{v.swatch && <span className="tag-swatch" style={{ background: v.swatch }} aria-hidden="true" />}<span className="v-name">{v.label}</span>
              <small>{v.products}</small>{!v.isActive && <span className="sr-only"> (deactivated)</span>}</summary>
            {write ? (
              <div className="value-chip-panel">
                <ActionForm action={renameAttributeValueAction} submitLabel="Save" className="form compact" id={`val-edit-${a.id}-${v.slug}`} label={`Edit ${v.label}`}>
                  <Hidden name="attributeId" value={a.id} /><Hidden name="slug" value={v.slug} />
                  <Field name="label" label="Name" defaultValue={v.label} required />
                  {a.id === 'colour' && <Field name="swatch" label="Swatch colour" type="color" defaultValue={v.swatch ?? '#000000'} />}
                </ActionForm>
                <p className="note">{v.products} product{v.products === 1 ? '' : 's'} have this value.{v.isActive ? '' : ' Deactivated: kept on those products, not offered for new ones or as a store filter.'}</p>
                <div className="actions row-actions">
                  <ActionForm action={setAttributeValueActiveAction} submitLabel={v.isActive ? 'Deactivate' : 'Reactivate'} variant={v.isActive ? 'danger' : 'ghost'}
                    className="inline-form" id={`val-active-${a.id}-${v.slug}`} label={`${v.isActive ? 'Deactivate' : 'Reactivate'} ${v.label}`}
                    confirmText={v.isActive ? `Deactivate ${v.label}? Products that have it keep it; it is no longer offered.` : undefined}>
                    <Hidden name="attributeId" value={a.id} /><Hidden name="slug" value={v.slug} /><Hidden name="active" value={v.isActive ? 'false' : 'true'} />
                  </ActionForm>
                  {!filtered && j > 0 && <ActionForm action={moveAttributeValueAction} submitLabel="← Earlier" variant="ghost" className="inline-form" id={`val-up-${a.id}-${v.slug}`} label={`Move ${v.label} earlier`}>
                    <Hidden name="attributeId" value={a.id} /><Hidden name="slug" value={v.slug} /><Hidden name="direction" value="up" /></ActionForm>}
                  {!filtered && j < a.values.length - 1 && <ActionForm action={moveAttributeValueAction} submitLabel="Later →" variant="ghost" className="inline-form" id={`val-down-${a.id}-${v.slug}`} label={`Move ${v.label} later`}>
                    <Hidden name="attributeId" value={a.id} /><Hidden name="slug" value={v.slug} /><Hidden name="direction" value="down" /></ActionForm>}
                  {v.products === 0 && <ActionForm action={deleteAttributeValueAction} submitLabel="Delete" variant="danger" className="inline-form" id={`val-del-${a.id}-${v.slug}`}
                    label={`Delete ${v.label}`} confirmText={`Delete ${v.label}? No product uses it.`}>
                    <Hidden name="attributeId" value={a.id} /><Hidden name="slug" value={v.slug} /></ActionForm>}
                </div>
              </div>
            ) : <div className="value-chip-panel"><p className="note">{v.products} product{v.products === 1 ? '' : 's'}{v.isActive ? '' : ' · deactivated'}</p></div>}
          </details>
        ))}
        {!a.values.length && <span className="note">{filtered ? 'No value matches.' : 'No values yet.'}</span>}
        {write && (
          <details className="value-add" data-add-value={a.id}>
            <summary>+ Add value</summary>
            <div className="value-chip-panel">
              <ActionForm action={addAttributeValueAction} submitLabel="Add" className="form compact" id={`val-add-${a.id}`} label={`Add a value to ${a.label}`} resetOnSuccess>
                <Hidden name="attributeId" value={a.id} />
                <Field name="label" label={`New ${a.label.toLowerCase()} value`} autoComplete="off" required hint="Names are unique whatever the letter case." />
                {a.id === 'colour' && <Field name="swatch" label="Swatch colour" type="color" defaultValue="#000000" />}
              </ActionForm>
            </div>
          </details>
        )}
      </div>
    </section>
  );

  return (
    <>
      <PageHead section="Catalogue" title="Attributes" eyebrow={`${all.length} attribute${all.length === 1 ? '' : 's'} · ${all.filter(a => a.isActive).length} shown in store`} />
      <p className="note lead-note">Attributes are tags customers can filter by (Colour, Fabric, Fit, Occasion…). Add values with <b>+ Add value</b>; click a value to rename,
        deactivate or reactivate it. Tag products on each product&apos;s page or many at once in Bulk edit. Colour is the one list of colours: the store&apos;s colour filter uses it once it is shown.</p>
      <FilterForm className="actions" role="search" aria-label="Search attributes" data-attribute-filters>
        <label className="sr-only" htmlFor="at-q">Search attributes and values</label>
        <input id="at-q" name="q" className="input" placeholder="Search attributes or values" defaultValue={q} />
        <label className="sr-only" htmlFor="at-s">Values</label>
        <select id="at-s" name="status" className="input" defaultValue={status}><option value="all">All values</option><option value="active">Active values</option><option value="inactive">Deactivated values</option></select>
        <button className="btn ghost" type="submit">Apply</button>
      </FilterForm>
      {list.length ? list.map(card) : filtered ? <Empty title="Nothing matches" kind="attributes">Try another word or show all values.</Empty>
        : <Empty title="No attributes yet" kind="attributes">Add attributes for anything customers should filter by, e.g. Colour, Fabric, Fit or Occasion.</Empty>}
      {write ? (
        <section className="card form-panel" data-section="new-attribute" aria-labelledby="na-h">
          <h2 id="na-h">New attribute</h2>
          <ActionForm action={createAttributeAction} submitLabel="Create attribute" id="create-attribute-form" label="Create attribute" resetOnSuccess>
            <Field name="label" label="Name" autoComplete="off" required hint="e.g. Colour, Fabric, Fit, Occasion" />
            <Select name="selection" label="Values per product" defaultValue="multi" options={SELECTION} />
            <Field name="description" label="Description (optional, staff only)" autoComplete="off" />
            <details className="advanced"><summary className="note">Link (optional)</summary>
              <Field name="id" label="Link id" autoComplete="off" hint="Made from the name when empty, e.g. Fabric → /shop?fabric=cotton. Cannot be changed later." />
            </details>
          </ActionForm>
        </section>
      ) : <p className="note section-foot" data-readonly="attributes">Changing attributes needs the categories.write permission.</p>}
    </>
  );
}
