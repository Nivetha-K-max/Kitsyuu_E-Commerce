import type { Metadata } from 'next';
import Link from 'next/link';
import { globalSearch } from '@kitsyuu/core';
import { Empty, PageHead } from '@/components/ui';
import { db, requireActor } from '@/lib/server';
import FilterForm from '@/components/FilterForm';

export const metadata: Metadata = { title: 'Search' };
type SP = Promise<Record<string, string | string[] | undefined>>;

/* M18: search across the admin. Results only come from areas the signed-in person may open. */
export default async function SearchPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  const raw = (await searchParams).q;
  const term = (Array.isArray(raw) ? raw[0] : raw ?? '').slice(0, 80);
  const groups = term.trim().length >= 2 ? await globalSearch(db(), actor, term) : [];
  return (
    <>
      <PageHead section="Overview" title="Search" eyebrow="Products, orders, customers, vendors, purchase orders, materials and production." />
      <FilterForm className="actions" role="search" data-global-search>
        <label className="sr-only" htmlFor="gs-q">Search</label>
        <input id="gs-q" name="q" className="input" placeholder="Name, SKU, order number, email…" defaultValue={term} autoFocus />
        <button className="btn" type="submit">Search</button>
      </FilterForm>
      {term.trim().length < 2 ? <p className="note">Type at least 2 characters.</p>
        : groups.length === 0 ? <Empty title={`Nothing found for “${term}”`} kind="search" />
        : <div className="search-groups" data-search-results>{groups.map(g => (
          <section key={g.key} className="card" aria-labelledby={`sg-${g.key}`} data-group={g.key}>
            <h2 id={`sg-${g.key}`}>{g.label}</h2>
            <ul className="plain search-hits">{g.hits.map(h => (
              <li key={h.href + h.title}><Link href={h.href}>{h.title}</Link> <span className="note">{h.detail}</span></li>
            ))}</ul>
          </section>
        ))}</div>}
    </>
  );
}
