import type { Metadata } from 'next';
import AccountNav from '@/components/AccountNav';
import { accountProfile } from '@/lib/account-data';
import { formatMonthYear, initialsOf } from '@/lib/account-format';
import { asset } from '@/lib/catalogue-utils';
import { requireCustomer } from '@/lib/server';

export const metadata: Metadata = { title: { default: 'Account', template: '%s | Account | KITSYUU Store' }, robots: { index: false } };

/* Every /account page needs a signed-in customer (checked against the database). Guests are sent to log in by proxy.ts
   first, which keeps the page they asked for; each page and action checks the session again itself.
   The profile header shows the customer's own details only (name, email, member since). */
export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const me = await requireCustomer('/account');
  const profile = await accountProfile(me);
  const name = profile.fullName?.trim();
  return (
    <div className="st-wrap st-auth st-account">
      <header className="st-acc-hero" aria-label="Your account">
        <span className="st-acc-avatar" aria-hidden="true">{initialsOf(profile.fullName, profile.email)}</span>
        <div className="st-acc-id">
          <p className="st-acc-eyebrow">KITSYUU account</p>
          <p className="st-acc-name">{name || 'Your account'}</p>
          <p className="st-acc-meta"><span>{profile.email}</span><span>Member since {formatMonthYear(profile.createdAt)}</span></p>
        </div>
        <img className="st-acc-mark" src={asset('assets/kitsyuu-icon.svg')} alt="" width={1024} height={1024} loading="lazy" decoding="async" aria-hidden="true" />
      </header>
      <div className="st-account-layout">
        <AccountNav />
        <div className="st-account-main">{children}</div>
      </div>
    </div>
  );
}
