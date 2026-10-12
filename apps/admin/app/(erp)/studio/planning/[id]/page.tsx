/* One content piece (2026-10-12), on the shared entity frame: everything written on it, what its stage still needs, and
   the move to the next stage (asked for by staff, approved by someone who may approve). */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { PIECE_FORMATS, PIECE_PLATFORMS, PIECE_STAGE_LABEL, listPieces, studioOwners } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, Select, TextArea } from '@/components/forms';
import { Entity, Facts, Section } from '@/components/frame';
import RecordActivity from '@/components/RecordActivity';
import { Forbidden, PageHead } from '@/components/ui';
import { db, requireActor } from '@/lib/server';
import { decidePieceMoveAction, deletePieceAction, requestPieceMoveAction, savePieceAction } from '../../actions';

export const metadata: Metadata = { title: 'Content piece' };
type Params = Promise<{ id: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default async function PiecePage({ params, searchParams }: { params: Params; searchParams: SP }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/studio/planning', label: 'Content planning' }];
  if (!can(actor, 'studio.read')) return <><PageHead title="Content piece" crumbs={crumbs} /><Forbidden permission="studio.read" /></>;
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const manage = can(actor, 'studio.manage'), seeAudit = can(actor, 'audit.read');
  const [d, owners] = await Promise.all([listPieces(db(), actor), manage ? studioOwners(db(), actor) : Promise.resolve([])]);
  const p = d.pieces.find(x => x.id === id);
  if (!p) notFound();
  const tab = sp.tab === 'activity' && seeAudit ? 'activity' : 'overview';
  const self = `/studio/planning/${p.id}`;
  const posted = p.stage === 'posted';
  return (
    <Entity module={{ href: '/studio/planning', label: 'Content planning' }} name="piece" title={p.title}
      status={<span className="badge as-written" data-piece-stage={p.stage}>{PIECE_STAGE_LABEL[p.stage]}</span>}
      factsAttr="data-piece-facts"
      facts={[{ label: 'Platform', value: p.platform ? cap(p.platform) : 'Not chosen' }, { label: 'Format', value: p.format ? cap(p.format) : 'Not chosen' },
        { label: 'Target date', value: p.target ?? 'No date yet', attr: 'target' }, { label: 'Owner', value: p.owner_name || p.owner_email || 'Nobody yet' }]}
      tabs={[{ id: 'overview', label: 'Overview' }, ...(seeAudit ? [{ id: 'activity', label: 'Activity' }] : [])]} current={tab} tabHref={t => (t === 'overview' ? self : `${self}?tab=${t}`)}
      notice={p.sent_back_note && !p.requested_stage ? <p className="msg" data-piece-sent-back>Sent back: {p.sent_back_note}</p> : undefined}>
      {tab === 'overview' && <>
        {!posted && (
          <Section id="pm-h" title="Next stage" name="move" hint={p.next ? `From ${PIECE_STAGE_LABEL[p.stage]} to ${PIECE_STAGE_LABEL[p.next]}.` : undefined}>
            {p.requested_stage ? (<>
              <p className="note" data-piece-waiting>Waiting for approval to move to <b>{PIECE_STAGE_LABEL[p.requested_stage]}</b>, asked by {p.requested_by_name || p.requested_by_email || 'staff'}.</p>
              {d.canApprove && (
                <div className="actions">
                  <ActionForm action={decidePieceMoveAction} submitLabel={`Approve → ${PIECE_STAGE_LABEL[p.requested_stage]}`} className="inline-form" id="piece-approve-form" label="Approve this move">
                    <Hidden name="pieceId" value={p.id} /><Hidden name="decision" value="approve" /><Hidden name="expectedStage" value={p.stage} />
                  </ActionForm>
                  <details className="row-edit"><summary className="btn ghost sm">Send back</summary>
                    <ActionForm action={decidePieceMoveAction} submitLabel="Send back" variant="ghost" className="form compact row-edit-form" id="piece-sendback-form" label="Send this piece back">
                      <Hidden name="pieceId" value={p.id} /><Hidden name="decision" value="send_back" /><Hidden name="expectedStage" value={p.stage} />
                      <Field name="note" label="What needs to change" required />
                    </ActionForm>
                  </details>
                </div>
              )}
            </>) : p.missing.length ? (
              <p className="note" data-piece-missing>Still needed before it can move on: <b>{p.missing.join(', ')}</b>. Fill {p.missing.length === 1 ? 'it' : 'them'} in below.</p>
            ) : manage && p.next ? (
              <ActionForm action={requestPieceMoveAction} submitLabel={d.canApprove ? `Move to ${PIECE_STAGE_LABEL[p.next]}` : `Ask to move to ${PIECE_STAGE_LABEL[p.next]}`} className="inline-form" id="piece-move-form" label="Move this piece on">
                <Hidden name="pieceId" value={p.id} /><Hidden name="expectedStage" value={p.stage} />
              </ActionForm>
            ) : <p className="note">Everything this stage needs is filled in. Moving it on needs the studio.manage permission.</p>}
          </Section>
        )}
        {manage ? (
          <Section id="pd-h" title="The piece" name="details" wide hint="Each stage needs some of these before the piece can move on: platform, format, owner and date; then hook and script; then the footage; then the final cut; then the link to the post.">
            <ActionForm action={savePieceAction} submitLabel="Save" id="piece-edit-form" label={`Edit ${p.title}`}>
              <Hidden name="pieceId" value={p.id} />
              <Field name="title" label="Title" defaultValue={p.title} required />
              <Select name="platform" label="Platform" defaultValue={p.platform ?? ''} options={[{ value: '', label: 'Not chosen yet' }, ...PIECE_PLATFORMS.map(x => ({ value: x, label: cap(x) }))]} />
              <Select name="format" label="Format" defaultValue={p.format ?? ''} options={[{ value: '', label: 'Not chosen yet' }, ...PIECE_FORMATS.map(x => ({ value: x, label: cap(x) }))]} />
              <Select name="ownerId" label="Owner" defaultValue={p.owner_id ?? ''} options={[{ value: '', label: 'Nobody yet' }, ...owners.map(o => ({ value: o.id, label: o.full_name || o.email })),
                ...(p.owner_id && !owners.some(o => o.id === p.owner_id) ? [{ value: p.owner_id, label: `${p.owner_name || p.owner_email} (inactive)` }] : [])]} />
              <Field name="targetOn" label="Target date" type="date" defaultValue={p.target ?? ''} />
              <Field name="hook" label="Hook" defaultValue={p.hook ?? ''} hint="The first line or first three seconds." />
              <TextArea name="script" label="Script" defaultValue={p.script ?? ''} rows={8} />
              <Field name="footageLink" label="Footage link" defaultValue={p.footage_link ?? ''} hint="Where the raw footage is (https://…)." />
              <Field name="finalLink" label="Final cut link" defaultValue={p.final_link ?? ''} hint="The edited file (https://…)." />
              <Field name="postedLink" label="Link to the post" defaultValue={p.posted_link ?? ''} hint="Once it is published (https://…)." />
              <TextArea name="notes" label="Notes" defaultValue={p.notes ?? ''} rows={4} />
            </ActionForm>
          </Section>
        ) : (
          <Section id="pd-h" title="The piece" name="details" wide>
            <Facts items={[{ label: 'Hook', value: p.hook ?? '—' }, { label: 'Script', value: p.script ? <span style={{ whiteSpace: 'pre-wrap' }}>{p.script}</span> : '—' }, { label: 'Notes', value: p.notes ? <span style={{ whiteSpace: 'pre-wrap' }}>{p.notes}</span> : '—' },
              { label: 'Link to the post', value: p.posted_link ? <a href={p.posted_link} target="_blank" rel="noopener noreferrer">{p.posted_link}</a> : '—' }]} />
            <p className="note" data-readonly="piece">Changing a piece needs the studio.manage permission.</p>
          </Section>
        )}
        {manage && p.stage === 'idea' && !p.requested_stage && (
          <Section id="px-h" title="Remove" name="remove" hint="Only for a piece added by mistake, while it is still an idea.">
            <ActionForm action={deletePieceAction} submitLabel="Remove this piece" variant="danger" className="inline-form" id="piece-delete-form" label="Remove this piece" confirmText={`Remove “${p.title}”? This cannot be undone.`}>
              <Hidden name="pieceId" value={p.id} />
            </ActionForm>
          </Section>
        )}
      </>}
      {tab === 'activity' && <RecordActivity entityType="content_pieces" entityId={p.id} name="piece" empty="Nothing has been recorded for this piece yet." />}
    </Entity>
  );
}
