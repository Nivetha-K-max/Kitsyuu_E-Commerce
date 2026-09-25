import type { Metadata } from 'next';
import CheckoutView from '@/components/CheckoutView';
export const metadata: Metadata = { title: 'Checkout (prototype)', description: 'Prototype checkout. Not a real purchase.' };
export default function Page() { return <CheckoutView />; }
