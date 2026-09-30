import BrandHero from '@/components/BrandHero';
import { getBrandCopy } from '@/lib/content';
import StoreHome from '@/components/StoreHome';
import PromoBanners from '@/components/PromoBanners';

/* The KITSYUU homepage is the store, as on a typical online shop: the layout's one store header, the brand hero, then the
   store homepage (new arrivals, the rotation banner, categories, featured pieces), then the layout's one footer.
   The brand film and story (the original landing page) are on /our-story. */
export default async function Home() {
  const copy = await getBrandCopy();
  return (
    <>
      <BrandHero copy={{ heroTop: copy.heroTop, heroEyebrow: copy.heroEyebrow, heroLead: copy.heroLead }} />
      <PromoBanners placement="home" />
      <StoreHome />
    </>
  );
}
