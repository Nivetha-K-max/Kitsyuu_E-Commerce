import BrandHero from '@/components/BrandHero';
import StoreHome from '@/components/StoreHome';

/* The KITSYUU homepage is the store, as on a typical online shop: the layout's one store header, the brand hero, then the
   store homepage (new arrivals, the rotation banner, categories, featured pieces), then the layout's one footer.
   The brand film and story (the original landing page) are on /our-story. */
export default function Home() {
  return (
    <>
      <BrandHero />
      <StoreHome />
    </>
  );
}
