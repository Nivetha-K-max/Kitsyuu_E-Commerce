'use client';
/* Checkout rendered on the server with an empty saved cart. A guest who has just logged in still has their cart in this
   browser: it is merged into the account a moment after the page loads (StoreProvider). Until the cart is known this
   shows "loading", and once the merged cart has items the page is asked for again, so the customer lands on the real
   checkout instead of "your cart is empty". Shown as empty only when the cart really is. */
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useStore } from './StoreProvider';

export default function CheckoutCartSync({ children }: { children: React.ReactNode }) {
  const { ready, mode, lines } = useStore();
  const router = useRouter();
  const asked = useRef(false);
  const [gaveUp, setGaveUp] = useState(false);
  const hasItems = ready && mode === 'customer' && lines.length > 0;
  useEffect(() => {
    if (!hasItems || asked.current) return;
    asked.current = true;
    router.refresh();
    const t = setTimeout(() => setGaveUp(true), 8000);   // the refreshed page replaces this component; if it does not, stop waiting
    return () => clearTimeout(t);
  }, [hasItems, router]);
  if (!ready || (hasItems && !gaveUp)) return <div className="st-loading-area" data-checkout-syncing><p className="st-status" role="status">Loading your cart…</p></div>;
  return <>{children}</>;
}
