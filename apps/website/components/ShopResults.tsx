'use client';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatMoney, pad, SORTS, sortList, url } from '@/lib/catalogue-utils';
import { activeCount, applyFilters, EMPTY, facetOptions, facetsFor, parseFilters, priceRange, writeFilters, type FilterState } from '@/lib/filters';
import type { Product } from '@/lib/types';
import { useStore } from './StoreProvider';
import { ProductGrid } from './ui';

export type Tab = { label: string; id: string; n: number };

/* Category tabs, the Filter & sort panel, active-filter chips and the grid. Sort and filters live in the URL
   (?sort=, ?size=, ?colour=, ?type=, ?min=, ?max=, ?stock=); only the sort is carried across the category tabs. */
export default function ShopResults({ productIds, tabs, isNew, base, initialSort }:
  { productIds: string[]; tabs: { label: string; items: Tab[]; current: string } | null; isNew: boolean; base: string; initialSort: string }) {
  const { idx } = useStore();
  // "Customer rating" is offered only once some product in the list has approved reviews.
  const sorts = SORTS(base).filter(s => s.id !== 'rating' || productIds.some(id => idx.byId.get(id)?.rating));
  const facets = useMemo(() => facetsFor(idx), [idx]);
  const list = useMemo(() => productIds.map(id => idx.byId.get(id)).filter((p): p is Product => !!p), [productIds, idx]);
  const [sort, setSort] = useState(sorts.some(s => s.id === initialSort) ? initialSort : 'default');
  const [filters, setFilters] = useState<FilterState>(EMPTY);
  // Filters come from the URL after hydration (the server renders the unfiltered list, so the markup always matches).
  useEffect(() => { setFilters(parseFilters(new URLSearchParams(location.search), facets)); }, [facets]);
  const [announce, setAnnounce] = useState('');
  const panel = useRef<HTMLDialogElement>(null);
  const tabHref = (id: string) => url.shop({ ...(id ? { category: id } : {}), ...(sort !== 'default' ? { sort } : {}) });

  const shown = useMemo(() => sortList(idx, applyFilters(list, filters, facets), sort), [idx, list, filters, facets, sort]);
  const range = priceRange(list);
  const nActive = activeCount(filters);
  // A facet with a single option cannot narrow the list, so it is not offered (e.g. Type inside a subcategory).
  const groups = facets.map(f => ({ f, opts: facetOptions(list, filters, facets, f) })).filter(g => g.opts.length > 1);

  /* The list always updates at once. For a typed price the address bar follows 250 ms after the last keystroke (it is
     not rewritten on every key; browsers limit how often a page may do that); other changes update it immediately. */
  const urlTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(urlTimer.current), []);
  const sync = (nextSort: string, next: FilterState, typing = false) => {
    clearTimeout(urlTimer.current);
    const write = () => {
      const q = writeFilters(new URLSearchParams(location.search), next, facets);
      if (nextSort === 'default') q.delete('sort'); else q.set('sort', nextSort);
      history.replaceState(history.state, '', location.pathname + (q.size ? '?' + q : ''));
    };
    if (typing) urlTimer.current = setTimeout(write, 250); else write();
  };
  const applySort = (next: string) => {
    setSort(next); sync(next, filters);
    setAnnounce(`Sorted by ${sorts.find(s => s.id === next)!.label.toLowerCase()}.`);
  };
  const applyFilter = (next: FilterState, typing = false) => {
    setFilters(next); sync(sort, next, typing);
    const n = applyFilters(list, next, facets).length;
    setAnnounce(`${n} ${n === 1 ? 'product' : 'products'} shown.`);
  };
  const toggle = (facet: string, value: string) => {
    const cur = filters.sel[facet] || [];
    applyFilter({ ...filters, sel: { ...filters.sel, [facet]: cur.includes(value) ? cur.filter(v => v !== value) : [...cur, value] } });
  };
  const setPrice = (key: 'min' | 'max', raw: string) => {
    const n = parseInt(raw, 10);
    applyFilter({ ...filters, [key]: Number.isFinite(n) && n >= 0 ? n : null }, true);
  };
  const clearAll = () => applyFilter(EMPTY);

  const chips = [
    ...groups.flatMap(({ f, opts }) => (filters.sel[f.id] || []).map(v => ({ key: `${f.id}:${v}`, label: `${f.label}: ${opts.find(o => o.value === v)?.label ?? v}`, remove: () => toggle(f.id, v) }))),
    ...(filters.min != null || filters.max != null ? [{ key: 'price', label: `Price: ${filters.min != null ? formatMoney(filters.min) : 'any'} – ${filters.max != null ? formatMoney(filters.max) : 'any'}`, remove: () => applyFilter({ ...filters, min: null, max: null }) }] : []),
    ...(filters.stock ? [{ key: 'stock', label: 'In stock only', remove: () => applyFilter({ ...filters, stock: false }) }] : [])
  ];

  return (
    <>
      {tabs && (
        <nav className="st-subnav" aria-label={tabs.label}>
          <ul>{tabs.items.map(t => <li key={t.id}><Link href={tabHref(t.id)} data-keep-sort="" {...(t.id === tabs.current ? { 'aria-current': 'page' as const } : {})}>{t.label}<sup>{pad(t.n)}</sup></Link></li>)}</ul>
        </nav>
      )}
      {list.length > 1 && (
        <div className="st-toolbar">
          <button className="st-filter-open" type="button" aria-haspopup="dialog" onClick={() => panel.current?.showModal()}>
            <FilterIcon /> Filter &amp; sort{nActive > 0 && <span className="st-filter-count">{nActive}</span>}
          </button>
          <span className="st-toolbar-count">{pad(shown.length)} of {pad(list.length)}</span>
          <div className="st-toolbar-sort">
            <label htmlFor="st-sort">Sort</label>
            <select id="st-sort" value={sort} onChange={e => applySort(e.target.value)}>{sorts.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
            <button className="st-clear" type="button" data-reset-sort="" hidden={sort === 'default'} onClick={() => { applySort('default'); document.getElementById('st-sort')?.focus(); }}>Reset</button>
          </div>
        </div>
      )}
      {chips.length > 0 && (
        <ul className="st-chips" aria-label="Active filters">
          {chips.map(c => <li key={c.key}><button type="button" onClick={c.remove} aria-label={`Remove filter ${c.label}`}>{c.label}<span aria-hidden="true">×</span></button></li>)}
          <li><button type="button" className="st-clear" onClick={clearAll}>Clear all</button></li>
        </ul>
      )}
      <div id="st-results">
        {!list.length ? <p className="st-status">No products in this category yet.</p>
          : shown.length ? <ProductGrid list={shown} pathOf={idx.categoryPath} opts={{ level: 2, isNew }} eagerFirst={4} />
          : <div className="st-status st-no-match"><p>No products match these filters.</p><button type="button" className="button" onClick={clearAll}>Clear filters</button></div>}
      </div>
      <p className="sr-only" role="status" aria-live="polite" id="st-sort-status">{announce}</p>

      <dialog className="st-filter" ref={panel} aria-labelledby="st-filter-title" onClick={e => { if (e.target === panel.current) panel.current.close(); }}>
        <div className="st-filter-inner">
          <header className="st-filter-head">
            <h2 id="st-filter-title">Filter &amp; sort</h2>
            <button type="button" className="st-filter-x" onClick={() => panel.current?.close()} aria-label="Close filters">×</button>
          </header>
          <div className="st-filter-body">
            <details open className="st-facet">
              <summary>Sort by</summary>
              <div className="st-facet-opts">{sorts.map(s => (
                <label key={s.id} className="st-opt"><input type="radio" name="st-sort-r" checked={sort === s.id} onChange={() => applySort(s.id)} /><span>{s.label}</span></label>
              ))}</div>
            </details>
            {groups.map(({ f, opts }) => (
              <details key={f.id} open className="st-facet">
                <summary>{f.label}{filters.sel[f.id]?.length ? <span>{filters.sel[f.id].length} selected</span> : null}</summary>
                <div className={`st-facet-opts${f.id === 'size' ? ' is-sizes' : ''}`}>{opts.map(o => (
                  <label key={o.value} className={`st-opt${o.count === 0 && !filters.sel[f.id]?.includes(o.value) ? ' is-empty' : ''}`}>
                    <input type="checkbox" checked={!!filters.sel[f.id]?.includes(o.value)} onChange={() => toggle(f.id, o.value)}
                      disabled={o.count === 0 && !filters.sel[f.id]?.includes(o.value)} />
                    <span>{o.label}</span><small>{pad(o.count)}</small>
                  </label>
                ))}</div>
              </details>
            ))}
            {range && range[0] !== range[1] && (
              <details open className="st-facet">
                <summary>Price{filters.min != null || filters.max != null ? <span>set</span> : null}</summary>
                <div className="st-price">
                  <label><span>Min ₹</span><input type="number" inputMode="numeric" min={0} step={100} placeholder={String(range[0])} value={filters.min ?? ''} onChange={e => setPrice('min', e.target.value)} /></label>
                  <span aria-hidden="true">–</span>
                  <label><span>Max ₹</span><input type="number" inputMode="numeric" min={0} step={100} placeholder={String(range[1])} value={filters.max ?? ''} onChange={e => setPrice('max', e.target.value)} /></label>
                </div>
                <p className="st-price-hint">This page: {formatMoney(range[0])} – {formatMoney(range[1])}</p>
              </details>
            )}
            <details open className="st-facet">
              <summary>Availability</summary>
              <div className="st-facet-opts">
                <label className="st-opt"><input type="checkbox" checked={filters.stock} onChange={() => applyFilter({ ...filters, stock: !filters.stock })} /><span>In stock only</span></label>
              </div>
            </details>
          </div>
          <footer className="st-filter-foot">
            <button type="button" className="st-clear" onClick={clearAll} disabled={!nActive}>Clear all</button>
            <button type="button" className="button" onClick={() => panel.current?.close()}>Show {shown.length} {shown.length === 1 ? 'product' : 'products'}</button>
          </footer>
        </div>
      </dialog>
    </>
  );
}

function FilterIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M2 4h12M4.5 8h7M7 12h2" /></svg>;
}
