import { Suspense } from 'react';
import Header from '@/components/Header';
import Landing from '@/components/Landing';
import StoreHome from '@/components/StoreHome';

/* The KITSYUU homepage is one continuous page:
   1. the original brand landing page (its own header, story, edit, world and closing sections);
   2. the store homepage, starting at #store with the store header (the layout does not render it at the top on `/`);
   3. the store footer (from the layout). */
export default function Home() {
  return (
    <>
      <Landing />
      <section id="store" className="st-home" aria-label="KITSYUU store">
        <Suspense fallback={<header className="st-header" />}><Header inline /></Suspense>
        <StoreHome />
      </section>
    </>
  );
}
