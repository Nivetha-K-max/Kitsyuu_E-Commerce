/* Production → Plan production (2026-10-08: its own page; both forms and their actions are unchanged).
   One size, or several sizes at once as one batch (a shared reference). Planning adds nothing to stock: pieces enter
   stock only when an order's quality check completes it. */
import type { Metadata } from 'next';
import { can } from '@kitsyuu/auth';
import { listProducibleVariants } from '@kitsyuu/core';
import MaterialLines from '@/components/MaterialLines';
import { ActionForm, Field, Select, TextArea } from '@/components/forms';
import { StateBlock } from '@/components/frame';
import { Forbidden, PageHead } from '@/components/ui';
import { db, requireActor } from '@/lib/server';
import { createProductionBatchAction, createProductionOrderAction } from '../actions';

export const metadata: Metadata = { title: 'Plan production' };

export default async function NewProductionPage() {
  const actor = await requireActor();
  const crumbs = [{ href: '/production', label: 'Production' }];
  if (!can(actor, 'production.manage')) return <><PageHead section="Supply" title="Plan production" crumbs={crumbs} /><Forbidden permission="production.manage" /></>;
  const variants = await listProducibleVariants(db(), actor);
  return (
    <div className="ord ws" data-workspace="new-production">
      <PageHead section="Supply" title="Plan production" crumbs={crumbs} eyebrow="Planning adds nothing to stock. Passed pieces enter stock when the quality check completes an order." />
      {variants.length === 0 ? <StateBlock title="No products to make yet" name="new-production">Add a product with sizes first.</StateBlock> : <>
        <section className="card form-panel" aria-labelledby="npr-h" data-section="new-production">
          <h2 id="npr-h">One size</h2>
          <ActionForm action={createProductionOrderAction} submitLabel="Plan production" id="create-production-form" label="New production order">
            <Select name="variantId" label="Piece and size" options={variants.map(v => ({ value: v.id, label: v.label }))} />
            <Field name="qty" label="Pieces to make" type="number" required />
            <Field name="dueOn" label="Due (optional)" type="date" />
            <TextArea name="notes" label="Notes (optional)" rows={2} />
          </ActionForm>
        </section>
        <section className="card form-panel" aria-labelledby="bpr-h" data-section="new-production-batch">
          <h2 id="bpr-h">Several sizes at once</h2>
          <p className="note">One production order per size, sharing a batch reference so they can be found together.</p>
          <ActionForm action={createProductionBatchAction} submitLabel="Plan production" className="form form-wide" id="create-production-batch-form" label="Plan several sizes" resetOnSuccess>
            <MaterialLines materials={[]} products={variants.map(v => ({ id: v.id, sku: v.sku, label: v.name, stock: v.stock, supplied: false }))} showCosts={false} />
            <div className="cols">
              <Field name="batchRef" label="Batch reference (optional)" hint="Empty: the first order's number." />
              <Field name="dueOn" label="Due (optional)" type="date" />
            </div>
            <TextArea name="notes" label="Notes (optional)" rows={2} />
          </ActionForm>
        </section>
      </>}
    </div>
  );
}
