'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createRoleInput, deleteRoleInput, updateRoleInput, type ActionState } from '@kitsyuu/contracts';
import { createRole, deleteRole, updateRole } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, requestContext, requireActor } from '@/lib/server';

export async function createRoleAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  let roleId = '';
  const r = await handle(createRoleInput, form, async input => { roleId = (await createRole(db(), actor, input, await requestContext())).roleId; return { ok: true }; });
  if (r.ok && roleId) { revalidatePath('/roles'); redirect(`/roles/${roleId}?notice=created`); }
  return r;
}

export async function updateRoleAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(updateRoleInput, form, async input => { await updateRole(db(), actor, input, await requestContext()); return { ok: true, message: 'Role saved.' }; },
    { permissionCodes: form.getAll('permissionCodes').map(String) });
  if (r.ok) revalidatePath('/roles', 'layout');
  return r;
}

export async function deleteRoleAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  let done = false;
  const r = await handle(deleteRoleInput, form, async input => { await deleteRole(db(), actor, input.roleId, await requestContext()); done = true; return { ok: true }; });
  if (done) { revalidatePath('/roles'); redirect('/roles?notice=deleted'); }
  return r;
}
