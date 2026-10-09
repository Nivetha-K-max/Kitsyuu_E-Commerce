import type { Metadata } from 'next';
import { can } from '@kitsyuu/auth';
import { TICKET_PRIORITIES } from '@kitsyuu/contracts';
import { supportCategories } from '@kitsyuu/core';
import { ActionForm, Field, Select, TextArea } from '@/components/forms';
import { Forbidden, PageHead } from '@/components/ui';
import { db, requireActor } from '@/lib/server';
import { openTicketAction } from '../actions';
import SupportNav from '../SupportNav';
import { Workspace } from '@/components/frame';

export const metadata: Metadata = { title: 'New ticket' };

/* A ticket for a customer who phoned or emailed. What they said is kept as an internal note (they did not write it). */
export default async function NewTicketPage() {
  const actor = await requireActor();
  if (!can(actor, 'support.manage')) return <><PageHead title="Support" /><Forbidden permission="support.manage" /></>;
  const categories = await supportCategories(db());
  return (
    <Workspace name="new-ticket" title="Support" summary="Open a ticket for a customer enquiry that came by phone or email.">
      <SupportNav current="/support/new" manage />
      <section className="card form-panel">
        <ActionForm action={openTicketAction} submitLabel="Open ticket" id="new-ticket-form" label="Open ticket">
          <div className="cols">
            <Field name="customerEmail" label="Customer email" type="email" required />
            <Field name="contactName" label="Name" />
            <Field name="subject" label="Subject" required />
            <Field name="orderNumber" label="Order number" hint="Optional." />
            <Select name="categoryCode" label="Category" options={categories.map(c => ({ value: c.code, label: c.label }))} />
            <Select name="priority" label="Priority" defaultValue="medium" options={TICKET_PRIORITIES.map(p => ({ value: p, label: p }))} />
          </div>
          <TextArea name="body" label="What the customer said" rows={5} required />
        </ActionForm>
      </section>
    </Workspace>
  );
}
