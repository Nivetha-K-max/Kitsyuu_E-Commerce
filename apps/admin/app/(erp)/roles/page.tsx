import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listRoles } from '@kitsyuu/core';
import { Icon } from '@/components/icons';
import { Forbidden, PageHead } from '@/components/ui';
import { db, requireActor } from '@/lib/server';

export const metadata: Metadata = { title: 'Roles & permissions' };
type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function RolesPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'roles.read')) return <><PageHead section="System" title="Roles & permissions" /><Forbidden permission="roles.read" /></>;
  const roles = await listRoles(db(), actor);
  const manage = can(actor, 'roles.manage');
  const deleted = (await searchParams).notice === 'deleted';
  return (
    <>
      <PageHead section="System" title="Roles & permissions" eyebrow={`${roles.length} roles`}>
        {manage && <Link className="btn" href="/roles/new"><Icon name="plus" size={16} />New role</Link>}
      </PageHead>
      {deleted && <p className="msg ok" role="status">Role deleted.</p>}
      <div className="table-wrap"><table data-roles-table>
        <thead><tr><th>Role</th><th>Description</th><th className="num">Permissions</th><th className="num">Staff</th><th className="num">Actions</th></tr></thead>
        <tbody>{roles.map(r => (
          <tr key={r.id} data-role-row={r.code}>
            <td><Link className="row-link" href={`/roles/${r.id}`}>{r.name}</Link>{r.isSystem && <> <span className="badge system">built-in</span></>}
              <div className="note mono">{r.code}</div></td>
            <td className="desc-cell">{r.description || <span className="note">—</span>}</td>
            <td className="num" data-perm-count>{r.permissions.length}</td>
            <td className="num">{r.members}</td>
            <td className="num"><Link className="btn ghost sm" href={`/roles/${r.id}`} aria-label={`${manage ? 'Edit' : 'View'} ${r.name}`}>{manage ? 'Edit' : 'View'}</Link></td>
          </tr>))}
        </tbody>
      </table></div>
    </>
  );
}
