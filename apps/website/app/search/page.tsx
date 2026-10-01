import type { Metadata } from 'next';
import { Suspense } from 'react';
import SearchView, { SearchBody } from '@/components/SearchView';
export const metadata: Metadata = { title: 'Search', description: 'Search the KITSYUU catalogue.' };
export default function Page() { return <Suspense fallback={<SearchBody initial="" />}><SearchView /></Suspense>; }
