/* Leads → Pipeline (2026-10-12). The sales pipeline as a board (one column per stage) or a list.
   A lead is entered by staff (there is no ads connection) and sits in one stage: New leads → Engaged → Qualified →
   Customer visited → Converted, or Disqualified with its reason. A card can be dragged to another column or moved with
   its own "Move" control; both send the same checked action, and a board that is out of date changes nothing.
   Reading and exporting need leads.read; adding and moving need leads.manage (checked again in the core). */
import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { LEAD_SOURCES, LEAD_STAGES, LEAD_STAGE_LABEL, listLeads, type LeadStage } from '@kitsyuu/core';
import { DragCard, DropColumn } from '@/components/DragMove';
import FilterForm from '@/components/FilterForm';
import ModuleViews from '@/components/ModuleViews';
import { ActionForm, Field, Hidden, Select, TextArea } from '@/components/forms';
import { StateBlock, ViewTabs, Workspace } from '@/components/frame';
import { FilterLink, NavLink } from '@/components/NavFrame';
import { Drawer } from '@/components/overlays';
import { Forbidden, PageHead } from '@/components/ui';
import { formatDateTime, formatNumber } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { moveLeadAction, saveLeadAction } from './actions';

export const metadata: Metadata = { title: 'Leads' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const SOURCE_LABEL: Record<string, string> = { manual: 'Manual', ads: 'Ads', instagram: 'Instagram', whatsapp: 'WhatsApp', walk_in: 'Walk-in', referral: 'Referral', website: 'Website', other: 'Other' };
const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('');
/** Cards drawn per column on the board; the list shows every lead. */
const BOARD_CAP = 60, PAGE_SIZE = 50;

export default async function LeadsPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'leads.read')) return <><PageHead title="Leads" /><Forbidden permission="leads.read" /></>;
  const sp = await searchParams;
  const q = (one(sp.q) ?? '').trim().slice(0, 80);
  const show = one(sp.show) === 'list' ? 'list' : 'board';
  const stage = (LEAD_STAGES as readonly string[]).includes(one(sp.stage) ?? '') ? one(sp.stage) as LeadStage : undefined;
  const list = await listLeads(db(), actor, { q, stage: show === 'list' ? stage : undefined });
  const manage = can(actor, 'leads.manage');
  const url = (over: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ q: q || undefined, show: show === 'list' ? 'list' : undefined, stage: show === 'list' ? stage : undefined, ...over })) if (v !== undefined && v !== '') p.set(k, String(v));
    return p.size ? `/leads?${p}` : '/leads';
  };
  const pages = Math.max(1, Math.ceil(list.rows.length / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, parseInt(one(sp.page) ?? '1', 10) || 1));
  const what = (l: { interest: string | null; timeline: string | null }) => [l.interest, l.timeline].filter(Boolean).join(' · ') || 'No details yet';

  return (
    <Workspace name="leads" title="Leads pipeline" summary={`${formatNumber(list.active)} active lead${list.active === 1 ? '' : 's'} · ${formatNumber(list.counts.new)} new${q ? ` · matching “${q}”` : ''}`}
      actions={<>
        <a className="btn ghost" href="/leads/export" data-link="leads-export" download>Excel ({formatNumber(list.total)})</a>
        {manage && (
          <Drawer trigger="New lead" name="new-lead" scope="ord" title="New lead" description="A lead starts in New leads. One lead per phone number.">
            <ActionForm action={saveLeadAction} submitLabel="Add lead" id="create-lead-form" label="Add lead" resetOnSuccess>
              <Field name="name" label="Name" required />
              <Field name="phone" label="Phone" required hint="With or without +91; spaces are fine." />
              <Field name="interest" label="Interested in (optional)" hint="e.g. Bespoke wedding suit" />
              <Field name="timeline" label="When (optional)" hint="e.g. Within 1 month" />
              <Select name="source" label="Source" defaultValue="manual" options={LEAD_SOURCES.map(s => ({ value: s, label: SOURCE_LABEL[s] ?? s }))} />
              <Field name="email" label="Email (optional)" type="email" />
              <TextArea name="notes" label="Notes (optional)" rows={2} />
            </ActionForm>
          </Drawer>
        )}
      </>}>
      <ModuleViews module="leads" label="Leads" current="/leads" />
      <div className="ord-toolbar">
        <FilterForm debounce={250} role="search" aria-label="Search leads" data-lead-filters>
          {show === 'list' && <input type="hidden" name="show" value="list" />}
          {show === 'list' && stage && <input type="hidden" name="stage" value={stage} />}
          <label className="sr-only" htmlFor="ld-q">Search leads</label>
          <input id="ld-q" name="q" className="input" placeholder="Search name, phone or interest" defaultValue={q} />
          <button className="btn ghost sr-only" type="submit">Apply</button>
        </FilterForm>
        {q && <FilterLink className="btn link" group="clear" current={false} href={show === 'list' ? '/leads?show=list' : '/leads'} data-clear-filters>Clear</FilterLink>}
        <div data-lead-show className="kb-toggle">
          <ViewTabs label="Show leads as" current={show} items={[{ id: 'board', label: 'Board', href: url({ show: undefined, stage: undefined, page: undefined }) }, { id: 'list', label: 'List', href: url({ show: 'list', page: undefined }) }]} />
        </div>
      </div>

      {list.total === 0 ? (
        <StateBlock title={q ? 'No matching leads' : 'No leads yet'} name="leads" action={q ? <Link className="btn ghost sm" href="/leads">Show all leads</Link> : undefined}>
          {q ? 'No lead matches this search.' : manage ? 'Add the first lead with “New lead”. It will appear in New leads.' : 'Leads appear here once they are added.'}
        </StateBlock>
      ) : show === 'board' ? (
        <div className="kb" data-lead-board key={q}>
          {LEAD_STAGES.map(s => {
            const cards = list.rows.filter(l => l.stage === s);
            const column = <>
              <header className="kb-head"><h2>{LEAD_STAGE_LABEL[s]}</h2><span className="kb-count" data-stage-count>{formatNumber(list.counts[s])}</span></header>
              <div className="kb-cards">
                {cards.length === 0 && <p className="kb-empty">{manage ? 'Drop a lead here' : 'None'}</p>}
                {cards.slice(0, BOARD_CAP).map(l => {
                  const body = <>
                    <div className="kb-who"><span className="kb-avatar" aria-hidden="true">{initials(l.name)}</span>
                      <div><NavLink className="row-link" href={`/leads/${l.id}`}>{l.name}</NavLink><div className="mono">{l.phone}</div></div></div>
                    <p className="kb-what">{what(l)}</p>
                    <p className="note">{formatDateTime(l.created_at as Date)}</p>
                    {s === 'disqualified' && l.disqualify_reason && <p className="note" data-lead-reason>Reason: {l.disqualify_reason}</p>}
                    <div className="kb-foot"><span className="badge as-written" data-lead-source>{SOURCE_LABEL[l.source] ?? l.source}</span>
                      {manage && (
                        <details className="row-edit kb-move"><summary className="btn ghost sm">Move</summary>
                          <ActionForm action={moveLeadAction} submitLabel="Move" className="form compact row-edit-form" id={`move-lead-${l.id}`} label={`Move ${l.name}`}>
                            <Hidden name="leadId" value={l.id} /><Hidden name="expectedStage" value={s} />
                            <Select name="stage" label="To" options={LEAD_STAGES.filter(x => x !== s).map(x => ({ value: x, label: LEAD_STAGE_LABEL[x] }))} />
                            <Field name="note" label="Note" hint="Required when disqualifying." />
                          </ActionForm>
                        </details>
                      )}</div>
                  </>;
                  return manage
                    ? <DragCard key={l.id} group="lead" data={{ leadId: l.id, expectedStage: s, label: l.name }} className="kb-card" data-lead={l.id} data-lead-stage={s}>{body}</DragCard>
                    : <div key={l.id} className="kb-card" data-lead={l.id} data-lead-stage={s}>{body}</div>;
                })}
                {cards.length > BOARD_CAP && <Link className="btn ghost sm" href={url({ show: 'list', stage: s })} data-more>All {formatNumber(list.counts[s])} in the list</Link>}
              </div>
            </>;
            return manage
              ? <DropColumn key={s} group="lead" action={moveLeadAction} fields={{ stage: s }} skipWhen={{ card: 'expectedStage', equals: s }} noteLabel={s === 'disqualified' ? 'Why is this lead disqualified?' : undefined}
                  className="kb-col" data-lead-column={s}>{column}</DropColumn>
              : <div key={s} className="kb-col" data-lead-column={s}>{column}</div>;
          })}
        </div>
      ) : (<>
        <div data-lead-stages>
          <ViewTabs label="Stage" current={stage ?? 'all'} items={[{ id: 'all', label: 'All', href: url({ stage: undefined, page: undefined }), count: list.total },
            ...LEAD_STAGES.map(s => ({ id: s, label: LEAD_STAGE_LABEL[s], href: url({ stage: s, page: undefined }), count: list.counts[s] }))]} />
        </div>
        {list.rows.length === 0 ? <StateBlock title="No leads in this stage" name="leads-stage">Choose another stage, or go back to the board.</StateBlock> : (
          <div className="table-wrap ord-table" data-fresh key={`${q}|${stage}|${page}`}><table data-leads-table>
            <thead><tr><th>Lead</th><th>Interested in</th><th>When</th><th>Source</th><th>Stage</th><th>Added</th></tr></thead>
            <tbody>{list.rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(l => (
              <tr key={l.id} data-lead={l.id} data-lead-stage={l.stage}>
                <td className="ord-who"><NavLink className="row-link" href={`/leads/${l.id}`}>{l.name}</NavLink><div className="ord-no">{l.phone}</div></td>
                <td className="ord-extra" data-label="Interested in">{l.interest ?? '—'}</td>
                <td className="ord-extra" data-label="When">{l.timeline ?? '—'}</td>
                <td className="ord-extra" data-label="Source">{SOURCE_LABEL[l.source] ?? l.source}</td>
                <td className="ord-stage"><span className="badge as-written">{LEAD_STAGE_LABEL[l.stage as LeadStage]}</span></td>
                <td className="ord-extra nowrap" data-label="Added">{formatDateTime(l.created_at as Date)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {pages > 1 && (
          <nav className="pager" aria-label="Pages" data-pager>
            {page > 1 ? <FilterLink className="btn ghost sm" group="page" current={false} href={url({ page: page === 2 ? undefined : page - 1 })}>← Previous</FilterLink> : <span />}
            <span className="pager-page">Page {formatNumber(page)} of {formatNumber(pages)}</span>
            {page < pages ? <FilterLink className="btn ghost sm" group="page" current={false} href={url({ page: page + 1 })}>Next →</FilterLink> : <span />}
          </nav>
        )}
      </>)}
      <p className="note section-foot" data-lead-definitions>Active leads are those not yet converted or disqualified. Leads are added by staff; every move between stages is recorded with who made it.
        {manage ? ' Drag a card to another column, or use its Move control.' : ''}</p>
    </Workspace>
  );
}
