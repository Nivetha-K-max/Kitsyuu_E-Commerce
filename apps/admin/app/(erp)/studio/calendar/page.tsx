/* Content studio → Calendar (2026-10-12). The pieces of the content pipeline by the day they are planned for: a week
   (default) or a month, with the pieces that have no date yet at the side. Dragging a card to a day changes its target
   date only; the stage is never changed here (moving to the next stage needs approval, in Planning). A card opens the
   piece, where the date can also be typed. Reading needs studio.read; changing a date needs studio.manage. */
import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { PIECE_STAGES, PIECE_STAGE_LABEL, listPieces } from '@kitsyuu/core';
import { DragCard, DropColumn } from '@/components/DragMove';
import ModuleViews from '@/components/ModuleViews';
import { ViewTabs, Workspace } from '@/components/frame';
import { FilterLink } from '@/components/NavFrame';
import { Forbidden, PageHead } from '@/components/ui';
import { formatNumber } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { pieceDateAction } from '../actions';

export const metadata: Metadata = { title: 'Content calendar' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const at = (d: string) => new Date(`${d}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const plus = (d: string, n: number) => { const x = at(d); x.setUTCDate(x.getUTCDate() + n); return iso(x); };
const monday = (d: string) => plus(d, -((at(d).getUTCDay() + 6) % 7));
const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const moveMonth = (d: string, n: number) => { const x = at(monthStart(d)); x.setUTCMonth(x.getUTCMonth() + n); return iso(x); };
const real = (d: string | undefined) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(at(d).getTime()) && iso(at(d)) === d && d >= '2000-01-01' && d <= '2099-12-31';
const short = (d: string) => `${at(d).getUTCDate()} ${MONTHS[at(d).getUTCMonth()]!.slice(0, 3)}`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default async function StudioCalendarPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'studio.read')) return <><PageHead title="Content studio" /><Forbidden permission="studio.read" /></>;
  const sp = await searchParams;
  const now = today();
  const view = one(sp.view) === 'month' ? 'month' : 'week';
  const date = real(one(sp.date)) ? one(sp.date)! : now;
  const hidePosted = one(sp.posted) === 'hide';
  const from = view === 'month' ? monday(monthStart(date)) : monday(date);
  const days = Array.from({ length: view === 'month' ? 42 : 7 }, (_, i) => plus(from, i)), to = days[days.length - 1]!;
  const d = await listPieces(db(), actor);
  const manage = can(actor, 'studio.manage');
  const all = d.pieces.filter(p => !(hidePosted && p.stage === 'posted'));
  const inRange = all.filter(p => p.target && p.target >= from && p.target <= to);
  const undated = all.filter(p => !p.target && p.stage !== 'posted');
  const href = (over: { view?: string; date?: string; posted?: string | null }) => {
    const v = over.view ?? view, dt = over.date ?? date, hp = over.posted === undefined ? hidePosted : over.posted === 'hide';
    const p = new URLSearchParams(); if (v === 'month') p.set('view', 'month'); if (dt !== now) p.set('date', dt); if (hp) p.set('posted', 'hide');
    return p.size ? `/studio/calendar?${p}` : '/studio/calendar';
  };
  const step = (n: number) => (view === 'month' ? moveMonth(date, n) : plus(date, 7 * n));
  const title = view === 'month' ? `${MONTHS[at(date).getUTCMonth()]} ${at(date).getUTCFullYear()}` : `${short(from)} – ${short(to)}`;
  const card = (p: (typeof all)[number], compact: boolean) => {
    const body = <>
      <Link className="kb-title-link" href={`/studio/planning/${p.id}`}>{p.title}</Link>
      <p className="kb-chips"><span className="badge as-written" data-piece-stage={p.stage}>{PIECE_STAGE_LABEL[p.stage]}</span>{!compact && p.format && <span className="badge as-written">{cap(p.format)}</span>}</p>
      {!compact && <p className="note">{p.owner_name || p.owner_email || 'No owner yet'}</p>}
    </>;
    return manage && p.stage !== 'posted'
      ? <DragCard key={p.id} group="piece-date" data={{ pieceId: p.id, from: p.target ?? '', label: p.title }} className={`kb-card${compact ? ' is-compact' : ''}`} data-piece={p.id} data-piece-date={p.target ?? ''}>{body}</DragCard>
      : <div key={p.id} className={`kb-card${compact ? ' is-compact' : ''}`} data-piece={p.id} data-piece-date={p.target ?? ''}>{body}</div>;
  };
  const dayCell = (dstr: string) => {
    const pieces = inRange.filter(p => p.target === dstr), outside = view === 'month' && dstr.slice(0, 7) !== date.slice(0, 7);
    const inner = <>
      <header className="cc-day-head"><span className="cc-dow">{WEEKDAYS[(at(dstr).getUTCDay() + 6) % 7]}</span><b>{at(dstr).getUTCDate()}</b>
        <span className="note">{pieces.length ? `${pieces.length} piece${pieces.length === 1 ? '' : 's'}` : ''}</span></header>
      <div className="kb-cards">{pieces.map(p => card(p, view === 'month'))}</div>
    </>;
    const cls = `cc-day${dstr === now ? ' is-today' : ''}${outside ? ' is-outside' : ''}${pieces.length ? '' : ' is-empty'}`;
    return manage
      ? <DropColumn key={dstr} group="piece-date" action={pieceDateAction} fields={{ targetOn: dstr }} skipWhen={{ card: 'from', equals: dstr }} className={cls} data-cal-day={dstr} data-day-count={String(pieces.length)}>{inner}</DropColumn>
      : <div key={dstr} className={cls} data-cal-day={dstr} data-day-count={String(pieces.length)}>{inner}</div>;
  };
  const side = <>
    <header className="cc-day-head"><b>No date yet</b><span className="note">{manage ? 'Drag one onto a day' : ''}</span><span className="kb-count" data-undated-count>{formatNumber(undated.length)}</span></header>
    <div className="kb-cards">{undated.length === 0 ? <p className="kb-empty">Every piece has a date</p> : undated.map(p => card(p, false))}</div>
  </>;
  return (
    <Workspace name="studio-calendar" title="Content calendar" summary={`${formatNumber(inRange.length)} planned ${view === 'month' ? 'in this view' : 'this week'} · ${formatNumber(undated.length)} with no date`}
      actions={<Link className="btn ghost" href="/studio/planning" data-link="open-pipeline">Open pipeline</Link>}>
      <ModuleViews module="studio" label="Content studio" current="/studio/calendar" />
      <div className="cal-bar">
        <nav className="cal-nav" aria-label="Period" data-cal-nav>
          <FilterLink className="btn ghost sm" group="period" current={false} href={href({ date: step(-1) })} data-cal-prev aria-label={`Previous ${view}`}>←</FilterLink>
          <h2 className="cal-title" data-cal-title>{title}</h2>
          <FilterLink className="btn ghost sm" group="period" current={false} href={href({ date: step(1) })} data-cal-next aria-label={`Next ${view}`}>→</FilterLink>
          <FilterLink className="btn ghost sm" group="period" current={false} href={href({ date: now })} data-cal-today>Today</FilterLink>
        </nav>
        <div data-cal-views><ViewTabs label="Calendar view" current={view} items={[{ id: 'week', label: 'Week', href: href({ view: 'week' }) }, { id: 'month', label: 'Month', href: href({ view: 'month' }) }]} /></div>
        <p className="cc-legend" data-cal-legend>{PIECE_STAGES.map(s => <span key={s} data-legend={s}>{PIECE_STAGE_LABEL[s]} <b>{inRange.filter(p => p.stage === s).length}</b></span>)}
          <FilterLink className="btn ghost sm" group="posted" current={false} href={href({ posted: hidePosted ? null : 'hide' })} data-cal-posted>{hidePosted ? 'Show posted' : 'Hide posted'}</FilterLink></p>
      </div>
      <div className={`cc cc-${view}`} data-content-calendar={view} data-from={from} data-to={to} key={`${view}|${from}|${hidePosted}`}>
        <div className="cc-days">{days.map(dayCell)}</div>
        {manage
          ? <DropColumn group="piece-date" action={pieceDateAction} fields={{ targetOn: '' }} skipWhen={{ card: 'from', equals: '' }} className="cc-side" data-cal-undated="">{side}</DropColumn>
          : <div className="cc-side" data-cal-undated="">{side}</div>}
      </div>
      <p className="note section-foot" data-cal-rule>Dragging a card changes its target date only. Moving it to the next stage still needs approval, in Planning.</p>
    </Workspace>
  );
}
