'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { plural, searchProducts, url } from '@/lib/catalogue-utils';
import { PageHead } from './CartView';
import { useStore } from './StoreProvider';
import { ProductGrid } from './ui';

export default function SearchView() {
  const { idx } = useStore();
  const initial = useSearchParams().get('q') || '';
  const [value, setValue] = useState(initial), [q, setQ] = useState(initial.trim());
  const input = useRef<HTMLInputElement>(null), timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => { if (!initial) input.current?.focus(); }, [initial]);
  const run = (v: string) => { const t = v.trim(); setQ(t); history.replaceState(null, '', url.search(t)); };
  const hits = searchProducts(idx, q);
  const browse = (
    <ul className="st-search-browse">
      {[...idx.top, ...idx.c.categories.filter(c => c.parent)].map(c => <li key={c.id}><Link href={url.shop({ category: c.id })}>{c.parent ? `${idx.catLabel(c.parent)} / ${c.label}` : c.label}</Link></li>)}
    </ul>
  );
  return (
    <div className="st-wrap">
      <PageHead label="Search" title="Search" />
      <form className="st-search" role="search" action={url.search()} onSubmit={e => { e.preventDefault(); clearTimeout(timer.current); run(value); }}>
        <label htmlFor="st-q">Search by product name, SKU or category</label>
        <div className="st-search-row">
          <input ref={input} id="st-q" name="q" type="search" value={value} autoComplete="off" spellCheck={false} placeholder="Hoodie, KTS-BTM-004, jeans…"
            onChange={e => { const v = e.target.value; setValue(v); clearTimeout(timer.current); timer.current = setTimeout(() => run(v), 160); }} />
          <button className="button" type="submit">Search</button>
        </div>
      </form>
      <p className="st-result-count st-search-count" id="st-search-count" role="status" aria-live="polite">{q ? `${plural(hits.length, 'result')} for “${q}”` : ''}</p>
      <div id="st-results">
        {!q ? <section className="st-search-empty"><h2>Browse categories</h2>{browse}</section>
          : hits.length ? <ProductGrid list={hits} pathOf={idx.categoryPath} opts={{ level: 2 }} />
          : <section className="st-search-empty"><h2>No products match “{q}”.</h2><p>Check the spelling, try a shorter word, or search by SKU (for example KTS-TOP-004). You can also browse a category:</p>{browse}
              <button className="st-clear" type="button" data-clear-search="" onClick={() => { setValue(''); run(''); input.current?.focus(); }}>Clear search</button></section>}
      </div>
    </div>
  );
}
