import type { Metadata } from 'next';
import ConfirmationView from '@/components/ConfirmationView';
export const metadata: Metadata = { title: 'Prototype order', description: 'Prototype order confirmation. No real order was placed.' };
export default function Page() { return <ConfirmationView />; }
