'use client';
import { useEffect, useRef } from 'react';
import { plural } from '@/lib/catalogue-utils';
import type { Product } from '@/lib/types';
import { PageHead } from './CartView';
import { useStore } from './StoreProvider';
import { EmptyState, ProductGrid } from './ui';

export default function WishlistView() {
  const { idx, ready, wishIds } = useStore();
  const list = wishIds.map(id => idx.byId.get(id)).filter((p): p is Product => !!p);
  const prev = useRef(list.length);
  /* When a heart removes a product here, keep keyboard focus on the page instead of losing it with the card. */
  useEffect(() => {
    if (list.length < prev.current && !document.activeElement?.closest('.st-card')) document.getElementById('st-page-title')?.focus();
    prev.current = list.length;
  }, [list.length]);
  if (!ready) return <div className="st-wrap"><p className="st-status">Loading…</p></div>;
  return (
    <div className="st-wrap">
      <PageHead label="Wishlist" title="Wishlist" aside={<><p className="st-result-count">{plural(list.length, 'product')}</p><p>Saved in this browser. Choose a size on the product page to add a piece to your cart.</p></>} />
      {list.length ? <ProductGrid list={list} pathOf={idx.categoryPath} opts={{ level: 2 }} /> : <EmptyState title="Your wishlist is empty." text="Tap the heart on any product to save it here." />}
    </div>
  );
}
