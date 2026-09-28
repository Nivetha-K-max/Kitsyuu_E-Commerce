import type { Metadata } from 'next';
import Link from 'next/link';
import { Fragment } from 'react';
import { randomBytes } from 'node:crypto';
import { getCustomerCart, lineProblemText, listCustomerAddresses } from '@kitsyuu/core';
import CheckoutForm from '@/components/CheckoutForm';
import { Crumbs, EmptyState } from '@/components/ui';
import { commerceConfig, paymentProvider } from '@/lib/commerce';
import { currentCustomer, db } from '@/lib/server';
import { productImageUrl, rupees } from '@/lib/account-format';

/* Checkout (M7): signed-in customers only (guests are asked to log in; their browser cart is merged in afterwards).
   Everything shown is priced on the server from the database; the order is created by placeOrderAction. */
export const metadata: Metadata = { title: 'Checkout', robots: { index: false } };
export const dynamic = 'force-dynamic';

const head = (aside?: React.ReactNode) => (
  <>
    <Crumbs list={[{ label: 'Store', href: '/' }, { label: 'Cart', href: '/cart' }, { label: 'Checkout' }]} />
    <header className="st-plp-head"><h1 id="st-page-title" tabIndex={-1}>Checkout</h1>{aside && <div className="st-plp-aside">{aside}</div>}</header>
  </>
);

export default async function CheckoutPage() {
  const me = await currentCustomer();
  if (!me) {
    return (
      <div className="st-wrap">
        {head()}
        <section className="st-empty st-empty-inline" data-checkout-login>
          <h2>Log in to check out.</h2>
          <p>Your cart stays as it is and comes with you when you log in.</p>
          <p className="st-empty-actions">
            <Link className="button" href="/login?next=%2Fcheckout">Log in</Link>{' '}
            <Link className="button button-outline" href="/signup">Create an account</Link>
          </p>
        </section>
      </div>
    );
  }
  const [cart, addresses] = await Promise.all([getCustomerCart(db(), me, commerceConfig()), listCustomerAddresses(db(), me)]);
  const provider = paymentProvider();
  if (!cart.lines.length) {
    return <div className="st-wrap">{head()}<EmptyState title="Your cart is empty." text="Add a product to your cart before checking out." /></div>;
  }
  const t = cart.totals;
  const problems = cart.lines.filter(l => l.problem);
  return (
    <div className="st-wrap">
      {head(<p>Signed in as {me.email}.</p>)}
      <div className="st-cart st-checkout-layout">
        <div>
          {problems.length > 0 ? (
            <div className="st-form-alert" role="alert" data-checkout-problems>
              <p>{problems.map(lineProblemText).join(' ')}</p>
              <p><Link className="text-link" href="/cart">Update your cart</Link></p>
            </div>
          ) : !provider ? (
            <p className="st-form-alert" role="alert" data-no-payments>Online payment is not set up yet, so orders cannot be placed. Your cart is saved.</p>
          ) : !addresses.length ? (
            <section className="st-form-group" data-no-address>
              <h2>Deliver to</h2>
              <p>Add a delivery address to continue.</p>
              <p><Link className="button" href="/account/addresses/new?next=/checkout">Add an address</Link></p>
            </section>
          ) : (
            <CheckoutForm idempotencyKey={randomBytes(16).toString('hex')} expectedTotalPaise={t.totalPaise} totalLabel={rupees(t.totalPaise)}
              addresses={addresses.map(a => ({ id: a.id, isDefault: a.isDefault,
                label: `${a.fullName}, ${a.line1}${a.line2 ? ', ' + a.line2 : ''}, ${a.city}, ${a.state} ${a.pin} · ${a.phone}` }))} />
          )}
        </div>
        <aside className="st-summary" aria-labelledby="st-summary-title">
          <h2 id="st-summary-title">Order summary</h2>
          <ul className="st-mini">
            {cart.lines.map(l => {
              const img = productImageUrl(l.imagePath);
              return (
                <li key={l.variantId} className={l.problem ? 'has-problem' : undefined}>
                  <span className="st-mini-media">{img ? <img src={img} alt="" width={60} height={80} /> : null}</span>
                  <span className="st-mini-info"><b>{l.name}</b><small>SKU {l.sku}</small><small>Size {l.size} · Qty {l.qty}</small></span>
                  <span className="st-mini-total">{rupees(l.lineTotalPaise)}</span>
                </li>
              );
            })}
          </ul>
          <dl>
            <dt>Subtotal</dt><dd data-subtotal>{rupees(t.subtotalPaise)}</dd>
            {t.discounts.map(d => <Fragment key={d.code}><dt>{d.label}</dt><dd>−{rupees(d.amountPaise)}</dd></Fragment>)}
            <dt>Shipping</dt><dd data-shipping>{!t.shipping.configured ? 'Not set up yet' : t.shippingPaise > 0 ? rupees(t.shippingPaise) : t.shipping.label}</dd>
            <dt>Taxes</dt><dd>{t.pricesIncludeTax ? 'Included in the prices' : rupees(t.taxPaise)}</dd>
            <dt className="st-total">Total</dt><dd className="st-total" data-total>{rupees(t.totalPaise)}</dd>
          </dl>
        </aside>
      </div>
    </div>
  );
}
