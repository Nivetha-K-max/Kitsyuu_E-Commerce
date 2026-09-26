import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError, uuid } from '@kitsyuu/contracts';
import { getRole, listPermissions } from '@kitsyuu/core';
import { ActionForm, Field, Hidden } from '@/components/forms';
import { Forbidden, PageHead } from '@/components/ui';
import { db, requireActor } from '@/lib/server';
import { deleteRoleAction, updateRoleAction } from '../actions';

export const metadata: Metadata = { title: 'Role' };
type Params = Promise<{ id: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function RolePage({ params, searchParams }: { params: Params; searchParams: SP }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/roles', label: 'Roles & permissions' }];
  if (!can(actor, 'roles.read')) return <><PageHead title="Role" crumbs={crumbs} /><Forbidden permission="roles.read" /></>;
  const { id } = await params;
  if (!uuid.safeParse(id).success) notFound();
  const role = await getRole(db(), actor, id).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const perms = await listPermissions(db(), actor);
  const modules = [...new Set(perms.map(p => p.module))];
  const manage = can(actor, 'roles.manage');
  const created = (await searchParams).notice === 'created';

  const matrix = (
    <div className="perm-grid" data-perm-matrix>
      {modules.map(m => (
        <fieldset className="fieldset" key={m}>
          <legend>{m}</legend>
          {perms.filter(p => p.module === m).map(p => {
            const held = actor.permissions.has(p.code);
            return (
              <label className="check" key={p.code} data-locked={manage && !held} data-perm={p.code}>
                <input type="checkbox" name="permissionCodes" value={p.code} defaultChecked={role.permissions.includes(p.code)} disabled={!manage || !held} />
                <span className="mono">{p.code}<small>{p.description}{manage && !held ? ' · you do not hold this' : ''}</small></span>
              </label>
            );
          })}
        </fieldset>
      ))}
    </div>
  );

  return (
    <>
      <PageHead title={role.name} eyebrow={`${role.code}${role.isSystem ? ' · built-in' : ''} · ${role.members} staff`} crumbs={crumbs} />
      {created && <p className="msg ok" role="status">Role created. Choose its permissions below.</p>}
      {manage ? (
        <ActionForm action={updateRoleAction} submitLabel="Save role" className="grid">
          <Hidden name="roleId" value={role.id} />
          <div className="form"><Field name="name" label="Name" defaultValue={role.name} /><Field name="description" label="Description" defaultValue={role.description} /></div>
          {matrix}
        </ActionForm>
      ) : (<>{matrix}<p className="note" style={{ marginTop: 12 }}>Changing roles needs the roles.manage permission.</p></>)}
      {manage && !role.isSystem && (
        <section className="card" style={{ marginTop: 18, maxWidth: 560 }}>
          <h2>Delete role</h2>
          {role.members > 0 ? <p className="note">Remove this role from its {role.members} staff member(s) first.</p> : (
            <ActionForm action={deleteRoleAction} submitLabel="Delete role" variant="danger" confirmText={`Delete the role ${role.name}?`}>
              <Hidden name="roleId" value={role.id} />
            </ActionForm>
          )}
        </section>
      )}
    </>
  );
}
