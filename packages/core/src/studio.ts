/* Content studio (2026-10-12; migration 20261012004800, local only until reviewed). Three views of one workflow:
     · R&D       ideas being researched: exploring → shortlisted, or parked. A shortlisted idea can be sent to planning,
                 once (it then points at the piece it became).
     · Planning  pieces being made, in one stage at a time: idea → script → shoot → edit → scheduled → posted.
                 A piece moves to the NEXT stage only: someone who works on it asks (what the stage needs must be filled
                 in first), and someone who may approve says yes or sends it back with a note. A person who may approve
                 moves it in one step.
     · Calendar  the same pieces by the day they are planned for. Changing the day never changes the stage.
   Nothing here publishes anything or talks to a social network: "posted" is recorded by staff with the link.
   Reading needs studio.read; adding, editing, planning and asking need studio.manage; approving and sending back need
   studio.approve. Every change is audited. */
import { recordAudit, sql, type Db } from '@kitsyuu/db';
import { ConflictError, DomainError, NotFoundError } from '@kitsyuu/contracts';
import { can, requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';

const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
const staffAudit = (actor: StaffPrincipal, ctx: MutationContext) => ({ actorType: 'staff' as const, staffId: actor.staffId, ...auditCtx(ctx) });

export const IDEA_STATUSES = ['exploring', 'shortlisted', 'parked'] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];
export const IDEA_STATUS_LABEL: Record<IdeaStatus, string> = { exploring: 'Exploring', shortlisted: 'Shortlisted', parked: 'Parked' };
export const PIECE_STAGES = ['idea', 'script', 'shoot', 'edit', 'scheduled', 'posted'] as const;
export type PieceStage = (typeof PIECE_STAGES)[number];
export const PIECE_STAGE_LABEL: Record<PieceStage, string> = { idea: 'Idea', script: 'Script', shoot: 'Shoot', edit: 'Edit', scheduled: 'Scheduled', posted: 'Posted' };
export const PIECE_PLATFORMS = ['instagram', 'facebook', 'youtube', 'whatsapp', 'other'] as const;
export const PIECE_FORMATS = ['reel', 'post', 'story', 'video', 'other'] as const;

const realDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const https = (v: string | null) => v === null || (/^https:\/\/[^\s]+$/.test(v) && v.length <= 500);
const nextStage = (s: PieceStage): PieceStage | null => PIECE_STAGES[PIECE_STAGES.indexOf(s) + 1] ?? null;

type Fillable = { platform: string | null; format: string | null; owner_id: string | null; target: string | null; hook: string | null; script: string | null; footage_link: string | null; final_link: string | null; posted_link: string | null };
/** What a piece must have before it may leave each stage (the "left to fill" on its card). */
const NEEDS: Record<Exclude<PieceStage, 'posted'>, [keyof Fillable, string][]> = {
  idea: [['platform', 'Platform'], ['format', 'Format'], ['owner_id', 'Owner'], ['target', 'Target date']],
  script: [['hook', 'Hook'], ['script', 'Script']],
  shoot: [['footage_link', 'Footage link']],
  edit: [['final_link', 'Final cut link'], ['target', 'Target date']],
  scheduled: [['posted_link', 'Link to the post']],
};
/** The fields still empty that this piece needs before it can move on from its stage. */
export function pieceMissing(p: Fillable & { stage: string }): string[] {
  return p.stage === 'posted' ? [] : NEEDS[p.stage as Exclude<PieceStage, 'posted'>].filter(([k]) => !p[k]).map(([, label]) => label);
}

// ---------------------------------------------------------------- R&D: ideas
export async function listIdeas(db: Db, actor: StaffPrincipal, query: { q?: string } = {}) {
  requirePermission(actor, 'studio.read');
  let base = db.selectFrom('content_ideas as i').leftJoin('staff_users as s', 's.id', 'i.created_by').leftJoin('content_pieces as p', 'p.id', 'i.piece_id')
    .select(['i.id', 'i.title', 'i.description', 'i.link', 'i.status', 'i.piece_id', 'i.created_at', 's.email as created_by_email', 's.full_name as created_by_name', 'p.stage as piece_stage']);
  const q = (query.q ?? '').trim().slice(0, 80);
  if (q) { const like = `%${q.replace(/[\\%_]/g, m => '\\' + m)}%`; base = base.where(eb => eb.or([sql<boolean>`i.title ilike ${like}`, sql<boolean>`i.description ilike ${like}`])); }
  const rows = await base.orderBy('i.created_at', 'desc').orderBy('i.id').limit(1000).execute();
  return { rows, total: rows.length, links: rows.filter(r => r.link).length };
}

export type IdeaInput = { ideaId?: string; title: string; description: string | null; link: string | null; status?: IdeaStatus };
export async function saveIdea(db: Db, actor: StaffPrincipal, input: IdeaInput, ctx: MutationContext) {
  requirePermission(actor, 'studio.manage');
  const title = input.title.trim();
  if (!title) throw new DomainError('invalid', 'Give the idea a title.');
  if (!https(input.link)) throw new DomainError('invalid', 'The link must start with https://');
  if (input.status && !(IDEA_STATUSES as readonly string[]).includes(input.status)) throw new DomainError('invalid', 'Unknown status.');
  return db.transaction().execute(async tx => {
    if (!input.ideaId) {
      const i = await tx.insertInto('content_ideas').values({ title, description: input.description, link: input.link, status: input.status ?? 'exploring', created_by: actor.staffId }).returning('id').executeTakeFirstOrThrow();
      await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'studio.idea_create', entityType: 'content_ideas', entityId: i.id, after: { title, status: input.status ?? 'exploring' } });
      return { id: i.id, changed: true };
    }
    const before = await tx.selectFrom('content_ideas').select(['title', 'description', 'link']).where('id', '=', input.ideaId).forUpdate().executeTakeFirst();
    if (!before) throw new NotFoundError('That idea no longer exists.');
    const after = { title, description: input.description, link: input.link };
    if (JSON.stringify(before) === JSON.stringify(after)) return { id: input.ideaId, changed: false };
    await tx.updateTable('content_ideas').set(after).where('id', '=', input.ideaId).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'studio.idea_update', entityType: 'content_ideas', entityId: input.ideaId, before, after });
    return { id: input.ideaId, changed: true };
  });
}

/** Moves an idea between Exploring, Shortlisted and Parked. */
export async function setIdeaStatus(db: Db, actor: StaffPrincipal, input: { ideaId: string; status: string; expectedStatus: string }, ctx: MutationContext) {
  requirePermission(actor, 'studio.manage');
  if (!(IDEA_STATUSES as readonly string[]).includes(input.status)) throw new DomainError('invalid', 'Unknown status.');
  return db.transaction().execute(async tx => {
    const i = await tx.selectFrom('content_ideas').select(['id', 'status']).where('id', '=', input.ideaId).forUpdate().executeTakeFirst();
    if (!i) throw new NotFoundError('That idea no longer exists.');
    if (i.status !== input.expectedStatus) throw new ConflictError('Someone else has just moved this idea. Reload the page.');
    if (i.status === input.status) return { changed: false };
    await tx.updateTable('content_ideas').set({ status: input.status as IdeaStatus }).where('id', '=', i.id).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'studio.idea_move', entityType: 'content_ideas', entityId: i.id, before: { status: i.status }, after: { status: input.status } });
    return { changed: true };
  });
}

/** Removes an idea. One that was sent to planning is kept (the piece it became points back to it). */
export async function deleteIdea(db: Db, actor: StaffPrincipal, input: { ideaId: string }, ctx: MutationContext) {
  requirePermission(actor, 'studio.manage');
  return db.transaction().execute(async tx => {
    const i = await tx.selectFrom('content_ideas').select(['id', 'title', 'piece_id']).where('id', '=', input.ideaId).forUpdate().executeTakeFirst();
    if (!i) throw new NotFoundError('That idea no longer exists.');
    if (i.piece_id) throw new ConflictError('This idea is already in planning, so it is kept. Park it instead.');
    await tx.deleteFrom('content_ideas').where('id', '=', i.id).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'studio.idea_delete', entityType: 'content_ideas', entityId: i.id, before: { title: i.title } });
    return { deleted: true };
  });
}

/** Sends a shortlisted idea to planning: one content piece in the Idea stage, once per idea. */
export async function planIdea(db: Db, actor: StaffPrincipal, input: { ideaId: string }, ctx: MutationContext) {
  requirePermission(actor, 'studio.manage');
  return db.transaction().execute(async tx => {
    const i = await tx.selectFrom('content_ideas').select(['id', 'title', 'description', 'link', 'status', 'piece_id']).where('id', '=', input.ideaId).forUpdate().executeTakeFirst();
    if (!i) throw new NotFoundError('That idea no longer exists.');
    if (i.piece_id) throw new ConflictError('This idea is already in planning.');
    if (i.status !== 'shortlisted') throw new ConflictError('Shortlist the idea first: only shortlisted ideas go to planning.');
    const notes = [i.description, i.link ? `Reference: ${i.link}` : null].filter(Boolean).join('\n\n').slice(0, 2000) || null;
    const p = await tx.insertInto('content_pieces').values({ title: i.title, notes, created_by: actor.staffId }).returning('id').executeTakeFirstOrThrow();
    await tx.updateTable('content_ideas').set({ piece_id: p.id }).where('id', '=', i.id).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'studio.idea_plan', entityType: 'content_ideas', entityId: i.id, after: { piece_id: p.id } });
    return { pieceId: p.id };
  });
}

// ---------------------------------------------------------------- planning: pieces
const day = (col: string) => sql<string | null>`to_char(${sql.ref(col)}, 'YYYY-MM-DD')`;

/** Every piece (posted ones from the last 90 days), with who owns it, what it still needs and any move waiting for approval. */
export async function listPieces(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'studio.read');
  const rows = await db.selectFrom('content_pieces as p').leftJoin('staff_users as o', 'o.id', 'p.owner_id').leftJoin('staff_users as r', 'r.id', 'p.requested_by')
    .select(['p.id', 'p.title', 'p.platform', 'p.format', 'p.stage', day('p.target_on').as('target'), 'p.owner_id', 'p.hook', 'p.script', 'p.footage_link', 'p.final_link', 'p.posted_link',
      'p.notes', 'p.requested_stage', 'p.requested_at', 'p.sent_back_note', 'p.posted_at', 'p.created_at', 'o.full_name as owner_name', 'o.email as owner_email', 'r.full_name as requested_by_name', 'r.email as requested_by_email'])
    .where(eb => eb.or([eb('p.stage', '<>', 'posted'), sql<boolean>`p.posted_at > now() - interval '90 days'`]))
    .orderBy('p.target_on', sql`asc nulls last`).orderBy('p.created_at', 'desc').limit(2000).execute();
  const pieces = rows.map(p => ({ ...p, stage: p.stage as PieceStage, missing: pieceMissing(p), next: nextStage(p.stage as PieceStage) }));
  return { pieces, waiting: pieces.filter(p => p.requested_stage), canApprove: can(actor, 'studio.approve') };
}

/** The staff a piece can be given to (active accounts; names only). */
export async function studioOwners(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'studio.read');
  return db.selectFrom('staff_users').select(['id', 'full_name', 'email']).where('status', '=', 'active').orderBy(sql`lower(coalesce(nullif(full_name, ''), email))`).execute();
}

export type PieceInput = { pieceId?: string; title: string; platform: string | null; format: string | null; ownerId: string | null; targetOn: string | null;
  hook: string | null; script: string | null; footageLink: string | null; finalLink: string | null; postedLink: string | null; notes: string | null };

/** Adds a piece (stage Idea) or changes what is written on it. The stage is changed only by the move functions. */
export async function savePiece(db: Db, actor: StaffPrincipal, input: PieceInput, ctx: MutationContext) {
  requirePermission(actor, 'studio.manage');
  const title = input.title.trim();
  if (!title) throw new DomainError('invalid', 'Give the piece a title.');
  if (input.platform && !(PIECE_PLATFORMS as readonly string[]).includes(input.platform)) throw new DomainError('invalid', 'Unknown platform.');
  if (input.format && !(PIECE_FORMATS as readonly string[]).includes(input.format)) throw new DomainError('invalid', 'Unknown format.');
  if (input.targetOn && !realDay(input.targetOn)) throw new DomainError('invalid', 'Choose a date.');
  for (const [v, label] of [[input.footageLink, 'footage link'], [input.finalLink, 'final cut link'], [input.postedLink, 'link to the post']] as const)
    if (!https(v)) throw new DomainError('invalid', `The ${label} must start with https://`);
  return db.transaction().execute(async tx => {
    if (input.ownerId && !(await tx.selectFrom('staff_users').select('id').where('id', '=', input.ownerId).where('status', '=', 'active').executeTakeFirst())) throw new NotFoundError('That staff member is not active.');
    const row = { title, platform: input.platform as PieceInput['platform'], format: input.format, owner_id: input.ownerId, target_on: input.targetOn, hook: input.hook, script: input.script,
      footage_link: input.footageLink, final_link: input.finalLink, posted_link: input.postedLink, notes: input.notes };
    if (!input.pieceId) {
      const p = await tx.insertInto('content_pieces').values({ ...row, created_by: actor.staffId } as never).returning('id').executeTakeFirstOrThrow();
      await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'studio.piece_create', entityType: 'content_pieces', entityId: p.id, after: { title, platform: input.platform, format: input.format, target_on: input.targetOn } });
      return { id: p.id, changed: true };
    }
    const b = await tx.selectFrom('content_pieces').select(['title', 'platform', 'format', 'owner_id', sql<string | null>`to_char(target_on, 'YYYY-MM-DD')`.as('target_on'), 'hook', 'script', 'footage_link', 'final_link', 'posted_link', 'notes'])
      .where('id', '=', input.pieceId).forUpdate().executeTakeFirst();
    if (!b) throw new NotFoundError('That piece no longer exists.');
    const changed = (Object.keys(row) as (keyof typeof row)[]).filter(k => (b as Record<string, unknown>)[k] !== row[k]);
    if (!changed.length) return { id: input.pieceId, changed: false };
    await tx.updateTable('content_pieces').set(row as never).where('id', '=', input.pieceId).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'studio.piece_update', entityType: 'content_pieces', entityId: input.pieceId, metadata: { changed } });
    return { id: input.pieceId, changed: true };
  });
}

/** The calendar: the day a piece is planned for (null = no date yet). The stage does not change. */
export async function setPieceDate(db: Db, actor: StaffPrincipal, input: { pieceId: string; targetOn: string | null }, ctx: MutationContext) {
  requirePermission(actor, 'studio.manage');
  if (input.targetOn && !realDay(input.targetOn)) throw new DomainError('invalid', 'Choose a date.');
  return db.transaction().execute(async tx => {
    const p = await tx.selectFrom('content_pieces').select(['id', 'stage', sql<string | null>`to_char(target_on, 'YYYY-MM-DD')`.as('target')]).where('id', '=', input.pieceId).forUpdate().executeTakeFirst();
    if (!p) throw new NotFoundError('That piece no longer exists.');
    if (p.stage === 'posted') throw new ConflictError('This piece is posted; its date is no longer planned.');
    if (p.target === input.targetOn) return { changed: false, stage: p.stage };
    await tx.updateTable('content_pieces').set({ target_on: input.targetOn }).where('id', '=', p.id).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'studio.piece_date', entityType: 'content_pieces', entityId: p.id, before: { target_on: p.target }, after: { target_on: input.targetOn } });
    return { changed: true, stage: p.stage };
  });
}

const PIECE_FOR_MOVE = ['id', 'title', 'stage', 'platform', 'format', 'owner_id', 'hook', 'script', 'footage_link', 'final_link', 'posted_link', 'requested_stage', 'requested_by'] as const;

/** Asks for a piece to move to its next stage. What the stage needs must be filled in. Someone who may approve moves it at
    once; otherwise the move waits for approval. `expectedStage` is the stage the page showed (a form sent twice, or an
    out-of-date page, changes nothing). */
export async function requestPieceMove(db: Db, actor: StaffPrincipal, input: { pieceId: string; expectedStage: string }, ctx: MutationContext) {
  requirePermission(actor, 'studio.manage');
  return db.transaction().execute(async tx => {
    const p = await tx.selectFrom('content_pieces').select([...PIECE_FOR_MOVE, sql<string | null>`to_char(target_on, 'YYYY-MM-DD')`.as('target')]).where('id', '=', input.pieceId).forUpdate().executeTakeFirst();
    if (!p) throw new NotFoundError('That piece no longer exists.');
    if (p.stage !== input.expectedStage) throw new ConflictError(`This piece is now in "${PIECE_STAGE_LABEL[p.stage as PieceStage]}". Reload the page.`);
    const to = nextStage(p.stage as PieceStage);
    if (!to) throw new ConflictError('This piece is posted: there is no next stage.');
    const missing = pieceMissing(p);
    if (missing.length) throw new ConflictError(`Fill in first: ${missing.join(', ')}.`);
    if (can(actor, 'studio.approve')) {
      await tx.updateTable('content_pieces').set({ stage: to, requested_stage: null, requested_by: null, requested_at: null, sent_back_note: null, ...(to === 'posted' ? { posted_at: sql<Date>`now()` } : {}) }).where('id', '=', p.id).execute();
      await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'studio.piece_move', entityType: 'content_pieces', entityId: p.id, before: { stage: p.stage }, after: { stage: to }, metadata: { approved_by_mover: true } });
      return { stage: to, waiting: false };
    }
    if (p.requested_stage) throw new ConflictError('This piece is already waiting for approval.');
    await tx.updateTable('content_pieces').set({ requested_stage: to, requested_by: actor.staffId, requested_at: sql<Date>`now()`, sent_back_note: null }).where('id', '=', p.id).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'studio.piece_request', entityType: 'content_pieces', entityId: p.id, after: { requested_stage: to } });
    return { stage: p.stage as PieceStage, waiting: true };
  });
}

/** Approves a waiting move, or sends it back with a note (the piece stays where it is). Needs studio.approve. */
export async function decidePieceMove(db: Db, actor: StaffPrincipal, input: { pieceId: string; decision: 'approve' | 'send_back'; expectedStage: string; note: string | null }, ctx: MutationContext) {
  requirePermission(actor, 'studio.approve');
  const note = (input.note ?? '').trim().slice(0, 300) || null;
  if (input.decision === 'send_back' && !note) throw new DomainError('invalid', 'Say what needs to change.');
  return db.transaction().execute(async tx => {
    const p = await tx.selectFrom('content_pieces').select([...PIECE_FOR_MOVE, sql<string | null>`to_char(target_on, 'YYYY-MM-DD')`.as('target')]).where('id', '=', input.pieceId).forUpdate().executeTakeFirst();
    if (!p) throw new NotFoundError('That piece no longer exists.');
    if (p.stage !== input.expectedStage || !p.requested_stage) throw new ConflictError('This piece is no longer waiting for approval. Reload the page.');
    if (input.decision === 'send_back') {
      await tx.updateTable('content_pieces').set({ requested_stage: null, requested_by: null, requested_at: null, sent_back_note: note }).where('id', '=', p.id).execute();
      await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'studio.piece_send_back', entityType: 'content_pieces', entityId: p.id, before: { requested_stage: p.requested_stage }, metadata: { note, requested_by: p.requested_by } });
      return { stage: p.stage as PieceStage, approved: false };
    }
    const to = p.requested_stage as PieceStage;
    // What was filled in when it was asked for may have been emptied since: it is checked again at the moment of approval.
    const missing = pieceMissing(p);
    if (to !== nextStage(p.stage as PieceStage) || missing.length) throw new ConflictError(missing.length ? `It can no longer move: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} empty. Send it back.` : 'This request is out of date. Send it back.');
    await tx.updateTable('content_pieces').set({ stage: to, requested_stage: null, requested_by: null, requested_at: null, sent_back_note: null, ...(to === 'posted' ? { posted_at: sql<Date>`now()` } : {}) }).where('id', '=', p.id).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'studio.piece_move', entityType: 'content_pieces', entityId: p.id, before: { stage: p.stage }, after: { stage: to }, metadata: { requested_by: p.requested_by } });
    return { stage: to, approved: true };
  });
}

/** Removes a piece added by mistake: only while it is still an idea and not waiting for approval. */
export async function deletePiece(db: Db, actor: StaffPrincipal, input: { pieceId: string }, ctx: MutationContext) {
  requirePermission(actor, 'studio.manage');
  return db.transaction().execute(async tx => {
    const p = await tx.selectFrom('content_pieces').select(['id', 'title', 'stage', 'requested_stage']).where('id', '=', input.pieceId).forUpdate().executeTakeFirst();
    if (!p) throw new NotFoundError('That piece no longer exists.');
    if (p.stage !== 'idea' || p.requested_stage) throw new ConflictError('Only a piece that is still an idea, and not waiting for approval, can be removed.');
    await tx.deleteFrom('content_pieces').where('id', '=', p.id).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'studio.piece_delete', entityType: 'content_pieces', entityId: p.id, before: { title: p.title } });
    return { deleted: true };
  });
}
