'use client';
/* The checkout form: which saved address, then "Place order". The server re-prices the cart and compares the total the
   customer saw (expectedTotalPaise); the random key makes a double submit return the same order. */
import Link from 'next/link';
import { placeOrderAction } from '@/app/checkout/actions';
import { ActionForm, Hidden, RadioGroup } from './forms';

export type AddressOption = { id: string; label: string; isDefault: boolean };

export default function CheckoutForm({ addresses, idempotencyKey, expectedTotalPaise, totalLabel }: {
  addresses: AddressOption[]; idempotencyKey: string; expectedTotalPaise: number; totalLabel: string;
}) {
  return (
    <ActionForm action={placeOrderAction} submitLabel={`Place order · ${totalLabel}`} pendingLabel="Placing your order…" id="st-checkout-form"
      className="st-checkout-form" label="Checkout"
      footer={<p className="st-note">Next you pay securely. Your items are held for you while the order waits for payment.</p>}>
      <Hidden name="idempotencyKey" value={idempotencyKey} />
      <Hidden name="expectedTotalPaise" value={String(expectedTotalPaise)} />
      <div className="st-form-group">
        <RadioGroup name="addressId" legend="Deliver to" defaultValue={addresses.find(a => a.isDefault)?.id ?? addresses[0]?.id}
          options={addresses.map(a => ({ value: a.id, label: a.label }))} />
        <p><Link className="text-link" href="/account/addresses/new?next=/checkout">Add a new address</Link></p>
      </div>
    </ActionForm>
  );
}
