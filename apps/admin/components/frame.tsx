/* The two frames every ERP module is built on (2026-10-07):

     SIDEBAR MODULE → MODULE WORKSPACE → INTERNAL VIEWS → ENTITY DETAIL → ENTITY TABS

   · Workspace: the module's title, ONE row of view buttons, then the toolbar and table of the selected view.
   · Entity: a back link to the module, the record's identity (name, status, a few key facts, its main action), ONE row
     of tabs, and only the selected tab's content. The tabs live in the URL (?tab=…) so they can be linked, refreshed and
     reached with the browser's back button, but they are one page: the header never changes between them.
   · Inside a tab: Sections. A section is a heading (with an optional line of explanation) and its content, separated from
     the next by a rule. It is not a card: only tables and forms inside it get a surface.

   Views and tabs respond at once and keep the page in place while the server answers (NavFrame). */
import type { ReactNode } from 'react';
import { Icon } from './icons';
import { FilterLink, NavFrame, NavLink } from './NavFrame';
import { PageHead } from './ui';

export interface ViewItem { id: string; label: string; href: string; count?: number }

/** The row of view buttons of a module workspace. */
export function ViewTabs({ label, items, current }: { label: string; items: ViewItem[]; current: string }) {
  return (
    <nav className="tabs ord-views" aria-label={label} data-views>
      {items.map(v => (
        <FilterLink key={v.id} className="btn ghost sm" group="view" current={v.id === current} currentValue="page" href={v.href} data-view={v.id}>
          {v.label}{v.count ? <span className="ord-count">{v.count}</span> : null}
        </FilterLink>
      ))}
    </nav>
  );
}

/** A module workspace: its title and main actions, ONE row of views, then the selected view (toolbar + table).
    Views given here change the address's query (`?view=…`); modules whose views are separate pages use
    components/ModuleViews for the same row. */
export function Workspace({ name, title, summary, actions, views, current, viewsLabel, crumbs, children }: {
  /** data-workspace value (e.g. "orders"). */
  name: string; title: string;
  /** One line under the title: what is listed and how many. */
  summary?: string;
  actions?: ReactNode;
  views?: ViewItem[]; current?: string; viewsLabel?: string;
  /** For a sub-page of a module (a report, a history): the way back, shown above the title. */
  crumbs?: { href: string; label: string }[];
  children: ReactNode;
}) {
  return (
    <NavFrame className="ord ws" data-workspace={name}>
      <PageHead title={title} eyebrow={summary} crumbs={crumbs}>{actions}</PageHead>
      {views && views.length > 1 && <ViewTabs label={viewsLabel ?? `${title} views`} items={views} current={current ?? views[0]!.id} />}
      {children}
    </NavFrame>
  );
}

/** A state shown in place of content: nothing here yet, could not load, or not permitted. One shape for all three,
    saying what is the case and what the person can do about it. */
export function StateBlock({ kind = 'empty', title, children, action, name }: {
  kind?: 'empty' | 'error' | 'denied'; title: string; children?: ReactNode; action?: ReactNode; name?: string;
}) {
  return (
    <div className={`state state-${kind}`} role={kind === 'error' ? 'alert' : 'status'} data-state={kind} data-empty={kind === 'empty' ? name : undefined}>
      <span className="state-icon" aria-hidden="true"><Icon name={kind === 'empty' ? 'inbox' : kind === 'error' ? 'alert' : 'roles'} size={20} /></span>
      <p className="state-title">{title}</p>
      {children && <p className="state-text">{children}</p>}
      {action && <div className="state-action">{action}</div>}
    </div>
  );
}

export interface EntityTab { id: string; label: string; count?: number }

/** An entity page: identity header, tab row, and the selected tab's content on one surface. */
export function Entity({ module: mod, name, title, media, status, facts, factsAttr, actions, tabs, current, tabHref, notice, children }: {
  /** The module this record belongs to (the back link). */
  module: { href: string; label: string };
  /** data-entity value (e.g. "product"). */
  name: string;
  title: string; media?: ReactNode; status?: ReactNode;
  /** A few key facts shown under the title, in reading order. */
  facts?: { label: string; value: ReactNode; attr?: string }[];
  /** Extra data-* hook on the facts list (e.g. "data-product-facts"). */
  factsAttr?: string;
  actions?: ReactNode;
  tabs: EntityTab[]; current: string; tabHref: (id: string) => string;
  notice?: ReactNode; children: ReactNode;
}) {
  return (
    <NavFrame className="ord ent" data-entity={name} data-tab={current}>
      <header className="page-head ent-head">
        <div className="page-title">
          <p className="crumbs"><NavLink href={mod.href} data-back>← {mod.label}</NavLink></p>
          <div className="ent-id">
            {media && <span className="ent-media">{media}</span>}
            <div className="ent-name">
              <h1>{title}{status && <span className="ent-status">{status}</span>}</h1>
              {facts && facts.length > 0 && (
                <dl className="ent-facts" data-entity-facts {...(factsAttr ? { [factsAttr]: '' } : {})}>
                  {facts.map(f => <div key={f.label}><dt>{f.label}</dt><dd {...(f.attr ? { 'data-fact': f.attr } : {})}>{f.value}</dd></div>)}
                </dl>
              )}
            </div>
          </div>
        </div>
        {actions && <div className="actions">{actions}</div>}
      </header>
      {notice}
      <div className="ent-body">
        <nav className="ent-tabs" aria-label={`${title}: sections`} data-entity-tabs>
          {tabs.map(t => (
            <FilterLink key={t.id} className="ent-tab" group="tab" current={t.id === current} currentValue="page" href={tabHref(t.id)} data-entity-tab={t.id}>
              {t.label}{t.count ? <span className="ord-count">{t.count}</span> : null}
            </FilterLink>
          ))}
        </nav>
        <div className="ent-panel" data-fresh key={current} data-tab-panel={current}>{children}</div>
      </div>
    </NavFrame>
  );
}

/** A group of related information inside a tab. `wide` puts the heading above the content (tables); otherwise the
    heading and its explanation sit beside it (forms and facts). */
export function Section({ id, title, hint, meta, wide, name, children }: {
  id: string; title: string; hint?: ReactNode; meta?: ReactNode; wide?: boolean; name?: string; children: ReactNode;
}) {
  return (
    <section className={`ent-section${wide ? ' wide' : ''}`} aria-labelledby={id} data-section={name ?? id}>
      <div className="ent-section-head">
        <h2 id={id}>{title}</h2>
        {meta && <span className="ent-section-meta">{meta}</span>}
        {hint && <p className="note">{hint}</p>}
      </div>
      <div className="ent-section-body">{children}</div>
    </section>
  );
}

/** Label / value pairs inside a section (no box around them). */
export function Facts({ items, attr }: { items: { label: string; value: ReactNode; attr?: string }[]; attr?: string }) {
  return (
    <dl className="ent-dl" {...(attr ? { [attr]: '' } : {})}>
      {items.map(f => <div key={f.label}><dt>{f.label}</dt><dd {...(f.attr ? { 'data-fact': f.attr } : {})}>{f.value}</dd></div>)}
    </dl>
  );
}

/** Headline numbers of a tab (sales, reviews): plain figures in a row, not boxes. */
export function Figures({ items }: { items: { label: string; value: ReactNode; note?: ReactNode }[] }) {
  return (
    <dl className="ent-figures" data-figures>
      {items.map(f => <div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd>{f.note && <small>{f.note}</small>}</div>)}
    </dl>
  );
}
