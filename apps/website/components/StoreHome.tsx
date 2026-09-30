import Link from 'next/link';
import { getCatalogue } from '@/lib/catalogue';
import { imageOf, indexCatalogue, pad, plural, url } from '@/lib/catalogue-utils';
import type { Product } from '@/lib/types';
import { ComingSoon, Price, ProductCard, ProductGrid } from '@/components/ui';
import Newsletter from '@/components/Newsletter';
import HeroTurntable from '@/components/HeroTurntable';
import WishButton from '@/components/WishButton';
import Choreo from '@/components/Choreo';
import { getBrandCopy } from '@/lib/content';

/* KITSYUU v2 store homepage (the brand hero above it, components/BrandHero.tsx, is unchanged). Same sections, copy,
   links and products as before; the images now carry the movement (see components/Choreo.tsx and the "KITSYUU v2"
   block in public/store.css). Every image frame stays a sharp rectangle. Without JavaScript or with reduced motion the
   sections show a still layout. */

/* Editorial photography per category panel (the catalogue has no category photos yet; these are the store's boards). */
const CATEGORY_PHOTO: Record<string, { src: string; w: number; h: number }> = {
  tops: { src: '/assets/layers.webp', w: 1672, h: 941 },
  bottoms: { src: '/assets/volume.webp', w: 1672, h: 941 },
  outerwear: { src: '/assets/hero.webp', w: 1024, h: 1024 },
};

function Cutout({ p, className = '', eager = false }: { p: Product; className?: string; eager?: boolean }) {
  const img = imageOf(p);
  return img.held ? <ComingSoon p={p} />
    : <img className={className} src={img.src} alt="" width={img.width} height={img.height} loading={eager ? 'eager' : 'lazy'} decoding="async" />;
}

export default async function StoreHome() {
  const [idx, copy] = await Promise.all([getCatalogue().then(indexCatalogue), getBrandCopy()]);   // brand wording: client change request
  const na = idx.collection('new-arrivals'), featured = idx.featured();
  const outer = idx.inCategory('outerwear').filter(p => !imageOf(p).held).slice(0, 2);
  const naList = na?.products ?? [];
  const cats = idx.top.map(c => {
    const list = idx.inCategory(c.id), shown = list.filter(p => !imageOf(p).held);
    return { c, list, lead: shown[0], second: shown[1] };
  });
  const rotation = [idx.inCategory('outerwear').find(p => !imageOf(p).held), naList.find(p => !imageOf(p).held)].filter((p): p is Product => !!p);

  return (
    <>
      <Choreo />

      {/* 01 — New arrivals: one large frame; scrolling moves through the pieces (a swipe strip on phones). */}
      <section className="st-section ch-na" aria-labelledby="st-na-title">
        <div className="st-wrap">
          <div className="section-label"><span>01 — NEW ARRIVALS</span><span data-count="new-arrivals">{na ? plural(naList.length, 'piece') : ''}</span></div>
          <div className="st-section-head"><h2 id="st-na-title">New<br /><em>arrivals.</em></h2><Link className="text-link" href={url.shop({ collection: 'new-arrivals' })}>View all new arrivals <span aria-hidden="true">↗</span></Link></div>
        </div>
        {naList.length > 0 && (
          <div className="ch-na-reel" data-scroll="pin" data-steps={naList.length} style={{ ['--n' as string]: naList.length }}>
            <div className="ch-na-stage st-wrap">
              <ul className="ch-na-list">
                {naList.map((p, i) => (
                  <li key={p.id} className={`ch-na-item${i === 0 ? ' is-current' : ''}`} data-step-item={i} style={{ ['--i' as string]: i }}>
                    <article className="st-card ch-na-card" data-sku={p.sku}>
                      <div className={`st-card-media ch-na-media${imageOf(p).held ? ' is-held' : ''}`}>
                        <span className="st-tag st-tag-new">New</span>
                        <Cutout p={p} eager />
                        {/* The picture opens the product too (the name link below is the one keyboard users reach). */}
                        <Link className="st-media-link" href={url.product(p)} tabIndex={-1} aria-hidden="true" />
                      </div>
                      <div className="st-card-body ch-na-info">
                        <p className="ch-count" aria-hidden="true"><b>{pad(i + 1)}</b> / {pad(naList.length)}</p>
                        <h3 className="st-card-name"><Link href={url.product(p)}>{p.name}</Link></h3>
                        <p className="st-card-cat">{idx.categoryPath(p)}</p>
                        <Price value={p.price} was={p.compareAt} />
                      </div>
                      <WishButton id={p.id} label={`Save ${p.name} to wishlist`} variant="card" />
                    </article>
                  </li>
                ))}
              </ul>
              <span className="ch-progress" aria-hidden="true" />
            </div>
          </div>
        )}
      </section>

      {/* Shop the rotation: the copy holds still; the photograph and two framed pieces drift at different speeds. */}
      {/* Turntable integration point: set data-turntable to the KTS-OUT-001 sequence manifest (see lib/turntable.ts). Empty = hero.webp only. */}
      <section className="st-hero ch-rot" aria-labelledby="st-hero-title" data-turntable="" data-turntable-product="ky-proto-015" data-scroll="pass">
        <img className="st-hero-img" src="/assets/hero.webp" alt="" width={1024} height={1024} fetchPriority="high" />
        <canvas className="st-hero-sequence" aria-hidden="true" hidden></canvas>
        <div className="st-hero-shade"></div>
        <div className="ch-rot-frames" aria-hidden="true">
          {rotation.map((p, i) => (
            <Link key={p.id} href={url.product(p)} tabIndex={-1} className={`ch-frame ch-rot-frame ch-rot-frame-${i + 1}`} data-reveal><Cutout p={p} eager /></Link>
          ))}
        </div>
        <div className="st-hero-copy st-wrap">
          <p className="eyebrow" data-brand-home-eyebrow><span></span>{copy.homeEyebrow}</p>
          <h2 id="st-hero-title">Shop the<br /><em>rotation.</em></h2>
          <p data-brand-home-intro>{copy.homeIntro}</p>
          <div className="st-hero-actions">
            <Link className="button" href={url.shop()}>Shop all products</Link>
            <Link className="text-link" href={url.shop({ collection: 'new-arrivals' })}>New arrivals <span aria-hidden="true">↗</span></Link>
          </div>
        </div>
        <HeroTurntable />
      </section>

      {/* 02 — Shop by category: Tops → Bottoms → Outerwear as editorial panels, one after another while scrolling. */}
      <section className="st-section ch-cats" aria-labelledby="st-cat-title">
        <div className="st-wrap">
          <div className="section-label"><span>02 — SHOP BY CATEGORY</span><span>TOPS / BOTTOMS / OUTERWEAR</span></div>
          <div className="st-section-head"><h2 id="st-cat-title">Start with<br /><em>the shape.</em></h2><Link className="text-link" href={url.shop()}>All products <span aria-hidden="true">↗</span></Link></div>
        </div>
        <div className="ch-cat-reel" data-scroll="pin" data-steps={cats.length} style={{ ['--n' as string]: cats.length }}>
          <div className="ch-cat-stage st-wrap">
            <ul className="ch-cat-list">
              {cats.map(({ c, list, lead, second }, i) => {
                const photo = CATEGORY_PHOTO[c.id];
                return (
                  <li key={c.id} className={`ch-cat-item${i === 0 ? ' is-current' : ''}`} data-step-item={i} style={{ ['--i' as string]: i }}>
                    <div className="ch-cat-text">
                      <span className="ch-count" aria-hidden="true"><b>{pad(i + 1)}</b> / {pad(cats.length)}</span>
                      <Link className="st-cat ch-cat-link" href={url.shop({ category: c.id })}>
                        <span className="st-cat-meta"><span className="st-cat-name">{c.label}</span><span className="st-cat-count">{plural(list.length, 'piece')}</span></span>
                      </Link>
                      <ul className="st-cat-subs" aria-label={`${c.label} categories`}>
                        {idx.children(c.id).map(s => <li key={s.id}><Link href={url.shop({ category: s.id })}>{s.label}</Link></li>)}
                      </ul>
                    </div>
                    <Link className="ch-cat-visual" href={url.shop({ category: c.id })} tabIndex={-1} aria-hidden="true">
                      <span className="ch-frame ch-cat-photo">
                        {photo ? <img src={photo.src} alt="" width={photo.w} height={photo.h} decoding="async" /> : lead && <Cutout p={lead} eager />}
                      </span>
                      {lead && <span className="ch-frame ch-cat-piece">{photo ? <Cutout p={lead} eager /> : second && <Cutout p={second} eager />}</span>}
                    </Link>
                  </li>
                );
              })}
            </ul>
            <span className="ch-progress" aria-hidden="true" />
          </div>
        </div>
      </section>

      {/* 03 — After hours: a campaign spread; the photographs move at different speeds, the copy stays put. */}
      <section className="st-editorial ch-ed" aria-labelledby="st-ed-title" data-scroll="pass">
        <div className="st-editorial-img">
          <img className="ch-ed-main" src="/assets/editorial.webp" alt="Oversized washed streetwear layers photographed in a narrow Japanese alley" width={1024} height={1024} loading="lazy" />
        </div>
        <div className="st-editorial-copy">
          <span className="ch-frame ch-ed-inset" aria-hidden="true" data-reveal><img src="/assets/volume.webp" alt="" width={1672} height={941} loading="lazy" decoding="async" /></span>
          <p className="eyebrow">03 — AFTER HOURS</p><h2 id="st-ed-title">Wide legs.<br />Washed<br /><em>layers.</em></h2><p>Balloon trousers, wide denim and washed tops. Start with the volume below and build the rest around it.</p><Link className="text-link" href={url.shop({ category: 'bottoms' })}>Shop bottoms <span aria-hidden="true">↗</span></Link>
        </div>
      </section>

      {/* 04 — Featured: an asymmetric spread of different sizes, revealed one by one. */}
      <section className="st-section" aria-labelledby="st-ft-title"><div className="st-wrap">
        <div className="section-label"><span>04 — FEATURED</span><span data-count="featured">{plural(featured.length, 'piece')}</span></div>
        <div className="st-section-head"><h2 id="st-ft-title">Featured<br /><em>pieces.</em></h2><p>A selection from the catalogue.</p></div>
        <div className="ch-ft"><ProductGrid list={featured} pathOf={idx.categoryPath} opts={(_, i) => ({ index: i + 1 })} reveal /></div>
      </div></section>

      {/* 05 — Outerwear: jacket 01, then jacket 02, as the section passes. */}
      <section className="st-section" aria-labelledby="st-ow-title"><div className="st-wrap st-feature">
        <div className="st-feature-copy"><p className="eyebrow">05 — OUTERWEAR</p><h2 id="st-ow-title">Hardware<br /><em>closures.</em></h2><p>Cropped and stand-collar jackets from the catalogue.</p><Link className="button button-outline" href={url.shop({ category: 'outerwear' })}>Shop outerwear</Link></div>
        <ul className="st-feature-items ch-ow" data-scroll="pass" data-steps={outer.length || undefined}>{outer.map(p => <ProductCard key={p.id} p={p} categoryPath={idx.categoryPath(p)} />)}</ul>
      </div></section>

      <section className="st-news" aria-labelledby="st-news-title"><div className="st-wrap st-news-inner">
        <div><p className="eyebrow">06 — LETTERS</p><h2 id="st-news-title">First to<br />know.</h2></div>
        <Newsletter />
      </div></section>
    </>
  );
}
