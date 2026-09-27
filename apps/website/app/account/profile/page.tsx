import type { Metadata } from 'next';
import { getCustomerProfile } from '@kitsyuu/core';
import { ProfileForm } from '@/components/AccountForms';
import { db, requireCustomer } from '@/lib/server';

export const metadata: Metadata = { title: 'Personal information' };

export default async function ProfilePage() {
  const me = await requireCustomer('/account/profile');
  const profile = await getCustomerProfile(db(), me);
  return (
    <>
      <header className="st-plp-head">
        <h1 id="st-page-title">Personal information</h1>
        <div className="st-plp-aside"><p className="st-result-count">Profile</p><p>Your email is {profile.email}. To use a different email, contact us.</p></div>
      </header>
      <ProfileForm fullName={profile.fullName} phone={profile.phone} />
    </>
  );
}
