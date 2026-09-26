import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listStaff } from '@kitsyuu/core';
import { Icon } from '@/components/icons';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { db, requireActor } from '@/lib/server';

export const metadata: Metadata = { title: 'Staff' };

export default async function StaffPage() {
  const actor = await requireActor();
  if (!can(actor, 'staff.read')) return <><PageHead section="System" title="Staff" /><Forbidden permission="staff.read" /></>;
  const staff = await listStaff(db(), actor);
  const manage = can(actor, 'staff.manage');
  return (
    <>
      <PageHead section="System" title="Staff" eyebrow={`${staff.length} account${staff.length === 1 ? '' : 's'}`}>
        {manage && <Link className="btn" href="/staff/invite" data-invite-link><Icon name="plus" size={16} />Invite staff</Link>}
      </PageHead>
      {staff.length === 0 ? <Empty title="No staff accounts yet">Invite a staff member to give them access.</Empty> : (
        <div className="table-wrap"><table data-staff-table>
          <thead><tr><th>Name</th><th>Email</th><th>Roles</th><th>Status</th><th>Last sign-in</th><th className="num">Actions</th></tr></thead>
          <tbody>{staff.map(s => (
            <tr key={s.id} data-staff-row={s.email}>
              <td><Link className="row-link" href={`/staff/${s.id}`}>{s.fullName || '—'}</Link>{s.id === actor.staffId && <span className="note"> (you)</span>}</td>
              <td>{s.email}</td>
              <td>{s.roles.length ? s.roles.map(r => <span className="badge role" key={r.id}>{r.name}</span>) : <span className="note">No roles</span>}</td>
              <td><StatusBadge status={s.status} /></td>
              <td className="nowrap">{formatDateTime(s.lastLoginAt)}</td>
              <td className="num"><Link className="btn ghost sm" href={`/staff/${s.id}`} aria-label={`${manage ? 'Manage' : 'View'} ${s.email}`}>{manage ? 'Manage' : 'View'}</Link></td>
            </tr>))}
          </tbody>
        </table></div>
      )}
    </>
  );
}
