'use client';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { formatMoney, imageOf, MAX_QTY, plural, url } from '@/lib/catalogue-utils';
import type { CartLine } from '@/lib/types';
import { useStore } from './StoreProvider';
import { Crumbs, EmptyState } from './ui';

export function LineImage({ line }: { line: CartLine }) {
  const { idx } = useStore();
  const img = imageOf(idx.byId.get(line.id)!);
  return img.held ? <img src={img.src} alt="" width={600} height={800} /> : <img src={img.src} alt="" width={img.width} height={img.height} loading="lazy" decoding="async" />;
}

export function PageHead({ label, title, aside }: { label: string; title: string; aside?: React.ReactNode }) {
  return (
    <>
      <Crumbs list={[{ label: 'Store', href: url.home }, { label }]} />
      <header className="st-plp-head"><h1 id="st-page-title" tabIndex={-1}>{title}</h1>{aside && <div className="st-plp-aside">{aside}</div>}</header>
    </>
  );
}

export default function CartView() {
  const { idx, ready, lines, cartCount, subtotal, setQty, removeLine, toast } = useStore();
  const focusNext = useRef<string | null>(null);
  useEffect(() => {
    if (!focusNext.current) return;
    const sel = focusNext.current; focusNext.current = null;
    (document.querySelector<HTMLElement>(sel) || document.getElementById('st-page-title'))?.focus();
  });
  const key = (l: CartLine) => `${l.id}|${l.size}`;
  const sel = (k: string, inner: string) => `[data-line="${CSS.escape(k)}"] ${inner}`;
  if (!ready) return <div className="st-wrap"><p className="st-status">Loading…</p></div>;

  return (
    <div className="st-wrap">
      <PageHead label="Cart" title="Cart" aside={<p className="st-result-count">{plural(cartCount, 'item')}</p>} />
      {lines.length ? (
        <div className="st-cart">
          <ul className="st-lines" aria-label="Items in your cart">
            {lines.map((l, n) => {
              const p = idx.byId.get(l.id)!, href = url.product(p), k = key(l);
              const step = (d: number) => {
                const next = setQty(l.id, l.size, l.qty + d);
                focusNext.current = sel(k, `[data-line-step="${d}"]:not(:disabled)`);
                if (next) toast(`${l.name}, size ${l.size}: quantity ${next.qty}.`);
              };
              return (
                <li className="st-line" data-line={k} key={k}>
                  <Link className="st-line-media" href={href} tabIndex={-1} aria-hidden="true"><LineImage line={l} /></Link>
                  <div className="st-line-info">
                    <h2 className="st-line-name"><Link href={href}>{l.name}</Link></h2>
                    <p className="st-line-meta">SKU {l.sku}<br />Size <b>{l.size}</b></p>
                    <p className="st-line-unit">{formatMoney(l.price)} <small>each</small></p>
                  </div>
                  <div className="st-line-controls">
                    <div className="st-qty" role="group" aria-label={`Quantity for ${l.name}, size ${l.size}`}>
                      <button type="button" data-line-step="-1" aria-label="Decrease quantity" disabled={l.qty <= 1} onClick={() => step(-1)}>−</button>
                      <input type="number" inputMode="numeric" min={1} max={MAX_QTY} defaultValue={l.qty} key={l.qty} data-line-qty="" aria-label="Quantity"
                        onBlur={e => { if (Number(e.target.value) !== l.qty) { setQty(l.id, l.size, Number(e.target.value)); focusNext.current = sel(k, '[data-line-qty]'); } }}
                        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
                      <button type="button" data-line-step="1" aria-label="Increase quantity" disabled={l.qty >= MAX_QTY} onClick={() => step(1)}>+</button>
                    </div>
                    <button className="st-line-remove" type="button" data-line-remove="" onClick={() => {
                      const nb = lines[n + 1] || lines[n - 1];
                      focusNext.current = nb ? sel(key(nb), '[data-line-remove]') : '#st-page-title';
                      removeLine(l.id, l.size); toast(`Removed ${l.name}, size ${l.size}, from your cart.`);
                    }}>Remove<span className="sr-only"> {l.name}, size {l.size}</span></button>
                  </div>
                  <p className="st-line-total"><span className="sr-only">Line total </span>{formatMoney(l.price * l.qty)}</p>
                </li>
              );
            })}
          </ul>
          <aside className="st-summary" aria-labelledby="st-summary-title">
            <h2 id="st-summary-title">Summary</h2>
            <dl><dt>Subtotal <small>({plural(cartCount, 'item')})</small></dt><dd>{formatMoney(subtotal)}</dd><dt>Shipping</dt><dd>Not calculated</dd></dl>
            <Link className="button st-checkout" href={url.checkout}>Checkout (prototype)</Link>
            <p className="st-note">Prototype checkout. No payment is taken and no order is placed. Prices are estimates in INR; tax inclusion is unconfirmed.</p>
            <Link className="text-link" href={url.shop()}>Continue shopping <span aria-hidden="true">↗</span></Link>
          </aside>
        </div>
      ) : <EmptyState title="Your cart is empty." text="Choose a product and a size to add it here." />}
    </div>
  );
}
