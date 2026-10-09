import { EmptyNote } from '@/components/account-ui';

/* An order, return, address, review or message that is not in this account (or no longer exists). Stays inside the
   account frame, with a way back, instead of the store-wide "not in the catalogue" page. */
export default function AccountNotFound() {
  return (
    <>
      <header className="st-plp-head"><h1 id="st-page-title">Not found</h1></header>
      <EmptyNote data-not-found="account" action={{ href: '/account/orders', label: 'Go to your orders' }}>
        We could not find that in your account. The link may be old, or it belongs to a different account.
      </EmptyNote>
    </>
  );
}
