import type { Metadata } from 'next';
import { ActionForm, Field } from '@/components/forms';
import { PageHead } from '@/components/ui';
import { requireActor } from '@/lib/server';
import { changePasswordAction } from './actions';

export const metadata: Metadata = { title: 'My account' };

export default async function AccountPage() {
  const actor = await requireActor();
  const perms = [...actor.permissions].sort();
  return (
    <>
      <PageHead title="My account" eyebrow={actor.email} />
      <div className="grid two">
        <section className="card">
          <h2>Change password</h2>
          <ActionForm action={changePasswordAction} submitLabel="Change password">
            <Field name="current" label="Current password" type="password" autoComplete="current-password" />
            <Field name="password" label="New password" type="password" autoComplete="new-password" hint="At least 12 characters." />
            <Field name="confirm" label="Repeat new password" type="password" autoComplete="new-password" />
          </ActionForm>
        </section>
        <section className="card">
          <h2>What you can do</h2>
          <p className="note">Your permissions come from your roles and are re-checked on every request.</p>
          <div data-my-permissions>{perms.length ? perms.map(p => <span className="badge" key={p}>{p}</span>) : <span className="note">No permissions.</span>}</div>
        </section>
      </div>
    </>
  );
}
