'use client';
/* The checkout form: which saved address, then "Place order". The server re-prices the cart and compares the total the
   customer saw (expectedTotalPaise); the random key makes a double submit return the same order. Choosing another address
   reloads the summary for it (the delivery charge can depend on the address). */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { placeOrderAction } from '@/app/checkout/actions';
import { RETURNS_POLICY } from '@/lib/store-policy';
import { ActionForm, Hidden, RadioGroup } from './forms';

export type AddressOption = { id: string; label: string; isDefault: boolean };

export default function CheckoutForm({ addresses, idempotencyKey, expectedTotalPaise, totalLabel, selectedAddressId, policy = RETURNS_POLICY, blocked }: {
  addresses: AddressOption[]; idempotencyKey: string; expectedTotalPaise: number; totalLabel: string; selectedAddressId?: string; policy?: string;
  /** Why this address cannot be used (e.g. no delivery there); the order cannot be placed. */
  blocked?: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const chosen = selectedAddressId ?? addresses.find(a => a.isDefault)?.id ?? addresses[0]?.id;
  return (
    <ActionForm action={placeOrderAction} submitLabel={`Place order · ${totalLabel}`} pendingLabel="Placing your order…" id="st-checkout-form"
      className="st-checkout-form" label="Checkout"
      footer={<><p className="st-note" data-returns-policy>{policy}</p><p className="st-note">Next you pay securely. Your items are held for you while the order waits for payment.</p></>}>
      <Hidden name="idempotencyKey" value={idempotencyKey} />
      <Hidden name="expectedTotalPaise" value={String(expectedTotalPaise)} />
      <div className="st-form-group" aria-busy={pending || undefined}
        onChange={e => { const t = e.target as HTMLInputElement; if (t.name === 'addressId' && t.value !== chosen) start(() => router.replace(`/checkout?address=${encodeURIComponent(t.value)}`, { scroll: false })); }}>
        <RadioGroup name="addressId" legend="Deliver to" defaultValue={chosen}
          options={addresses.map(a => ({ value: a.id, label: a.label }))} />
        <p><Link className="text-link" href="/account/addresses/new?next=/checkout">Add a new address</Link></p>
      </div>
      {blocked && <p className="st-form-alert" role="alert" data-address-blocked>{blocked}</p>}
    </ActionForm>
  );
}
