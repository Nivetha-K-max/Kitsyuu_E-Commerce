import type { Metadata } from 'next';
import Link from 'next/link';
import { listCustomerAddresses } from '@kitsyuu/core';
import { AddressActions } from '@/components/AccountForms';
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
      {addresses.length === 0 ? <p className="st-account-empty" data-empty="addresses">You have not saved an address yet.</p> : (
        <ul className="st-address-list">
          {addresses.map(a => (
            <li key={a.id} className="st-address-card" data-address={a.id} data-default={a.isDefault || undefined}>
              {a.isDefault && <p className="st-address-tag">Default</p>}
              <address className="st-address-text">{a.fullName}<br />{a.line1}{a.line2 && <><br />{a.line2}</>}<br />{a.city}, {a.state} {a.pin}<br />{a.country} · {a.phone}</address>
              <div className="st-address-actions-row">
                <Link className="st-link-button" href={`/account/addresses/${a.id}`} aria-label={`Edit the address ${a.line1}`}>Edit</Link>
                <AddressActions address={a} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {addresses.length < 20 && <p className="st-account-more"><Link className="button" href="/account/addresses/new">Add an address</Link></p>}
    </>
  );
}
