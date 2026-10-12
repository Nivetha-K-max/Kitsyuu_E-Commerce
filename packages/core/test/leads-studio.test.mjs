/* Leads pipeline and content studio (2026-10-12), against the LOCAL test database only.
   Leads: one per phone number; stage moves are recorded and counted; an out-of-date board changes nothing; conversion
   figures; export; permissions. Studio: ideas (exploring / shortlisted / parked) and sending one to planning once; a
   piece moves one stage at a time, only with what the stage needs, asked for by staff and approved by someone who may
   approve; the calendar date never changes the stage; permissions; audit; the store's role sees none of it.
   Run by apps/admin/tests/run-e2e.mjs, or: node --env-file=apps/admin/tests/.output/test.env --test packages/core/test/leads-studio.test.mjs */
import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {ConflictError, DomainError, ForbiddenError, NotFoundError, leadInput, pieceInput} from '@kitsyuu/contracts';
import {
  decidePieceMove, deleteIdea, deletePiece, exportLeads, getLead, leadConversion, leadPhoneKey, listIdeas, listLeads, listPieces, moveLead, planIdea, requestPieceMove, saveIdea, saveLead,
  savePiece, setIdeaStatus, setPieceDate, studioOwners,
} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const db = createDb({connectionString: ADMIN_DATABASE_URL, max: 6});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 2});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 2});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'leads-studio.test', requestId: 'test'};

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(db, (await acceptStaffInvite(db, {token, password: 'leads studio passphrase', fullName: role}, ctx)).token);
}
const today = () => new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Kolkata'}).format(new Date());
const day = n => { const d = new Date(`${today()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const lead = (over = {}) => leadInput.parse({name: 'Mahaveer Jain', phone: '+91 94440 10801', interest: 'Bespoke wedding suit', timeline: 'Within 1 month', source: 'ads', ...over});
const piece = (over = {}) => pieceInput.parse({title: 'Gold sherwani walking reel', ...over});

let admin, manager, sales, support;
before(async () => {
  admin = await staff('ls.admin@test.local', 'admin');           // everything, including studio.approve
  manager = await staff('ls.manager@test.local', 'manager');     // leads + studio, cannot approve
  sales = await staff('ls.sales@test.local', 'sales');           // leads only
  support = await staff('ls.support@test.local', 'support');     // neither
});
after(async () => { await db.destroy(); await owner.destroy(); await pool.end(); });

test('leads: added by staff as new; one lead per phone number however it is typed; inputs are validated', async () => {
  assert.deepEqual((await listLeads(db, sales)).total, 0);
  const a = await saveLead(db, sales, lead(), ctx);
  const dup = e => e instanceof ConflictError && /already exists: Mahaveer Jain \(New leads\)/.test(e.message);
  await assert.rejects(saveLead(db, sales, lead({name: 'Someone Else', phone: '094440-10801'}), ctx), dup, 'the same number written differently');
  await assert.rejects(saveLead(db, manager, lead({name: 'Third', phone: '9444010801'}), ctx), dup);
  // Several people adding the same new number at the same moment: one lead.
  const race = await Promise.allSettled(Array.from({length: 5}, (_, i) => saveLead(db, sales, lead({name: `Race ${i}`, phone: '98400 99999'}), ctx)));
  assert.equal(race.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(race.filter(r => r.status === 'rejected').every(r => r.reason instanceof ConflictError));
  assert.equal((await q(`select count(*)::int n from leads`))[0].n, 2);
  assert.equal(leadPhoneKey('+91 (94440) 10801'), '9444010801'); assert.equal(leadPhoneKey('12345'), null);
  for (const bad of [{name: ''}, {phone: '12345'}, {phone: 'call me'}, {source: 'billboard'}, {email: 'nope'}, {name: 'x'.repeat(121)}])
    assert.equal(leadInput.safeParse({name: 'A', phone: '9000000001', ...bad}).success, false, JSON.stringify(bad).slice(0, 30));
  const got = await getLead(db, sales, a.id);
  assert.deepEqual([got.lead.stage, got.lead.source, got.lead.interest, got.events.map(e => [e.from_stage, e.to_stage])], ['new', 'ads', 'Bespoke wedding suit', [[null, 'new']]]);
  // Editing details: the stage is not touched; a number that belongs to another lead is refused.
  assert.deepEqual(await saveLead(db, sales, lead({leadId: a.id, timeline: 'Within 2 weeks'}), ctx), {id: a.id, changed: true});
  assert.deepEqual(await saveLead(db, sales, lead({leadId: a.id, timeline: 'Within 2 weeks'}), ctx), {id: a.id, changed: false});
  await assert.rejects(saveLead(db, sales, lead({leadId: a.id, phone: '9840099999'}), ctx), ConflictError);
  await assert.rejects(saveLead(db, sales, lead({leadId: '00000000-0000-4000-8000-000000000000'}), ctx), NotFoundError);
});

test('leads: moves are recorded; an out-of-date board or a move sent twice changes nothing; disqualifying needs the reason', async () => {
  const [l] = await q(`select id from leads where phone_key = '9444010801'`);
  const move = (actor, stage, expectedStage, note = null) => moveLead(db, actor, {leadId: l.id, stage, expectedStage, note}, ctx);
  assert.deepEqual(await move(sales, 'engaged', 'new'), {stage: 'engaged', changed: true});
  await assert.rejects(move(sales, 'qualified', 'new'), e => e instanceof ConflictError && /is now in "Engaged"/.test(e.message), 'the board showed New; it is Engaged');
  const twice = await Promise.allSettled([move(sales, 'qualified', 'engaged'), move(manager, 'qualified', 'engaged')]);
  assert.deepEqual(twice.map(r => r.status).sort(), ['fulfilled', 'rejected'], 'two people dragging the same card: one move');
  assert.deepEqual(await move(sales, 'qualified', 'qualified'), {stage: 'qualified', changed: false});
  await assert.rejects(move(sales, 'disqualified', 'qualified'), DomainError, 'a reason is required');
  await assert.rejects(move(sales, 'won', 'qualified'), DomainError);
  assert.deepEqual(await move(sales, 'disqualified', 'qualified', 'Budget too low'), {stage: 'disqualified', changed: true});
  assert.equal((await getLead(db, sales, l.id)).lead.disqualify_reason, 'Budget too low');
  assert.deepEqual(await move(sales, 'visited', 'disqualified'), {stage: 'visited', changed: true}, 'a lead can come back');
  assert.equal((await getLead(db, sales, l.id)).lead.disqualify_reason, null, 'the old reason does not stay on it');
  await move(sales, 'converted', 'visited');
  assert.deepEqual((await getLead(db, sales, l.id)).events.map(e => e.to_stage), ['converted', 'visited', 'disqualified', 'qualified', 'engaged', 'new'], 'newest first, every move once');
  await assert.rejects(q(`update leads set stage = 'disqualified', disqualify_reason = null where id = $1`, [l.id]), /leads_disqualified_has_reason/);
});

test('leads: the board counts, search, conversion figures and the export', async () => {
  await saveLead(db, sales, lead({name: 'Nave Nesa', phone: '9043319408', source: 'walk_in', interest: 'Business suit'}), ctx);
  const list = await listLeads(db, sales);
  assert.deepEqual([list.total, list.active, list.counts.new, list.counts.converted], [3, 2, 2, 1]);
  assert.deepEqual((await listLeads(db, sales, {q: 'business'})).rows.map(r => r.name), ['Nave Nesa']);
  assert.deepEqual((await listLeads(db, sales, {q: '90433 19'})).rows.map(r => r.name), ['Nave Nesa'], 'by part of the phone number');
  assert.deepEqual((await listLeads(db, sales, {q: '100%_'})).rows, [], 'wildcards are text');
  assert.equal((await listLeads(db, sales, {stage: 'converted'})).rows.length, 1);
  const c = await leadConversion(db, sales, {from: day(-1), to: day(0)});
  assert.deepEqual([c.total, c.converted, c.ratePct], [3, 1, 33.3]);
  assert.deepEqual(Object.fromEntries(c.stages.map(s => [s.stage, [s.now, s.reached]])), {new: [2, 3], engaged: [0, 1], qualified: [0, 1], visited: [0, 1], converted: [1, 1], disqualified: [0, 1]});
  assert.deepEqual(c.bySource.map(s => [s.source, s.leads, s.converted]), [['ads', 2, 1], ['walk_in', 1, 0]]);
  assert.deepEqual([(await leadConversion(db, sales, {from: day(-30), to: day(-2)})).total, (await leadConversion(db, sales, {from: day(-30), to: day(-2)})).ratePct], [0, null]);
  await assert.rejects(leadConversion(db, sales, {from: day(0), to: day(-1)}), DomainError);
  const rows = await exportLeads(db, sales, ctx);
  assert.equal(rows.length, 3);
  assert.equal((await q(`select metadata->>'rows' n from audit_logs where action = 'lead.export'`))[0].n, '3', 'an export is recorded');
});

test('studio R&D: ideas are sorted into exploring, shortlisted and parked; a shortlisted idea goes to planning once', async () => {
  const a = await saveIdea(db, manager, {title: 'Hands off bro', description: 'Someone grabs the suit bag in a parking area.', link: 'https://instagram.com/p/abc'}, ctx);
  const b = await saveIdea(db, manager, {title: 'Japanese outfit', description: null, link: null}, ctx);
  await assert.rejects(saveIdea(db, manager, {title: 'x', description: null, link: 'http://insecure.example'}, ctx), DomainError);
  await assert.rejects(saveIdea(db, manager, {title: 'x', description: null, link: 'javascript:alert(1)'}, ctx), DomainError);
  await assert.rejects(saveIdea(db, manager, {title: '  ', description: null, link: null}, ctx), DomainError);
  const list = await listIdeas(db, manager);
  assert.deepEqual([list.total, list.links, list.rows.every(r => r.status === 'exploring')], [2, 1, true]);
  await assert.rejects(planIdea(db, manager, {ideaId: a.id}, ctx), e => e instanceof ConflictError && /Shortlist the idea first/.test(e.message));
  await setIdeaStatus(db, manager, {ideaId: a.id, status: 'shortlisted', expectedStatus: 'exploring'}, ctx);
  await assert.rejects(setIdeaStatus(db, manager, {ideaId: a.id, status: 'parked', expectedStatus: 'exploring'}, ctx), ConflictError, 'an out-of-date board');
  const plans = await Promise.allSettled([planIdea(db, manager, {ideaId: a.id}, ctx), planIdea(db, manager, {ideaId: a.id}, ctx)]);
  assert.deepEqual(plans.map(r => r.status).sort(), ['fulfilled', 'rejected'], 'sent to planning once, even when clicked twice');
  assert.equal((await q(`select count(*)::int n from content_pieces`))[0].n, 1);
  const [p] = await q(`select title, stage, notes from content_pieces`);
  assert.deepEqual([p.title, p.stage], ['Hands off bro', 'idea']); assert.match(p.notes, /parking area[\s\S]*Reference: https:\/\/instagram\.com\/p\/abc/);
  await assert.rejects(deleteIdea(db, manager, {ideaId: a.id}, ctx), e => e instanceof ConflictError && /already in planning/.test(e.message));
  assert.deepEqual(await deleteIdea(db, manager, {ideaId: b.id}, ctx), {deleted: true});
  assert.deepEqual((await listIdeas(db, manager, {q: 'hands'})).rows.map(r => [r.title, r.piece_stage]), [['Hands off bro', 'idea']]);
});

test('studio planning: one stage at a time, only with what the stage needs; staff ask, an approver decides', async () => {
  const p = await savePiece(db, manager, piece(), ctx);
  const get = async () => (await listPieces(db, manager)).pieces.find(x => x.id === p.id);
  const ask = (actor, expectedStage) => requestPieceMove(db, actor, {pieceId: p.id, expectedStage}, ctx);
  const decide = (actor, decision, expectedStage, note = null) => decidePieceMove(db, actor, {pieceId: p.id, decision, expectedStage, note}, ctx);
  assert.deepEqual([(await get()).stage, (await get()).missing, (await get()).next], ['idea', ['Platform', 'Format', 'Owner', 'Target date'], 'script']);
  await assert.rejects(ask(manager, 'idea'), e => e instanceof ConflictError && /Fill in first: Platform, Format, Owner, Target date/.test(e.message));
  const owners = await studioOwners(db, manager);
  const full = {pieceId: p.id, platform: 'instagram', format: 'reel', ownerId: owners.find(o => o.email === 'ls.manager@test.local').id, targetOn: day(5)};
  await savePiece(db, manager, piece(full), ctx);
  assert.deepEqual((await get()).missing, []);
  // The manager cannot approve: the move waits.
  assert.deepEqual(await ask(manager, 'idea'), {stage: 'idea', waiting: true});
  await assert.rejects(ask(manager, 'idea'), e => e instanceof ConflictError && /already waiting/.test(e.message), 'asked once');
  assert.deepEqual([(await get()).stage, (await get()).requested_stage, (await listPieces(db, admin)).waiting.length], ['idea', 'script', 1]);
  await assert.rejects(decide(manager, 'approve', 'idea'), ForbiddenError, 'the person who asked cannot approve their own move');
  await assert.rejects(decide(admin, 'send_back', 'idea'), DomainError, 'sending back says why');
  await decide(admin, 'send_back', 'idea', 'Pick a later date');
  assert.deepEqual([(await get()).stage, (await get()).requested_stage, (await get()).sent_back_note], ['idea', null, 'Pick a later date']);
  await assert.rejects(decide(admin, 'approve', 'idea'), e => e instanceof ConflictError && /no longer waiting/.test(e.message));
  await ask(manager, 'idea');
  const both = await Promise.allSettled([decide(admin, 'approve', 'idea'), decide(admin, 'approve', 'idea')]);
  assert.deepEqual(both.map(r => r.status).sort(), ['fulfilled', 'rejected'], 'approved once');
  assert.deepEqual([(await get()).stage, (await get()).requested_stage, (await get()).sent_back_note, (await get()).missing], ['script', null, null, ['Hook', 'Script']]);
  // What was filled in is checked again at approval: emptied meanwhile, it cannot be approved.
  await savePiece(db, manager, piece({...full, hook: 'Two kings, one walk', script: 'Wide shot, then close on the embroidery.'}), ctx);
  await ask(manager, 'script');
  await savePiece(db, manager, piece({...full, hook: 'Two kings, one walk', script: ''}), ctx);
  await assert.rejects(decide(admin, 'approve', 'script'), e => e instanceof ConflictError && /Script is empty/.test(e.message));
  await decide(admin, 'send_back', 'script', 'Script went missing');
  // Someone who may approve moves it in one step, and never past a stage.
  const done = {...full, hook: 'Two kings, one walk', script: 'Wide shot, then close on the embroidery.', footageLink: 'https://drive.example/footage', finalLink: 'https://drive.example/final'};
  await savePiece(db, admin, piece(done), ctx);
  assert.deepEqual(await ask(admin, 'script'), {stage: 'shoot', waiting: false});
  await assert.rejects(ask(admin, 'script'), e => e instanceof ConflictError && /now in "Shoot"/.test(e.message), 'the same click twice moves it once');
  assert.deepEqual(await ask(admin, 'shoot'), {stage: 'edit', waiting: false});
  assert.deepEqual(await ask(admin, 'edit'), {stage: 'scheduled', waiting: false});
  await assert.rejects(ask(admin, 'scheduled'), /Fill in first: Link to the post/);
  await savePiece(db, admin, piece({...done, postedLink: 'https://instagram.com/reel/xyz'}), ctx);
  assert.deepEqual(await ask(admin, 'scheduled'), {stage: 'posted', waiting: false});
  assert.ok((await q(`select posted_at from content_pieces where id = $1`, [p.id]))[0].posted_at);
  await assert.rejects(ask(admin, 'posted'), e => e instanceof ConflictError && /no next stage/.test(e.message));
  await assert.rejects(q(`update content_pieces set stage = 'edit' where id = $1`, [p.id]), /content_pieces_posted_consistent/);
  for (const bad of [{platform: 'tiktokk'}, {format: 'carousel9'}, {targetOn: '31/10/2026'}, {footageLink: 'ftp://x'}, {title: ''}])
    assert.equal(pieceInput.safeParse({title: 'A', ...bad}).success, false, JSON.stringify(bad));
});

test('studio calendar: the planned day changes, the stage does not; only an untouched idea can be removed', async () => {
  const p = await savePiece(db, manager, piece({title: 'Atlee solo photo sofa seated'}), ctx);
  assert.deepEqual(await setPieceDate(db, manager, {pieceId: p.id, targetOn: day(3)}, ctx), {changed: true, stage: 'idea'});
  assert.deepEqual(await setPieceDate(db, manager, {pieceId: p.id, targetOn: day(3)}, ctx), {changed: false, stage: 'idea'});
  assert.deepEqual(await setPieceDate(db, manager, {pieceId: p.id, targetOn: null}, ctx), {changed: true, stage: 'idea'}, 'back to "no date yet"');
  await assert.rejects(setPieceDate(db, manager, {pieceId: p.id, targetOn: '2026-02-30'}, ctx), DomainError);
  const [posted] = await q(`select id from content_pieces where stage = 'posted'`);
  await assert.rejects(setPieceDate(db, manager, {pieceId: posted.id, targetOn: day(1)}, ctx), e => e instanceof ConflictError && /is posted/.test(e.message));
  await assert.rejects(deletePiece(db, manager, {pieceId: posted.id}, ctx), ConflictError);
  assert.deepEqual(await deletePiece(db, manager, {pieceId: p.id}, ctx), {deleted: true});
  assert.equal((await q(`select count(*)::int n from content_pieces`))[0].n, 2);
});

test('permissions: leads for sales, studio for managers, approval for admins; support and the store see none of it', async () => {
  const [l] = await q(`select id, stage from leads limit 1`), [p] = await q(`select id from content_pieces where stage = 'idea' limit 1`), [i] = await q(`select id, status from content_ideas limit 1`);
  for (const f of [() => listLeads(db, support), () => getLead(db, support, l.id), () => leadConversion(db, support, {from: day(-1), to: day(0)}), () => exportLeads(db, support, ctx),
    () => saveLead(db, support, lead({phone: '9000000009'}), ctx), () => moveLead(db, support, {leadId: l.id, stage: 'engaged', expectedStage: l.stage, note: null}, ctx),
    () => listIdeas(db, support), () => listPieces(db, support), () => studioOwners(db, support),
    () => listIdeas(db, sales), () => listPieces(db, sales), () => saveIdea(db, sales, {title: 'x', description: null, link: null}, ctx), () => savePiece(db, sales, piece(), ctx),
    () => setIdeaStatus(db, sales, {ideaId: i.id, status: 'parked', expectedStatus: i.status}, ctx), () => planIdea(db, sales, {ideaId: i.id}, ctx),
    () => requestPieceMove(db, sales, {pieceId: p.id, expectedStage: 'idea'}, ctx), () => setPieceDate(db, sales, {pieceId: p.id, targetOn: day(1)}, ctx), () => deletePiece(db, sales, {pieceId: p.id}, ctx),
    () => decidePieceMove(db, sales, {pieceId: p.id, decision: 'approve', expectedStage: 'idea', note: null}, ctx)])
    await assert.rejects(f(), ForbiddenError, f.toString().slice(6, 60));
  assert.equal((await listLeads(db, manager)).total, 3, 'a manager reads leads');
  for (const t of ['leads', 'lead_events', 'content_ideas', 'content_pieces'])
    assert.equal((await q(`select has_table_privilege('kitsyuu_website', 'public.' || $1, 'select') w`, [t]))[0].w, false, `the store has no access to ${t}`);
});

test('audit: every change names who made it; nothing here touches customers, orders or stock', async () => {
  const actions = Object.fromEntries((await q(`select action, count(*)::int n from audit_logs where action like 'lead.%' or action like 'studio.%' group by 1`)).map(r => [r.action, r.n]));
  assert.deepEqual(actions, {'lead.create': 3, 'lead.update': 1, 'lead.move': 5, 'lead.export': 1, 'studio.idea_create': 2, 'studio.idea_move': 1, 'studio.idea_plan': 1, 'studio.idea_delete': 1,
    'studio.piece_create': 2, 'studio.piece_update': 5, 'studio.piece_request': 3, 'studio.piece_send_back': 2, 'studio.piece_move': 5, 'studio.piece_date': 2, 'studio.piece_delete': 1});
  assert.equal((await q(`select count(*)::int n from audit_logs where (action like 'lead.%' or action like 'studio.%') and staff_id is null`))[0].n, 0);
  assert.equal((await q(`select count(*)::int n from audit_logs where action = 'lead.update' and (after_data::text like '%94440%' or metadata::text like '%94440%')`))[0].n, 0, 'a phone number is not copied into the audit log');
  assert.deepEqual((await q(`select (select count(*)::int from customers) customers, (select count(*)::int from orders) orders, (select coalesce(sum(stock_qty), 0)::int from product_variants) units`))[0], {customers: 0, orders: 0, units: 1100});
});
