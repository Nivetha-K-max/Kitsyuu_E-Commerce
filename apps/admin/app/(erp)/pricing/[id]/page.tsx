import { redirect } from 'next/navigation';

/* A product's prices (price, compare-at, sale, size prices, scheduled changes, history) are the Pricing tab of the
   product page (2026-10-07): one product, one place. This address is kept so existing links and bookmarks still work. */
export default async function ProductPricingRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/products/${encodeURIComponent(id)}?tab=pricing`);
}
