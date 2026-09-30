import type { Metadata } from 'next';
import { can } from '@kitsyuu/auth';
import { listSizeCharts, sizeChartTableText } from '@kitsyuu/core';
import { ActionForm, Checkbox, Field, Hidden, Select, TextArea } from '@/components/forms';
import { Empty, Forbidden, PageHead } from '@/components/ui';
import { db, requireActor } from '@/lib/server';
import { saveSizeChartAction } from './actions';

export const metadata: Metadata = { title: 'Size charts' };
type Data = Awaited<ReturnType<typeof listSizeCharts>>;
type Chart = Data['charts'][number];

function ChartFields({ c, d }: { c?: Chart; d: Data }) {
  const cats = d.categories.filter(x => x.size_chart_id === c?.id).map(x => x.id);
  const prods = d.products.filter(x => x.size_chart_id === c?.id).map(x => x.id);
  return (
    <>
      {c && <Hidden name="chartId" value={c.id} />}
      <div className="cols">
        <Field name="name" label="Name" defaultValue={c?.name} required hint="e.g. Tops, Bottoms (waist)." />
        <Select name="unit" label="Unit" defaultValue={c?.unit ?? 'cm'} options={[{ value: 'cm', label: 'Centimetres' }, { value: 'in', label: 'Inches' }]} />
      </div>
      <TextArea name="table" label="Chart" rows={6} defaultValue={c ? sizeChartTableText(c) : ''} required
        hint="First line: Size, then the measurements (e.g. Size, Chest, Length). Then one line per size: S, 96, 68. Commas or tabs (you can paste from a spreadsheet)." />
      <TextArea name="notes" label="Note for customers" rows={2} defaultValue={c?.notes ?? ''} hint="Optional, e.g. how the garment is measured." />
      <details><summary className="btn ghost sm">Categories using this chart ({cats.length})</summary>
        <div className="check-grid">{d.categories.map(x => (
          <label key={x.id} className="check"><input type="checkbox" name="categoryIds[]" value={x.id} defaultChecked={cats.includes(x.id)} />
            <span>{x.parent_id ? `${d.categories.find(p => p.id === x.parent_id)?.label ?? ''} → ` : ''}{x.label}</span></label>
        ))}</div></details>
      <details><summary className="btn ghost sm">Products using this chart instead of their category’s ({prods.length})</summary>
        <div className="check-grid">{d.products.map(x => (
          <label key={x.id} className="check"><input type="checkbox" name="productIds[]" value={x.id} defaultChecked={prods.includes(x.id)} /><span>{x.name}</span></label>
        ))}</div></details>
      <Checkbox name="active" label="Show in the store" defaultChecked={c?.is_active ?? true} />
    </>
  );
}

/* Client change request: size charts. Each is assigned to categories (their products and subcategories) and/or single
   products; a product shows its own chart, else its subcategory's, else its category's. Nothing is pre-filled. */
export default async function SizeChartsPage() {
  const actor = await requireActor();
  if (!can(actor, 'products.read')) return <><PageHead title="Size charts" /><Forbidden permission="products.read" /></>;
  const d = await listSizeCharts(db(), actor);
  const write = can(actor, 'products.write');
  return (
    <>
      <PageHead title="Size charts" eyebrow="Measurement tables shown on product pages. A product uses its own chart, else its subcategory’s, else its category’s." />
      {d.charts.length === 0 ? <Empty title="No size charts yet" kind="size-charts">Add a chart below and choose the categories it applies to.</Empty> : d.charts.map(c => (
        <section key={c.id} className="card" aria-labelledby={`sc-${c.id}`} data-size-chart={c.name}>
          <h2 id={`sc-${c.id}`}>{c.name} {!c.is_active && <span className="badge inactive">hidden</span>}</h2>
          <div className="table-wrap"><table data-size-chart-table>
            <thead><tr><th>Size</th>{c.headers.map(h => <th key={h} className="num">{h} ({c.unit})</th>)}</tr></thead>
            <tbody>{c.rows.map(r => <tr key={r.size}><td>{r.size}</td>{r.values.map((v, i) => <td key={i} className="num">{v}</td>)}</tr>)}</tbody>
          </table></div>
          <p className="note spaced">Used by: {[...d.categories.filter(x => x.size_chart_id === c.id).map(x => x.label), ...d.products.filter(x => x.size_chart_id === c.id).map(x => x.name)].join(', ') || 'nothing yet'}</p>
          {write && <details className="row-edit spaced"><summary className="btn ghost sm">Edit</summary>
            <ActionForm action={saveSizeChartAction} submitLabel="Save chart" className="form compact row-edit-form" id={`size-chart-${c.id}`} label={`Edit ${c.name}`}><ChartFields c={c} d={d} /></ActionForm></details>}
        </section>
      ))}
      {write && <section className="card form-panel" aria-labelledby="nsc-h"><h2 id="nsc-h">New size chart</h2>
        <ActionForm action={saveSizeChartAction} submitLabel="Add chart" id="create-size-chart-form" label="Add size chart" resetOnSuccess><ChartFields d={d} /></ActionForm></section>}
    </>
  );
}
