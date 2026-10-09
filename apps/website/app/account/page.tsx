import type { Metadata } from 'next';
import Link from 'next/link';
import { customerReviewState, listCustomerAddresses, listCustomerOrders, loyaltyBalance, readLoyaltySettings } from '@kitsyuu/core';
import AccountCartNotice from '@/components/AccountCartNotice';
import AccountWishCount from '@/components/AccountWishCount';
import { Card, StatusPill } from '@/components/account-ui';
import { accountProfile } from '@/lib/account-data';
import { db, requireCustomer } from '@/lib/server';
import { formatDate, ORDER_STATUS_LABEL, rupees } from '@/lib/account-format';

export const metadata: Metadata = { title: 'Overview' };
type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function AccountPage({ searchParams }: { searchParams: SP }) {
  const me = await requireCustomer('/account');
  const welcome = (await searchParams).welcome === '1';
  // The summary tiles are extras: if points or reviews cannot be read, the overview still shows without them.
  const [profile, addresses, orders, points, reviews] = await Promise.all([accountProfile(me), listCustomerAddresses(db(), me), listCustomerOrders(db(), me),
    Promise.all([readLoyaltySettings(db()), loyaltyBalance(db(), me.customerId)]).then(([s, balance]) => (s.enabled || balance > 0 ? balance : null)).catch(() => null),
    customerReviewState(db(), me).then(r => ({ written: r.reviews.length, waiting: r.reviewable.length })).catch(() => null)]);
  const home = addresses.find(a => a.isDefault);
  const unpaid = orders.filter(o => o.status === 'pending_payment' || o.status === 'payment_failed').slice(0, 2);
  const orderLink = (n: string) => `/account/orders/${encodeURIComponent(n)}`;
  return (
    <>
      <header className="st-plp-head">
        <h1 id="st-page-title">Overview</h1>
      </header>
      {welcome && <div className="st-form-ok" role="status" data-notice="welcome">Your email is confirmed. Welcome to KITSYUU.</div>}
      <AccountCartNotice />
      {(unpaid.length > 0 || !!reviews?.waiting) && (
        <ul className="st-acc-attention" aria-label="Needs your attention">
          {unpaid.map(o => (
            <li key={o.orderNumber}><Link href={orderLink(o.orderNumber)}>
              <span>{o.status === 'payment_failed' ? 'The payment did not go through for order' : 'Waiting for payment: order'} <b>{o.orderNumber}</b></span><span aria-hidden="true">→</span></Link></li>
          ))}
          {!!reviews?.waiting && <li><Link href="/account/reviews"><span><b>{reviews.waiting}</b> {reviews.waiting === 1 ? 'purchase is' : 'purchases are'} waiting for your review</span><span aria-hidden="true">→</span></Link></li>}
        </ul>
      )}
      <ul className="st-acc-tiles">
        <li><Link href="/account/orders"><span className="st-acc-tile-n">{orders.length >= 100 ? '100+' : orders.length}</span><span className="st-acc-tile-l">{orders.length === 1 ? 'Order' : 'Orders'}</span></Link></li>
        <li><Link href="/account/wishlist"><span className="st-acc-tile-n"><AccountWishCount /></span><span className="st-acc-tile-l">Wishlist</span></Link></li>
        {points !== null && <li><Link href="/account/points"><span className="st-acc-tile-n">{points}</span><span className="st-acc-tile-l">Points</span></Link></li>}
        {reviews && <li><Link href="/account/reviews"><span className="st-acc-tile-n">{reviews.written}</span><span className="st-acc-tile-l">{reviews.written === 1 ? 'Review' : 'Reviews'}</span></Link></li>}
      </ul>
      <div className="st-acc-grid">
        <Card id="st-acc-details" title="Profile" action={{ href: '/account/profile', label: 'Edit' }}>
          <dl className="st-account-dl">
            <dt>Name</dt><dd data-account-name="">{profile.fullName || 'Not set'}</dd>
            <dt>Email</dt><dd data-account-email="">{profile.email}</dd>
            <dt>Mobile</dt><dd>{profile.phone || 'Not set'}</dd>
            <dt>Member since</dt><dd>{formatDate(profile.createdAt)}</dd>
          </dl>
        </Card>
        <Card id="st-acc-address" title="Default address" action={{ href: '/account/addresses', label: 'Manage' }}>
          {home ? <address className="st-address-text"><b>{home.fullName}</b><br />{home.line1}{home.line2 && <><br />{home.line2}</>}<br />{home.city}, {home.state} {home.pin}</address>
            : <p className="st-acc-quiet">No address saved yet.</p>}
        </Card>
        <Card id="st-acc-orders" title="Recent orders" action={{ href: '/account/orders', label: 'All orders' }} className="is-wide">
          {orders.length === 0 ? <p className="st-acc-quiet" data-empty="orders">You have not placed any orders yet.</p> : (
            <ul className="st-order-list">
              {orders.slice(0, 3).map(o => (
                <li key={o.orderNumber}><Link href={orderLink(o.orderNumber)}>
                  <span className="st-order-no">{o.orderNumber}</span><span className="st-order-when">{formatDate(o.createdAt)}</span>
                  <StatusPill status={o.status} label={ORDER_STATUS_LABEL[o.status] ?? o.status} /><span className="st-order-total">{rupees(o.totalPaise)}</span></Link></li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
