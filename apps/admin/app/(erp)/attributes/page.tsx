import type { Metadata } from 'next';
import { can } from '@kitsyuu/auth';
import { listAttributes, type AttributeRow } from '@kitsyuu/core';
import { ActionForm, Field, Hidden } from '@/components/forms';
import { Empty, Forbidden, PageHead } from '@/components/ui';
import { db, requireActor } from '@/lib/server';
import {
  addAttributeValueAction, createAttributeAction, deleteAttributeValueAction, moveAttributeAction, moveAttributeValueAction,
  renameAttributeValueAction, setAttributeActiveAction, updateAttributeAction
} from './actions';

export const metadata: Metadata = { title: 'Attributes' };

/* Product attributes: what the store can filter by besides type, size, colour, price and stock (Fabric, Sleeve length,
   Occasion, …). Nothing is pre-filled: the business adds the attributes and values it wants, then tags products on
   each product's page. An active attribute appears in the store's Filter panel once products in a list carry it. */
export default async function AttributesPage() {
  const actor = await requireActor();
  if (!can(actor, 'categories.read')) return <><PageHead section="Catalogue" title="Attributes" /><Forbidden permission="categories.read" /></>;
  const list = await listAttributes(db(), actor);
  const write = can(actor, 'categories.write');

  const card = (a: AttributeRow, i: number) => (
    <section key={a.id} className="card attr-card" data-attribute={a.id} data-active={a.isActive ? 'yes' : 'no'} aria-labelledby={`attr-${a.id}`}>
      <header className="attr-head">
        <div>
          <h2 id={`attr-${a.id}`}>{a.label} <span className={`badge ${a.isActive ? 'active' : 'disabled'}`}>{a.isActive ? 'Shown in store' : 'Hidden'}</span></h2>
          <div className="note mono">?{a.id}=… · {a.values.length} value{a.values.length === 1 ? '' : 's'} · {a.products} product{a.products === 1 ? '' : 's'} tagged</div>
          {a.description && <p className="note">{a.description}</p>}
        </div>
        {write && (
          <div className="actions row-actions">
            <details className="row-edit">
              <summary className="btn ghost sm">Edit</summary>
              <ActionForm action={updateAttributeAction} submitLabel="Save changes" className="form compact row-edit-form" id={`attr-edit-${a.id}`} label={`Edit ${a.label}`}>
                <Hidden name="attributeId" value={a.id} /><Hidden name="expectedLabel" value={a.label} />
                <Field name="label" label="Name" defaultValue={a.label} required />
                <Field name="description" label="Description (staff only)" defaultValue={a.description} />
              </ActionForm>
            </details>
            <ActionForm action={setAttributeActiveAction} submitLabel={a.isActive ? 'Hide from store' : 'Show in store'} variant={a.isActive ? 'danger' : 'ghost'}
              className="inline-form" id={`attr-active-${a.id}`} label={`${a.isActive ? 'Hide' : 'Show'} ${a.label}`}
              confirmText={a.isActive ? `Hide ${a.label} from the store? Its filter disappears; product tags are kept.` : undefined}>
              <Hidden name="attributeId" value={a.id} /><Hidden name="active" value={a.isActive ? 'false' : 'true'} /><Hidden name="expectedActive" value={a.isActive ? 'true' : 'false'} />
            </ActionForm>
            {i > 0 && <ActionForm action={moveAttributeAction} submitLabel="↑" variant="ghost" className="inline-form" id={`attr-up-${a.id}`} label={`Move ${a.label} up`}>
              <Hidden name="attributeId" value={a.id} /><Hidden name="direction" value="up" /></ActionForm>}
            {i < list.length - 1 && <ActionForm action={moveAttributeAction} submitLabel="↓" variant="ghost" className="inline-form" id={`attr-down-${a.id}`} label={`Move ${a.label} down`}>
              <Hidden name="attributeId" value={a.id} /><Hidden name="direction" value="down" /></ActionForm>}
          </div>
        )}
      </header>
      {a.values.length ? (
        <div className="table-wrap"><table className="attr-values">
          <thead><tr><th>Value</th><th className="num">Products</th>{write && <th>Actions</th>}</tr></thead>
          <tbody>{a.values.map((v, j) => (
            <tr key={v.slug} data-value={v.slug}>
              <td>{v.label}<div className="note mono">{v.slug}</div></td>
              <td className="num">{v.products}</td>
              {write && <td><div className="actions row-actions">
                <details className="row-edit">
                  <summary className="btn ghost sm">Rename</summary>
                  <ActionForm action={renameAttributeValueAction} submitLabel="Save" className="form compact row-edit-form" id={`val-edit-${a.id}-${v.slug}`} label={`Rename ${v.label}`}>
                    <Hidden name="attributeId" value={a.id} /><Hidden name="slug" value={v.slug} />
                    <Field name="label" label="Name" defaultValue={v.label} required hint="The link id stays the same." />
                  </ActionForm>
                </details>
                {j > 0 && <ActionForm action={moveAttributeValueAction} submitLabel="↑" variant="ghost" className="inline-form" id={`val-up-${a.id}-${v.slug}`} label={`Move ${v.label} up`}>
                  <Hidden name="attributeId" value={a.id} /><Hidden name="slug" value={v.slug} /><Hidden name="direction" value="up" /></ActionForm>}
                {j < a.values.length - 1 && <ActionForm action={moveAttributeValueAction} submitLabel="↓" variant="ghost" className="inline-form" id={`val-down-${a.id}-${v.slug}`} label={`Move ${v.label} down`}>
                  <Hidden name="attributeId" value={a.id} /><Hidden name="slug" value={v.slug} /><Hidden name="direction" value="down" /></ActionForm>}
                {v.products === 0 && <ActionForm action={deleteAttributeValueAction} submitLabel="Delete" variant="danger" className="inline-form" id={`val-del-${a.id}-${v.slug}`}
                  label={`Delete ${v.label}`} confirmText={`Delete the value ${v.label}?`}>
                  <Hidden name="attributeId" value={a.id} /><Hidden name="slug" value={v.slug} /></ActionForm>}
              </div></td>}
            </tr>
          ))}</tbody>
        </table></div>
      ) : <p className="note">No values yet.</p>}
      {write && (
        <ActionForm action={addAttributeValueAction} submitLabel="Add value" className="form compact attr-add" id={`val-add-${a.id}`} label={`Add a value to ${a.label}`} resetOnSuccess>
          <Hidden name="attributeId" value={a.id} />
          <Field name="label" label="New value" autoComplete="off" required hint="e.g. Cotton. The link id is made from the name." />
          <Field name="slug" label="Link id (optional)" autoComplete="off" hint="Only needed for names without Latin letters." />
        </ActionForm>
      )}
    </section>
  );

  return (
    <>
      <PageHead section="Catalogue" title="Attributes" eyebrow={`${list.length} attribute${list.length === 1 ? '' : 's'} · ${list.filter(a => a.isActive).length} shown in store`} />
      <p className="note lead-note">Attributes become filters in the store (Fabric, Sleeve length, Occasion…). Add an attribute and its values here,
        then tick the values on each product&apos;s page. A filter appears in the store once products carry it. Ids are fixed once created
        (the store uses them in links); names can be changed at any time.</p>
      {list.length ? list.map(card) : <Empty title="No attributes yet" kind="attributes">Type, size, colour, price and availability filters already work from the product data. Add attributes for anything else you want customers to filter by.</Empty>}
      {write ? (
        <section className="card form-panel" data-section="new-attribute" aria-labelledby="na-h">
          <h2 id="na-h">New attribute</h2>
          <ActionForm action={createAttributeAction} submitLabel="Create attribute" id="create-attribute-form" label="Create attribute" resetOnSuccess>
            <Field name="label" label="Name" autoComplete="off" required hint="e.g. Fabric, Sleeve length, Occasion" />
            <Field name="id" label="Link id" autoComplete="off" required hint="e.g. fabric → /shop?fabric=cotton. Lower-case letters, digits and hyphens. Cannot be changed later." />
            <Field name="description" label="Description (optional, staff only)" autoComplete="off" />
          </ActionForm>
        </section>
      ) : <p className="note section-foot" data-readonly="attributes">Changing attributes needs the categories.write permission.</p>}
    </>
  );
}
