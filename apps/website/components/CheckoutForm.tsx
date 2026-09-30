'use client';
/* The checkout form: which saved address, how to deliver, where to bill, then "Place order". The server re-prices the cart
   and compares the total the customer saw (expectedTotalPaise); the random key makes a double submit return the same
   order. Choosing another address or delivery option reloads the summary for it (the delivery charge depends on both).
   Billing (client change request): the delivery address by default; untick to choose another of the saved addresses.
   Second pass: how to pay (online, or cash on delivery when the business offers it) and "use my points". Both reload the
   summary too; the server decides whether they apply and what they cost, and re-checks it when the order is placed. */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { placeOrderAction } from '@/app/checkout/actions';
import { RETURNS_POLICY } from '@/lib/store-policy';
import { ActionForm, Hidden, RadioGroup } from './forms';

export type AddressOption = { id: string; label: string; isDefault: boolean };
/** The payment choices the server worked out for this cart and address. */
export type PaymentOptions = {
  method: 'online' | 'cod'; onlineAvailable: boolean;
  cod: { offered: boolean; available: boolean; reason: string | null; note: string | null };
  points: { redeemable: boolean; balance: number; usable: number; valueLabel: string | null; using: boolean; message: string | null } | null;
};

export default function CheckoutForm({ addresses, idempotencyKey, expectedTotalPaise, totalLabel, selectedAddressId, policy = RETURNS_POLICY, blocked,
  deliveryOptions = [], selectedDeliveryId = null, payment }: {
  addresses: AddressOption[]; idempotencyKey: string; expectedTotalPaise: number; totalLabel: string; selectedAddressId?: string; policy?: string;
  /** Why this address cannot be used (e.g. no delivery there); the order cannot be placed. */
  blocked?: string | null;
  /** Delivery options for this address and order (e.g. Standard, Express), when zone delivery charges are set up. */
  deliveryOptions?: { id: string; label: string }[]; selectedDeliveryId?: string | null;
  payment?: PaymentOptions;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [billingSame, setBillingSame] = useState(true);
  const chosen = selectedAddressId ?? addresses.find(a => a.isDefault)?.id ?? addresses[0]?.id;
  const go = (address: string, delivery: string | null, pay = payment?.method ?? 'online', points = !!payment?.points?.using) =>
    start(() => router.replace(`/checkout?address=${encodeURIComponent(address)}${delivery ? `&delivery=${encodeURIComponent(delivery)}` : ''}`
      + `${pay === 'cod' ? '&pay=cod' : ''}${points ? '&points=1' : ''}`, { scroll: false }));
  const cod = payment?.method === 'cod';
  const others = addresses.filter(a => a.id !== chosen);
  return (
    <ActionForm action={placeOrderAction} submitLabel={`Place order · ${totalLabel}`} pendingLabel="Placing your order…" id="st-checkout-form"
      className="st-checkout-form" label="Checkout"
      footer={<><p className="st-note" data-returns-policy>{policy}</p><p className="st-note">{cod ? 'You pay in cash when the order is delivered. We start packing it straight away.'
        : 'Next you pay securely. Your items are held for you while the order waits for payment.'}</p></>}>
      <Hidden name="idempotencyKey" value={idempotencyKey} />
      <Hidden name="expectedTotalPaise" value={String(expectedTotalPaise)} />
      <div className="st-form-group" aria-busy={pending || undefined}
        onChange={e => { const t = e.target as HTMLInputElement; if (t.name === 'addressId' && t.value !== chosen) go(t.value, null); }}>
        <RadioGroup name="addressId" legend="Deliver to" defaultValue={chosen}
          options={addresses.map(a => ({ value: a.id, label: a.label }))} />
        <p><Link className="text-link" href="/account/addresses/new?next=/checkout">Add a new address</Link></p>
      </div>
      {blocked && <p className="st-form-alert" role="alert" data-address-blocked>{blocked}</p>}
      {deliveryOptions.length > 0 && (
        <div className="st-form-group" aria-busy={pending || undefined} data-delivery-options
          onChange={e => { const t = e.target as HTMLInputElement; if (t.name === 'deliveryRateId' && t.value !== selectedDeliveryId) go(chosen!, t.value); }}>
          <RadioGroup name="deliveryRateId" legend="Delivery" defaultValue={selectedDeliveryId ?? deliveryOptions[0].id}
            options={deliveryOptions.map(o => ({ value: o.id, label: o.label }))} />
        </div>
      )}
      {payment && (payment.cod.offered || !payment.onlineAvailable) && (
        <div className="st-form-group" aria-busy={pending || undefined} data-payment-methods
          onChange={e => { const t = e.target as HTMLInputElement; if (t.name === 'paymentMethod' && t.value !== payment.method) go(chosen!, selectedDeliveryId, t.value as 'online' | 'cod'); }}>
          <fieldset className="st-radio-group">
            <legend>Payment</legend>
            <label className="st-radio"><input type="radio" name="paymentMethod" value="online" defaultChecked={!cod} disabled={!payment.onlineAvailable} />
              <span>Pay online now{!payment.onlineAvailable && <small> · not available yet</small>}</span></label>
            <label className="st-radio"><input type="radio" name="paymentMethod" value="cod" defaultChecked={cod} disabled={!payment.cod.available} />
              <span>Cash on delivery{payment.cod.note && <small> · {payment.cod.note}</small>}</span></label>
          </fieldset>
          {payment.cod.reason && <p className="st-note" data-cod-reason>{payment.cod.reason}</p>}
        </div>
      )}
      {payment?.points && payment.points.redeemable && payment.points.balance > 0 && (
        <div className="st-form-group" aria-busy={pending || undefined} data-points>
          <label className="st-check">
            <input type="checkbox" name="usePoints" value="on" defaultChecked={payment.points.using} disabled={!payment.points.usable}
              onChange={e => go(chosen!, selectedDeliveryId, payment.method, e.currentTarget.checked)} />
            <span>{payment.points.usable ? `Use ${payment.points.usable} of my ${payment.points.balance} points (${payment.points.valueLabel} off)` : `You have ${payment.points.balance} points`}</span>
          </label>
          {payment.points.message && <p className="st-note">{payment.points.message}</p>}
        </div>
      )}
      <div className="st-form-group" data-billing>
        <label className="st-check">
          <input type="checkbox" name="billingSame" value="on" checked={billingSame} onChange={e => setBillingSame(e.currentTarget.checked)} disabled={!others.length} />
          <span>Billing address is the same as the delivery address</span>
        </label>
        {!billingSame && others.length > 0 && (
          <>
            <Hidden name="billingSame" value="false" />
            <RadioGroup name="billingAddressId" legend="Bill to" defaultValue={others[0].id} options={others.map(a => ({ value: a.id, label: a.label }))} />
          </>
        )}
        {!others.length && <p className="st-note">To bill a different address, <Link className="text-link" href="/account/addresses/new?next=/checkout">add it to your addresses</Link> first.</p>}
      </div>
    </ActionForm>
  );
}
