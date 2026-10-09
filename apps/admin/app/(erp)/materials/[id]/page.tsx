/* One material (2026-10-08: on the shared entity frame).

     header  name, code, in stock, on order, reorder level; Adjust stock
     tabs    Ledger · Details

   The ledger is material_movements, the only record of material stock: every receipt (from a goods receipt on a purchase
   order), every quantity production used (against a production order), and every correction or write-off, each with the
   balance after it. It is read-only here. A correction is made with the existing action, which writes one ledger row
   through adjust_material_stock; nothing on this page sets a quantity directly. */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { listMaterials } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, Select, TextArea } from '@/components/forms';
import { Entity, Facts, Section, StateBlock } from '@/components/frame';
import { FilterLink } from '@/components/NavFrame';
import { Drawer } from '@/components/overlays';
import { Forbidden, PageHead } from '@/components/ui';
import { formatDateTime, formatNumber } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { adjustMaterialAction, saveMaterialAction } from '../actions';

export const metadata: Metadata = { title: 'Material' };
type Params = Promise<{ id: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const TABS = [['ledger', 'Ledger'], ['details', 'Details']] as const;
type Tab = (typeof TABS)[number][0];
const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 3 });
const REASON: Record<string, string> = { receipt: 'Goods received', consume: 'Used in production', correction: 'Stock count correction', damage: 'Damaged / written off' };
const PAGE_SIZE = 50;

export default async function MaterialPage({ params, searchParams }: { params: Params; searchParams: SP }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/materials', label: 'Materials' }];
  if (!can(actor, 'procurement.read')) return <><PageHead section="Supply" title="Material" crumbs={crumbs} /><Forbidden permission="procurement.read" /></>;
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const m = (await listMaterials(db(), actor)).find(x => x.id === id);
  if (!m) notFound();
  const manage = can(actor, 'procurement.manage'), seeProduction = can(actor, 'production.read');
  const tab: Tab = TABS.find(t => t[0] === sp.tab)?.[0] ?? 'ledger';
  const self = `/materials/${m.id}`;
  const href = (t: string) => (t === 'ledger' ? self : `${self}?tab=${t}`);
  const page = Math.min(10_000, Math.max(1, parseInt(one(sp.page) ?? '1', 10) || 1));
  // The ledger rows with what each refers to: the goods receipt and its purchase order, or the production order.
  const rows = tab === 'ledger' ? await db().selectFrom('material_movements as mv').leftJoin('staff_users as s', 's.id', 'mv.staff_id')
    .leftJoin('goods_receipts as g', 'g.id', 'mv.goods_receipt_id').leftJoin('purchase_orders as po', 'po.id', 'g.purchase_order_id')
    .select(['mv.id', 'mv.created_at', 'mv.delta', 'mv.balance_after', 'mv.reason', 'mv.note', 's.email as staff_email', 'g.id as receipt_id', 'g.receipt_number', 'po.id as po_id', 'po.po_number'])
    .where('mv.material_id', '=', m.id).orderBy('mv.id', 'desc').limit(PAGE_SIZE + 1).offset((page - 1) * PAGE_SIZE).execute() : [];
  const more = rows.length > PAGE_SIZE, shown = rows.slice(0, PAGE_SIZE);
  const numbers = [...new Set(shown.filter(r => r.reason === 'consume' && r.note).map(r => r.note!))];
  const production = numbers.length ? await db().selectFrom('production_orders').select(['id', 'number']).where('number', 'in', numbers).execute() : [];

  return (
    <Entity module={{ href: '/materials', label: 'Materials' }} name="material" title={m.name}
      status={!m.is_active ? <span className="badge disabled">Inactive</span> : m.low ? <span className="badge low_stock" data-low>Low</span> : undefined}
      factsAttr="data-material-facts"
      facts={[
        { label: 'Code', value: <span className="mono">{m.code}</span> },
        { label: 'In stock', value: `${fmt(m.stock)} ${m.unit}`, attr: 'stock' },
        { label: 'On order', value: m.incoming ? `${fmt(m.incoming)} ${m.unit}` : '—', attr: 'incoming' },
        { label: 'Reorder at', value: m.reorderLevel === null ? 'Not set' : `${fmt(m.reorderLevel)} ${m.unit}` },
      ]}
      actions={manage ? (
        <Drawer trigger="Adjust stock" triggerClass="btn ghost sm" name="adjust-material" scope="ord" title={`Adjust ${m.name}`}
          description={`In stock now: ${fmt(m.stock)} ${m.unit}. Receipts come from purchase orders and usage from production; use this only for a count correction or a write-off.`}>
          <ActionForm action={adjustMaterialAction} submitLabel="Record" id={`mat-adj-${m.id}`} label={`Adjust ${m.name}`} resetOnSuccess
            confirmText={`Record this stock change for ${m.name}? It is written to the material ledger and cannot be edited afterwards.`}>
            <Hidden name="materialId" value={m.id} />
            <Select name="reason" label="Reason" options={[{ value: 'correction', label: 'Stock count correction' }, { value: 'damage', label: 'Damaged / written off' }]} />
            <Field name="delta" label={`Change (${m.unit})`} required hint="Positive adds, negative removes (write-offs are negative). Stock cannot go below zero." />
            <Field name="note" label="Note" required />
          </ActionForm>
        </Drawer>
      ) : undefined}
      tabs={TABS.map(([tid, label]) => ({ id: tid, label }))} current={tab} tabHref={href}>

      {tab === 'ledger' && (
        <Section id="ml-h" title="Material ledger" name="ledger" wide hint="Every change to this material's stock, newest first, with the balance after it. Rows are never edited or removed.">
          {shown.length === 0 ? <StateBlock title={page > 1 ? 'No more movements' : 'No movements yet'} name="material-ledger">Stock arrives when a purchase order for this material is received.</StateBlock> : (
            <div className="table-wrap"><table data-material-ledger>
              <thead><tr><th>When</th><th>Type</th><th className="num">Change</th><th className="num">Balance after</th><th>Reference</th><th>By</th></tr></thead>
              <tbody>{shown.map(r => {
                const pr = r.reason === 'consume' ? production.find(p => p.number === r.note) : undefined;
                return (
                  <tr key={String(r.id)} data-material-movement={r.reason}>
                    <td className="nowrap">{formatDateTime(r.created_at as Date)}</td><td>{REASON[r.reason] ?? r.reason}</td>
                    <td className="num" data-delta>{Number(r.delta) > 0 ? '+' : ''}{fmt(Number(r.delta))} {m.unit}</td><td className="num" data-balance>{fmt(Number(r.balance_after))} {m.unit}</td>
                    <td data-reference>
                      {r.po_id ? <><Link href={`/purchase-orders/${r.po_id}/receipts/${r.receipt_id}`} className="mono">{r.receipt_number ?? 'Delivery'}</Link> · <Link href={`/purchase-orders/${r.po_id}?tab=receiving`} className="mono">{r.po_number}</Link></>
                        : pr ? (seeProduction ? <Link href={`/production/${pr.id}?tab=materials`} className="mono">{pr.number}</Link> : <span className="mono">{pr.number}</span>)
                        : r.note ?? '—'}
                    </td>
                    <td>{r.staff_email ?? '—'}</td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          )}
          {(page > 1 || more) && (
            <nav className="pager" aria-label="Ledger pages" data-pager>
              {page > 1 ? <FilterLink className="btn ghost sm" group="page" current={false} href={page === 2 ? self : `${self}?page=${page - 1}`}>← Newer</FilterLink> : <span />}
              <span className="pager-page">Page {formatNumber(page)}</span>
              {more ? <FilterLink className="btn ghost sm" group="page" current={false} href={`${self}?page=${page + 1}`}>Older →</FilterLink> : <span />}
            </nav>
          )}
        </Section>
      )}

      {tab === 'details' && (manage ? (
        <Section id="md-h" title="Material details" name="details" hint="The code is fixed once created. Leave the reorder level empty for no low-stock alert.">
          <ActionForm action={saveMaterialAction} submitLabel="Save" id={`mat-edit-${m.id}`} label={`Edit ${m.name}`}>
            <Hidden name="materialId" value={m.id} />
            <Field name="name" label="Name" defaultValue={m.name} required />
            <Field name="unit" label="Unit" defaultValue={m.unit} required />
            <Field name="reorderLevel" label="Reorder at" defaultValue={m.reorderLevel === null ? '' : String(m.reorderLevel)} hint="Leave empty for no alert." />
            <TextArea name="notes" label="Notes" defaultValue={m.notes ?? ''} rows={2} />
          </ActionForm>
        </Section>
      ) : (
        <Section id="md-h" title="Material details" name="details">
          <Facts items={[{ label: 'Name', value: m.name }, { label: 'Code', value: m.code }, { label: 'Unit', value: m.unit },
            { label: 'Reorder at', value: m.reorderLevel === null ? 'Not set' : `${fmt(m.reorderLevel)} ${m.unit}` }, { label: 'Notes', value: m.notes ?? '—' }]} />
          <p className="note" data-readonly="material">Changing a material needs the procurement.manage permission.</p>
        </Section>
      ))}
    </Entity>
  );
}
