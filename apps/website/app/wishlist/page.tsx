import type { Metadata } from 'next';
import WishlistView from '@/components/WishlistView';
export const metadata: Metadata = { title: 'Wishlist', description: 'Products saved to your KITSYUU wishlist.' };
export default function Page() { return <WishlistView />; }
