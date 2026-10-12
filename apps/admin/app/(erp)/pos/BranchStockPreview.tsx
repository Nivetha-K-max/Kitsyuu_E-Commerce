'use client';
/* Open-session screen (client request, 2026-10-09): the products available at the store chosen in the "Store / branch"
   list, shown as soon as a store is selected and before the session is opened. Read-only: nothing is reserved or sold
   here. It follows the form's own select, so the form itself is unchanged. */
import { useEffect, useState } from 'react';
import { posStockAction } from './actions';

type Variant = { variantId: string; sku: string; size: string; colourLabel: string | null; unitPaise: number; stock: number };
type Product = { productId: string; name: string; image: string | null; variants: Variant[] };
const inr = (p: number) => '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function BranchStockPreview({ formId, locations }: { formId: string; locations: { id: string; name: string }[] }) {
  const [locationId, setLocationId] = useState(locations[0]?.id ?? '');
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [products, setProducts] = useState<Product[]>([]); const [more, setMore] = useState(false);
  const name = locations.find(l => l.id === locationId)?.name ?? 'this store';

  // follow the store chosen in the form
  useEffect(() => {
    const select = document.querySelector<HTMLSelectElement>(`#${formId} select[name=locationId]`);
    if (!select) return;
    const onChange = () => setLocationId(select.value);
    onChange();
    select.addEventListener('change', onChange);
    return () => select.removeEventListener('change', onChange);
  }, [formId]);

  useEffect(() => {
    if (!locationId) return;
    let live = true;
    setState('loading');
    void posStockAction(locationId).then(r => {
      if (!live) return;
      if (!r.ok) { setState('error'); return; }
      setProducts(r.data.products as Product[]); setMore(r.data.more); setState('ready');
    });
    return () => { live = false; };
  }, [locationId]);

  const units = products.reduce((n, p) => n + p.variants.reduce((m, v) => m + v.stock, 0), 0);
  return (
    <section className="card pos-preview" aria-labelledby="pos-preview-h" aria-busy={state === 'loading' || undefined} data-pos-preview={locationId}>
      <h2 id="pos-preview-h">Available at {name}</h2>
      {state === 'loading' ? <p className="note">Loading the stock at {name}…</p>
        : state === 'error' ? <p className="msg error" role="alert">The stock at {name} could not be loaded.</p>
        : products.length === 0 ? <p className="note" data-pos-preview-empty>Nothing is in stock at {name}. Send stock to this store with a transfer (Inventory → Transfers) or receive a purchase order there; then it can be sold here.</p>
        : (
          <>
            <p className="note" data-pos-preview-count>{more ? `The first ${products.length} products` : `${products.length} product${products.length === 1 ? '' : 's'} · ${units} unit${units === 1 ? '' : 's'}`} in stock at this store. Open the session to start billing.</p>
            <ul className="pos-results pos-preview-list" data-pos-preview-list>
              {products.map(p => (
                <li key={p.productId} className="pos-product">
                  <div className="pos-product-head">
                    {p.image ? <img src={p.image} alt="" width={44} height={56} loading="lazy" /> : <span className="pos-noimg" aria-hidden="true" />}
                    <b>{p.name}</b>
                  </div>
                  <div className="pos-variants">
                    {p.variants.map(v => (
                      <span key={v.variantId} className="pos-variant pos-variant-view" data-pos-preview-variant={v.sku}>
                        <span>{v.colourLabel ? `${v.colourLabel} · ` : ''}{v.size}</span>
                        <small>{inr(v.unitPaise)} · {v.stock} in stock</small>
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
    </section>
  );
}
