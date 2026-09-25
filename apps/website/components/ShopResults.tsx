'use client';
import Link from 'next/link';
import { useState } from 'react';
import { pad, SORTS, sortList, url } from '@/lib/catalogue-utils';
import type { Product } from '@/lib/types';
import { useStore } from './StoreProvider';
import { ProductGrid } from './ui';

export type Tab = { label: string; id: string; n: number };

/* Category tabs, sort control and grid. The sort lives in the URL (?sort=) and is carried across the tabs. */
export default function ShopResults({ productIds, tabs, isNew, base, initialSort }:
  { productIds: string[]; tabs: { label: string; items: Tab[]; current: string } | null; isNew: boolean; base: string; initialSort: string }) {
  const { idx } = useStore();
  const sorts = SORTS(base);
  const [sort, setSort] = useState(sorts.some(s => s.id === initialSort) ? initialSort : 'default');
  const [announce, setAnnounce] = useState('');
  const list = productIds.map(id => idx.byId.get(id)).filter((p): p is Product => !!p);
  const tabHref = (id: string) => url.shop({ ...(id ? { category: id } : {}), ...(sort !== 'default' ? { sort } : {}) });

  const apply = (next: string) => {
    setSort(next);
    const q = new URLSearchParams(location.search);
    if (next === 'default') q.delete('sort'); else q.set('sort', next);
    history.replaceState(null, '', location.pathname + (q.size ? '?' + q : ''));
    setAnnounce(`Sorted by ${sorts.find(s => s.id === next)!.label.toLowerCase()}.`);
  };

  return (
    <>
      {tabs && (
        <nav className="st-subnav" aria-label={tabs.label}>
          <ul>{tabs.items.map(t => <li key={t.id}><Link href={tabHref(t.id)} data-keep-sort="" {...(t.id === tabs.current ? { 'aria-current': 'page' as const } : {})}>{t.label}<sup>{pad(t.n)}</sup></Link></li>)}</ul>
        </nav>
      )}
      {list.length > 1 && (
        <div className="st-toolbar">
          <label htmlFor="st-sort">Sort</label>
          <select id="st-sort" value={sort} onChange={e => apply(e.target.value)}>{sorts.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
          <button className="st-clear" type="button" data-reset-sort="" hidden={sort === 'default'} onClick={() => { apply('default'); document.getElementById('st-sort')?.focus(); }}>Reset</button>
        </div>
      )}
      <div id="st-results">
        {list.length ? <ProductGrid list={sortList(idx, list, sort)} pathOf={idx.categoryPath} opts={{ level: 2, isNew }} /> : <p className="st-status">No products in this category yet.</p>}
      </div>
      <p className="sr-only" role="status" aria-live="polite" id="st-sort-status">{announce}</p>
    </>
  );
}
