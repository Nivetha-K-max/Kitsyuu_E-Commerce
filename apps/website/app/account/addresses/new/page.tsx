import type { Metadata } from 'next';
import { AddressForm } from '@/components/AccountForms';
import { Crumbs } from '@/components/ui';
import { requireCustomer } from '@/lib/server';

export const metadata: Metadata = { title: 'Add an address' };

export default async function NewAddressPage() {
  await requireCustomer('/account/addresses/new');
  return (
    <>
      <Crumbs list={[{ label: 'Addresses', href: '/account/addresses' }, { label: 'Add' }]} />
      <header className="st-plp-head">
        <h1 id="st-page-title">Add an address</h1>
        <div className="st-plp-aside"><p className="st-result-count">India only</p><p>We currently deliver within India. Fields marked * are required.</p></div>
      </header>
      <AddressForm />
    </>
  );
}
