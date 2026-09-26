/* Shared markup, identical to the static store so store.css applies unchanged.
   No 'use client' here: these render on the server or inside client components. */
import Link from 'next/link';
import type { Product } from '@/lib/types';
import { asset, formatMoney, imageOf, pad, url } from '@/lib/catalogue-utils';
import WishButton from './WishButton';
import { Icons } from './icons';
export { Icons };



export function ComingSoon({ p, label = false }: { p: Product; label?: boolean }) {
  const a11y = label ? { role: 'img', 'aria-label': `${p.name}: photo coming soon` } : { 'aria-hidden': true as const };
  return (
    <div className="st-soon" {...a11y}>
      <img className="st-soon-mark" src={asset('assets/kitsyuu-icon.svg')} alt="" width={1024} height={1024} />
      <span className="st-soon-title">Photo<br />coming soon</span>
      <span className="st-soon-label">KITSYUU / PROTOTYPE</span>
    </div>
  );
}

export function Price({ value }: { value: number }) {
  return <p className="st-price">{formatMoney(value)}<small aria-hidden="true">EST.</small><span className="sr-only">, estimated prototype price</span></p>;
}

export type CardOpts = { level?: 2 | 3; isNew?: boolean; index?: number };
export function ProductCard({ p, categoryPath, level = 3, isNew = false, index = 0 }: { p: Product; categoryPath: string } & CardOpts) {
  const img = imageOf(p);
  const H = `h${level}` as 'h2' | 'h3';
  return (
    <li>
      <article className="st-card">
        <div className={`st-card-media${img.held ? ' is-held' : ''}`}>
          <span className="st-tag">{p.sku}</span>
          {isNew && <span className="st-tag st-tag-new">New</span>}
          {index > 0 && <span className="st-index" aria-hidden="true">{pad(index)}</span>}
          {img.held ? <ComingSoon p={p} /> : <img src={img.src} alt="" width={img.width} height={img.height} loading="lazy" decoding="async" />}
        </div>
        <div className="st-card-body">
          <H className="st-card-name"><Link href={url.product(p)}>{p.name}</Link></H>
          <p className="st-card-cat">{categoryPath}{img.held && <span className="sr-only">. Photo coming soon</span>}</p>
          <Price value={p.price} />
        </div>
        <WishButton id={p.id} label={`Save ${p.name} to wishlist`} variant="card" />
      </article>
    </li>
  );
}

export function ProductGrid({ list, pathOf, opts }: { list: Product[]; pathOf: (p: Product) => string; opts?: CardOpts | ((p: Product, i: number) => CardOpts) }) {
  return (
    <ul className="st-grid">
      {list.map((p, i) => <ProductCard key={p.id} p={p} categoryPath={pathOf(p)} {...(typeof opts === 'function' ? opts(p, i) : opts)} />)}
    </ul>
  );
}

export function Crumbs({ list }: { list: { label: string; href?: string }[] }) {
  return (
    <nav className="st-crumbs" aria-label="Breadcrumb">
      <ol>
        {list.map((c, i) => <li key={i}>{i === list.length - 1 || !c.href ? <span aria-current="page">{c.label}</span> : c.href === '/' ? <a href="/">{c.label}</a> : <Link href={c.href}>{c.label}</Link>}</li>)}
      </ol>
    </nav>
  );
}

export function EmptyState({ title, text, cta }: { title: string; text: string; cta?: React.ReactNode }) {
  return (
    <section className="st-empty st-empty-inline">
      <p className="eyebrow"><span></span>NOTHING HERE YET</p>
      <h2>{title}</h2><p>{text}</p>
      {cta ?? <Link className="button" href={url.shop()}>Shop all products</Link>}
    </section>
  );
}

export function NotFoundBlock({ title, text }: { title: string; text: string }) {
  return (
    <div className="st-wrap">
      <section className="st-empty">
        <p className="eyebrow"><span></span>NOT IN THE PROTOTYPE CATALOGUE</p>
        <h1>{title}</h1><p>{text}</p>
        <Link className="button" href={url.shop()}>Shop all products</Link>
      </section>
    </div>
  );
}
