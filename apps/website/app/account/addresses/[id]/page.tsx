import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { NotFoundError, uuid } from '@kitsyuu/contracts';
import { getCustomerAddress } from '@kitsyuu/core';
import { AddressForm } from '@/components/AccountForms';
import { Crumbs } from '@/components/ui';
import { db, requireCustomer } from '@/lib/server';

export const metadata: Metadata = { title: 'Edit address' };
type Params = Promise<{ id: string }>;

export default async function EditAddressPage({ params }: { params: Params }) {
  const { id } = await params;
  const me = await requireCustomer(`/account/addresses/${encodeURIComponent(id)}`);
  if (!uuid.safeParse(id).success) notFound();
  // Only the customer's own addresses are found; any other id is "not found", never "forbidden".
  const address = await getCustomerAddress(db(), me, id).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  return (
    <>
      <Crumbs list={[{ label: 'Addresses', href: '/account/addresses' }, { label: 'Edit' }]} />
      <header className="st-plp-head">
        <h1 id="st-page-title">Edit address</h1>
        <div className="st-plp-aside"><p className="st-result-count">{address.isDefault ? 'Default address' : 'Address'}</p><p>Fields marked * are required.</p></div>
      </header>
      <AddressForm address={address} />
    </>
  );
}
