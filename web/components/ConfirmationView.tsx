'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { url } from '@/lib/catalogue-utils';
import type { CartLine } from '@/lib/types';
import { PageHead } from './CartView';
import { Summary } from './CheckoutView';
import { KEYS, useStore } from './StoreProvider';
import { Crumbs, EmptyState } from './ui';

type Order = { ref: string; lines: CartLine[]; customer?: Record<string, string>; shipping?: Record<string, string> };

export default function ConfirmationView() {
  const { idx } = useStore();
  const [order, setOrder] = useState<Order | null | undefined>(undefined);
  useEffect(() => {
    let o: Order | null = null;
    try { o = JSON.parse(sessionStorage.getItem(KEYS.order) || 'null'); } catch {}
    setOrder(o?.ref && Array.isArray(o.lines) ? o : null);
  }, []);
  useEffect(() => { if (order) document.getElementById('st-page-title')?.focus(); }, [order]);

  if (order === undefined) return <div className="st-wrap"><p className="st-status">Loading…</p></div>;
  if (!order) return <div className="st-wrap"><PageHead label="Prototype order" title="Prototype order" /><EmptyState title="No prototype order to show." text="A confirmation appears here after you complete the prototype checkout in this tab." /></div>;
  const s = order.shipping || {}, c = order.customer || {};
  const ship = [s.address1, s.address2, [s.city, s.state].filter(Boolean).join(', '), s.pin, s.country].filter(Boolean);
  return (
    <div className="st-wrap">
      <Crumbs list={[{ label: 'Store', href: url.home }, { label: 'Prototype order' }]} />
      <section className="st-confirm" aria-labelledby="st-page-title">
        <p className="eyebrow"><span></span>PROTOTYPE / NOT A REAL PURCHASE</p>
        <h1 id="st-page-title" tabIndex={-1}>Prototype order<br /><em>complete.</em></h1>
        <p className="st-confirm-lead">This was a demonstration checkout. No order was placed with KITSYUU, nothing was charged, and no details were sent.</p>
        <dl className="st-confirm-ref"><dt>Prototype reference</dt><dd>{order.ref}</dd></dl>
      </section>
      <div className="st-cart st-checkout-layout">
        <div className="st-confirm-details">
          <section className="st-form-group"><h2>Contact</h2><p>{c.name}<br />{c.email}<br />{c.phone}</p></section>
          <section className="st-form-group"><h2>Ship to</h2><p>{ship.map((t, i) => <span key={i}>{i > 0 && <br />}{t}</span>)}</p></section>
          <Link className="button" href={url.shop()}>Continue shopping</Link>
        </div>
        <Summary lines={order.lines.filter(l => idx.byId.has(l.id))} title="Items" />
      </div>
    </div>
  );
}
