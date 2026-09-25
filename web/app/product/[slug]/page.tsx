import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getCatalogue } from '@/lib/catalogue';
import { formatMoney, imagesOf, indexCatalogue, plural, url } from '@/lib/catalogue-utils';
import { Crumbs, ProductGrid } from '@/components/ui';
import BuyForm from '@/components/BuyForm';
import Gallery from '@/components/Gallery';

type Params = Promise<{ slug: string }>;

export async function generateStaticParams() {
  return (await getCatalogue()).products.map(p => ({ slug: p.slug }));
}
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const p = indexCatalogue(await getCatalogue()).bySlug(decodeURIComponent((await params).slug));
  return p ? { title: p.name, description: p.description } : { title: 'Product not found' };
}

export default async function ProductPage({ params }: { params: Params }) {
  const idx = indexCatalogue(await getCatalogue());
  const p = idx.bySlug(decodeURIComponent((await params).slug));
  if (!p) notFound();
  const imgs = imagesOf(p), img = imgs[0];
  const styled = (p.styledWith || []).map(id => idx.byId.get(id)).filter(x => !!x);
  const more = idx.inCategory(p.subcategory).filter(x => x !== p && !styled.includes(x)).slice(0, 4);
  const sub = idx.catLabel(p.subcategory);
  const caption: [string, string] = img.held ? ['Photo coming soon', 'Product photography in preparation'] : [img.quality === 'prototype' ? 'Prototype image / catalogue cutout' : 'Product image', 'Official photography pending'];
  return (
    <div className="st-wrap">
      <Crumbs list={[{ label: 'Store', href: url.home }, { label: 'Shop', href: url.shop() }, { label: idx.catLabel(p.category), href: url.shop({ category: p.category }) }, { label: sub, href: url.shop({ category: p.subcategory }) }, { label: p.name }]} />
      <article className="st-pdp" aria-labelledby="st-pdp-title">
        <Gallery p={p} images={imgs} caption={caption} />
        <div className="st-info">
          <p className="st-pdp-meta"><b>{idx.categoryPath(p)}</b><br />SKU {p.sku}</p>
          <h1 id="st-pdp-title">{p.name}</h1>
          <p className="st-pdp-price">{formatMoney(p.price)}<small>Prototype price, estimated{idx.c.meta.priceIncludesTax === null ? '. Tax inclusion unconfirmed' : ''}</small></p>
          <p className="st-colour"><i style={{ background: p.colour?.swatches?.[0] || 'transparent' }} aria-hidden="true"></i>Colour <b>{p.colour?.label}</b></p>
          <p className="st-desc">{p.description}</p>
          <BuyForm productId={p.id} />
          <div className="st-details">
            {p.features?.length > 0 && <details open><summary>Details</summary><ul>{p.features.map(f => <li key={f}>{f}</li>)}</ul></details>}
            <details><summary>Material &amp; care</summary><p>{[p.material, p.care, p.origin].some(Boolean) ? [p.material, p.care, p.origin].filter(Boolean).map((t, i) => <span key={i}>{i > 0 && <br />}{t}</span>) : 'Material, care and origin details have not been supplied yet.'}</p></details>
            <details><summary>Product data</summary><dl><dt>SKU</dt><dd>{p.sku}</dd><dt>Catalogue ref</dt><dd>{p.catalogueRef}</dd><dt>Category</dt><dd>{idx.categoryPath(p)}</dd><dt>Data</dt><dd>Prototype. Not confirmed company data.</dd><dt>Image</dt><dd>{img.held ? 'Withheld pending clearance' : 'Prototype catalogue cutout, no zoom'}</dd></dl></details>
          </div>
        </div>
      </article>
      {styled.length > 0 && (
        <section className="st-rail" aria-labelledby="st-styled">
          <div className="section-label"><span>STYLED WITH</span><span>AS PAIRED IN THE PROTOTYPE CATALOGUE</span></div>
          <div className="st-section-head"><h2 id="st-styled">Complete<br /><em>the look.</em></h2></div>
          <ProductGrid list={styled} pathOf={idx.categoryPath} opts={{ level: 3 }} />
        </section>
      )}
      {more.length > 0 && (
        <section className="st-rail" aria-labelledby="st-more">
          <div className="section-label"><span>MORE {sub.toUpperCase()}</span><span>{plural(more.length, 'piece')}</span></div>
          <div className="st-section-head"><h2 id="st-more">More<br /><em>{sub}.</em></h2><Link className="text-link" href={url.shop({ category: p.subcategory })}>View all <span aria-hidden="true">↗</span></Link></div>
          <ProductGrid list={more} pathOf={idx.categoryPath} opts={{ level: 3 }} />
        </section>
      )}
      <p className="st-footnote">Prototype catalogue: names, sizes, prices and descriptions are estimates and not confirmed company data.</p>
    </div>
  );
}
