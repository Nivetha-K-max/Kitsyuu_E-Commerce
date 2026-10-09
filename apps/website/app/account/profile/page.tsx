import type { Metadata } from 'next';
import { ProfileForm } from '@/components/AccountForms';
import { Card } from '@/components/account-ui';
import { accountProfile } from '@/lib/account-data';
import { formatDate } from '@/lib/account-format';
import { requireCustomer } from '@/lib/server';

export const metadata: Metadata = { title: 'Personal information' };

export default async function ProfilePage() {
  const me = await requireCustomer('/account/profile');
  const profile = await accountProfile(me);
  return (
    <>
      <header className="st-plp-head">
        <h1 id="st-page-title">Personal information</h1>
        <div className="st-plp-aside"><p>The name and mobile number we use for your orders.</p></div>
      </header>
      <div className="st-acc-grid">
        <Card id="st-prof-edit" title="Your details">
          <ProfileForm fullName={profile.fullName} phone={profile.phone} />
        </Card>
        <Card id="st-prof-login" title="Sign-in email">
          <dl className="st-account-dl is-stacked">
            <dt>Email</dt><dd>{profile.email}{profile.emailVerified && <span className="st-pill" data-tone="ok">Verified</span>}</dd>
            <dt>Member since</dt><dd>{formatDate(profile.createdAt)}</dd>
          </dl>
          <p className="st-acc-quiet">To use a different email, contact us.</p>
        </Card>
      </div>
    </>
  );
}
