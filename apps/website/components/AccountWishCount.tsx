'use client';
import { useStore } from './StoreProvider';

/** Number of saved products, from the wishlist the store already holds in memory (no request of its own). */
export default function AccountWishCount() {
  const { ready, wishIds } = useStore();
  return <>{ready ? wishIds.length : '–'}</>;
}
