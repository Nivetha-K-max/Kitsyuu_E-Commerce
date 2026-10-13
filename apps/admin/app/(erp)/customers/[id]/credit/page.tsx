import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import CustomerMoney from '@/components/CustomerMoney';
import { Forbidden, PageHead } from '@/components/ui';
import { db, requireActor } from '@/lib/server';

export const metadata: Metadata = { title: 'Store credit and credit account' };
type Params = Promise<{ id: string }>;

/* The forms for a customer's store credit and credit account (2026-10-13). They are here, not on the customer's Payments
   tab, which stays a read-only list. Each form is shown only to staff who hold its permission; the services check again. */
export default async function CustomerCreditPage({ params }: { params: Params }) {
  const actor = await requireActor();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const crumbs = [{ href: '/customers', label: 'Customers' }, { href: `/customers/${id}?tab=payments`, label: 'Customer' }];
  if (!can(actor, 'customers.read')) return <><PageHead title="Store credit and credit account" crumbs={crumbs} /><Forbidden permission="customers.read" /></>;
  if (!can(actor, 'store_credit.adjust') && !can(actor, 'credit.manage')) return <><PageHead title="Store credit and credit account" crumbs={crumbs} /><Forbidden permission="credit.manage" /></>;
  const c = await db().selectFrom('customers').select(['email', 'full_name']).where('id', '=', id).executeTakeFirst();
  if (!c) notFound();
  return (
    <>
      <PageHead title="Store credit and credit account" crumbs={crumbs} eyebrow={c.full_name ?? c.email} />
      <div className="ent-body" data-customer-credit><CustomerMoney actor={actor} customerId={id} forms /></div>
    </>
  );
}
