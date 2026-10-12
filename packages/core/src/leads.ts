/* Leads pipeline (2026-10-12; migration 20261012004800, local only until reviewed).
   A lead is a person who asked about something, entered by staff (there is no ads / Meta connection). It sits in one
   stage at a time: new → engaged → qualified → visited → converted, or disqualified (with the reason). Staff may move a
   lead to any stage; every move is a row in lead_events and an audit record, so the board can be trusted and the
   conversion figures are counted from what really happened.
   One lead per phone number (compared on its last ten digits). A lead is not a customer: it has no login and changes
   nothing in orders, customers or stock. Reading (and exporting) needs leads.read; every change needs leads.manage. */
import { recordAudit, sql, type Db } from '@kitsyuu/db';
import { ConflictError, DomainError, NotFoundError } from '@kitsyuu/contracts';
import { requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';

const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
const staffAudit = (actor: StaffPrincipal, ctx: MutationContext) => ({ actorType: 'staff' as const, staffId: actor.staffId, ...auditCtx(ctx) });

export const LEAD_STAGES = ['new', 'engaged', 'qualified', 'visited', 'converted', 'disqualified'] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];
export const LEAD_STAGE_LABEL: Record<LeadStage, string> = { new: 'New leads', engaged: 'Engaged', qualified: 'Qualified', visited: 'Customer visited', converted: 'Converted', disqualified: 'Disqualified' };
/** Where a lead came from: a short tag chosen by staff. */
export const LEAD_SOURCES = ['manual', 'ads', 'instagram', 'whatsapp', 'walk_in', 'referral', 'website', 'other'] as const;
export const LEADS_MAX = 2000;

/** A phone number as it is compared: digits only, the last ten (so "+91 98400 10001" and "098400-10001" are one lead). */
export function leadPhoneKey(phone: string): string | null {
  const d = phone.replace(/\D/g, '');
  return d.length >= 7 && d.length <= 15 ? d.slice(-10) : null;
}
const isLeadStage = (s: string): s is LeadStage => (LEAD_STAGES as readonly string[]).includes(s);
const duplicate = (e: unknown) => (e as { code?: string })?.code === '23505';

const COLS = ['l.id', 'l.name', 'l.phone', 'l.email', 'l.interest', 'l.timeline', 'l.source', 'l.stage', 'l.notes', 'l.disqualify_reason', 'l.assigned_to', 'l.customer_id',
  'l.stage_changed_at', 'l.created_at', 'l.updated_at'] as const;

/** The pipeline: leads (newest first, at most LEADS_MAX) and how many are in each stage. `q` searches name, phone, interest. */
export async function listLeads(db: Db, actor: StaffPrincipal, query: { q?: string; stage?: LeadStage; source?: string } = {}) {
  requirePermission(actor, 'leads.read');
  let base = db.selectFrom('leads as l').leftJoin('staff_users as s', 's.id', 'l.assigned_to');
  const q = (query.q ?? '').trim().slice(0, 80);
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, m => '\\' + m)}%`, digits = q.replace(/\D/g, '');
    base = base.where(eb => eb.or([sql<boolean>`l.name ilike ${like}`, sql<boolean>`l.interest ilike ${like}`, sql<boolean>`l.email ilike ${like}`,
      ...(digits.length >= 3 ? [sql<boolean>`l.phone_key like ${'%' + digits.slice(-10) + '%'}`] : [])]));
  }
  if (query.source) base = base.where('l.source', '=', query.source);
  const counted = await base.select(['l.stage', sql<number>`count(*)::int`.as('n')]).groupBy('l.stage').execute();
  let rowsQ = base.select([...COLS, 's.email as assigned_email']);
  if (query.stage) rowsQ = rowsQ.where('l.stage', '=', query.stage);
  const rows = await rowsQ.orderBy('l.created_at', 'desc').orderBy('l.id').limit(LEADS_MAX).execute();
  const counts = Object.fromEntries(LEAD_STAGES.map(s => [s, counted.find(c => c.stage === s)?.n ?? 0])) as Record<LeadStage, number>;
  const total = LEAD_STAGES.reduce((n, s) => n + counts[s], 0);
  return { rows, counts, total, active: total - counts.converted - counts.disqualified };
}

export async function getLead(db: Db, actor: StaffPrincipal, id: string) {
  requirePermission(actor, 'leads.read');
  const lead = await db.selectFrom('leads as l').leftJoin('staff_users as s', 's.id', 'l.assigned_to').leftJoin('staff_users as c', 'c.id', 'l.created_by')
    .select([...COLS, 's.email as assigned_email', 'c.email as created_by_email']).where('l.id', '=', id).executeTakeFirst();
  if (!lead) throw new NotFoundError('Lead not found.');
  const events = await db.selectFrom('lead_events as e').leftJoin('staff_users as s', 's.id', 'e.staff_id')
    .select(['e.id', 'e.from_stage', 'e.to_stage', 'e.note', 'e.created_at', 's.email as staff_email']).where('e.lead_id', '=', id).orderBy('e.id', 'desc').execute();
  return { lead, events: events.map(e => ({ ...e, id: String(e.id) })) };
}

export type LeadInput = { leadId?: string; name: string; phone: string; email: string | null; interest: string | null; timeline: string | null; source: string; notes: string | null };

/** Adds a lead (stage 'new') or changes its details. The stage is changed only by moveLead. */
export async function saveLead(db: Db, actor: StaffPrincipal, input: LeadInput, ctx: MutationContext) {
  requirePermission(actor, 'leads.manage');
  const name = input.name.trim(), phone = input.phone.trim(), key = leadPhoneKey(phone);
  if (!name) throw new DomainError('invalid', 'Enter the name.');
  if (!key) throw new DomainError('invalid', 'Enter a phone number (7 to 15 digits).');
  if (!(LEAD_SOURCES as readonly string[]).includes(input.source)) throw new DomainError('invalid', 'Choose where the lead came from.');
  const row = { name, phone, phone_key: key, email: input.email, interest: input.interest, timeline: input.timeline, source: input.source, notes: input.notes };
  const taken = async (e: unknown): Promise<never> => {
    if (!duplicate(e)) throw e;
    const other = await db.selectFrom('leads').select(['name', 'stage']).where('phone_key', '=', key).executeTakeFirst();
    throw new ConflictError(`A lead with this phone number already exists${other ? `: ${other.name} (${LEAD_STAGE_LABEL[other.stage as LeadStage]})` : ''}.`);
  };
  if (!input.leadId) {
    return db.transaction().execute(async tx => {
      const l = await tx.insertInto('leads').values({ ...row, created_by: actor.staffId }).returning('id').executeTakeFirstOrThrow();
      await tx.insertInto('lead_events').values({ lead_id: l.id, from_stage: null, to_stage: 'new', note: null, staff_id: actor.staffId }).execute();
      await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'lead.create', entityType: 'leads', entityId: l.id, after: { name, source: input.source, interest: input.interest } });
      return { id: l.id, changed: true };
    }).catch(taken);
  }
  return db.transaction().execute(async tx => {
    const before = await tx.selectFrom('leads').select(['name', 'phone', 'email', 'interest', 'timeline', 'source', 'notes']).where('id', '=', input.leadId!).forUpdate().executeTakeFirst();
    if (!before) throw new NotFoundError('Lead not found.');
    const after = { name, phone, email: input.email, interest: input.interest, timeline: input.timeline, source: input.source, notes: input.notes };
    if (JSON.stringify(before) === JSON.stringify(after)) return { id: input.leadId!, changed: false };
    await tx.updateTable('leads').set(row).where('id', '=', input.leadId!).execute();
    // The audit record says which fields changed, not the phone number or the notes themselves.
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'lead.update', entityType: 'leads', entityId: input.leadId!,
      metadata: { changed: (Object.keys(after) as (keyof typeof after)[]).filter(k => before[k] !== after[k]) } });
    return { id: input.leadId!, changed: true };
  }).catch(taken);
}

/** Moves a lead to a stage. `expectedStage` is the stage the page showed: if someone else moved it meanwhile (or the
    same move is sent twice) nothing changes and the person is told. Disqualifying needs the reason. */
export async function moveLead(db: Db, actor: StaffPrincipal, input: { leadId: string; stage: string; expectedStage: string; note: string | null }, ctx: MutationContext) {
  requirePermission(actor, 'leads.manage');
  if (!isLeadStage(input.stage)) throw new DomainError('invalid', 'Unknown stage.');
  const to = input.stage, note = (input.note ?? '').trim().slice(0, 300) || null;
  if (to === 'disqualified' && !note) throw new DomainError('invalid', 'Say why this lead is disqualified.');
  return db.transaction().execute(async tx => {
    const l = await tx.selectFrom('leads').select(['id', 'name', 'stage']).where('id', '=', input.leadId).forUpdate().executeTakeFirst();
    if (!l) throw new NotFoundError('Lead not found.');
    if (l.stage !== input.expectedStage) throw new ConflictError(`${l.name} is now in "${LEAD_STAGE_LABEL[l.stage as LeadStage]}". Reload the page to see the board as it is.`);
    if (l.stage === to) return { stage: to, changed: false };
    await tx.updateTable('leads').set({ stage: to, stage_changed_at: sql<Date>`now()`, disqualify_reason: to === 'disqualified' ? note : null }).where('id', '=', l.id).execute();
    await tx.insertInto('lead_events').values({ lead_id: l.id, from_stage: l.stage, to_stage: to, note, staff_id: actor.staffId }).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'lead.move', entityType: 'leads', entityId: l.id, before: { stage: l.stage }, after: { stage: to }, metadata: note ? { note } : undefined });
    return { stage: to, changed: true };
  });
}

/** Conversion: of the leads added in a period, how many reached each stage (from the recorded moves), how many are in
    each stage now, and the same by source. "Reached" counts a lead once per stage however often it moved. */
export async function leadConversion(db: Db, actor: StaffPrincipal, range: { from: string; to: string }) {
  requirePermission(actor, 'leads.read');
  const ok = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
  if (!ok(range.from) || !ok(range.to) || range.to < range.from) throw new DomainError('invalid', 'Choose a valid period.');
  const inPeriod = sql<boolean>`l.created_at >= (${range.from}::date)::timestamp at time zone 'Asia/Kolkata' and l.created_at < (${range.to}::date + 1)::timestamp at time zone 'Asia/Kolkata'`;
  const [now, reached, bySource] = await Promise.all([
    db.selectFrom('leads as l').select(['l.stage', sql<number>`count(*)::int`.as('n')]).where(inPeriod).groupBy('l.stage').execute(),
    db.selectFrom('lead_events as e').innerJoin('leads as l', 'l.id', 'e.lead_id').select(['e.to_stage', sql<number>`count(distinct e.lead_id)::int`.as('n')]).where(inPeriod).groupBy('e.to_stage').execute(),
    db.selectFrom('leads as l').select(['l.source', sql<number>`count(*)::int`.as('leads'), sql<number>`(count(*) filter (where l.stage = 'converted'))::int`.as('converted'),
      sql<number>`(count(*) filter (where l.stage = 'disqualified'))::int`.as('disqualified')]).where(inPeriod).groupBy('l.source').orderBy(sql`count(*)`, 'desc').orderBy('l.source').execute(),
  ]);
  const total = now.reduce((n, r) => n + r.n, 0);
  const stages = LEAD_STAGES.map(s => ({ stage: s, label: LEAD_STAGE_LABEL[s], now: now.find(r => r.stage === s)?.n ?? 0, reached: s === 'new' ? total : reached.find(r => r.to_stage === s)?.n ?? 0 }));
  const converted = stages.find(s => s.stage === 'converted')!.now;
  return { from: range.from, to: range.to, total, converted, ratePct: total ? Math.round((converted / total) * 1000) / 10 : null, stages, bySource };
}

/** Every lead as rows for a spreadsheet (leads.read). The export itself is audited: it leaves with phone numbers. */
export async function exportLeads(db: Db, actor: StaffPrincipal, ctx: MutationContext) {
  requirePermission(actor, 'leads.read');
  const rows = await db.selectFrom('leads as l').select(['l.name', 'l.phone', 'l.email', 'l.interest', 'l.timeline', 'l.source', 'l.stage', 'l.disqualify_reason', 'l.created_at', 'l.stage_changed_at'])
    .orderBy('l.created_at', 'desc').limit(20_000).execute();
  await recordAudit(db, { ...staffAudit(actor, ctx), action: 'lead.export', entityType: 'leads', entityId: 'all', metadata: { rows: rows.length } });
  return rows;
}
