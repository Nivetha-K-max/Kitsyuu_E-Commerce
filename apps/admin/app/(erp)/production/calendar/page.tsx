/* Production → Calendar (2026-10-12). A view of dates, not a second record of production:
     · each production order's own due date (cancelled orders are left out);
     · the milestones "Ready for Trial" and "Ex-Factory" (at most one of each per production order);
     · tasks staff added to a production order or to a customer order.
   Nothing here is created automatically: every milestone and task is added by a staff member, and a customer order can
   carry tasks only. Month · Week · Day are three views of the same entries; the period and the view are in the address.
   Reading needs production.read; adding and changing need production.manage (checked again in the core). Entries of a
   customer order are shown only to staff who may read orders. */
import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { MILESTONE_LABEL, calendarToday, productionCalendar, type CalendarEvent } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, Select } from '@/components/forms';
import { StateBlock, ViewTabs, Workspace } from '@/components/frame';
import { FilterLink } from '@/components/NavFrame';
import { Drawer } from '@/components/overlays';
import { Forbidden, PageHead } from '@/components/ui';
import { formatNumber } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { deleteMilestoneAction, milestoneDoneAction, saveMilestoneAction } from '../actions';

export const metadata: Metadata = { title: 'Production calendar' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const VIEWS = ['month', 'week', 'day'] as const;
type View = (typeof VIEWS)[number];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// Calendar days are handled as YYYY-MM-DD text and moved with UTC arithmetic, so no time zone can shift a date.
const at = (d: string) => new Date(`${d}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const plus = (d: string, n: number) => { const x = at(d); x.setUTCDate(x.getUTCDate() + n); return iso(x); };
const monday = (d: string) => plus(d, -((at(d).getUTCDay() + 6) % 7));
const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const moveMonth = (d: string, n: number) => { const x = at(monthStart(d)); x.setUTCMonth(x.getUTCMonth() + n); return iso(x); };
const real = (d: string | undefined) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(at(d).getTime()) && iso(at(d)) === d && d >= '2000-01-01' && d <= '2099-12-31';
const long = (d: string) => `${WEEKDAYS[(at(d).getUTCDay() + 6) % 7]}, ${at(d).getUTCDate()} ${MONTHS[at(d).getUTCMonth()]} ${at(d).getUTCFullYear()}`;
const short = (d: string) => `${at(d).getUTCDate()} ${MONTHS[at(d).getUTCMonth()]!.slice(0, 3)}`;

export default async function ProductionCalendarPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/production', label: '← Production' }];
  if (!can(actor, 'production.read')) return <><PageHead section="Supply" title="Production calendar" crumbs={crumbs} /><Forbidden permission="production.read" /></>;
  const sp = await searchParams;
  const today = calendarToday();
  const view: View = (VIEWS as readonly string[]).includes(one(sp.view) ?? '') ? one(sp.view) as View : 'month';
  const date = real(one(sp.date)) ? one(sp.date)! : today;
  const from = view === 'month' ? monday(monthStart(date)) : view === 'week' ? monday(date) : date;
  const to = view === 'month' ? plus(from, 41) : view === 'week' ? plus(from, 6) : date;
  const cal = await productionCalendar(db(), actor, { from, to });
  const manage = can(actor, 'production.manage'), seeOrders = can(actor, 'orders.read');
  const byDay = new Map<string, CalendarEvent[]>();
  for (const e of cal.events) byDay.set(e.date, [...(byDay.get(e.date) ?? []), e]);
  const days = Array.from({ length: view === 'month' ? 42 : view === 'week' ? 7 : 1 }, (_, i) => plus(from, i));
  const inPeriod = (d: string) => view !== 'month' || d.slice(0, 7) === date.slice(0, 7);
  const shownEvents = cal.events.filter(e => inPeriod(e.date));
  const overdue = shownEvents.filter(e => e.overdue).length;
  const href = (v: View, d: string) => { const p = new URLSearchParams(); if (v !== 'month') p.set('view', v); if (d !== today) p.set('date', d); return p.size ? `/production/calendar?${p}` : '/production/calendar'; };
  const step = (n: number) => (view === 'month' ? moveMonth(date, n) : plus(date, view === 'week' ? 7 * n : n));
  const title = view === 'month' ? `${MONTHS[at(date).getUTCMonth()]} ${at(date).getUTCFullYear()}` : view === 'week' ? `${short(from)} – ${short(to)} ${at(to).getUTCFullYear()}` : long(date);
  const target = (e: CalendarEvent) => (e.production ? `/production/${e.production.id}` : `/orders/${e.order!.id}`);
  const ref = (e: CalendarEvent) => e.production?.number ?? e.order?.number ?? '';
  const chip = (e: CalendarEvent) => (
    <Link key={e.key} href={target(e)} className={`cal-ev${e.done ? ' is-done' : ''}${e.overdue ? ' is-overdue' : ''}`} data-event={e.key} data-event-kind={e.kind} data-event-state={e.done ? 'done' : e.overdue ? 'overdue' : 'open'}
      title={`${e.label} · ${ref(e)}${e.production ? ` · ${e.production.product}, size ${e.production.size}` : ''}${e.done ? ' · done' : e.overdue ? ' · overdue' : ''}`}>
      <b>{e.label}</b><span className="mono">{ref(e)}</span>{e.overdue && <span className="cal-flag">Overdue</span>}{e.done && <span className="cal-flag">Done</span>}
    </Link>
  );

  return (
    <Workspace name="production-calendar" title="Production calendar" crumbs={crumbs}
      summary={`${title} · ${formatNumber(shownEvents.length)} entr${shownEvents.length === 1 ? 'y' : 'ies'}${overdue ? ` · ${formatNumber(overdue)} overdue` : ''}`}
      actions={manage ? (
        <Drawer trigger="Add milestone or task" name="new-milestone" scope="ord" title="Add a milestone or task"
          description="For one production order, or a task for a customer order. Nothing is added to any order automatically.">
          <ActionForm action={saveMilestoneAction} submitLabel="Add" id="create-milestone-form" label="Add a milestone or task" resetOnSuccess>
            <Field name="ref" label="Order number" required hint={seeOrders ? 'A production order (PR…) or a customer order number.' : 'A production order number (PR…).'} />
            <Select name="kind" label="What" options={[{ value: 'task', label: 'Task' }, { value: 'ready_for_trial', label: `${MILESTONE_LABEL.ready_for_trial} (production order only, one per order)` },
              { value: 'ex_factory', label: `${MILESTONE_LABEL.ex_factory} (production order only, one per order)` }]} />
            <Field name="title" label="Task (leave empty for a milestone)" hint="What has to be done." />
            <Field name="dueOn" label="Date" type="date" defaultValue={view === 'day' ? date : today} required />
            <Field name="note" label="Note (optional)" />
          </ActionForm>
        </Drawer>
      ) : undefined}>
      <div className="cal-bar">
        <div data-calendar-views>
          <ViewTabs label="Calendar view" current={view} items={VIEWS.map(v => ({ id: v, label: v === 'month' ? 'Month' : v === 'week' ? 'Week' : 'Day', href: href(v, date) }))} />
        </div>
        <nav className="cal-nav" aria-label="Period" data-calendar-nav>
          <FilterLink className="btn ghost sm" group="period" current={false} href={href(view, step(-1))} data-calendar-prev aria-label={`Previous ${view}`}>←</FilterLink>
          <FilterLink className="btn ghost sm" group="period" current={false} href={href(view, today)} data-calendar-today>Today</FilterLink>
          <FilterLink className="btn ghost sm" group="period" current={false} href={href(view, step(1))} data-calendar-next aria-label={`Next ${view}`}>→</FilterLink>
          <h2 className="cal-title" data-calendar-title>{title}</h2>
        </nav>
      </div>

      {view !== 'day' ? (
        <div className={`cal cal-${view}`} data-calendar={view} data-from={from} data-to={to} key={`${view}|${from}`}>
          {WEEKDAYS.map(w => <div key={w} className="cal-head" aria-hidden="true">{w.slice(0, 3)}</div>)}
          {days.map(d => {
            const events = byDay.get(d) ?? [], limit = view === 'month' ? 3 : events.length;
            return (
              <div key={d} className={`cal-day${inPeriod(d) ? '' : ' is-outside'}${d === today ? ' is-today' : ''}${events.length ? '' : ' is-empty'}`} data-day={d} data-day-count={events.length}>
                <Link className="cal-date" href={href('day', d)} aria-label={`${long(d)}: ${events.length} entr${events.length === 1 ? 'y' : 'ies'}`}>
                  <span className="cal-dow">{WEEKDAYS[(at(d).getUTCDay() + 6) % 7]!.slice(0, 3)} </span>{at(d).getUTCDate()}{(view === 'week' || at(d).getUTCDate() === 1) && <span className="cal-mon"> {MONTHS[at(d).getUTCMonth()]!.slice(0, 3)}</span>}
                </Link>
                {events.slice(0, limit).map(chip)}
                {events.length > limit && <Link className="cal-more" href={href('day', d)} data-more>+{events.length - limit} more</Link>}
              </div>
            );
          })}
        </div>
      ) : shownEvents.length === 0 ? (
        <StateBlock title="Nothing on this day" name="calendar-day">{manage ? 'No production order is due and no milestone or task is dated this day.' : 'No production order is due and nothing is scheduled this day.'}</StateBlock>
      ) : (
        <div className="table-wrap" data-calendar="day" data-from={from} data-to={to}><table data-calendar-day>
          <thead><tr><th>What</th><th>Order</th><th>Details</th><th>Status</th>{manage && <th>Change</th>}</tr></thead>
          <tbody>{shownEvents.map(e => (
            <tr key={e.key} data-event={e.key} data-event-kind={e.kind} data-event-state={e.done ? 'done' : e.overdue ? 'overdue' : 'open'}>
              <td><b>{e.label}</b>{e.kind !== 'due' && e.kind !== 'task' && <div className="note">Production milestone</div>}{e.kind === 'task' && <div className="note">Task</div>}</td>
              <td><Link href={target(e)} className="mono">{ref(e)}</Link><div className="note">{e.production ? 'Production order' : 'Customer order'}</div></td>
              <td>{e.production ? `${e.production.product} · size ${e.production.size} · ${e.production.qty} planned` : '—'}{e.note && <div className="note">{e.note}</div>}</td>
              <td>{e.done ? <span className="badge active as-written">Done</span> : e.overdue ? <span className="badge low_stock">Overdue</span> : <span className="badge as-written">Open</span>}</td>
              {manage && <td>{e.milestoneId ? (
                <div className="actions">
                  <ActionForm action={milestoneDoneAction} submitLabel={e.done ? 'Mark not done' : 'Mark done'} variant="ghost" className="inline-form" id={`ms-done-${e.milestoneId}`} label={`${e.done ? 'Reopen' : 'Complete'} ${e.label}`}>
                    <Hidden name="milestoneId" value={e.milestoneId} /><Hidden name="done" value={e.done ? 'no' : 'yes'} /><Hidden name="expectedDone" value={e.done ? 'yes' : 'no'} />
                  </ActionForm>
                  {!e.done && <ActionForm action={deleteMilestoneAction} submitLabel="Remove" variant="danger" className="inline-form" id={`ms-del-${e.milestoneId}`} label={`Remove ${e.label}`}
                    confirmText={`Remove "${e.label}" from ${ref(e)}? Use this only for an entry added by mistake.`}><Hidden name="milestoneId" value={e.milestoneId} /></ActionForm>}
                </div>
              ) : <span className="note">The due date is changed on the production order.</span>}</td>}
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <p className="note section-foot" data-calendar-definitions>Shown: the due date of each production order that is not cancelled, the milestones Ready for Trial and Ex-Factory (one of each per production order), and tasks.
        Milestones and tasks are added by staff; no order receives one automatically, and a customer order can carry tasks only. Overdue means the date has passed and it is not done.</p>
    </Workspace>
  );
}
