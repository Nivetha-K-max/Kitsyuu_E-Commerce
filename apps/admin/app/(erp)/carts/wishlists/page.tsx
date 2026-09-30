import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listWishlists, wishlistReport } from '@kitsyuu/core';
import FilterForm from '@/components/FilterForm';
import SubNav from '@/components/SubNav';
import { Empty, Forbidden, PageHead } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { one, pageOf, type SP } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';

export const metadata: Metadata = { title: 'Wishlists' };

export default async function WishlistsPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'carts.read')) return <><PageHead title="Carts & wishlists" /><Forbidden permission="carts.read" /></>;
  const sp = await searchParams;
  const q = one(sp.q).trim().slice(0, 60) || undefined;
  const page = pageOf(sp.page);
  const [top, list] = await Promise.all([wishlistReport(db(), actor, 20), listWishlists(db(), actor, { q, page })]);
  return (
    <>
      <PageHead title="Carts & wishlists" eyebrow="What customers want: products in wishlists and active carts right now." />
      <SubNav label="Carts" current="/carts/wishlists" items={[{ href: '/carts', label: 'Carts' }, { href: '/carts/checkouts', label: 'Abandoned checkouts' }, { href: '/carts/wishlists', label: 'Wishlists' }]} />
      <section className="card" aria-labelledby="mw-h"><h2 id="mw-h">Most wanted products</h2>
        {top.length === 0 ? <Empty compact title="No products in wishlists or carts" /> : (
          <div className="table-wrap"><table data-wanted>
            <thead><tr><th>Product</th><th className="num">Wishlists</th><th className="num">Active carts</th><th className="num">In stock</th></tr></thead>
            <tbody>{top.map(p => <tr key={p.id}><td>{p.name}<div className="note mono">{p.sku} · {p.status}</div></td><td className="num">{p.wishlists}</td><td className="num">{p.carts}</td><td className="num">{p.stock}</td></tr>)}</tbody>
          </table></div>
        )}
      </section>
      <section className="card" aria-labelledby="wl-h"><h2 id="wl-h">Customer wishlists</h2>
        <FilterForm className="actions" role="search" aria-label="Search wishlists">
          <label className="sr-only" htmlFor="wl-q">Customer</label>
          <input id="wl-q" name="q" className="input" placeholder="Customer email or name" defaultValue={q ?? ''} />
          <button className="btn ghost" type="submit">Search</button>
        </FilterForm>
        {list.rows.length === 0 ? <Empty compact title="No wishlists" /> : (
          <div className="table-wrap"><table data-wishlists>
            <thead><tr><th>Customer</th><th className="num">Items</th><th>Updated</th></tr></thead>
            <tbody>{list.rows.map(w => <tr key={w.id}><td>{can(actor, 'customers.read') ? <Link href={`/customers/${w.customer_id}`}>{w.email}</Link> : w.email}</td>
              <td className="num">{w.items}</td><td className="nowrap">{formatDateTime(w.updated_at as Date)}</td></tr>)}</tbody>
          </table></div>
        )}
        <nav className="pager actions" aria-label="Pages">
          {page > 1 && <Link className="btn ghost sm" href={`/carts/wishlists?page=${page - 1}`}>Previous</Link>}
          {list.hasNext && <Link className="btn ghost sm" href={`/carts/wishlists?page=${page + 1}`}>Next</Link>}
        </nav>
      </section>
    </>
  );
}
