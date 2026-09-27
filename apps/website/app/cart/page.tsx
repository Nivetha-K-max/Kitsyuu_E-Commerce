import type { Metadata } from 'next';
import CartView from '@/components/CartView';
export const metadata: Metadata = { title: 'Cart', description: 'Your KITSYUU cart.' };
export default function Page() { return <CartView />; }
