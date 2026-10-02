'use client';
/* The POS counter: search / scan → pick colour and size → bill → customer → (discount) → payment → bill printed.
   Built for speed: one screen, keyboard first (F2 search, Enter adds a scanned barcode / exact SKU, F9 takes payment),
   large touch targets, no animation. Prices, tax, discounts and stock are always worked out on the server (quote), and
   the sale is completed on the server only for the total the cashier saw. */
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { posCompleteAction, posCustomersAction, posQuoteAction, posSearchAction } from './actions';

type Variant = { variantId: string; sku: string; barcode: string | null; size: string; colour: string | null; colourLabel: string | null; unitPaise: number; stock: number };
type Product = { productId: string; name: string; image: string | null; variants: Variant[] };
type Line = { variantId: string; qty: number; name: string; sku: string; size: string; colourLabel: string | null; unitPaise: number; stock: number };
type Customer = { id: string; email: string; full_name: string | null; phone: string | null };
type Quote = NonNullable<Extract<Awaited<ReturnType<typeof posQuoteAction>>, { ok: true }>['data']>;
type Method = 'cash' | 'upi' | 'card';
type Done = { orderId: string; posNumber: string; totalPaise: number; changePaise: number };

const inr = (p: number) => '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const newKey = () => (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, '');
const MAX = 10;

export default function PosCounter({ session, maxDiscountBp, canDiscount }: {
  session: { id: string; number: string; location_id: string; location_name: string };
  maxDiscountBp: number | null; canDiscount: boolean;
}) {
  const [q, setQ] = useState(''); const [results, setResults] = useState<Product[]>([]); const [searchMsg, setSearchMsg] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [quote, setQuote] = useState<Quote | null>(null); const [quoteErr, setQuoteErr] = useState('');
  const [customer, setCustomer] = useState<Customer | null>(null); const [custQ, setCustQ] = useState(''); const [custResults, setCustResults] = useState<Customer[]>([]);
  const [contactName, setContactName] = useState(''); const [contactPhone, setContactPhone] = useState('');
  const [discount, setDiscount] = useState(''); const [reason, setReason] = useState('');
  const [method, setMethod] = useState<Method>('cash'); const [tendered, setTendered] = useState(''); const [reference, setReference] = useState('');
  const [error, setError] = useState(''); const [done, setDone] = useState<Done | null>(null);
  const [key, setKey] = useState(newKey);
  const [paying, startPay] = useTransition();
  const searchRef = useRef<HTMLInputElement>(null);
  const discountPercent = canDiscount ? Math.max(0, Number(discount) || 0) : 0;

  // ---------- search (debounced); Enter adds an exact barcode / SKU match
  const runSearch = useCallback(async (term: string, addExact: boolean) => {
    if (!term.trim()) { setResults([]); setSearchMsg(''); return; }
    const r = await posSearchAction(session.location_id, term);
    if (!r.ok) { setSearchMsg(r.message); return; }
    setResults(r.data.products);
    setSearchMsg(r.data.products.length ? '' : 'No product matches.');
    if (addExact && r.data.exact) { add(r.data.exact, r.data.exact.name); setQ(''); setResults([]); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.location_id]);
  useEffect(() => { const t = setTimeout(() => void runSearch(q, false), 200); return () => clearTimeout(t); }, [q, runSearch]);

  function add(v: Variant, name: string) {
    setError(''); setDone(null);
    setLines(ls => {
      const at = ls.find(l => l.variantId === v.variantId);
      const next = (at?.qty ?? 0) + 1;
      if (next > v.stock) { setError(`Only ${v.stock} of ${name} ${v.colourLabel ? v.colourLabel + ', ' : ''}size ${v.size} in stock at ${session.location_name}.`); return ls; }
      if (next > MAX) { setError(`At most ${MAX} of one size per bill.`); return ls; }
      return at ? ls.map(l => l.variantId === v.variantId ? { ...l, qty: next, stock: v.stock } : l)
        : [...ls, { variantId: v.variantId, qty: 1, name, sku: v.sku, size: v.size, colourLabel: v.colourLabel, unitPaise: v.unitPaise, stock: v.stock }];
    });
  }
  function setQty(id: string, qty: number) {
    setError('');
    setLines(ls => ls.flatMap(l => {
      if (l.variantId !== id) return [l];
      if (qty <= 0) return [];
      if (qty > l.stock) { setError(`Only ${l.stock} of ${l.name} size ${l.size} in stock at this branch.`); return [l]; }
      return [{ ...l, qty: Math.min(qty, MAX) }];
    }));
  }

  // ---------- server quote whenever the bill changes
  const quoteKey = JSON.stringify([lines.map(l => [l.variantId, l.qty]), customer?.id ?? null, discountPercent]);
  useEffect(() => {
    if (!lines.length) { setQuote(null); setQuoteErr(''); return; }
    let live = true;
    const t = setTimeout(async () => {
      const r = await posQuoteAction({ locationId: session.location_id, lines: lines.map(l => ({ variantId: l.variantId, qty: l.qty })), customerId: customer?.id ?? null,
        discountPercent, discountReason: reason });
      if (!live) return;
      if (r.ok && r.data) { setQuote(r.data); setQuoteErr(r.data.problems.join(' ')); setLines(ls => ls.map(l => { const x = r.data!.lines.find(y => y.variantId === l.variantId); return x ? { ...l, stock: x.stock, unitPaise: x.unitPaise } : l; })); }
      else if (!r.ok) { setQuote(null); setQuoteErr(r.message); }
    }, 150);
    return () => { live = false; clearTimeout(t); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteKey, session.location_id]);

  // ---------- customers
  useEffect(() => {
    if (custQ.trim().length < 3) { setCustResults([]); return; }
    const t = setTimeout(async () => { const r = await posCustomersAction(custQ); if (r.ok) setCustResults(r.data as Customer[]); }, 250);
    return () => clearTimeout(t);
  }, [custQ]);

  const total = quote?.totals.totalPaise ?? 0;
  const tenderedPaise = Math.round((Number(tendered.replace(/[,₹\s]/g, '')) || 0) * 100);
  const change = method === 'cash' ? tenderedPaise - total : 0;
  const ready = !!quote && !quoteErr && lines.length > 0 && !paying
    && (method === 'cash' ? tenderedPaise >= total : reference.trim().length >= 4)
    && (discountPercent === 0 || reason.trim().length >= 3);

  function pay() {
    if (!ready || !quote) return;
    setError('');
    startPay(async () => {
      const r = await posCompleteAction({ sessionId: session.id, idempotencyKey: key, lines: lines.map(l => ({ variantId: l.variantId, qty: l.qty })), customerId: customer?.id ?? null,
        contactName, contactPhone, discountPercent, discountReason: reason, method, tendered, reference, expectedTotalPaise: quote.totals.totalPaise });
      if (!r.ok) { setError(r.message); return; }
      setDone({ orderId: r.data.orderId, posNumber: r.data.posNumber, totalPaise: r.data.totalPaise, changePaise: r.data.changePaise });
    });
  }
  function newSale() {
    setLines([]); setQuote(null); setCustomer(null); setCustQ(''); setContactName(''); setContactPhone(''); setDiscount(''); setReason('');
    setMethod('cash'); setTendered(''); setReference(''); setError(''); setDone(null); setKey(newKey()); setQ(''); setResults([]);
    setTimeout(() => searchRef.current?.focus(), 0);
  }

  // ---------- keyboard: F2 search, F9 pay, Esc clears the search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F2') { e.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); }
      if (e.key === 'F9') { e.preventDefault(); if (done) newSale(); else pay(); }
    };
    addEventListener('keydown', onKey); return () => removeEventListener('keydown', onKey);
  });

  const quick = useMemo(() => { if (!total) return []; const r = Math.ceil(total / 10000) * 10000; return [...new Set([total, r, Math.ceil(total / 50000) * 50000, Math.ceil(total / 100000) * 100000])].slice(0, 4); }, [total]);

  if (done) return (
    <section className="pos-done card" data-pos-done aria-live="polite">
      <h2>Payment received · {done.posNumber}</h2>
      <p className="pos-done-total">{inr(done.totalPaise)}</p>
      {done.changePaise > 0 && <p className="pos-change" data-pos-change>Change to give: <b>{inr(done.changePaise)}</b></p>}
      <div className="pos-done-actions">
        <a className="btn pos-big" href={`/pos/sale/${done.orderId}?print=1`} target="_blank" rel="noreferrer" data-pos-print>Print bill</a>
        <Link className="btn ghost pos-big" href={`/pos/sale/${done.orderId}`}>View sale</Link>
        <button type="button" className="btn primary pos-big" onClick={newSale} data-pos-new autoFocus>New sale (F9)</button>
      </div>
    </section>
  );

  return (
    <div className="pos" data-pos>
      <section className="pos-left card" aria-label="Products">
        <label className="pos-search-label" htmlFor="pos-search">Scan barcode or search name / SKU <kbd>F2</kbd></label>
        <input id="pos-search" ref={searchRef} className="pos-search" value={q} autoFocus autoComplete="off" placeholder="Scan or type…"
          onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void runSearch(q, true); } if (e.key === 'Escape') { setQ(''); setResults([]); } }} data-pos-search />
        {searchMsg && <p className="note" data-pos-search-msg>{searchMsg}</p>}
        <ul className="pos-results" data-pos-results>
          {results.map(p => (
            <li key={p.productId} className="pos-product">
              <div className="pos-product-head">
                {p.image ? <img src={p.image} alt="" width={44} height={56} loading="lazy" /> : <span className="pos-noimg" aria-hidden="true" />}
                <b>{p.name}</b>
              </div>
              <div className="pos-variants">
                {p.variants.map(v => (
                  <button key={v.variantId} type="button" className="pos-variant" disabled={v.stock <= 0} onClick={() => add(v, p.name)}
                    data-pos-variant={v.sku} title={`${v.sku}${v.barcode ? ' · ' + v.barcode : ''}`}>
                    <span>{v.colourLabel ? `${v.colourLabel} · ` : ''}{v.size}</span>
                    <small>{inr(v.unitPaise)} · {v.stock > 0 ? `${v.stock} in stock` : 'out of stock'}</small>
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="pos-right card" aria-label="Bill">
        <div className="pos-bill-head"><h2>Bill</h2>{lines.length > 0 && <button type="button" className="btn ghost" onClick={newSale} data-pos-clear>Clear</button>}</div>
        {lines.length === 0 ? <p className="note">Scan or search a product to start the bill.</p> : (
          <table className="pos-lines" data-pos-lines>
            <thead><tr><th>Item</th><th className="num">Price</th><th className="num">Qty</th><th className="num">Amount</th><th><span className="sr-only">Remove</span></th></tr></thead>
            <tbody>{lines.map(l => (
              <tr key={l.variantId} data-pos-line={l.sku}>
                <td>{l.name}<div className="note">{l.colourLabel ? `${l.colourLabel} · ` : ''}Size {l.size} · <span className="mono">{l.sku}</span> · {l.stock} in stock</div></td>
                <td className="num">{inr(l.unitPaise)}</td>
                <td className="num"><div className="pos-qty">
                  <button type="button" className="btn ghost" aria-label={`One less ${l.sku}`} onClick={() => setQty(l.variantId, l.qty - 1)} data-pos-minus>−</button>
                  <span data-pos-qty>{l.qty}</span>
                  <button type="button" className="btn ghost" aria-label={`One more ${l.sku}`} onClick={() => setQty(l.variantId, l.qty + 1)} disabled={l.qty >= l.stock || l.qty >= MAX} data-pos-plus>+</button>
                </div></td>
                <td className="num">{inr(l.unitPaise * l.qty)}</td>
                <td><button type="button" className="btn ghost" aria-label={`Remove ${l.sku}`} onClick={() => setQty(l.variantId, 0)} data-pos-remove>×</button></td>
              </tr>
            ))}</tbody>
          </table>
        )}

        <div className="pos-customer" data-pos-customer>
          {customer ? (
            <p>Customer: <b>{customer.full_name ?? customer.email}</b> · {customer.phone ?? customer.email} <button type="button" className="btn ghost" onClick={() => setCustomer(null)} data-pos-customer-clear>Change</button></p>
          ) : (
            <>
              <label htmlFor="pos-cust">Customer (optional): phone, email or name — leave empty for a walk-in customer</label>
              <input id="pos-cust" value={custQ} onChange={e => setCustQ(e.target.value)} autoComplete="off" placeholder="Walk-in customer" data-pos-customer-search />
              {custResults.length > 0 && <ul className="pos-cust-results">{custResults.map(c => (
                <li key={c.id}><button type="button" className="btn ghost" onClick={() => { setCustomer(c); setCustQ(''); setCustResults([]); }} data-pos-customer-pick={c.email}>
                  {c.full_name ?? '—'} · {c.phone ?? ''} · {c.email}</button></li>))}</ul>}
              <div className="pos-row">
                <input aria-label="Walk-in name (optional)" placeholder="Name (optional)" value={contactName} onChange={e => setContactName(e.target.value)} data-pos-contact-name />
                <input aria-label="Walk-in phone (optional)" placeholder="Phone (optional)" value={contactPhone} onChange={e => setContactPhone(e.target.value)} inputMode="tel" data-pos-contact-phone />
              </div>
            </>
          )}
        </div>

        {canDiscount && (
          <div className="pos-row pos-discount" data-pos-discount>
            <label>Discount %<input value={discount} onChange={e => setDiscount(e.target.value.replace(/[^0-9.]/g, ''))} inputMode="decimal" placeholder="0" data-pos-discount-pct /></label>
            <label className="grow">Reason<input value={reason} onChange={e => setReason(e.target.value)} placeholder="Required for a discount" data-pos-discount-reason /></label>
            <span className="note">{maxDiscountBp ? `Max ${maxDiscountBp / 100}%` : 'Discounts not set up (Settings → Discounts)'}</span>
          </div>
        )}

        {quote && (
          <dl className="pos-totals" data-pos-totals>
            <dt>Subtotal ({quote.totals.units} item{quote.totals.units === 1 ? '' : 's'})</dt><dd>{inr(quote.totals.subtotalPaise)}</dd>
            {quote.totals.discountPaise > 0 && <><dt>Discount</dt><dd data-pos-discount-amount>− {inr(quote.totals.discountPaise)}</dd></>}
            <dt>{quote.totals.tax.configured ? `${quote.totals.tax.label}${quote.totals.pricesIncludeTax ? ' (included)' : ''}` : 'Tax'}</dt>
            <dd>{quote.totals.tax.configured ? inr(quote.totals.taxPaise) : 'Not configured'}</dd>
            <dt className="pos-total">Total payable</dt><dd className="pos-total" data-pos-total={quote.totals.totalPaise}>{inr(quote.totals.totalPaise)}</dd>
          </dl>
        )}
        {quoteErr && <p className="msg error" role="alert" data-pos-quote-error>{quoteErr}</p>}

        <div className="pos-pay" data-pos-pay>
          <div className="pos-methods" role="radiogroup" aria-label="Payment method">
            {(['cash', 'upi', 'card'] as Method[]).map(m => (
              <button key={m} type="button" role="radio" aria-checked={method === m} className={`btn pos-method${method === m ? ' active' : ''}`} onClick={() => setMethod(m)} data-pos-method={m}>
                {m === 'cash' ? 'Cash' : m === 'upi' ? 'UPI' : 'Card'}
              </button>
            ))}
          </div>
          {method === 'cash' ? (
            <div className="pos-row">
              <label className="grow">Cash received (₹)<input value={tendered} onChange={e => setTendered(e.target.value)} inputMode="decimal" data-pos-tendered /></label>
              <div className="pos-quick">{quick.map(p => <button key={p} type="button" className="btn ghost" onClick={() => setTendered(String(p / 100))} data-pos-quick>{inr(p)}</button>)}</div>
              {total > 0 && tenderedPaise >= total && <p className="pos-change" data-pos-change-preview>Change: <b>{inr(change)}</b></p>}
            </div>
          ) : (
            <label>{method === 'upi' ? 'UPI transaction reference (UTR) — after the customer’s payment succeeds' : 'Card approval / transaction reference — from the terminal slip'}
              <input value={reference} onChange={e => setReference(e.target.value)} autoComplete="off" data-pos-reference /></label>
          )}
          {error && <p className="msg error" role="alert" data-pos-error>{error}</p>}
          <button type="button" className="btn primary pos-charge" disabled={!ready} onClick={pay} data-pos-charge>
            {paying ? 'Recording payment…' : quote ? `Charge ${inr(total)} (F9)` : 'Charge'}
          </button>
        </div>
      </section>
    </div>
  );
}
