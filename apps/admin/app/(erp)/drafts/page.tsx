import { redirect } from 'next/navigation';

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

/* Draft orders are part of the order lifecycle and live under Orders → Draft (2026-10-06). This address is kept so old
   links and bookmarks still work: /drafts, /drafts?status=confirmed and /drafts?customer=<id>#dn-h all land on the same
   list and form there (the browser keeps the #anchor across the redirect). A single draft is still /drafts/<id>. */
export default async function DraftsRedirect({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const qs = new URLSearchParams({ view: 'draft' });
  if (['confirmed', 'cancelled', 'all'].includes(one(sp.status))) qs.set('draft', one(sp.status));
  if (/^[0-9a-f-]{36}$/i.test(one(sp.customer))) qs.set('customer', one(sp.customer));
  redirect(`/orders?${qs}`);
}
