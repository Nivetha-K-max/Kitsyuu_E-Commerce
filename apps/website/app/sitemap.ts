/* sitemap.xml from the catalogue (2026-10-01): home, shop, categories, visible collections, every active product and the
   story page. Account, cart and checkout pages are private and not listed. */
import type { MetadataRoute } from 'next';
import { getCatalogue } from '@/lib/catalogue';
import { url } from '@/lib/catalogue-utils';
import { absolute } from '@/lib/seo';

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const c = await getCatalogue();
  return [
    { url: absolute('/'), changeFrequency: 'daily', priority: 1 },
    { url: absolute(url.shop()), changeFrequency: 'daily', priority: 0.8 },
    ...c.collections.map(x => ({ url: absolute(url.collection(x.id)), changeFrequency: 'daily' as const, priority: 0.7 })),
    ...c.categories.map(x => ({ url: absolute(url.shop({ category: x.id })), changeFrequency: 'weekly' as const, priority: 0.6 })),
    ...c.products.map(p => ({ url: absolute(url.product(p)), changeFrequency: 'weekly' as const, priority: 0.8 })),
    { url: absolute('/our-story'), changeFrequency: 'monthly', priority: 0.4 },
  ];
}
