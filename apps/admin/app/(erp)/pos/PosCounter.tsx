'use client';
/* The POS counter: search / scan → pick colour and size → bill → customer → (coupon, points, discount) → payment → bill printed.
   2026-10-12: a coupon code and, for a customer on the bill, their loyalty points. The counter only says WHICH coupon and
   WHETHER to use points; whether either applies and what it takes off is the server's answer (the quote), shown line by line.
   Built for speed: one screen, keyboard first (F2 search, Enter adds a scanned barcode / exact SKU, F9 takes payment),
   large touch targets, no animation. Prices, tax, discounts and stock are always worked out on the server (quote), and
   the sale is completed on the server only for the total the cashier saw. */
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { posCompleteAction, posCustomersAction, posQuoteAction, posSearchAction, posStockAction } from './actions';

type Variant = { variantId: string; sku: string; barcode: string | null; size: string; colour: string | null; colourLabel: string | null; unitPaise: number; stock: number };
type Product = { productId: string; name: string; image: string | null; category: string | null; variants: Variant[] };
type Line = { variantId: string; qty: number; image: string | null; name: string; sku: string; size: string; colourLabel: string | null; unitPaise: number; stock: number };
type Customer = { id: string; email: string; full_name: string | null; phone: string | null };
type Quote = NonNullable<Extract<Awaited<ReturnType<typeof posQuoteAction>>, { ok: true }>['data']>;
type Method = 'cash' | 'upi' | 'card';
type Done = { orderId: string; posNumber: string; totalPaise: number; changePaise: number };

const inr = (p: number) => '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const newKey = () => (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, '');
const MAX = 10;
/* The keypad (2026-10-13) types into ONE thing at a time: the quantity of the selected line, the cash received, or the
   staff discount %. It is a second way to enter what the fields already take; nothing is priced here. */
type Pad = 'qty' | 'cash' | 'discount';
const PAD_KEYS = ['7', '8', '9', 'C', '4', '5', '6', '⌫', '1', '2', '3', '+', '.', '0', '00', '−'] as const;

export default function PosCounter({ session, locations, maxDiscountBp, canDiscount }: {
  session: { id: string; number: string; location_id: string; location_name: string };
  /** The branches POS can bill at. The session belongs to one of them (its cash drawer is counted there). */
  locations: { id: string; name: string; code: string }[];
  maxDiscountBp: number | null; canDiscount: boolean;
}) {
  const [q, setQ] = useState(''); const [results, setResults] = useState<Product[]>([]); const [searchMsg, setSearchMsg] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [quote, setQuote] = useState<Quote | null>(null); const [quoteErr, setQuoteErr] = useState('');
  const [customer, setCustomer] = useState<Customer | null>(null); const [custQ, setCustQ] = useState(''); const [custResults, setCustResults] = useState<Customer[]>([]);
  const [contactName, setContactName] = useState(''); const [contactPhone, setContactPhone] = useState('');
  const [discount, setDiscount] = useState(''); const [reason, setReason] = useState('');
  const [coupon, setCoupon] = useState(''); const [usePoints, setUsePoints] = useState(false);
  const [method, setMethod] = useState<Method>('cash'); const [tendered, setTendered] = useState(''); const [reference, setReference] = useState('');
  const [error, setError] = useState(''); const [done, setDone] = useState<Done | null>(null);
  const [key, setKey] = useState(newKey);
  const [paying, startPay] = useTransition();
  const searchRef = useRef<HTMLInputElement>(null);
  // The branch's stock, shown while nothing is searched; and the store the cashier asked for, when it is not this session's.
  const [stock, setStock] = useState<Product[]>([]); const [stockMore, setStockMore] = useState(false); const [stockState, setStockState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [otherStore, setOtherStore] = useState('');
  const [cat, setCat] = useState('');                 // category chip ('' = all); applies to the branch's stock list
  const [pad, setPad] = useState<Pad>('qty'); const [sel, setSel] = useState('');   // keypad target; the bill line it works on
  const loadStock = useCallback(async () => {
    const r = await posStockAction(session.location_id);
    if (!r.ok) { setStockState('error'); return; }
    setStock(r.data.products); setStockMore(r.data.more); setStockState('ready');
  }, [session.location_id]);
  useEffect(() => { void loadStock(); }, [loadStock]);
  // The staff discount is offered only when it can be used: this cashier may give one and a maximum is set (Configuration → Discounts).
  const offerDiscount = canDiscount && !!maxDiscountBp;
  const discountPercent = offerDiscount ? Math.max(0, Number(discount) || 0) : 0;

  // ---------- search (debounced); Enter adds an exact barcode / SKU match
  const searchSeq = useRef(0);
  const runSearch = useCallback(async (term: string, addExact: boolean) => {
    const mine = ++searchSeq.current;
    if (!term.trim()) { setResults([]); setSearchMsg(''); return; }
    let r: Awaited<ReturnType<typeof posSearchAction>>;
    try { r = await posSearchAction(session.location_id, term); }
    catch { if (mine === searchSeq.current) setSearchMsg('Search could not reach the server. Check the connection and try again.'); return; }
    if (mine !== searchSeq.current) return;                       // a newer search has been sent since: its answer is the one shown
    if (!r.ok) { setSearchMsg(r.message); return; }
    setResults(r.data.products);
    setSearchMsg(r.data.products.length ? '' : 'No product matches.');
    if (addExact && r.data.exact) { add(r.data.exact, r.data.exact.name); setQ(''); setResults([]); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.location_id]);
  useEffect(() => { const t = setTimeout(() => void runSearch(q, false), 200); return () => clearTimeout(t); }, [q, runSearch]);

  function add(v: Variant, name: string, image: string | null = null) {
    setError(''); setDone(null); setSel(v.variantId);
    setLines(ls => {
      const at = ls.find(l => l.variantId === v.variantId);
      const next = (at?.qty ?? 0) + 1;
      if (next > v.stock) { setError(`Only ${v.stock} of ${name} ${v.colourLabel ? v.colourLabel + ', ' : ''}size ${v.size} in stock at ${session.location_name}.`); return ls; }
      if (next > MAX) { setError(`At most ${MAX} of one size per bill.`); return ls; }
      return at ? ls.map(l => l.variantId === v.variantId ? { ...l, qty: next, stock: v.stock } : l)
        : [...ls, { variantId: v.variantId, qty: 1, image, name, sku: v.sku, size: v.size, colourLabel: v.colourLabel, unitPaise: v.unitPaise, stock: v.stock }];
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
  const couponCode = coupon.trim();
  const quoteKey = JSON.stringify([lines.map(l => [l.variantId, l.qty]), customer?.id ?? null, discountPercent, couponCode, usePoints]);
  // Points belong to the customer on the bill: changing or removing the customer starts again without them.
  useEffect(() => { setUsePoints(false); }, [customer?.id]);
  useEffect(() => {
    if (!lines.length) { setQuote(null); setQuoteErr(''); return; }
    let live = true;
    const t = setTimeout(async () => {
      let r: Awaited<ReturnType<typeof posQuoteAction>>;
      try {
        r = await posQuoteAction({ locationId: session.location_id, lines: lines.map(l => ({ variantId: l.variantId, qty: l.qty })), customerId: customer?.id ?? null,
          discountPercent, discountReason: reason, couponCode, usePoints: usePoints && !!customer });
      } catch { if (live) { setQuote(null); setQuoteErr('The total could not be worked out: the server could not be reached. Check the connection.'); } return; }
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
    && (discountPercent === 0 || reason.trim().length >= 3)
    // A coupon or points that the server did not apply must be taken off the bill before payment (the server refuses the sale otherwise).
    && (!couponCode || !!quote.coupon?.applied) && (!usePoints || (quote.loyalty?.usedPoints ?? 0) > 0);

  function pay() {
    if (!ready || !quote) return;
    setError('');
    startPay(async () => {
      let r: Awaited<ReturnType<typeof posCompleteAction>>;
      try {
        r = await posCompleteAction({ sessionId: session.id, idempotencyKey: key, lines: lines.map(l => ({ variantId: l.variantId, qty: l.qty })), customerId: customer?.id ?? null,
          contactName, contactPhone, discountPercent, discountReason: reason, method, tendered, reference, expectedTotalPaise: quote.totals.totalPaise,
          couponCode, usePoints: usePoints && !!customer });
      } catch {
        // The request did not come back (connection dropped, timeout). The sale may or may not have been saved. The bill and
        // its key are kept exactly as they are: pressing Charge again asks the server, which never saves the same bill twice.
        setError('The server did not answer, so it is not known yet whether this sale was saved. Do not change the bill: press Charge again. The same bill is never charged twice.');
        return;
      }
      if (!r.ok) { setError(r.message); return; }
      setDone({ orderId: r.data.orderId, posNumber: r.data.posNumber, totalPaise: r.data.totalPaise, changePaise: r.data.changePaise });
    });
  }
  function newSale() {
    setLines([]); setQuote(null); setCustomer(null); setCustQ(''); setContactName(''); setContactPhone(''); setDiscount(''); setReason(''); setCoupon(''); setUsePoints(false);
    setMethod('cash'); setTendered(''); setReference(''); setError(''); setDone(null); setKey(newKey()); setQ(''); setResults([]);
    void loadStock();                                   // the sale just made changed what is left at this branch
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

  // ---------- category chips: the categories of what is in stock at this branch, with how many products each holds
  const cats = useMemo(() => { const m = new Map<string, number>(); for (const p of stock) if (p.category) m.set(p.category, (m.get(p.category) ?? 0) + 1); return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])); }, [stock]);
  const searching = !!q.trim();
  const shown = searching ? results : cat ? stock.filter(p => p.category === cat) : stock;
  const selected = lines.find(l => l.variantId === sel) ?? lines[lines.length - 1] ?? null;

  // ---------- keypad
  const typeInto = (cur: string, k: string, decimals: boolean) => k === 'C' ? '' : k === '⌫' ? cur.slice(0, -1) : k === '.' ? (decimals && !cur.includes('.') ? (cur || '0') + '.' : cur) : (cur + k).slice(0, 9);
  function press(k: typeof PAD_KEYS[number]) {
    if (pad === 'qty') {
      if (!selected) { setError('Add a product first, then set its quantity.'); return; }
      if (k === '+') setQty(selected.variantId, selected.qty + 1);
      else if (k === '−') setQty(selected.variantId, selected.qty - 1);
      else if (k === 'C' || k === '⌫') setQty(selected.variantId, 1);
      else if (/^[1-9]$/.test(k)) setQty(selected.variantId, Number(k));
      return;
    }
    if (k === '+' || k === '−') return;
    if (pad === 'cash') setTendered(t => typeInto(t, k, true));
    else setDiscount(d => typeInto(d, k, true));
  }
  const padOn = (p: Pad) => p === 'qty' || (p === 'cash' ? method === 'cash' : offerDiscount);
  useEffect(() => { if (!padOn(pad)) setPad('qty'); });

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
      <section className="pos-left" aria-label="Products">
       <div className="pos-bar card">
        <div className="pos-store" data-pos-store>
          <label htmlFor="pos-store">Store / branch</label>
          <select id="pos-store" className="input" value={otherStore || session.location_id} onChange={e => setOtherStore(e.target.value === session.location_id ? '' : e.target.value)} data-pos-store-select>
            {locations.some(l => l.id === session.location_id) ? null : <option value={session.location_id}>{session.location_name}</option>}
            {locations.map(l => <option key={l.id} value={l.id}>{l.name} ({l.code})</option>)}
          </select>
        </div>
        {otherStore && (
          <p className="msg" role="status" data-pos-store-switch>
            This session and its cash drawer belong to <b>{session.location_name}</b>, so bills here take stock from {session.location_name} only.
            To bill at {locations.find(l => l.id === otherStore)?.name ?? 'another store'}, <Link href="/pos/sessions#close">close this session</Link> and open one there.{' '}
            <button type="button" className="btn ghost" onClick={() => setOtherStore('')} data-pos-store-stay>Stay at {session.location_name}</button>
          </p>
        )}
        <div className="pos-find">
        <label className="pos-search-label" htmlFor="pos-search">Scan barcode or search name / SKU <kbd>F2</kbd></label>
        <input id="pos-search" ref={searchRef} className="pos-search" value={q} autoFocus autoComplete="off" placeholder="Scan or type…"
          onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void runSearch(q, true); } if (e.key === 'Escape') { setQ(''); setResults([]); } }} data-pos-search />
        </div>
       </div>
        {searchMsg && <p className="note" data-pos-search-msg>{searchMsg}</p>}
        {!searching && stock.length > 0 && cats.length > 1 && (
          <div className="pos-cats" role="group" aria-label="Filter by category" data-pos-cats>
            <button type="button" className={`pos-cat${cat === '' ? ' active' : ''}`} aria-pressed={cat === ''} onClick={() => setCat('')} data-pos-cat="all"><span>All</span><b>{stock.length}</b></button>
            {cats.map(([name, n]) => <button key={name} type="button" className={`pos-cat${cat === name ? ' active' : ''}`} aria-pressed={cat === name} onClick={() => setCat(name)} data-pos-cat={name}><span>{name}</span><b>{n}</b></button>)}
          </div>
        )}
        {!q.trim() && (
          <p className="pos-stock-head" data-pos-stock-head>
            {stockState === 'loading' ? `Loading the stock at ${session.location_name}…`
              : stockState === 'error' ? `The stock at ${session.location_name} could not be loaded. Search still works.`
              : stock.length === 0 ? `Nothing is in stock at ${session.location_name}. Receive or transfer stock to this store (Inventory) to sell here.`
              : `In stock at ${session.location_name}${stockMore ? ' (first ' + stock.length + ' products; search for the rest)' : ''}`}
          </p>
        )}
        <ul className="pos-results pos-grid" data-pos-results data-pos-listing={searching ? 'search' : 'stock'}>
          {shown.map(p => { const left = p.variants.reduce((n, v) => n + Math.max(0, v.stock), 0), low = Math.min(...p.variants.map(v => v.unitPaise)), high = Math.max(...p.variants.map(v => v.unitPaise)); return (
            <li key={p.productId} className="pos-product pos-tile" data-pos-product={p.productId}>
              <div className="pos-tile-img">{p.image ? <img src={p.image} alt="" loading="lazy" /> : <span className="pos-noimg" aria-hidden="true" />}</div>
              <div className="pos-tile-body">
                <b>{p.name}</b>
                <div className="pos-tile-meta"><span className="pos-tile-price">{low === high ? inr(low) : `${inr(low)} – ${inr(high)}`}</span><span>Available: {left}</span></div>
              </div>
              <div className="pos-variants">
                {p.variants.map(v => (
                  <button key={v.variantId} type="button" className="pos-variant" disabled={v.stock <= 0} onClick={() => add(v, p.name, p.image)}
                    data-pos-variant={v.sku} title={`${v.stock > 0 ? v.stock + ' in stock' : 'Out of stock'} · ${inr(v.unitPaise)} · ${v.sku}${v.barcode ? ' · ' + v.barcode : ''}`}>
                    <span>{v.colourLabel ? `${v.colourLabel} · ` : ''}{v.size}</span>
                    <small className="pos-variant-more">{low === high ? '' : `${inr(v.unitPaise)} · `}{v.stock > 0 ? `${v.stock} in stock` : 'out of stock'}</small>
                  </button>
                ))}
              </div>
            </li>
          ); })}
        </ul>
      </section>

      <section className="pos-right card" aria-label="Bill">
        <div className="pos-bill-head"><h2>Bill</h2>{lines.length > 0 && <button type="button" className="btn ghost" onClick={newSale} data-pos-clear>Clear</button>}</div>
        {lines.length === 0 ? <p className="pos-empty" data-pos-empty>No items yet. Tap a size on the left, or scan a barcode.</p> : (
          <table className="pos-lines" data-pos-lines>
            <thead><tr><th>Item</th><th className="num">Price</th><th className="num">Qty</th><th className="num">Amount</th><th><span className="sr-only">Remove</span></th></tr></thead>
            <tbody>{lines.map(l => (
              <tr key={l.variantId} data-pos-line={l.sku} className={selected?.variantId === l.variantId ? 'sel' : undefined} onClick={() => setSel(l.variantId)} aria-selected={selected?.variantId === l.variantId}>
                <td><div className="pos-line-item">{l.image ? <img src={l.image} alt="" loading="lazy" /> : <span className="pos-noimg" aria-hidden="true" />}<div>{l.name}<div className="note">{l.colourLabel ? `${l.colourLabel} · ` : ''}Size {l.size} · <span className="mono">{l.sku}</span> · {l.stock} in stock</div></div></div></td>
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
              <label htmlFor="pos-cust">Customer (optional)</label>
              <input id="pos-cust" value={custQ} onChange={e => setCustQ(e.target.value)} autoComplete="off" placeholder="Walk-in customer · or search phone, email, name" data-pos-customer-search />
              {custResults.length > 0 && <ul className="pos-cust-results">{custResults.map(c => (
                <li key={c.id}><button type="button" className="btn ghost" onClick={() => { setCustomer(c); setCustQ(''); setCustResults([]); }} data-pos-customer-pick={c.email}>
                  {c.full_name ?? '—'} · {c.phone ?? ''} · {c.email}</button></li>))}</ul>}
              <details className="pos-walkin" data-pos-walkin><summary>Add a name or phone for this walk-in customer</summary>
              <div className="pos-row">
                <input aria-label="Walk-in name (optional)" placeholder="Name (optional)" value={contactName} onChange={e => setContactName(e.target.value)} data-pos-contact-name />
                <input aria-label="Walk-in phone (optional)" placeholder="Phone (optional)" value={contactPhone} onChange={e => setContactPhone(e.target.value)} inputMode="tel" data-pos-contact-phone />
              </div>
              </details>
            </>
          )}
        </div>

        {lines.length > 0 && (
          <div className="pos-row pos-discount" data-pos-coupon>
            <label className="grow">Coupon code (optional)<input value={coupon} onChange={e => setCoupon(e.target.value.toUpperCase().slice(0, 40))} autoComplete="off" autoCapitalize="characters" placeholder="No coupon" data-pos-coupon-code /></label>
            {couponCode && <button type="button" className="btn ghost" onClick={() => setCoupon('')} data-pos-coupon-clear>Remove</button>}
            {couponCode && quote?.coupon && (quote.coupon.applied
              ? <p className="note" role="status" data-pos-coupon-state="applied">Coupon {quote.coupon.code} applied.</p>
              : <p className="msg error" role="alert" data-pos-coupon-state="rejected">{quote.coupon.message ?? 'This coupon does not apply.'} Remove it to take payment.</p>)}
          </div>
        )}
        {customer && quote?.loyalty && (
          <div className="pos-row pos-discount" data-pos-loyalty>
            <p className="grow">Loyalty points: <b data-pos-points-balance>{quote.loyalty.balance}</b> available{!quote.loyalty.redeemable ? ' · points cannot be used yet (Configuration → Loyalty)' : ''}</p>
            {quote.loyalty.redeemable && quote.loyalty.usablePoints > 0 && (
              <label><input type="checkbox" checked={usePoints} onChange={e => setUsePoints(e.target.checked)} data-pos-use-points /> Use {quote.loyalty.usablePoints} points (− {inr(quote.loyalty.usableValuePaise)})</label>)}
            {quote.loyalty.redeemable && quote.loyalty.usablePoints === 0 && <p className="note" data-pos-points-note>{quote.loyalty.message ?? 'No points can be used on this bill.'}</p>}
          </div>
        )}

        {offerDiscount && (
          <div className="pos-row pos-discount" data-pos-discount>
            <label>Discount %<input value={discount} onChange={e => setDiscount(e.target.value.replace(/[^0-9.]/g, ''))} inputMode="decimal" placeholder="0" data-pos-discount-pct /></label>
            <label className="grow">Reason<input value={reason} onChange={e => setReason(e.target.value)} placeholder="Required for a discount" data-pos-discount-reason /></label>
            <span className="note">Max {maxDiscountBp / 100}%</span>
          </div>
        )}

        {quote && (
          <dl className="pos-totals" data-pos-totals>
            {/* The one bill breakdown (core bill.ts), worked out on the server: every discount on its own line, in the order it is taken off. */}
            {quote.bill.lines.map((l, n) => l.kind === 'subtotal' ? <span key={n} style={{ display: 'contents' }}><dt>Subtotal ({quote.totals.units} item{quote.totals.units === 1 ? '' : 's'})</dt><dd>{inr(l.amountPaise)}</dd></span>
              : l.kind === 'total' ? null
              : <span key={n} style={{ display: 'contents' }} data-pos-bill-line={l.kind}><dt>{l.label}</dt><dd {...(l.effect < 0 ? { 'data-pos-discount-amount': l.amountPaise } : {})}>{l.effect < 0 ? '− ' : ''}{inr(l.amountPaise)}</dd></span>)}
            {!quote.totals.tax.configured && <><dt>Tax</dt><dd>Not configured</dd></>}
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
          {lines.length > 0 && <details className="pos-pad" data-pos-pad open>
            <summary>Keypad</summary>
            <div className="pos-pad-tabs" role="tablist" aria-label="Keypad enters">
              {(['qty', 'cash', 'discount'] as Pad[]).filter(padOn).map(p => (
                <button key={p} type="button" role="tab" aria-selected={pad === p} className={`pos-pad-tab${pad === p ? ' active' : ''}`} onClick={() => setPad(p)} data-pos-pad-tab={p}>{p === 'qty' ? 'Quantity' : p === 'cash' ? 'Cash received' : 'Discount %'}</button>
              ))}
            </div>
            <p className="pos-pad-target" data-pos-pad-target>
              {pad === 'qty' ? (selected ? <>{selected.name} · size {selected.size}: <b>{selected.qty}</b></> : 'No line selected') : pad === 'cash' ? <>Cash received: <b>{tendered ? `₹${tendered}` : '—'}</b></> : <>Discount: <b>{discount ? `${discount}%` : '—'}</b></>}
            </p>
            <div className="pos-pad-keys">
              {PAD_KEYS.map(k => <button key={k} type="button" className={`pos-key${k === 'C' || k === '⌫' || k === '+' || k === '−' ? ' fn' : ''}`} onClick={() => press(k)}
                disabled={pad === 'qty' ? k === '.' || k === '00' || k === '0' : k === '+' || k === '−'} aria-label={k === 'C' ? 'Clear' : k === '⌫' ? 'Delete' : k === '+' ? 'One more' : k === '−' ? 'One less' : k} data-pos-key={k}>{k}</button>)}
            </div>
          </details>}
          <button type="button" className="btn primary pos-charge" disabled={!ready} onClick={pay} data-pos-charge>
            {paying ? 'Recording payment…' : quote ? `Charge ${inr(total)} (F9)` : 'Charge'}
          </button>
          <div className="pos-foot">
            <Link className="btn ghost" href="/pos/sessions" data-pos-sales-link>Sessions &amp; sales</Link>
            <Link className="btn ghost" href="/pos/sessions#close" data-pos-end-link>End session</Link>
          </div>
        </div>
      </section>
    </div>
  );
}
