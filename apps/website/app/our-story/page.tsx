import type { Metadata } from 'next';
import Landing from '@/components/Landing';

export const metadata: Metadata = { title: 'Our story', description: 'The KITSYUU story: Japanese streetwear, unconventional shapes, brought to India.' };

/* The original KITSYUU landing page (scroll film, style studies, our world), under the one store header and above the
   one store footer. Its own header and footer are not shown here (store.css), so the site has a single header. */
export default function OurStory() {
  return <div className="st-our-story"><Landing /></div>;
}
