'use client';
/* Price and stock forms. They only ask for confirmation in the browser; the server re-validates everything, checks
   permissions, refuses stale data (expected price / expected quantity) and writes the audit record. */
import type { ActionState } from '@kitsyuu/contracts';
import { paiseToRupees, rupeesToPaise } from '@kitsyuu/contracts';
import { ActionForm, Field, Hidden, Select } from './forms';

type Action = (state: ActionState, form: FormData) => Promise<ActionState>;

export function PriceForm({ action, productId, currentPaise }: { action: Action; productId: string; currentPaise: number }) {
  return (
    <ActionForm action={action} submitLabel="Change price" pendingLabel="Saving…" id="price-form" label="Change price"
      confirm={data => {
        const next = rupeesToPaise(String(data.get('price') ?? ''));
        if (next === null || next <= 0 || next === currentPaise) return null;   // invalid/unchanged: let the server answer
        const change = next > currentPaise ? 'increase' : 'decrease';
        return `Change the price from ₹${paiseToRupees(currentPaise)} to ₹${paiseToRupees(next)} (${change})? The store shows it within a minute.`;
      }}>
      <Hidden name="productId" value={productId} />
      <Hidden name="expectedPricePaise" value={String(currentPaise)} />
      <Field name="price" label="New price (₹, tax-inclusive)" defaultValue={paiseToRupees(currentPaise).replace(/,/g, '')} autoComplete="off"
        hint={`Current price ₹${paiseToRupees(currentPaise)}. Rupees with up to 2 decimals.`} />
    </ActionForm>
  );
}

export function StockAdjustForm({ action, productId, variant, reasons }: {
  action: Action; productId: string; variant: { id: string; sku: string; size: string; stockQty: number };
  reasons: { code: string; label: string; direction: string }[];
}) {
  const direction = (d: string) => (d === 'in' ? ' (increase only)' : d === 'out' ? ' (decrease only)' : '');
  return (
    <ActionForm action={action} submitLabel={`Adjust ${variant.size}`} pendingLabel="Adjusting…" resetOnSuccess className="form stock-form"
      id={`adjust-${variant.sku}`} label={`Adjust stock for size ${variant.size}`}
      confirm={data => {
        const qty = Number(data.get('quantity'));
        if (data.get('direction') !== 'decrease' || !Number.isInteger(qty) || qty < 1) return null;
        if (qty > variant.stockQty) return null;                                   // the server refuses it and explains why
        return qty >= Math.max(5, Math.ceil(variant.stockQty / 2))
          ? `Remove ${qty} of ${variant.stockQty} units of ${variant.sku}? This is recorded in the stock ledger.` : null;
      }}>
      <Hidden name="productId" value={productId} />
      <Hidden name="variantId" value={variant.id} />
      <Hidden name="expectedQty" value={String(variant.stockQty)} />
      <Select name="direction" label="Change" options={[{ value: 'increase', label: 'Increase' }, { value: 'decrease', label: 'Decrease' }]} />
      <Field name="quantity" label="Quantity" type="number" autoComplete="off" />
      <Select name="reason" label="Reason" options={[{ value: '', label: 'Choose a reason…' }, ...reasons.map(r => ({ value: r.code, label: r.label + direction(r.direction) }))]} />
      <Field name="note" label="Note (optional)" autoComplete="off" />
    </ActionForm>
  );
}
