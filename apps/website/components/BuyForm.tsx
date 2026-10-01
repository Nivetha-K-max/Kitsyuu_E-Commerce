'use client';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { MAX_QTY, url } from '@/lib/catalogue-utils';
import { useStore } from './StoreProvider';
import WishButton from './WishButton';
import { useColour } from './ColourScope';

/* Size + quantity + Add to cart. A size is required; the status line appears only after an action. */
export default function BuyForm({ productId }: { productId: string }) {
  const { idx, addToCart } = useStore();
  const p = idx.byId.get(productId)!;
  const [size, setSize] = useState(''), [qty, setQtyState] = useState(1), [invalid, setInvalid] = useState(false);
  const [status, setStatus] = useState<React.ReactNode>(null), [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  // Third pass: a product that comes in colours shows the colours first; the sizes are those of the chosen colour.
  const { colour, setColour } = useColour();
  const colours = p.colours ?? [], coloured = colours.length > 0;
  const colourLabel = colours.find(c => c.slug === colour)?.label ?? null;
  const sizes = coloured ? p.variants.filter(v => v.colour === colour) : p.variants;
  const clamp = (v: unknown) => Math.min(MAX_QTY, Math.max(1, Math.round(Number(v)) || 1));
  const setQty = (v: unknown) => setQtyState(clamp(v));

  return (
    <form className="st-buy" noValidate ref={form} aria-busy={busy || undefined} onSubmit={async e => {
      e.preventDefault();
      if (busy) return;
      if (coloured && !colour) {
        setStatus('Select a colour to add this to your cart.');
        form.current!.querySelector<HTMLInputElement>('input[name="colour"]')?.focus(); return;
      }
      if (!size) {
        setInvalid(true); setStatus('Select a size to add this to your cart.');
        form.current!.querySelector<HTMLInputElement>('input[name="size"]:not(:disabled)')?.focus(); return;
      }
      const input = form.current!.querySelector<HTMLInputElement>('#st-qty')!, n = clamp(input.value);
      setQty(n);
      setBusy(true);
      const r = await addToCart(p, size, n, coloured ? colour : null).finally(() => setBusy(false));
      if (!r.ok) { setStatus(r.message ?? 'Your cart could not be saved in this browser.'); return; }
      const what = `${colourLabel ? `${colourLabel}, ` : ''}size ${size}`;
      setStatus(<>{r.capped ? `Your cart now has the maximum of ${MAX_QTY} in ${what}.` : `Added to cart: ${what}, quantity ${r.merged ? `now ${r.qty}` : r.qty}.`} <Link href={url.cart}>View cart</Link></>);
    }}>
      {coloured && (
        <fieldset className="st-fieldset st-colours-set">
          <legend>Colour <span aria-hidden="true">{colourLabel ?? 'Select a colour'}</span></legend>
          <div className="st-sizes st-colours">
            {colours.map(c => {
              const any = p.variants.some(v => v.colour === c.slug && v.available);
              return (
                <label className="st-size st-colour-opt" key={c.slug}>
                  <input type="radio" name="colour" value={c.slug} checked={colour === c.slug}
                    onChange={() => { setColour(c.slug); if (!p.variants.some(v => v.colour === c.slug && v.size === size && v.available)) setSize(''); setStatus(null); }} />
                  <span><i style={{ background: c.swatch || 'transparent' }} aria-hidden="true"></i>{c.label}{!any && <span className="st-colour-out"> · sold out</span>}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      )}
      <fieldset className={`st-fieldset${invalid ? ' is-invalid' : ''}`} {...(invalid ? { 'aria-describedby': 'st-buy-status' } : {})}>
        <legend>Size <span aria-hidden="true" data-size-label>{size ? `Selected: ${size}` : 'Select a size'}</span></legend>
        <div className="st-sizes">
          {sizes.map(v => (
            <label className="st-size" key={`${v.colour ?? ''}|${v.size}`}>
              <input type="radio" name="size" value={v.size} disabled={!v.available} checked={size === v.size} onChange={() => { setSize(v.size); setInvalid(false); }} />
              <span>{v.size}{!v.available && <span className="sr-only"> (unavailable)</span>}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="st-qty-row">
        <div className="st-qty" role="group" aria-label="Quantity">
          <button type="button" data-step="-1" aria-label="Decrease quantity" disabled={qty <= 1} onClick={() => setQtyState(q => clamp(q - 1))}>−</button>
          <input id="st-qty" type="number" inputMode="numeric" min={1} max={MAX_QTY} value={qty} aria-label="Quantity"
            onChange={e => setQtyState(Number(e.target.value) || 0)} onBlur={e => setQty(e.target.value)} />
          <button type="button" data-step="1" aria-label="Increase quantity" disabled={qty >= MAX_QTY} onClick={() => setQtyState(q => clamp(q + 1))}>+</button>
        </div>
        <button className="button st-add" type="submit" disabled={busy}>{busy ? 'Adding…' : 'Add to cart'}</button>
      </div>
      <WishButton id={p.id} label={`Save ${p.name} to wishlist`} variant="pdp" />
      <p className="st-phase-note st-buy-status" id="st-buy-status" role="status" aria-live="polite">{status}</p>
    </form>
  );
}
