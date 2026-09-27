import type { Metadata } from 'next';
import AccountNav from '@/components/AccountNav';
import { requireCustomer } from '@/lib/server';

export const metadata: Metadata = { title: { default: 'Account', template: '%s | Account | KITSYUU Store' }, robots: { index: false } };

/* Every /account page needs a signed-in customer (checked against the database). Guests are sent to log in by proxy.ts
   first, which keeps the page they asked for; each page and action checks the session again itself. */
export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const me = await requireCustomer('/account');
  const first = me.fullName?.split(/\s+/)[0];
  return (
    <div className="st-wrap st-auth st-account">
      <div className="st-account-layout">
        <AccountNav greeting={first ? `Hello, ${first}` : 'Your account'} />
        <div className="st-account-main">{children}</div>
      </div>
    </div>
  );
}
