'use client';
/* Checkout could not load (e.g. the database or the payment service is unreachable). Nothing is lost: the cart and any
   order already placed are kept on the server. No internal details are shown; the reference matches the server log. */
import Link from 'next/link';

export default function CheckoutError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="st-wrap">
      <section className="st-empty" data-checkout-error>
        <p className="eyebrow"><span></span>CHECKOUT UNAVAILABLE</p>
        <h1>Checkout is not available right now.</h1>
        <p>Your cart and any order you already placed are safe. Please try again in a moment.{error.digest ? ` (Reference ${error.digest})` : ''}</p>
        <p className="st-empty-actions"><button className="button" type="button" onClick={reset}>Try again</button> <Link className="button button-outline" href="/cart">Back to cart</Link></p>
      </section>
    </div>
  );
}
