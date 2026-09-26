import type { Metadata } from 'next';
import { can } from '@kitsyuu/auth';
import { listRoles } from '@kitsyuu/core';
import { ActionForm, Field, FieldError } from '@/components/forms';
import RoleChecks from '@/components/RoleChecks';
import { Forbidden, PageHead } from '@/components/ui';
import { db, requireActor } from '@/lib/server';
import { inviteStaffAction } from '../actions';

export const metadata: Metadata = { title: 'Invite staff' };

export default async function InviteStaffPage() {
  const actor = await requireActor();
  const crumbs = [{ href: '/staff', label: 'Staff' }];
  if (!can(actor, 'staff.manage')) return <><PageHead title="Invite staff" crumbs={crumbs} /><Forbidden permission="staff.manage" /></>;
  const roles = can(actor, 'roles.read') ? await listRoles(db(), actor) : [];
  return (
    <>
      <PageHead title="Invite staff" crumbs={crumbs} />
      <p className="note" style={{ maxWidth: 560 }}>The person receives a one-time link to set their own password. No password is ever chosen or seen by the inviter.</p>
      {roles.length === 0 ? <p className="msg error">Assigning roles needs the roles.read permission.</p> : (
        <ActionForm action={inviteStaffAction} submitLabel="Send invitation" pendingLabel="Inviting…">
          <Field name="email" label="Email" type="email" autoComplete="off" required />
          <Field name="fullName" label="Name" autoComplete="off" required />
          <RoleChecks roles={roles} actorPermissions={actor.permissions} selected={[]} />
          <FieldError name="roleIds" />
        </ActionForm>
      )}
    </>
  );
}
