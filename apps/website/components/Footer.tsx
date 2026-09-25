import Link from 'next/link';
import type { Catalogue } from '@/lib/types';
import { asset, indexCatalogue, url } from '@/lib/catalogue-utils';

/* The brand landing page is parked while the store is built; its links return with the landing page. */
export default function Footer({ catalogue }: { catalogue: Catalogue }) {
  const idx = indexCatalogue(catalogue);
  const items = idx.c.navigation.map(n => n.all ? { label: 'All products', href: url.shop() }
    : n.collection ? { label: n.label, href: url.shop({ collection: n.collection }) }
    : { label: n.label, href: url.shop({ category: n.category! }) });
  const shop = [...items.filter(i => i.label === 'All products'), ...items.filter(i => i.label !== 'All products')];
  return (
    <footer className="st-footer">
      <div className="st-wrap">
        <div className="st-footer-top">
          <div className="st-footer-brand">
            <Link className="st-brand" href={url.home} aria-label="KITSYUU store home">
              <span className="logo-crop"><img src={asset('assets/kitsyuu-icon.svg')} alt="" width={1024} height={1024} loading="lazy" /></span>
              <span className="st-wordmark" aria-hidden="true">KITSYUU</span>
            </Link>
            <p>JAPANESE STREETWEAR.<br />INDIAN STREETS.</p>
          </div>
          <nav aria-labelledby="st-f-shop"><h2 id="st-f-shop">Shop</h2><ul>{shop.map(i => <li key={i.href}><Link href={i.href}>{i.label}</Link></li>)}</ul></nav>
          <div><h2>Prototype store</h2><p className="st-footer-note">Product names, sizes, prices and descriptions come from a prototype catalogue and are estimates, not confirmed company data. Product images are prototype-quality catalogue cutouts, not final product photography. Photography and commercial details may be updated. No orders, payments or sign-ups are processed.</p></div>
        </div>
        <div className="st-footer-bottom"><span>KITSYUU STORE / PROTOTYPE BUILD</span><a href="#main">Back to top ↑</a></div>
      </div>
    </footer>
  );
}
