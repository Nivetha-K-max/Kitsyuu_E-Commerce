import type { Metadata } from 'next';
import Link from 'next/link';
import { unsubscribeByToken } from '@kitsyuu/core';
import { db } from '@/lib/server';

export const metadata: Metadata = { title: 'Unsubscribe', robots: { index: false } };
export const dynamic = 'force-dynamic';

/* Client change request: the unsubscribe link in newsletter emails. The page says the same thing for any link, so it cannot
   be used to find out which addresses are on the list. */
export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const token = (await searchParams).token;
  const done = typeof token === 'string' ? (await unsubscribeByToken(db(), token).catch(() => ({ ok: false }))).ok : false;
  return (
    <div className="st-wrap">
      <header className="st-plp-head"><h1 id="st-page-title" tabIndex={-1}>Newsletter</h1></header>
      <section className="st-empty st-empty-inline" data-unsubscribe={done ? 'done' : 'unknown'}>
        <h2>{done ? 'You are unsubscribed.' : 'This link is not valid any more.'}</h2>
        <p>{done ? 'You will not receive KITSYUU newsletter emails. You can sign up again at any time.' : 'If you still receive our emails, use the unsubscribe link in the newest one, or contact us.'}</p>
        <p className="st-empty-actions"><Link className="button" href="/">Back to the store</Link></p>
      </section>
    </div>
  );
}
