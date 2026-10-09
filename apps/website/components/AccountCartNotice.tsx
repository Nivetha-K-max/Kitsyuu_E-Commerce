'use client';
import Link from 'next/link';
import { plural, url } from '@/lib/catalogue-utils';
import { useStore } from './StoreProvider';

/** Account overview: a cart with items is one tap from checkout (e.g. after creating an account on the way to pay). */
export default function AccountCartNotice() {
  const { ready, cartCount } = useStore();
  if (!ready || cartCount === 0) return null;
  return (
    <p className="st-acc-cart" data-account-cart>
      <Link href={url.cart}><span>Your cart has <b>{plural(cartCount, 'item')}</b> waiting</span><span>Go to cart <span aria-hidden="true">→</span></span></Link>
    </p>
  );
}
