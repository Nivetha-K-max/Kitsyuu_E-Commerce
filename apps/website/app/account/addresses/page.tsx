import type { Metadata } from 'next';
import Link from 'next/link';
import { listCustomerAddresses } from '@kitsyuu/core';
import { AddressActions } from '@/components/AccountForms';
import { EmptyNote } from '@/components/account-ui';
import { db, requireCustomer } from '@/lib/server';

export const metadata: Metadata = { title: 'Addresses' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const NOTICES: Record<string, string> = { added: 'Address added.', updated: 'Address saved.' };

export default async function AddressesPage({ searchParams }: { searchParams: SP }) {
  const me = await requireCustomer('/account/addresses');
  const notice = NOTICES[String((await searchParams).notice ?? '')];
  const addresses = await listCustomerAddresses(db(), me);
  return (
    <>
      <header className="st-plp-head">
        <h1 id="st-page-title">Addresses</h1>
        <div className="st-plp-aside"><p className="st-result-count">{addresses.length} saved</p><p>Your default address is used first at checkout. You can keep up to 20.</p></div>
      </header>
      {notice && <div className="st-form-ok" role="status" data-notice="address">{notice}</div>}
      {addresses.length === 0 ? <EmptyNote data-empty="addresses" action={{ href: '/account/addresses/new', label: 'Add an address' }}>You have not saved an address yet.</EmptyNote> : (
        <ul className="st-address-list">
          {addresses.map(a => (
            <li key={a.id} className="st-address-card" data-address={a.id} data-default={a.isDefault || undefined}>
              <div className="st-address-head"><p className="st-address-name">{a.fullName}</p>{a.isDefault && <p className="st-address-tag">Default</p>}</div>
              <address className="st-address-text">{a.line1}{a.line2 && <><br />{a.line2}</>}<br />{a.city}, {a.state} {a.pin}<br />{a.country}</address>
              <p className="st-address-phone">{a.phone}</p>
              <div className="st-address-actions-row">
                <Link className="st-link-button" href={`/account/addresses/${a.id}`} aria-label={`Edit the address ${a.line1}`}>Edit</Link>
                <AddressActions address={a} />
              </div>
            </li>
          ))}
          {addresses.length < 20 && <li className="st-address-add"><Link href="/account/addresses/new"><span aria-hidden="true">+</span>Add an address</Link></li>}
        </ul>
      )}
    </>
  );
}
