import type { Metadata } from 'next';
import Link from 'next/link';
import { getCustomerProfile, listCustomerAddresses, listCustomerOrders } from '@kitsyuu/core';
import { db, requireCustomer } from '@/lib/server';
import { formatDate, ORDER_STATUS_LABEL, rupees } from '@/lib/account-format';

export const metadata: Metadata = { title: 'Overview' };
type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function AccountPage({ searchParams }: { searchParams: SP }) {
  const me = await requireCustomer('/account');
  const welcome = (await searchParams).welcome === '1';
  const [profile, addresses, orders] = await Promise.all([getCustomerProfile(db(), me), listCustomerAddresses(db(), me), listCustomerOrders(db(), me)]);
  const home = addresses.find(a => a.isDefault);
  return (
    <>
      <header className="st-plp-head">
        <h1 id="st-page-title">Account</h1>
        <div className="st-plp-aside"><p className="st-result-count">Customer</p><p>Signed in as <span data-account-email="">{profile.email}</span>.</p></div>
      </header>
      {welcome && <div className="st-form-ok" role="status" data-notice="welcome">Your email is confirmed. Welcome to KITSYUU.</div>}
      <section className="st-form-group" aria-labelledby="st-acc-details">
        <h2 id="st-acc-details">Details</h2>
        <dl className="st-account-dl">
          <dt>Name</dt><dd data-account-name="">{profile.fullName || 'Not set'}</dd>
          <dt>Email</dt><dd>{profile.email}</dd>
          <dt>Mobile</dt><dd>{profile.phone || 'Not set'}</dd>
          <dt>Member since</dt><dd>{formatDate(profile.createdAt)}</dd>
        </dl>
        <p className="st-account-more"><Link className="text-link" href="/account/profile">Edit personal information <span aria-hidden="true">↗</span></Link></p>
      </section>
      <section className="st-form-group" aria-labelledby="st-acc-address">
        <h2 id="st-acc-address">Default address</h2>
        {home ? <address className="st-address-text">{home.fullName}<br />{home.line1}{home.line2 && <><br />{home.line2}</>}<br />{home.city}, {home.state} {home.pin}</address>
          : <p>No address saved yet.</p>}
        <p className="st-account-more"><Link className="text-link" href="/account/addresses">Manage addresses <span aria-hidden="true">↗</span></Link></p>
      </section>
      <section className="st-form-group" aria-labelledby="st-acc-orders">
        <h2 id="st-acc-orders">Recent orders</h2>
        {orders.length === 0 ? <p data-empty="orders">You have not placed any orders yet.</p> : (
          <ul className="st-order-list">
            {orders.slice(0, 3).map(o => (
              <li key={o.orderNumber}><Link href={`/account/orders/${encodeURIComponent(o.orderNumber)}`}>
                <span className="st-order-no">{o.orderNumber}</span><span>{formatDate(o.createdAt)}</span>
                <span>{ORDER_STATUS_LABEL[o.status] ?? o.status}</span><span className="st-order-total">{rupees(o.totalPaise)}</span></Link></li>
            ))}
          </ul>
        )}
        <p className="st-account-more"><Link className="text-link" href="/account/orders">All orders <span aria-hidden="true">↗</span></Link></p>
      </section>
    </>
  );
}
