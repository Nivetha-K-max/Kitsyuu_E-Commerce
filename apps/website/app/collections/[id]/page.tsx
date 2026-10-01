/* A collection's own page: /collections/men, /collections/women, /collections/sale, /collections/new-arrivals… (any
   collection staff made visible). The same listing as /shop?collection=<id>; this is its canonical address. */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getCatalogue } from '@/lib/catalogue';
import ShopListing, { listingMetadata } from '@/components/ShopListing';

type Params = Promise<{ id: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || '';

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  return listingMetadata({ collection: decodeURIComponent((await params).id) });
}

export default async function CollectionPage({ params, searchParams }: { params: Params; searchParams: SP }) {
  const id = decodeURIComponent((await params).id);
  // A hidden or unknown collection is a real 404 here (the store only receives visible collections).
  if (!(await getCatalogue()).collections.some(c => c.id === id)) notFound();
  return <ShopListing query={{ collection: id, sort: one((await searchParams).sort) }} />;
}
