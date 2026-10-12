/* One lead (2026-10-12), on the shared entity frame: its details, where it stands, and every move it made.
   The stage is changed with the same checked action the board uses; details are edited here. */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError } from '@kitsyuu/contracts';
import { LEAD_SOURCES, LEAD_STAGES, LEAD_STAGE_LABEL, getLead, type LeadStage } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, Select, TextArea } from '@/components/forms';
import { Entity, Facts, Section, StateBlock } from '@/components/frame';
import { Forbidden, PageHead } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { moveLeadAction, saveLeadAction } from '../actions';

export const metadata: Metadata = { title: 'Lead' };
type Params = Promise<{ id: string }>;
const SOURCE_LABEL: Record<string, string> = { manual: 'Manual', ads: 'Ads', instagram: 'Instagram', whatsapp: 'WhatsApp', walk_in: 'Walk-in', referral: 'Referral', website: 'Website', other: 'Other' };
const label = (s: string | null) => (s ? LEAD_STAGE_LABEL[s as LeadStage] ?? s : 'Added');

export default async function LeadPage({ params }: { params: Params }) {
  const actor = await requireActor();
  if (!can(actor, 'leads.read')) return <><PageHead title="Lead" crumbs={[{ href: '/leads', label: 'Leads' }]} /><Forbidden permission="leads.read" /></>;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { lead: l, events } = await getLead(db(), actor, id).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const manage = can(actor, 'leads.manage');
  return (
    <Entity module={{ href: '/leads', label: 'Leads' }} name="lead" title={l.name} status={<span className="badge as-written" data-lead-stage={l.stage}>{LEAD_STAGE_LABEL[l.stage as LeadStage]}</span>}
      factsAttr="data-lead-facts"
      facts={[
        { label: 'Phone', value: <a href={`tel:${l.phone.replace(/[^\d+]/g, '')}`} className="mono">{l.phone}</a>, attr: 'phone' },
        { label: 'Interested in', value: l.interest ?? '—' }, { label: 'When', value: l.timeline ?? '—' },
        { label: 'Source', value: SOURCE_LABEL[l.source] ?? l.source },
      ]}
      tabs={[{ id: 'overview', label: 'Overview' }]} current="overview" tabHref={() => `/leads/${l.id}`}>
      {l.stage === 'disqualified' && l.disqualify_reason && <p className="msg" data-lead-reason>Disqualified: {l.disqualify_reason}</p>}
      {manage && (
        <Section id="ls-h" title="Stage" name="stage" hint="Where this lead stands. Every move is kept in its history below.">
          <ActionForm action={moveLeadAction} submitLabel="Move" className="form compact" id="lead-move-form" label={`Move ${l.name}`}>
            <Hidden name="leadId" value={l.id} /><Hidden name="expectedStage" value={l.stage} />
            <Select name="stage" label="Move to" options={LEAD_STAGES.filter(s => s !== l.stage).map(s => ({ value: s, label: LEAD_STAGE_LABEL[s] }))} />
            <Field name="note" label="Note" hint="Required when disqualifying (the reason)." />
          </ActionForm>
        </Section>
      )}
      {manage ? (
        <Section id="ld-h" title="Details" name="details">
          <ActionForm action={saveLeadAction} submitLabel="Save" id="lead-edit-form" label={`Edit ${l.name}`}>
            <Hidden name="leadId" value={l.id} />
            <Field name="name" label="Name" defaultValue={l.name} required />
            <Field name="phone" label="Phone" defaultValue={l.phone} required />
            <Field name="interest" label="Interested in" defaultValue={l.interest ?? ''} />
            <Field name="timeline" label="When" defaultValue={l.timeline ?? ''} />
            <Select name="source" label="Source" defaultValue={l.source} options={LEAD_SOURCES.map(s => ({ value: s, label: SOURCE_LABEL[s] ?? s }))} />
            <Field name="email" label="Email" type="email" defaultValue={l.email ?? ''} />
            <TextArea name="notes" label="Notes" defaultValue={l.notes ?? ''} rows={3} />
          </ActionForm>
        </Section>
      ) : (
        <Section id="ld-h" title="Details" name="details">
          <Facts items={[{ label: 'Email', value: l.email ?? '—' }, { label: 'Notes', value: l.notes ?? '—' }, { label: 'Added', value: `${formatDateTime(l.created_at as Date)}${l.created_by_email ? ` · ${l.created_by_email}` : ''}` }]} />
          <p className="note" data-readonly="lead">Changing a lead needs the leads.manage permission.</p>
        </Section>
      )}
      <Section id="lh-h" title="History" name="history" wide hint="Every stage this lead has been in, newest first.">
        {events.length === 0 ? <StateBlock title="No history" name="lead-history">Nothing has been recorded for this lead.</StateBlock> : (
          <div className="table-wrap"><table data-lead-history>
            <thead><tr><th>When</th><th>Move</th><th>Note</th><th>By</th></tr></thead>
            <tbody>{events.map(e => (
              <tr key={e.id} data-lead-event={e.to_stage}>
                <td className="nowrap">{formatDateTime(e.created_at as Date)}</td>
                <td>{e.from_stage ? `${label(e.from_stage)} → ${label(e.to_stage)}` : 'Added as a new lead'}</td>
                <td>{e.note ?? '—'}</td><td>{e.staff_email ?? '—'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Section>
    </Entity>
  );
}
