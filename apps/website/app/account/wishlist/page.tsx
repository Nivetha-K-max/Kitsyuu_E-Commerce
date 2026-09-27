import type { Metadata } from 'next';
import WishlistView from '@/components/WishlistView';
import { requireCustomer } from '@/lib/server';

export const metadata: Metadata = { title: 'Wishlist' };

/* The wishlist is still kept in this browser (as on /wishlist); M7 moves it to the account. */
export default async function AccountWishlistPage() {
  await requireCustomer('/account/wishlist');
  return <div className="st-account-embed"><WishlistView /></div>;
}
