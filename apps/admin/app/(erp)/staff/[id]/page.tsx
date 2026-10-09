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
import { resendInviteAction, resetTwoFactorAction, revokeSessionsAction, setStaffRolesAction, setStaffStatusAction, updateStaffAction } from '../actions';
import { Entity, Section } from '@/components/frame';
import RecordActivity from '@/components/RecordActivity';

export const metadata: Metadata = { title: 'Staff member' };
type Params = Promise<{ id: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function StaffDetailPage({ params, searchParams }: { params: Params; searchParams: SP }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/staff', label: 'Staff' }];
  if (!can(actor, 'staff.read')) return <><PageHead section="System" title="Staff member" crumbs={crumbs} /><Forbidden permission="staff.read" /></>;
  const { id } = await params;
  if (!uuid.safeParse(id).success) notFound();
  const staff = await getStaff(db(), actor, id).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const manage = can(actor, 'staff.manage');
  const roles = manage && can(actor, 'roles.read') ? await listRoles(db(), actor) : [];
  const self = staff.id === actor.staffId;
  const spv = await searchParams;
  const invited = spv.notice === 'invited';
  const seeAudit = can(actor, 'audit.read');
  const tab = spv.tab === 'activity' && seeAudit ? 'activity' : 'main';
  const selfHref = `/staff/${staff.id}`;
  return (
    <Entity module={{ href: '/staff', label: 'Staff' }} name="staff-member" title={staff.fullName || staff.email} status={<StatusBadge status={staff.status} />}
      factsAttr="data-staff-facts" facts={[{ label: 'Email', value: staff.email }]}
      tabs={[{ id: 'main', label: 'Account' }, ...(seeAudit ? [{ id: 'activity', label: 'Activity' }] : [])]} current={tab} tabHref={x => (x === 'main' ? selfHref : `${selfHref}?tab=${x}`)}>
      {tab === 'activity' && (
        <Section id="act-h" title="Activity" name="activity" wide hint="Changes to this staff account, from the audit log.">
          <RecordActivity entityType="staff_users" entityId={staff.id} name="staff-member" empty="Changes to this staff account are listed here as they are made." />
        </Section>
      )}
      {tab === 'main' && <>
      {invited && <p className="msg ok" role="status" data-notice="invited">Invitation sent to {staff.email}. The link expires {formatDateTime(staff.inviteExpiresAt)}.</p>}
      <div className="grid two">
        <section className="card">
          <h2>Account</h2>
          <dl className="facts" data-staff-facts>
            <dt>Roles</dt><dd>{staff.roles.length ? staff.roles.map(r => <span className="badge" key={r.id}>{r.name}</span>) : '—'}</dd>
            <dt>Last sign-in</dt><dd>{formatDateTime(staff.lastLoginAt)}</dd>
            <dt>Password set</dt><dd>{formatDateTime(staff.passwordChangedAt)}</dd>
            <dt>Active sessions</dt><dd data-active-sessions>{staff.activeSessions}</dd>
            <dt>Invited</dt><dd>{formatDateTime(staff.createdAt)}</dd>
            {staff.status === 'invited' && <><dt>Invitation expires</dt><dd>{staff.inviteExpiresAt ? formatDateTime(staff.inviteExpiresAt) : 'expired'}</dd></>}
          </dl>
          {can(actor, 'audit.read') && <p className="section-foot"><Link className="btn ghost" href={`/audit?staffId=${staff.id}`}>Actions by this person</Link></p>}
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
        <div className="grid two">
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
              <ActionForm action={resetTwoFactorAction} submitLabel="Remove two-factor sign-in" variant="ghost" id="reset-mfa"
                confirmText="Remove this person's two-factor sign-in (for example after a lost phone)? They can set it up again.">
                <Hidden name="staffId" value={staff.id} />
              </ActionForm>
            )}
            {!self && (
              <div className="danger-zone">
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
      </>}
    </Entity>
  );
}
