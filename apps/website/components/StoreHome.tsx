import Link from 'next/link';
import { getCatalogue } from '@/lib/catalogue';
import { imageOf, indexCatalogue, pad, plural, url } from '@/lib/catalogue-utils';
import { ProductCard, ProductGrid } from '@/components/ui';
import Newsletter from '@/components/Newsletter';
import HeroTurntable from '@/components/HeroTurntable';

export default async function StoreHome() {
  const idx = indexCatalogue(await getCatalogue());
  const na = idx.collection('new-arrivals'), featured = idx.featured();
  const outer = idx.inCategory('outerwear').filter(p => !imageOf(p).held).slice(0, 2);
  return (
    <>
      {/* Turntable integration point: set data-turntable to the KTS-OUT-001 sequence manifest (see lib/turntable.ts). Empty = hero.webp only. */}
      <section className="st-hero" aria-labelledby="st-hero-title" data-turntable="" data-turntable-product="ky-proto-015">
        <img className="st-hero-img" src="/assets/hero.webp" alt="" width={1024} height={1024} fetchPriority="high" />
        <canvas className="st-hero-sequence" aria-hidden="true" hidden></canvas>
        <div className="st-hero-shade"></div>
        <div className="st-hero-copy st-wrap">
          <p className="eyebrow"><span></span>KITSYUU STORE / JAPAN → INDIA</p>
          <h1 id="st-hero-title">Shop the<br /><em>rotation.</em></h1>
          <p>Japanese streetwear, brought to India. Oversized shapes, washed layers and hardware details, piece by piece.</p>
          <div className="st-hero-actions">
            <Link className="button" href={url.shop()}>Shop all products</Link>
            <Link className="text-link" href={url.shop({ collection: 'new-arrivals' })}>New arrivals <span aria-hidden="true">↗</span></Link>
          </div>
        </div>
        <span className="st-caption" aria-hidden="true">Concept image / not a catalogue item</span>
        <HeroTurntable />
      </section>

      <section className="st-section" aria-labelledby="st-na-title"><div className="st-wrap">
        <div className="section-label"><span>01 — NEW ARRIVALS</span><span data-count="new-arrivals">{na ? plural(na.products.length, 'piece') : ''}</span></div>
        <div className="st-section-head"><h2 id="st-na-title">New<br /><em>arrivals.</em></h2><Link className="text-link" href={url.shop({ collection: 'new-arrivals' })}>View all new arrivals <span aria-hidden="true">↗</span></Link></div>
        {na && <ProductGrid list={na.products} pathOf={idx.categoryPath} opts={{ isNew: true }} />}
      </div></section>

      <section className="st-section" aria-labelledby="st-cat-title"><div className="st-wrap">
        <div className="section-label"><span>02 — SHOP BY CATEGORY</span><span>TOPS / BOTTOMS / OUTERWEAR</span></div>
        <div className="st-section-head"><h2 id="st-cat-title">Start with<br /><em>the shape.</em></h2><Link className="text-link" href={url.shop()}>All products <span aria-hidden="true">↗</span></Link></div>
        <ul className="st-cat-grid">
          {idx.top.map((c, i) => {
            const list = idx.inCategory(c.id), lead = list.find(p => !imageOf(p).held), img = lead && imageOf(lead);
            return (
              <li key={c.id}>
                <Link className="st-cat" href={url.shop({ category: c.id })}>
                  <span className="st-cat-media">{img && <img src={img.src} alt="" width={img.width} height={img.height} loading="lazy" decoding="async" />}</span>
                  <span className="st-cat-index" aria-hidden="true">{pad(i + 1)}</span>
                  <span className="st-cat-meta"><span className="st-cat-name">{c.label}</span><span className="st-cat-count">{plural(list.length, 'piece')}</span></span>
                </Link>
                <ul className="st-cat-subs" aria-label={`${c.label} categories`}>
                  {idx.children(c.id).map(s => <li key={s.id}><Link href={url.shop({ category: s.id })}>{s.label}</Link></li>)}
                </ul>
              </li>
            );
          })}
        </ul>
      </div></section>

      <section className="st-editorial" aria-labelledby="st-ed-title">
        <div className="st-editorial-img"><img src="/assets/editorial.webp" alt="Oversized washed streetwear layers photographed in a narrow Japanese alley" width={1024} height={1024} loading="lazy" /><span className="st-caption">Concept editorial / not a catalogue item</span></div>
        <div className="st-editorial-copy"><p className="eyebrow">03 — AFTER HOURS</p><h2 id="st-ed-title">Wide legs.<br />Washed<br /><em>layers.</em></h2><p>Balloon trousers, wide denim and washed tops. Start with the volume below and build the rest around it.</p><Link className="text-link" href={url.shop({ category: 'bottoms' })}>Shop bottoms <span aria-hidden="true">↗</span></Link></div>
      </section>

      <section className="st-section" aria-labelledby="st-ft-title"><div className="st-wrap">
        <div className="section-label"><span>04 — FEATURED</span><span data-count="featured">{plural(featured.length, 'piece')}</span></div>
        <div className="st-section-head"><h2 id="st-ft-title">Featured<br /><em>pieces.</em></h2><p>A prototype selection from the catalogue, chosen for store development.</p></div>
        <ProductGrid list={featured} pathOf={idx.categoryPath} opts={(_, i) => ({ index: i + 1 })} />
      </div></section>

      <section className="st-section" aria-labelledby="st-ow-title"><div className="st-wrap st-feature">
        <div className="st-feature-copy"><p className="eyebrow">05 — OUTERWEAR</p><h2 id="st-ow-title">Hardware<br /><em>closures.</em></h2><p>Cropped and stand-collar jackets from the prototype catalogue.</p><Link className="button button-outline" href={url.shop({ category: 'outerwear' })}>Shop outerwear</Link></div>
        <ul className="st-feature-items">{outer.map(p => <ProductCard key={p.id} p={p} categoryPath={idx.categoryPath(p)} />)}</ul>
      </div></section>

      <section className="st-news" aria-labelledby="st-news-title"><div className="st-wrap st-news-inner">
        <div><p className="eyebrow">06 — LETTERS</p><h2 id="st-news-title">First to<br />know.</h2></div>
        <Newsletter />
      </div></section>
    </>
  );
}
