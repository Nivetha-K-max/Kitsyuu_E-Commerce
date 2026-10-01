import type { Metadata } from 'next';
import ShopListing, { listingMetadata, type ListingQuery } from '@/components/ShopListing';

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || '';
const query = async (sp: SP): Promise<ListingQuery> => { const q = await sp; return { category: one(q.category), collection: one(q.collection), sort: one(q.sort) }; };

export async function generateMetadata({ searchParams }: { searchParams: SP }): Promise<Metadata> {
  return listingMetadata(await query(searchParams));
}

export default async function Shop({ searchParams }: { searchParams: SP }) {
  return <ShopListing query={await query(searchParams)} />;
}
