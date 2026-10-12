/* Content studio → Planning (2026-10-12). The content pipeline as a board: Idea → Script → Shoot → Edit → Scheduled →
   Posted. A piece moves one stage at a time. Its card says what the stage still needs ("2 left to fill"); once that is
   filled in, staff ask for the move and someone who may approve says yes or sends it back with a note (the strip at the
   top lists what is waiting). A person who may approve moves a piece in one step.
   A piece is opened on its own page to be written. Nothing here publishes anything: "Posted" is recorded by staff.
   Reading needs studio.read, working needs studio.manage, approving needs studio.approve (all checked in the core). */
import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { PIECE_FORMATS, PIECE_PLATFORMS, PIECE_STAGES, PIECE_STAGE_LABEL, listPieces, studioOwners } from '@kitsyuu/core';
import ModuleViews from '@/components/ModuleViews';
import { ActionForm, Field, Hidden, Select } from '@/components/forms';
import { StateBlock, Workspace } from '@/components/frame';
import { NavLink } from '@/components/NavFrame';
import { Drawer } from '@/components/overlays';
import { Forbidden, PageHead } from '@/components/ui';
import { formatNumber } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { decidePieceMoveAction, requestPieceMoveAction, savePieceAction } from '../actions';

export const metadata: Metadata = { title: 'Content planning' };
const HINT: Record<string, string> = { idea: 'Approved to work on', script: 'Words and hook written', shoot: 'Footage captured', edit: 'Cut and graded', scheduled: 'Slotted for a date', posted: 'Published (last 90 days)' };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const shortDay = (d: string) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
const stamp = (d: unknown) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(d as Date));

export default async function StudioPlanningPage() {
  const actor = await requireActor();
  if (!can(actor, 'studio.read')) return <><PageHead title="Content studio" /><Forbidden permission="studio.read" /></>;
  const manage = can(actor, 'studio.manage');
  const [d, owners] = await Promise.all([listPieces(db(), actor), manage ? studioOwners(db(), actor) : Promise.resolve([])]);
  const open = d.pieces.filter(p => p.stage !== 'posted').length, posted = d.pieces.length - open;
  return (
    <Workspace name="studio-planning" title="Content planning"
      summary={`${formatNumber(open)} piece${open === 1 ? '' : 's'} in the pipeline · ${formatNumber(posted)} posted · ${formatNumber(d.waiting.length)} waiting on approval`}
      actions={manage ? (
        <Drawer trigger="New content" name="new-piece" scope="ord" title="New content" description="Starts in the Idea column. Open it afterwards to write the script.">
          <ActionForm action={savePieceAction} submitLabel="Add" id="create-piece-form" label="Add content" resetOnSuccess>
            <Field name="title" label="Title" required />
            <Select name="platform" label="Platform" defaultValue="" options={[{ value: '', label: 'Not chosen yet' }, ...PIECE_PLATFORMS.map(p => ({ value: p, label: cap(p) }))]} />
            <Select name="format" label="Format" defaultValue="" options={[{ value: '', label: 'Not chosen yet' }, ...PIECE_FORMATS.map(f => ({ value: f, label: cap(f) }))]} />
            <Select name="ownerId" label="Owner" defaultValue="" options={[{ value: '', label: 'Nobody yet' }, ...owners.map(o => ({ value: o.id, label: o.full_name || o.email }))]} />
            <Field name="targetOn" label="Target date (optional)" type="date" />
          </ActionForm>
        </Drawer>
      ) : undefined}>
      <ModuleViews module="studio" label="Content studio" current="/studio/planning" />

      {d.waiting.length > 0 && (
        <section className="kb-approvals" aria-label="Waiting for approval" data-approvals>
          <h2>{formatNumber(d.waiting.length)} card{d.waiting.length === 1 ? '' : 's'} waiting for {d.canApprove ? 'your approval' : 'approval'}</h2>
          <ul>{d.waiting.map(p => (
            <li key={p.id} data-approval={p.id}>
              <div><Link href={`/studio/planning/${p.id}`}><b>{p.title}</b></Link>
                <div className="note">{PIECE_STAGE_LABEL[p.stage]} → <b>{PIECE_STAGE_LABEL[p.requested_stage!]}</b> · asked by {p.requested_by_name || p.requested_by_email || 'staff'} · {stamp(p.requested_at)}</div></div>
              {d.canApprove && (
                <div className="actions">
                  <ActionForm action={decidePieceMoveAction} submitLabel="Approve" className="inline-form" id={`approve-${p.id}`} label={`Approve ${p.title}`}>
                    <Hidden name="pieceId" value={p.id} /><Hidden name="decision" value="approve" /><Hidden name="expectedStage" value={p.stage} />
                  </ActionForm>
                  <details className="row-edit"><summary className="btn ghost sm">Send back</summary>
                    <ActionForm action={decidePieceMoveAction} submitLabel="Send back" variant="ghost" className="form compact row-edit-form" id={`sendback-${p.id}`} label={`Send back ${p.title}`}>
                      <Hidden name="pieceId" value={p.id} /><Hidden name="decision" value="send_back" /><Hidden name="expectedStage" value={p.stage} />
                      <Field name="note" label="What needs to change" required />
                    </ActionForm>
                  </details>
                </div>
              )}
            </li>
          ))}</ul>
        </section>
      )}

      {d.pieces.length === 0 ? (
        <StateBlock title="Nothing in the pipeline yet" name="pieces">{manage ? 'Add a piece with “New content”, or send a shortlisted idea here from R&D.' : 'Content appears here once it is planned.'}</StateBlock>
      ) : (
        <div className="kb" data-piece-board>
          {PIECE_STAGES.map(s => {
            const cards = d.pieces.filter(p => p.stage === s);
            return (
              <div key={s} className="kb-col" data-piece-column={s}>
                <header className="kb-head"><h2>{PIECE_STAGE_LABEL[s]}</h2><span className="kb-count" data-stage-count>{formatNumber(cards.length)}</span><span className="kb-hint">{HINT[s]}</span></header>
                <div className="kb-cards">
                  {cards.length === 0 && <p className="kb-empty">Nothing here</p>}
                  {cards.map(p => (
                    <div key={p.id} className={`kb-card${p.requested_stage ? ' is-waiting' : ''}`} data-piece={p.id} data-piece-stage={s} data-piece-state={p.requested_stage ? 'waiting' : p.missing.length ? 'incomplete' : s === 'posted' ? 'posted' : 'ready'}>
                      {p.requested_stage && <p className="kb-flag" data-piece-waiting>Needs approval</p>}
                      <h3 className="kb-title"><NavLink className="row-link" href={`/studio/planning/${p.id}`}>{p.title}</NavLink></h3>
                      <p className="kb-chips">{p.platform && <span className="badge as-written">{cap(p.platform)}</span>}{p.format && <span className="badge as-written">{cap(p.format)}</span>}
                        {p.target && <span className="note">{shortDay(p.target)}</span>}</p>
                      <p className="note">{p.owner_name || p.owner_email || 'No owner yet'}</p>
                      {p.sent_back_note && !p.requested_stage && <p className="note" data-piece-sent-back>Sent back: {p.sent_back_note}</p>}
                      {s !== 'posted' && (p.requested_stage ? (
                        d.canApprove && <ActionForm action={decidePieceMoveAction} submitLabel={`Approve → ${PIECE_STAGE_LABEL[p.requested_stage]}`} className="inline-form kb-action" id={`card-approve-${p.id}`} label={`Approve ${p.title}`}>
                          <Hidden name="pieceId" value={p.id} /><Hidden name="decision" value="approve" /><Hidden name="expectedStage" value={s} />
                        </ActionForm>
                      ) : p.missing.length ? (
                        <Link className="btn ghost sm kb-action" href={`/studio/planning/${p.id}`} data-piece-missing title={`Still needed: ${p.missing.join(', ')}`}>{p.missing.length} left to fill</Link>
                      ) : manage && p.next ? (
                        <ActionForm action={requestPieceMoveAction} submitLabel={d.canApprove ? `Move to ${PIECE_STAGE_LABEL[p.next]}` : `Ask to move to ${PIECE_STAGE_LABEL[p.next]}`} variant="ghost" className="inline-form kb-action" id={`move-piece-${p.id}`} label={`Move ${p.title}`}>
                          <Hidden name="pieceId" value={p.id} /><Hidden name="expectedStage" value={s} />
                        </ActionForm>
                      ) : null)}
                      {s === 'posted' && p.posted_link && <p><a className="kb-link" href={p.posted_link} target="_blank" rel="noopener noreferrer">See the post</a></p>}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="note section-foot">A piece moves one stage at a time, once what the stage needs is filled in. {d.canApprove ? 'You may approve moves, so your own moves happen at once.' : 'A move you ask for waits for someone who may approve it.'}</p>
    </Workspace>
  );
}
