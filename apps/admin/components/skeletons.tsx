/* Loading placeholders for the Orders and Payments screens. They have the shape of the page that follows (the real
   title, tabs, toolbar and a table; or a header and two columns), so nothing jumps when the content arrives, and they
   pulse like every other placeholder in the admin.
   They sit in the same NavFrame the pages use. That is deliberate: the placeholder then needs the screen's small script
   as soon as it is shown, so the browser fetches it while the page data is still on its way, instead of only after the
   data has arrived (which made the first order or payment opened in a session wait for two server answers in a row). */
import { NavFrame } from './NavFrame';
import { PageHead } from './ui';

export function ListSkeleton({ title, tabs }: { title: string; tabs: number }) {
  return (
    <NavFrame className="ord sk-wide" role="status" aria-live="polite" data-loading>
      <span className="sr-only">Loading the latest data…</span>
      <PageHead section="Commerce" title={title} eyebrow=" " />
      <div aria-hidden="true">
        <div className="sk sk-tabs" style={{ width: tabs * 96 }} />
        <div className="sk sk-note" />
        <div className="sk-toolbar"><div className="sk" /><div className="sk" /><div className="sk" /></div>
        <div className="sk sk-chips" />
        <div className="sk-card">
          {Array.from({ length: 8 }, (_, i) => <div className="sk-trow sk-trow-tall" key={i}><div className="sk sk-text" /><div className="sk sk-short" /><div className="sk sk-short" /><div className="sk sk-short" /></div>)}
        </div>
      </div>
    </NavFrame>
  );
}

export function DetailSkeleton({ back }: { back: string }) {
  return (
    <NavFrame className="ord ord-detail sk-wide" role="status" aria-live="polite" data-loading>
      <span className="sr-only">Loading the latest data…</span>
      <header className="page-head" aria-hidden="true">
        <div className="page-title"><p className="crumbs">{back}</p><div className="sk sk-title" /><div className="sk sk-line" /></div>
      </header>
      <div className="ord-cols" aria-hidden="true">
        <div className="ord-main"><div className="card sk-panel" /><div className="card sk-panel sk-panel-tall" /></div>
        <div className="ord-side"><div className="card sk-panel" /><div className="card sk-panel" /></div>
      </div>
    </NavFrame>
  );
}
