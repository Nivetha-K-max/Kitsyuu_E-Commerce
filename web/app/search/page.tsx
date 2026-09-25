import type { Metadata } from 'next';
import { Suspense } from 'react';
import SearchView from '@/components/SearchView';
export const metadata: Metadata = { title: 'Search', description: 'Search the prototype KITSYUU catalogue.' };
export default function Page() { return <Suspense fallback={<div className="st-wrap"><p className="st-status">Loading…</p></div>}><SearchView /></Suspense>; }
