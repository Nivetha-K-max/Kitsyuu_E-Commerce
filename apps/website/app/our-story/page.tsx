import type { Metadata } from 'next';
import Landing from '@/components/Landing';
import { getBrandCopy } from '@/lib/content';

/* The description is part of the editable brand wording (client change request); the default is the original text. */
export async function generateMetadata(): Promise<Metadata> {
  return { title: 'Our story', description: (await getBrandCopy()).storyDescription };
}

/* The original KITSYUU landing page (scroll film, style studies, our world), under the one store header and above the
   one store footer. Its own header and footer are not shown here (store.css), so the site has a single header. */
export default function OurStory() {
  return <div className="st-our-story"><Landing /></div>;
}
