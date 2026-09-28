import type { Metadata } from 'next';
import { can } from '@kitsyuu/auth';
import { listMaterials } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, Select, TextArea } from '@/components/forms';
import { Empty, Forbidden, PageHead } from '@/components/ui';
import { db, requireActor } from '@/lib/server';
import { adjustMaterialAction, saveMaterialAction } from './actions';

export const metadata: Metadata = { title: 'Materials' };
const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 3 });

/* M13: what production uses (fabric, trims, labels, packaging…), with stock kept in a ledger. Stock rises when a
   purchase order is received and changes otherwise only through a recorded correction or write-off. */
export default async function MaterialsPage() {
  const actor = await requireActor();
  if (!can(actor, 'procurement.read')) return <><PageHead section="Supply" title="Materials" /><Forbidden permission="procurement.read" /></>;
  const materials = await listMaterials(db(), actor);
  const manage = can(actor, 'procurement.manage');
  return (
    <>
      <PageHead section="Supply" title="Materials" eyebrow={`${materials.filter(m => m.is_active).length} active · ${materials.filter(m => m.low).length} at or below reorder level`} />
      {materials.length === 0 ? <Empty title="No materials yet" kind="materials">Add the fabric, trims and other materials you buy and use in production.</Empty> : (
        <div className="table-wrap"><table data-materials-table>
          <thead><tr><th>Material</th><th className="num">In stock</th><th className="num">On order</th><th className="num">Reorder at</th>{manage && <th>Actions</th>}</tr></thead>
          <tbody>{materials.map(m => (
            <tr key={m.id} data-material={m.code}>
              <td><b>{m.name}</b><div className="note mono">{m.code}</div>{!m.is_active && <span className="badge disabled">Inactive</span>}</td>
              <td className="num">{fmt(m.stock)} {m.unit}{m.low && <div><span className="badge low_stock" data-low>Low</span></div>}</td>
              <td className="num">{m.incoming ? `${fmt(m.incoming)} ${m.unit}` : '—'}</td>
              <td className="num">{m.reorderLevel === null ? '—' : `${fmt(m.reorderLevel)} ${m.unit}`}</td>
              {manage && <td><div className="actions row-actions">
                <details className="row-edit"><summary className="btn ghost sm">Edit</summary>
                  <ActionForm action={saveMaterialAction} submitLabel="Save" className="form compact row-edit-form" id={`mat-edit-${m.id}`} label={`Edit ${m.name}`}>
                    <Hidden name="materialId" value={m.id} />
                    <Field name="name" label="Name" defaultValue={m.name} required />
                    <Field name="unit" label="Unit" defaultValue={m.unit} required />
                    <Field name="reorderLevel" label="Reorder at" defaultValue={m.reorderLevel === null ? '' : String(m.reorderLevel)} hint="Leave empty for no alert." />
                    <TextArea name="notes" label="Notes" defaultValue={m.notes ?? ''} rows={2} />
                  </ActionForm>
                </details>
                <details className="row-edit"><summary className="btn ghost sm">Adjust stock</summary>
                  <ActionForm action={adjustMaterialAction} submitLabel="Record" className="form compact row-edit-form" id={`mat-adj-${m.id}`} label={`Adjust ${m.name}`} resetOnSuccess>
                    <Hidden name="materialId" value={m.id} />
                    <Select name="reason" label="Reason" options={[{ value: 'correction', label: 'Stock count correction' }, { value: 'damage', label: 'Damaged / written off' }]} />
                    <Field name="delta" label={`Change (${m.unit})`} required hint="Positive adds, negative removes (write-offs are negative)." />
                    <Field name="note" label="Note" required />
                  </ActionForm>
                </details>
              </div></td>}
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {manage && (
        <section className="card form-panel" aria-labelledby="nm-h" data-section="new-material">
          <h2 id="nm-h">New material</h2>
          <ActionForm action={saveMaterialAction} submitLabel="Add material" id="create-material-form" label="Add material" resetOnSuccess>
            <div className="cols">
              <Field name="code" label="Code" required hint="e.g. FAB-DENIM-12OZ. Cannot be changed later." />
              <Field name="name" label="Name" required />
              <Field name="unit" label="Unit" required hint="As you buy it: m, kg, pcs, cones…" />
              <Field name="reorderLevel" label="Reorder at (optional)" />
            </div>
            <TextArea name="notes" label="Notes (optional)" rows={2} />
          </ActionForm>
        </section>
      )}
    </>
  );
}
