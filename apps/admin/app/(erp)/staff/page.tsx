import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listStaff } from '@kitsyuu/core';
import { Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { db, requireActor } from '@/lib/server';

export const metadata: Metadata = { title: 'Staff' };

export default async function StaffPage() {
  const actor = await requireActor();
  if (!can(actor, 'staff.read')) return <><PageHead section="System" title="Staff" /><Forbidden permission="staff.read" /></>;
  const staff = await listStaff(db(), actor);
  return (
    <>
      <PageHead section="System" title="Staff" eyebrow={`${staff.length} account${staff.length === 1 ? '' : 's'}`}>
        {can(actor, 'staff.manage') && <Link className="btn" href="/staff/invite" data-invite-link>Invite staff</Link>}
      </PageHead>
      {staff.length === 0 ? <p className="empty">No staff accounts yet.</p> : (
        <div className="table-wrap"><table data-staff-table>
          <thead><tr><th>Email</th><th>Name</th><th>Status</th><th>Roles</th><th>Last sign-in</th></tr></thead>
          <tbody>{staff.map(s => (
            <tr key={s.id} data-staff-row={s.email}>
              <td><Link href={`/staff/${s.id}`}>{s.email}</Link>{s.id === actor.staffId && <span className="note"> (you)</span>}</td>
              <td>{s.fullName || '—'}</td>
              <td><StatusBadge status={s.status} /></td>
              <td>{s.roles.map(r => <span className="badge" key={r.id}>{r.name}</span>)}</td>
              <td>{formatDateTime(s.lastLoginAt)}</td>
            </tr>))}
          </tbody>
        </table></div>
      )}
    </>
  );
}
