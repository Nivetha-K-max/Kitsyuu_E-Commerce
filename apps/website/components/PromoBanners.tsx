import Link from 'next/link';
import { getBanners } from '@/lib/content';

/* ERP module 4: promotional banners published from the admin (Marketing → Banners). Renders nothing when none are live. */
export default async function PromoBanners({ placement, wrap = true }: { placement: 'home' | 'shop'; wrap?: boolean }) {
  const banners = await getBanners(placement);
  if (!banners.length) return null;
  return (
    <div className={wrap ? 'st-wrap' : undefined} data-promo-banners={placement}>
      {banners.map(b => (
        <aside key={b.id} className="st-promo" aria-label="Promotion" data-promo={b.id}>
          <div><h2>{b.heading}</h2>{b.body && <p>{b.body}</p>}</div>
          {b.ctaLabel && b.link && <Link className="button" href={b.link}>{b.ctaLabel}</Link>}
        </aside>
      ))}
    </div>
  );
}
