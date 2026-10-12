/* Content studio → R&D (2026-10-12). Ideas being researched, in three columns: Exploring (still thinking), Shortlisted
   (worth making) and Parked (good, but not now). An idea is a title, an optional description and an optional link to a
   reference. A shortlisted idea can be sent to planning once; it then shows where its piece stands.
   Reading needs studio.read; every change needs studio.manage (checked again in the core). */
import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { IDEA_STATUSES, IDEA_STATUS_LABEL, PIECE_STAGE_LABEL, listIdeas, type IdeaStatus, type PieceStage } from '@kitsyuu/core';
import { DragCard, DropColumn } from '@/components/DragMove';
import FilterForm from '@/components/FilterForm';
import ModuleViews from '@/components/ModuleViews';
import { ActionForm, Field, Hidden, Select, TextArea } from '@/components/forms';
import { StateBlock, Workspace } from '@/components/frame';
import { FilterLink } from '@/components/NavFrame';
import { Drawer } from '@/components/overlays';
import { Forbidden, PageHead } from '@/components/ui';
import { formatNumber } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { deleteIdeaAction, ideaStatusAction, planIdeaAction, saveIdeaAction } from './actions';

export const metadata: Metadata = { title: 'Content R&D' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const HINT: Record<IdeaStatus, string> = { exploring: 'Still thinking', shortlisted: 'Worth making', parked: 'Good, but not now' };
const host = (link: string) => { try { return new URL(link).hostname.replace(/^www\./, ''); } catch { return 'link'; } };
const shortDay = (d: unknown) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(d as Date));

export default async function StudioIdeasPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'studio.read')) return <><PageHead title="Content studio" /><Forbidden permission="studio.read" /></>;
  const sp = await searchParams;
  const q = (one(sp.q) ?? '').trim().slice(0, 80);
  const list = await listIdeas(db(), actor, { q });
  const manage = can(actor, 'studio.manage');
  return (
    <Workspace name="studio-ideas" title="Content R&D" summary={`${formatNumber(list.total)} idea${list.total === 1 ? '' : 's'} · ${formatNumber(list.links)} research link${list.links === 1 ? '' : 's'}${q ? ` · matching “${q}”` : ''}`}
      actions={manage ? (
        <Drawer trigger="New idea" name="new-idea" scope="ord" title="New idea" description="Starts in Exploring.">
          <ActionForm action={saveIdeaAction} submitLabel="Add idea" id="create-idea-form" label="Add idea" resetOnSuccess>
            <Field name="title" label="Title" required />
            <TextArea name="description" label="What is the idea? (optional)" rows={4} />
            <Field name="link" label="Reference link (optional)" hint="Starts with https://" />
          </ActionForm>
        </Drawer>
      ) : undefined}>
      <ModuleViews module="studio" label="Content studio" current="/studio" />
      <div className="ord-toolbar">
        <FilterForm debounce={250} role="search" aria-label="Search ideas" data-idea-filters>
          <label className="sr-only" htmlFor="id-q">Search ideas</label>
          <input id="id-q" name="q" className="input" placeholder="Search ideas" defaultValue={q} />
          <button className="btn ghost sr-only" type="submit">Apply</button>
        </FilterForm>
        {q && <FilterLink className="btn link" group="clear" current={false} href="/studio" data-clear-filters>Clear</FilterLink>}
      </div>
      {list.total === 0 ? (
        <StateBlock title={q ? 'No matching ideas' : 'No ideas yet'} name="ideas" action={q ? <Link className="btn ghost sm" href="/studio">Show all ideas</Link> : undefined}>
          {q ? 'No idea matches this search.' : manage ? 'Note the first idea with “New idea”: a title, and a link to what inspired it.' : 'Ideas appear here once they are added.'}
        </StateBlock>
      ) : (
        <div className="kb kb-3" data-idea-board key={q}>
          {IDEA_STATUSES.map(s => {
            const cards = list.rows.filter(i => i.status === s);
            const column = <>
              <header className="kb-head"><h2>{IDEA_STATUS_LABEL[s]}</h2><span className="kb-count" data-status-count>{formatNumber(cards.length)}</span><span className="kb-hint">{HINT[s]}</span></header>
              <div className="kb-cards">
                {cards.length === 0 && <p className="kb-empty">{manage ? 'Drop or add' : 'None'}</p>}
                {cards.map(i => {
                  const body = <>
                    <h3 className="kb-title">{i.title}</h3>
                    {i.description && <p className="kb-desc">{i.description}</p>}
                    {i.link && <p><a className="kb-link" href={i.link} target="_blank" rel="noopener noreferrer" data-idea-link>{host(i.link)}</a></p>}
                    <p className="note">{i.created_by_name || i.created_by_email || 'Staff'} · {shortDay(i.created_at)}</p>
                    {i.piece_id && <p className="note" data-idea-planned>In planning: <Link href={`/studio/planning/${i.piece_id}`}>{PIECE_STAGE_LABEL[i.piece_stage as PieceStage] ?? 'open'}</Link></p>}
                    {manage && (
                      <div className="kb-foot">
                        {s === 'shortlisted' && !i.piece_id && (
                          <ActionForm action={planIdeaAction} submitLabel="Send to planning" className="inline-form" id={`plan-idea-${i.id}`} label={`Send ${i.title} to planning`}><Hidden name="ideaId" value={i.id} /></ActionForm>
                        )}
                        <details className="row-edit kb-move"><summary className="btn ghost sm">Edit</summary>
                          <ActionForm action={ideaStatusAction} submitLabel="Move" className="form compact row-edit-form" id={`move-idea-${i.id}`} label={`Move ${i.title}`}>
                            <Hidden name="ideaId" value={i.id} /><Hidden name="expectedStatus" value={s} />
                            <Select name="status" label="Move to" options={IDEA_STATUSES.filter(x => x !== s).map(x => ({ value: x, label: IDEA_STATUS_LABEL[x] }))} />
                          </ActionForm>
                          <ActionForm action={saveIdeaAction} submitLabel="Save" className="form compact row-edit-form" id={`edit-idea-${i.id}`} label={`Edit ${i.title}`}>
                            <Hidden name="ideaId" value={i.id} />
                            <Field name="title" label="Title" defaultValue={i.title} required />
                            <TextArea name="description" label="Description" defaultValue={i.description ?? ''} rows={3} />
                            <Field name="link" label="Reference link" defaultValue={i.link ?? ''} />
                          </ActionForm>
                          {!i.piece_id && <ActionForm action={deleteIdeaAction} submitLabel="Remove idea" variant="danger" className="inline-form" id={`delete-idea-${i.id}`} label={`Remove ${i.title}`}
                            confirmText={`Remove the idea “${i.title}”? This cannot be undone.`}><Hidden name="ideaId" value={i.id} /></ActionForm>}
                        </details>
                      </div>
                    )}
                  </>;
                  return manage
                    ? <DragCard key={i.id} group="idea" data={{ ideaId: i.id, expectedStatus: s, label: i.title }} className="kb-card" data-idea={i.id} data-idea-status={s}>{body}</DragCard>
                    : <div key={i.id} className="kb-card" data-idea={i.id} data-idea-status={s}>{body}</div>;
                })}
              </div>
            </>;
            return manage
              ? <DropColumn key={s} group="idea" action={ideaStatusAction} fields={{ status: s }} skipWhen={{ card: 'expectedStatus', equals: s }} className="kb-col" data-idea-column={s}>{column}</DropColumn>
              : <div key={s} className="kb-col" data-idea-column={s}>{column}</div>;
          })}
        </div>
      )}
      <p className="note section-foot">An idea is a note for the team. Shortlist the ones worth making; “Send to planning” turns a shortlisted idea into a piece in the content pipeline, once.</p>
    </Workspace>
  );
}
