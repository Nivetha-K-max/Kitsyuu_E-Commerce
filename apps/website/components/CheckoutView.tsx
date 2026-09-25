'use client';
/* Checkout prototype (Phase 4.1 parity): no payment fields, nothing is sent. The order summary is kept in sessionStorage
   only so the confirmation page can show it; the cart is cleared only after that save succeeds.
   Phase 4.6 replaces the submit with server order creation + Razorpay test payment. */
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { formatMoney, pad, url } from '@/lib/catalogue-utils';
import type { CartLine } from '@/lib/types';
import { LineImage, PageHead } from './CartView';
import { KEYS, useStore } from './StoreProvider';
import { Crumbs, EmptyState } from './ui';

type Field = { id: string; label: string; group: 'contact' | 'ship'; type?: string; auto: string; pattern?: string; mode?: 'tel' | 'numeric'; msg?: string; optional?: boolean };
export const FIELDS: Field[] = [
  { id: 'name', label: 'Full name', group: 'contact', auto: 'name', msg: 'Enter your full name.' },
  { id: 'email', label: 'Email', group: 'contact', type: 'email', auto: 'email', msg: 'Enter a valid email address.' },
  { id: 'phone', label: 'Mobile number', group: 'contact', type: 'tel', auto: 'tel', pattern: '[+0-9 ]{10,15}', mode: 'tel', msg: 'Enter a 10-digit mobile number.' },
  { id: 'address1', label: 'Address', group: 'ship', auto: 'address-line1', msg: 'Enter your street address.' },
  { id: 'address2', label: 'Apartment, landmark (optional)', group: 'ship', auto: 'address-line2', optional: true },
  { id: 'city', label: 'City', group: 'ship', auto: 'address-level2', msg: 'Enter your city.' },
  { id: 'state', label: 'State', group: 'ship', auto: 'address-level1', msg: 'Enter your state.' },
  { id: 'pin', label: 'PIN code', group: 'ship', auto: 'postal-code', pattern: '[1-9][0-9]{5}', mode: 'numeric', msg: 'Enter a 6-digit PIN code.' }
];

export function Summary({ lines, title = 'Order summary' }: { lines: CartLine[]; title?: string }) {
  return (
    <aside className="st-summary" aria-labelledby="st-summary-title">
      <h2 id="st-summary-title">{title}</h2>
      <ul className="st-mini">
        {lines.map(l => (
          <li key={`${l.id}|${l.size}`}>
            <span className="st-mini-media"><LineImage line={l} /></span>
            <span className="st-mini-info"><b>{l.name}</b><small>SKU {l.sku}</small><small>Size {l.size} · Qty {l.qty}</small></span>
            <span className="st-mini-total">{formatMoney(l.price * l.qty)}</span>
          </li>
        ))}
      </ul>
      <dl><dt>Subtotal</dt><dd>{formatMoney(lines.reduce((s, l) => s + l.price * l.qty, 0))}</dd><dt>Shipping</dt><dd>Not calculated</dd></dl>
    </aside>
  );
}

function FieldRow({ f, error }: { f: Field; error?: string }) {
  return (
    <div className={`st-field${f.id === 'address1' || f.id === 'address2' ? ' st-field-wide' : ''}`}>
      <label htmlFor={`st-f-${f.id}`}>{f.label}</label>
      <input id={`st-f-${f.id}`} name={f.id} type={f.type || 'text'} autoComplete={f.auto} required={!f.optional} pattern={f.pattern} inputMode={f.mode}
        {...(error ? { 'aria-invalid': true, 'aria-describedby': `st-e-${f.id}` } : {})} />
      <p className="st-field-error" id={`st-e-${f.id}`} hidden={!error}>{error}</p>
    </div>
  );
}

export default function CheckoutView() {
  const { ready, lines, clearCart } = useStore();
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const [errors, setErrors] = useState<Record<string, string>>({}), [alert, setAlert] = useState('');

  if (!ready) return <div className="st-wrap"><p className="st-status">Loading…</p></div>;
  if (!lines.length) return <div className="st-wrap"><PageHead label="Checkout" title="Checkout" /><EmptyState title="Your cart is empty." text="Add a product to your cart before checking out." /></div>;

  const check = (f: Field) => {
    const input = form.current!.elements.namedItem(f.id) as HTMLInputElement;
    if (f.id === 'phone') input.value = input.value.replace(/[^+0-9 ]/g, '');
    input.value = input.value.trim();
    return f.optional || input.checkValidity();
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const bad = FIELDS.filter(f => !check(f));
    setErrors(Object.fromEntries(bad.map(f => [f.id, f.msg!])));
    if (bad.length) {
      setAlert(`Please check ${bad.length === 1 ? '1 field' : `${bad.length} fields`}: ${bad.map(f => f.label.replace(' (optional)', '')).join(', ')}.`);
      (form.current!.elements.namedItem(bad[0].id) as HTMLInputElement).focus(); return;
    }
    setAlert('');
    const v = Object.fromEntries(FIELDS.map(f => [f.id, (form.current!.elements.namedItem(f.id) as HTMLInputElement).value]));
    const d = new Date(), rand = [...crypto.getRandomValues(new Uint8Array(4))].map(b => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[b % 31]).join('');
    const order = {
      ref: `KTS-PROTO-${String(d.getFullYear()).slice(2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${rand}`, createdAt: d.toISOString(),
      lines, subtotal: lines.reduce((s, l) => s + l.price * l.qty, 0), customer: { name: v.name, email: v.email, phone: v.phone },
      shipping: { address1: v.address1, address2: v.address2, city: v.city, state: v.state, pin: v.pin, country: 'India' }
    };
    try { sessionStorage.setItem(KEYS.order, JSON.stringify(order)); }
    catch { setAlert('This browser blocked saving the prototype order, so your cart was kept. Please try again.'); return; }
    clearCart(); router.push(url.confirmation);
  };

  return (
    <div className="st-wrap">
      <Crumbs list={[{ label: 'Store', href: url.home }, { label: 'Cart', href: url.cart }, { label: 'Checkout' }]} />
      <header className="st-plp-head"><h1 id="st-page-title" tabIndex={-1}>Checkout</h1><div className="st-plp-aside"><p className="st-result-count">Prototype</p><p>This is a demonstration checkout, not a real purchase. Nothing is charged and nothing is sent to KITSYUU.</p></div></header>
      <div className="st-cart st-checkout-layout">
        <form className="st-checkout-form" noValidate ref={form} onSubmit={submit}
          onChange={e => { const t = e.target as unknown as HTMLInputElement, f = FIELDS.find(x => x.id === t.name); if (f && errors[f.id] && check(f)) setErrors(({ [f.id]: _, ...rest }) => rest); }}>
          <div className="st-form-alert" id="st-form-alert" role="alert" hidden={!alert}>{alert}</div>
          <fieldset className="st-form-group"><legend>01 / Contact</legend><div className="st-fields">{FIELDS.filter(f => f.group === 'contact').map(f => <FieldRow key={f.id} f={f} error={errors[f.id]} />)}</div></fieldset>
          <fieldset className="st-form-group"><legend>02 / Shipping address</legend><div className="st-fields">{FIELDS.filter(f => f.group === 'ship').map(f => <FieldRow key={f.id} f={f} error={errors[f.id]} />)}<div className="st-field"><span className="st-field-label">Country</span><p className="st-field-static">India</p></div></div></fieldset>
          <fieldset className="st-form-group st-pay"><legend>03 / Payment <span className="st-proto-tag">Prototype</span></legend><p>No payment is taken in this prototype. Card, UPI and bank details are not requested, and no payment provider is connected.</p></fieldset>
          <button className="button st-place" type="submit">Place prototype order</button>
          <p className="st-note">Your details stay in this browser tab to show the confirmation. They are not sent or stored anywhere else.</p>
        </form>
        <Summary lines={lines} />
      </div>
    </div>
  );
}
