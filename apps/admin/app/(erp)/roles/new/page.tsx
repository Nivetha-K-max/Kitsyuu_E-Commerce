import type { Metadata } from 'next';
import { can } from '@kitsyuu/auth';
import { ActionForm, Field } from '@/components/forms';
import { Forbidden, PageHead } from '@/components/ui';
import { requireActor } from '@/lib/server';
import { createRoleAction } from '../actions';

export const metadata: Metadata = { title: 'New role' };

export default async function NewRolePage() {
  const actor = await requireActor();
  const crumbs = [{ href: '/roles', label: 'Roles & permissions' }];
  if (!can(actor, 'roles.manage')) return <><PageHead section="System" title="New role" crumbs={crumbs} /><Forbidden permission="roles.manage" /></>;
  return (
    <>
      <PageHead section="System" title="New role" crumbs={crumbs} />
      <ActionForm action={createRoleAction} submitLabel="Create role">
        <Field name="name" label="Name" required />
        <Field name="code" label="Code" hint="Permanent identifier, e.g. warehouse_lead (lower-case letters, digits, underscores)." required />
        <Field name="description" label="Description" />
      </ActionForm>
      <p className="note" style={{ marginTop: 12 }}>Permissions are chosen on the next screen.</p>
    </>
  );
}
