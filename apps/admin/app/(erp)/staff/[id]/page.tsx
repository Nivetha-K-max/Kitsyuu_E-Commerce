import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError, uuid } from '@kitsyuu/contracts';
import { getStaff, listRoles } from '@kitsyuu/core';
import { ActionForm, Field, Hidden } from '@/components/forms';
import RoleChecks from '@/components/RoleChecks';
import { Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { resendInviteAction, revokeSessionsAction, setStaffRolesAction, setStaffStatusAction, updateStaffAction } from '../actions';

export const metadata: Metadata = { title: 'Staff member' };
type Params = Promise<{ id: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function StaffDetailPage({ params, searchParams }: { params: Params; searchParams: SP }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/staff', label: 'Staff' }];
  if (!can(actor, 'staff.read')) return <><PageHead title="Staff member" crumbs={crumbs} /><Forbidden permission="staff.read" /></>;
  const { id } = await params;
  if (!uuid.safeParse(id).success) notFound();
  const staff = await getStaff(db(), actor, id).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const manage = can(actor, 'staff.manage');
  const roles = manage && can(actor, 'roles.read') ? await listRoles(db(), actor) : [];
  const self = staff.id === actor.staffId;
  const invited = (await searchParams).notice === 'invited';
  return (
    <>
      <PageHead title={staff.fullName || staff.email} eyebrow={staff.email} crumbs={crumbs}>
        <StatusBadge status={staff.status} />
      </PageHead>
      {invited && <p className="msg ok" role="status" data-notice="invited">Invitation sent to {staff.email}. The link expires {formatDateTime(staff.inviteExpiresAt)}.</p>}
      <div className="grid two" style={{ marginTop: 14 }}>
        <section className="card">
          <h2>Account</h2>
          <dl className="grid" style={{ gridTemplateColumns: 'auto 1fr', gap: '6px 16px', margin: 0 }} data-staff-facts>
            <dt className="note">Roles</dt><dd style={{ margin: 0 }}>{staff.roles.length ? staff.roles.map(r => <span className="badge" key={r.id}>{r.name}</span>) : '—'}</dd>
            <dt className="note">Last sign-in</dt><dd style={{ margin: 0 }}>{formatDateTime(staff.lastLoginAt)}</dd>
            <dt className="note">Password set</dt><dd style={{ margin: 0 }}>{formatDateTime(staff.passwordChangedAt)}</dd>
            <dt className="note">Active sessions</dt><dd style={{ margin: 0 }} data-active-sessions>{staff.activeSessions}</dd>
            <dt className="note">Invited</dt><dd style={{ margin: 0 }}>{formatDateTime(staff.createdAt)}</dd>
            {staff.status === 'invited' && <><dt className="note">Invitation expires</dt><dd style={{ margin: 0 }}>{staff.inviteExpiresAt ? formatDateTime(staff.inviteExpiresAt) : 'expired'}</dd></>}
          </dl>
          {can(actor, 'audit.read') && <p style={{ marginTop: 14 }}><Link className="btn ghost" href={`/audit?staffId=${staff.id}`}>Actions by this person</Link></p>}
        </section>
        {manage ? (
          <section className="card" data-section="details">
            <h2>Details</h2>
            <ActionForm action={updateStaffAction} submitLabel="Save details">
              <Hidden name="staffId" value={staff.id} />
              <Field name="fullName" label="Name" defaultValue={staff.fullName} />
              <Field name="email" label="Email" type="email" defaultValue={staff.email} hint="Changing the email is recorded in the audit log." />
            </ActionForm>
          </section>
        ) : <section className="card"><p className="note">Changing staff accounts needs the staff.manage permission.</p></section>}
      </div>
      {manage && (
        <div className="grid two" style={{ marginTop: 14 }}>
          <section className="card" data-section="roles">
            <h2>Roles</h2>
            {roles.length ? (
              <ActionForm action={setStaffRolesAction} submitLabel="Save roles">
                <Hidden name="staffId" value={staff.id} />
                <RoleChecks roles={roles} actorPermissions={actor.permissions} selected={staff.roles.map(r => r.id)} />
              </ActionForm>
            ) : <p className="note">Assigning roles also needs roles.read.</p>}
          </section>
          <section className="card" data-section="access">
            <h2>Access</h2>
            {staff.status === 'invited' && (
              <ActionForm action={resendInviteAction} submitLabel="Send a new invitation" variant="ghost" className="form" id="resend">
                <Hidden name="staffId" value={staff.id} />
              </ActionForm>
            )}
            <ActionForm action={revokeSessionsAction} submitLabel={self ? 'Sign out my other sessions' : 'Sign out everywhere'} variant="ghost" id="revoke">
              <Hidden name="staffId" value={staff.id} />
            </ActionForm>
            {!self && (
              <div style={{ marginTop: 14 }}>
                <ActionForm action={setStaffStatusAction} id="status"
                  submitLabel={staff.status === 'disabled' ? 'Re-enable account' : 'Disable account'} variant={staff.status === 'disabled' ? 'ghost' : 'danger'}
                  confirmText={staff.status === 'disabled' ? undefined : `Disable ${staff.email}? They will be signed out everywhere.`}>
                  <Hidden name="staffId" value={staff.id} />
                  <Hidden name="status" value={staff.status === 'disabled' ? 'active' : 'disabled'} />
                </ActionForm>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
