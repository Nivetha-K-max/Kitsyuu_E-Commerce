/* Catalogue setup → Size charts (2026-10-08: on the shared workspace frame; "used by" opens the products concerned). */
import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listSizeCharts, sizeChartTableText } from '@kitsyuu/core';
import { ActionForm, Checkbox, Field, Hidden, Select, TextArea } from '@/components/forms';
import ModuleViews from '@/components/ModuleViews';
import { StateBlock, Workspace } from '@/components/frame';
import { Drawer } from '@/components/overlays';
import { Forbidden, PageHead } from '@/components/ui';
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
  const seeCategories = can(actor, 'categories.read');
  return (
    <Workspace name="size-charts" title="Size charts" summary={`${d.charts.length} chart${d.charts.length === 1 ? '' : 's'} · ${d.charts.filter(c => c.is_active).length} shown in the store`}
      actions={write ? (
        <Drawer trigger="New size chart" name="new-size-chart" scope="ord" title="New size chart" description="A measurement table shown on product pages. Choose the categories (and single products) it applies to.">
          <ActionForm action={saveSizeChartAction} submitLabel="Add chart" id="create-size-chart-form" label="Add size chart" resetOnSuccess><ChartFields d={d} /></ActionForm>
        </Drawer>
      ) : undefined}>
      <ModuleViews module="catalogue" label="Catalogue setup" current="/size-charts" />
      {d.charts.length === 0 ? <StateBlock title="No size charts yet" name="size-charts">{write ? 'Add a chart and choose the categories it applies to.' : 'Size charts appear here once they are added.'}</StateBlock> : d.charts.map(c => {
        // Where the chart is assigned directly. A product without its own chart shows its subcategory's, else its category's.
        const cats = d.categories.filter(x => x.size_chart_id === c.id), prods = d.products.filter(x => x.size_chart_id === c.id);
        return (
          <section key={c.id} className="card" aria-labelledby={`sc-${c.id}`} data-size-chart={c.name}>
            <h2 id={`sc-${c.id}`}>{c.name} <span className={`badge ${c.is_active ? 'active' : 'disabled'}`}>{c.is_active ? 'In store' : 'Hidden'}</span></h2>
            <div className="table-wrap"><table data-size-chart-table>
              <thead><tr><th>Size</th>{c.headers.map(h => <th key={h} className="num">{h} ({c.unit})</th>)}</tr></thead>
              <tbody>{c.rows.map(r => <tr key={r.size}><td>{r.size}</td>{r.values.map((v, i) => <td key={i} className="num">{v}</td>)}</tr>)}</tbody>
            </table></div>
            {c.notes && <p className="note spaced">{c.notes}</p>}
            <dl className="ent-dl spaced" data-size-chart-use>
              <div><dt>Categories</dt><dd>{cats.length === 0 ? <span className="note">none</span> : cats.map((x, i) => <span key={x.id}>{i > 0 && ', '}
                <Link href={`/products?category=${encodeURIComponent(x.id)}`} data-link="chart-category">{x.parent_id ? `${d.categories.find(p => p.id === x.parent_id)?.label ?? ''} / ` : ''}{x.label}</Link></span>)}</dd></div>
              <div><dt>Single products</dt><dd>{prods.length === 0 ? <span className="note">none</span> : prods.map((x, i) => <span key={x.id}>{i > 0 && ', '}
                <Link href={`/products/${x.id}?tab=merchandising`} data-link="chart-product">{x.name}</Link></span>)}</dd></div>
            </dl>
            {write && <details className="row-edit spaced"><summary className="btn ghost sm">Edit</summary>
              <ActionForm action={saveSizeChartAction} submitLabel="Save chart" className="form compact row-edit-form" id={`size-chart-${c.id}`} label={`Edit ${c.name}`}><ChartFields c={c} d={d} /></ActionForm></details>}
          </section>
        );
      })}
      <p className="note section-foot">{write
        ? <>A product uses its own chart, else its subcategory&apos;s, else its category&apos;s. A category link opens Products in that category{seeCategories ? <>; categories themselves are under <Link href="/categories">Categories</Link></> : null}.</>
        : <span data-readonly="size-charts">Changing size charts needs the products.write permission.</span>}</p>
    </Workspace>
  );
}
