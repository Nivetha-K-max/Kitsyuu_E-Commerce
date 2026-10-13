'use client';
/* Return / exchange at the counter (2026-10-13). The cashier says WHAT comes back (and whether it is damaged) and WHAT the
   customer takes instead; every amount shown is the server's (quote), and the exchange is saved for exactly the figures
   shown. One of four outcomes is displayed before confirming: Collect, Store credit, Refund, or Even. */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { posExchangeQuoteAction, posExchangeSettleAction, posSearchAction, type TenderInput } from '../../actions';

type Line = { id: string; name: string; size: string; colour: string | null; sku: string; bought: number; returnable: number; unitValuePaise: number; image: string | null };
type Variant = { variantId: string; sku: string; size: string; colourLabel: string | null; unitPaise: number; stock: number };
type Product = { productId: string; name: string; image: string | null; variants: Variant[] };
type Pick = { variantId: string; qty: number; name: string; size: string; unitPaise: number; stock: number };
type Quote = NonNullable<Extract<Awaited<ReturnType<typeof posExchangeQuoteAction>>, { ok: true }>['data']>;
type Done = NonNullable<Extract<Awaited<ReturnType<typeof posExchangeSettleAction>>, { ok: true }>['data']>;
const inr = (p: number) => '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const newKey = () => (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, '');

export default function ExchangeCounter({ orderId, number, session, lines, reasons, hasCustomer, canStoreCredit, canRefund }: {
  orderId: string; number: string; session: { id: string; location_id: string; location_name: string }; lines: Line[];
  reasons: { code: string; label: string }[]; hasCustomer: boolean; canStoreCredit: boolean; canRefund: boolean;
}) {
  const [back, setBack] = useState<Record<string, { qty: number; damaged: boolean }>>({});
  const [reason, setReason] = useState(reasons[0]?.code ?? ''); const [note, setNote] = useState('');
  const [q, setQ] = useState(''); const [results, setResults] = useState<Product[]>([]); const [picks, setPicks] = useState<Pick[]>([]);
  const [quote, setQuote] = useState<Quote | null>(null); const [err, setErr] = useState('');
  const [surplus, setSurplus] = useState<'store_credit' | 'refund'>(hasCustomer && canStoreCredit ? 'store_credit' : 'refund');
  const [method, setMethod] = useState<'cash' | 'upi' | 'card'>('cash'); const [reference, setReference] = useState('');
  const [key] = useState(newKey); const [done, setDone] = useState<Done | null>(null);
  const [busy, start] = useTransition();
  const router = useRouter();
  const seq = useRef(0);

  const items = useMemo(() => lines.filter(l => (back[l.id]?.qty ?? 0) > 0).map(l => ({ orderItemId: l.id, qty: back[l.id]!.qty, restock: !back[l.id]!.damaged })), [back, lines]);
  const replacements = useMemo(() => picks.map(p => ({ variantId: p.variantId, qty: p.qty })), [picks]);

  useEffect(() => {
    if (!q.trim()) { setResults([]); return; }
    const t = setTimeout(async () => { const r = await posSearchAction(session.location_id, q); if (r.ok) setResults(r.data.products); }, 220);
    return () => clearTimeout(t);
  }, [q, session.location_id]);

  // the server's figures, whenever the selection changes
  useEffect(() => {
    if (!items.length) { setQuote(null); setErr(''); return; }
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      let r: Awaited<ReturnType<typeof posExchangeQuoteAction>>;
      try { r = await posExchangeQuoteAction({ orderId, locationId: session.location_id, items, replacements }); }
      catch { if (mine === seq.current) { setQuote(null); setErr('The amounts could not be worked out: the server could not be reached.'); } return; }
      if (mine !== seq.current) return;
      if (r.ok) { setQuote(r.data); setErr(r.data.problems.join(' ')); } else { setQuote(null); setErr(r.message); }
    }, 180);
    return () => clearTimeout(t);
  }, [items, replacements, orderId, session.location_id]);

  const setQty = (l: Line, qty: number) => setBack(b => ({ ...b, [l.id]: { qty: Math.max(0, Math.min(l.returnable, qty)), damaged: b[l.id]?.damaged ?? false } }));
  const addPick = (p: Product, v: Variant) => setPicks(ps => {
    const at = ps.find(x => x.variantId === v.variantId);
    if ((at?.qty ?? 0) + 1 > v.stock) { setErr(`Only ${v.stock} of ${p.name} size ${v.size} in stock at ${session.location_name}.`); return ps; }
    return at ? ps.map(x => x.variantId === v.variantId ? { ...x, qty: x.qty + 1 } : x) : [...ps, { variantId: v.variantId, qty: 1, name: p.name, size: v.size, unitPaise: v.unitPaise, stock: v.stock }];
  });

  const due = quote?.duePaise ?? 0, owed = quote?.surplusPaise ?? 0;
  const outcome = !quote ? null : due > 0 ? `Collect ${inr(due)}` : owed > 0 ? (surplus === 'refund' ? `Refund ${inr(owed)}` : `Issue store credit ${inr(owed)}`) : 'Even — no additional settlement';
  const blocked = !quote || !!err || !reason || busy || (due > 0 && method !== 'cash' && reference.trim().length < 4)
    || (owed > 0 && surplus === 'store_credit' && (!hasCustomer || !canStoreCredit)) || (owed > 0 && surplus === 'refund' && !canRefund);

  function confirm() {
    if (blocked || !quote) return;
    setErr('');
    start(async () => {
      const tenders: TenderInput[] | undefined = due > 0 ? [{ method, amount: String(due / 100), reference, tendered: method === 'cash' ? String(due / 100) : undefined }] : undefined;
      let r: Awaited<ReturnType<typeof posExchangeSettleAction>>;
      try { r = await posExchangeSettleAction({ sessionId: session.id, orderId, items, reasonCode: reason, note, replacements, surplus, tenders, expected: { returnValuePaise: quote.returnValuePaise, replacementPaise: quote.replacementPaise }, key }); }
      catch { setErr('The server did not answer, so it is not known yet whether this was saved. Do not change anything: press Confirm again. The same exchange is never saved twice.'); return; }
      if (!r.ok) { setErr(r.message); return; }
      setDone(r.data);
      // Saving refreshes this page (the order now has nothing left to return): the result is shown from the saved return.
      router.replace(`/pos/exchange/${orderId}?done=${r.data.returnId}`);
    });
  }

  if (done) return (
    <section className="pos-done card" data-exchange-done aria-live="polite">
      <h2>Return {done.returnNumber} saved</h2>
      <p className="pos-done-total" data-exchange-outcome={done.outcome}>
        {done.outcome === 'collect' ? `Collected ${inr(done.amountPaise)}` : done.outcome === 'store_credit' ? `Store credit issued ${inr(done.amountPaise)}` : done.outcome === 'refund' ? `Refund ${inr(done.amountPaise)}: give it to the customer` : 'Even — nothing more to settle'}
      </p>
      <div className="pos-done-actions">
        {done.replacementOrderId && <a className="btn pos-big" href={`/pos/sale/${done.replacementOrderId}?print=1`} target="_blank" rel="noreferrer" data-exchange-print>Print replacement bill</a>}
        <Link className="btn ghost pos-big" href={`/returns/${done.returnId}`}>View return</Link>
        <Link className="btn primary pos-big" href="/pos" data-exchange-new>Back to the counter</Link>
      </div>
    </section>
  );

  return (
    <div className="pos pos-exchange" data-exchange>
      <section className="pos-left" aria-label="What comes back and what goes out">
        <div className="card">
          <h2>1. What is the customer returning?</h2>
          <table className="pos-lines" data-exchange-lines><tbody>{lines.map(l => (
            <tr key={l.id} data-exchange-line={l.sku} className={(back[l.id]?.qty ?? 0) > 0 ? 'sel' : undefined}>
              <td><div className="pos-line-item">{l.image ? <img src={l.image} alt="" loading="lazy" /> : <span className="pos-noimg" aria-hidden="true" />}<div>{l.name}
                <div className="note">{l.colour ? `${l.colour} · ` : ''}Size {l.size} · bought {l.bought}{l.returnable < l.bought ? ` · ${l.bought - l.returnable} already returned` : ''}</div>
                {(back[l.id]?.qty ?? 0) > 0 && <label className="pos-damaged"><input type="checkbox" checked={back[l.id]!.damaged} onChange={e => setBack(b => ({ ...b, [l.id]: { ...b[l.id]!, damaged: e.target.checked } }))} data-exchange-damaged /> Damaged: do not put back on sale</label>}
              </div></div></td>
              <td>{inr(l.unitValuePaise)}</td>
              <td><div className="pos-qty">
                <button type="button" className="btn ghost" aria-label={`One less ${l.sku}`} onClick={() => setQty(l, (back[l.id]?.qty ?? 0) - 1)} disabled={(back[l.id]?.qty ?? 0) === 0}>−</button>
                <span data-exchange-qty>{back[l.id]?.qty ?? 0}</span>
                <button type="button" className="btn ghost" aria-label={`One more ${l.sku}`} onClick={() => setQty(l, (back[l.id]?.qty ?? 0) + 1)} disabled={(back[l.id]?.qty ?? 0) >= l.returnable} data-exchange-plus>+</button>
              </div></td>
              <td>{inr(l.unitValuePaise * (back[l.id]?.qty ?? 0))}</td><td />
            </tr>
          ))}</tbody></table>
          <div className="pos-row">
            <label>Reason<select className="input" value={reason} onChange={e => setReason(e.target.value)} data-exchange-reason>{reasons.map(r => <option key={r.code} value={r.code}>{r.label}</option>)}</select></label>
            <label className="grow">Note (optional)<input value={note} onChange={e => setNote(e.target.value.slice(0, 500))} data-exchange-note /></label>
          </div>
        </div>
        <div className="card">
          <h2>2. What are they taking instead? <span className="note">(leave empty for a return only)</span></h2>
          <input className="pos-search" value={q} onChange={e => setQ(e.target.value)} placeholder={`Search the stock at ${session.location_name}…`} autoComplete="off" data-exchange-search />
          {results.length > 0 && <ul className="pos-results pos-grid" data-exchange-results>{results.map(p => (
            <li key={p.productId} className="pos-product pos-tile">
              <div className="pos-tile-body"><b>{p.name}</b></div>
              <div className="pos-variants">{p.variants.map(v => (
                <button key={v.variantId} type="button" className="pos-variant" disabled={v.stock <= 0} onClick={() => addPick(p, v)} title={`${inr(v.unitPaise)} · ${v.stock} in stock`} data-exchange-variant={v.sku}><span>{v.colourLabel ? `${v.colourLabel} · ` : ''}{v.size}</span></button>
              ))}</div>
            </li>
          ))}</ul>}
          {picks.length > 0 && <table className="pos-lines" data-exchange-picks><tbody>{picks.map(p => (
            <tr key={p.variantId}><td>{p.name}<div className="note">Size {p.size}</div></td><td>{inr(p.unitPaise)}</td>
              <td><div className="pos-qty"><button type="button" className="btn ghost" onClick={() => setPicks(ps => ps.flatMap(x => x.variantId !== p.variantId ? [x] : x.qty > 1 ? [{ ...x, qty: x.qty - 1 }] : []))} aria-label="One less">−</button><span>{p.qty}</span>
                <button type="button" className="btn ghost" onClick={() => setPicks(ps => ps.map(x => x.variantId === p.variantId && x.qty < x.stock ? { ...x, qty: x.qty + 1 } : x))} aria-label="One more" disabled={p.qty >= p.stock}>+</button></div></td>
              <td>{inr(p.unitPaise * p.qty)}</td>
              <td><button type="button" className="btn ghost" onClick={() => setPicks(ps => ps.filter(x => x.variantId !== p.variantId))} aria-label="Remove">×</button></td></tr>
          ))}</tbody></table>}
        </div>
      </section>

      <section className="pos-right card" aria-label="Settlement">
        <div className="pos-bill-head"><h2>Settlement · {number}</h2></div>
        {!quote ? <p className="pos-empty">Choose what is being returned to see the amounts.</p> : (
          <dl className="pos-totals" data-exchange-totals>
            <dt>Value of the return</dt><dd data-exchange-return-value={quote.returnValuePaise}>{inr(quote.returnValuePaise)}</dd>
            <dt>Replacement</dt><dd data-exchange-replacement={quote.replacementPaise}>{quote.replacementPaise ? inr(quote.replacementPaise) : '—'}</dd>
            <dt className="pos-total">{due > 0 ? 'Customer pays' : owed > 0 ? 'Shop owes' : 'Difference'}</dt><dd className="pos-total" data-exchange-difference={due > 0 ? due : -owed}>{inr(due > 0 ? due : owed)}</dd>
          </dl>
        )}
        {quote && <p className="pos-outcome" role="status" data-exchange-outcome-label>{outcome}</p>}
        {quote && due > 0 && (
          <div className="pos-pay">
            <div className="pos-methods" role="radiogroup" aria-label="How the difference is paid">
              {(['cash', 'upi', 'card'] as const).map(m => <button key={m} type="button" role="radio" aria-checked={method === m} className={`btn pos-method${method === m ? ' active' : ''}`} onClick={() => setMethod(m)} data-exchange-method={m}>{m === 'cash' ? 'Cash' : m === 'upi' ? 'UPI' : 'Card'}</button>)}
            </div>
            {method !== 'cash' && <label>{method === 'upi' ? 'UPI transaction reference (UTR)' : 'Card approval / transaction reference'}<input value={reference} onChange={e => setReference(e.target.value)} autoComplete="off" data-exchange-reference /></label>}
          </div>
        )}
        {quote && owed > 0 && (
          <div className="pos-pay" role="radiogroup" aria-label="How the difference is given">
            <label className="pos-choice"><input type="radio" name="surplus" checked={surplus === 'store_credit'} onChange={() => setSurplus('store_credit')} disabled={!hasCustomer || !canStoreCredit} data-exchange-surplus="store_credit" /> Store credit (never expires)
              {!hasCustomer && <span className="note"> — needs a customer account on the order</span>}{hasCustomer && !canStoreCredit && <span className="note"> — your role cannot issue store credit</span>}</label>
            <label className="pos-choice"><input type="radio" name="surplus" checked={surplus === 'refund'} onChange={() => setSurplus('refund')} disabled={!canRefund} data-exchange-surplus="refund" /> Refund in money
              {!canRefund && <span className="note"> — needs the refund permission, and an order paid in the shop</span>}</label>
          </div>
        )}
        {err && <p className="msg error" role="alert" data-exchange-error>{err}</p>}
        <button type="button" className="btn primary pos-charge" disabled={blocked} onClick={confirm} data-exchange-confirm>{busy ? 'Saving…' : quote ? `Confirm: ${outcome}` : 'Confirm'}</button>
        <p className="note">Returned stock comes into {session.location_name}. The original bill is kept as it is; the return and any replacement bill are linked to it.</p>
      </section>
    </div>
  );
}
