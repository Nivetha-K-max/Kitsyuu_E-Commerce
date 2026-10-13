'use client';
/* The store's help window (2026-10-12): a "Help" button that opens a small window with three parts.
     · Help topics: fixed questions and answers from the server (/api/help). Typing a question matches it to those topics
       by keywords (askHelpAction). These are automated answers, said so in the window; it is not a chat with a person
       and nothing is generated.
     · Check an order: order number + the email or phone the order was placed with. Shows status and shipping only.
     · Send a message: a support ticket; our team replies by email.
   It asks the server for nothing until it is opened. It is a dialog that does not trap the page: Escape and the close
   button dismiss it and focus returns to the Help button. Not shown on checkout (nothing may sit over paying), and on
   the home page only once the visitor has scrolled past the landing film into the store.
   2026-10-12: a small robot mascot stands above the Help button with a "Need help?" bubble. It is a second way to the
   SAME window: the robot and the Help button call the same handler and share the one `open` state; there is no second
   panel and nothing is sent or opened by itself. The mascot is an inline drawing (no image file, no library). The bubble
   is shown until the window has been opened once in this visit. While the window is open neither is in the page, so they
   cannot cover it. On the cart page only the Help button is shown, so nothing sits over the checkout button. */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState, useTransition, type FormEvent } from 'react';
import { askHelpAction, orderStatusAction, sendHelpMessageAction } from '@/app/help-actions';

type Topic = { id: string; question: string; answer: string };
type Data = { signedIn: boolean; /** order lookup and guest messages are open on this server */ guest: boolean; topics: Topic[]; categories: { code: string; label: string }[] };
type Order = { orderNumber: string; statusLabel: string; placedOn: string; shipment: { courier: string | null; trackingNumber: string | null; trackingUrl: string | null; shippedOn: string | null; deliveredOn: string | null } | null };
type Tab = 'topics' | 'order' | 'message';
const QUIET = ['/checkout'];
/** Pages where the mascot would sit over an essential action: the Help button alone is shown there. */
const NO_MASCOT = ['/cart'];
const BUBBLE_SEEN = 'kitsyuu.help.bubble-seen';
const bubbleSeen = () => { try { return sessionStorage.getItem(BUBBLE_SEEN) === '1'; } catch { return false; } };
const TABS: [Tab, string][] = [['topics', 'Help topics'], ['order', 'Check an order'], ['message', 'Send a message']];
/** A small robot face: the help window gives automated answers, and the picture makes the button easy to find.
    Decorative (the button and the heading carry the word "Help"). */
const BotIcon = ({ size = 20 }: { size?: number }) => (
  <svg className="st-help-bot" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" data-help-bot>
    <path d="M12 8V4H8" /><rect width="16" height="12" x="4" y="8" rx="2" /><path d="M2 14h2" /><path d="M20 14h2" /><path d="M15 13v2" /><path d="M9 13v2" />
  </svg>
);
/** The mascot: white head and body, electric-blue eyes and details, one arm raised to wave. Decorative: the button around
    it carries the name. Its parts have classes so the styles can float it gently, blink and wave (and stop all of that
    for visitors who ask for reduced motion). */
const Mascot = () => (
  <svg className="st-help-mascot" viewBox="0 0 96 104" aria-hidden="true" focusable="false">
    <ellipse className="st-help-mascot-shadow" cx="48" cy="98" rx="24" ry="4" />
    <g className="st-help-mascot-body">
      <line x1="48" y1="14" x2="48" y2="6" stroke="#0b1b3a" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="48" cy="5" r="4" fill="#1f6bff" />
      <g className="st-help-mascot-arm">
        <path d="M72 66 C82 60 86 50 84 40" fill="none" stroke="#0b1b3a" strokeWidth="9" strokeLinecap="round" />
        <path d="M72 66 C82 60 86 50 84 40" fill="none" stroke="#ffffff" strokeWidth="6" strokeLinecap="round" />
        <circle cx="84" cy="38" r="6.5" fill="#ffffff" stroke="#0b1b3a" strokeWidth="1.5" />
      </g>
      <path d="M24 66 C16 70 14 78 16 84" fill="none" stroke="#0b1b3a" strokeWidth="9" strokeLinecap="round" />
      <path d="M24 66 C16 70 14 78 16 84" fill="none" stroke="#ffffff" strokeWidth="6" strokeLinecap="round" />
      <rect x="26" y="56" width="44" height="36" rx="14" fill="#ffffff" stroke="#0b1b3a" strokeWidth="1.5" />
      <rect x="38" y="66" width="20" height="12" rx="6" fill="#eaf1ff" stroke="#1f6bff" strokeWidth="1.5" />
      <circle cx="44" cy="72" r="2" fill="#1f6bff" /><circle cx="52" cy="72" r="2" fill="#1f6bff" />
      <rect x="10" y="26" width="6" height="16" rx="3" fill="#1f6bff" /><rect x="80" y="26" width="6" height="16" rx="3" fill="#1f6bff" />
      <rect x="16" y="14" width="64" height="44" rx="20" fill="#ffffff" stroke="#0b1b3a" strokeWidth="1.5" />
      <rect x="24" y="22" width="48" height="26" rx="13" fill="#0b1b3a" />
      <g className="st-help-mascot-eyes"><ellipse cx="38" cy="34" rx="5" ry="6" fill="#3d8bff" /><ellipse cx="58" cy="34" rx="5" ry="6" fill="#3d8bff" />
        <circle cx="39.5" cy="32" r="1.6" fill="#ffffff" /><circle cx="59.5" cy="32" r="1.6" fill="#ffffff" /></g>
      <path d="M42 42 Q48 46 54 42" fill="none" stroke="#3d8bff" strokeWidth="2" strokeLinecap="round" />
    </g>
  </svg>
);
const day = (d: string | null) => (d ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`)) : null);

export default function HelpWidget() {
  const path = usePathname() ?? '/';
  const quiet = QUIET.some(p => path === p || path.startsWith(p + '/'));
  const uid = useId();
  const [inStore, setInStore] = useState(path !== '/');
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('topics');
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);
  const [asked, setAsked] = useState<{ question: string; topics: Topic[]; message?: string } | null>(null);
  const [order, setOrder] = useState<{ ok: boolean; message?: string; order?: Order } | null>(null);
  const [sent, setSent] = useState<{ ok: boolean; message: string } | null>(null);
  const [bubble, setBubble] = useState(false);
  const [pending, start] = useTransition();
  const panel = useRef<HTMLDivElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);

  // On the home page the button appears once the visitor has scrolled into the store (the landing film plays untouched).
  useEffect(() => {
    if (path !== '/') { setInStore(true); return; }
    const check = () => { const s = document.getElementById('store'); setInStore(s ? s.getBoundingClientRect().top <= innerHeight * 0.5 : scrollY > innerHeight * 0.4); };
    check();
    addEventListener('scroll', check, { passive: true });
    return () => removeEventListener('scroll', check);
  }, [path]);

  // The Help button is not in the page while the window is open: focus goes back to it once it has been drawn again.
  const close = useCallback(() => { setOpen(false); setTimeout(() => launcher.current?.focus(), 0); }, []);
  // The bubble is offered once per visit: it goes when the window is first opened and does not come back.
  useEffect(() => { setBubble(!bubbleSeen()); }, []);
  /* What the window shows comes from one request. If it fails (the connection dropped, the server was restarting) the
     window says so and offers to try again; it also tries again by itself each time it is opened. Until it has loaded,
     no form is offered, because a form without its topics could not be sent. */
  const loading = useRef(false);
  const load = () => {
    if (loading.current) return;
    loading.current = true; setFailed(false);
    fetch('/api/help', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null))
      .then((d: Data | null) => { if (d && d.topics.length) setData(d); else setFailed(true); })
      .catch(() => setFailed(true)).finally(() => { loading.current = false; });
  };
  const show = () => {
    setOpen(true);
    setBubble(false); try { sessionStorage.setItem(BUBBLE_SEEN, '1'); } catch { /* storage unavailable: the bubble may show again, nothing else depends on it */ }
    if (!data) load();
  };
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>('[data-help-close]')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);
  useEffect(() => { if (quiet) setOpen(false); }, [quiet]);

  if (quiet || (!inStore && !open)) return null;

  const ask = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const question = String(new FormData(e.currentTarget).get('q') ?? '').trim();
    if (!question) { setAsked(null); return; }
    start(async () => { const r = await askHelpAction(question); setAsked({ question, topics: r.topics, message: r.ok ? undefined : r.message }); });
  };
  const lookup = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = new FormData(e.currentTarget); start(async () => { setOrder(await orderStatusAction(f)); }); };
  const send = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget, f = new FormData(form);
    start(async () => { const r = await sendHelpMessageAction(f); setSent(r); if (r.ok) form.reset(); });
  };
  const list = asked ? asked.topics : data?.topics ?? [];

  return (
    <div className="st-help" data-help>
      {!open && (
        <div className="st-help-trigger" data-help-trigger>
          {!NO_MASCOT.some(p => path === p || path.startsWith(p + '/')) && (
            <button type="button" className="st-help-robot" onClick={show} aria-label="Open customer support" aria-haspopup="dialog" data-help-robot>
              {bubble && <span className="st-help-bubble" aria-hidden="true" data-help-bubble>Need help?</span>}
              <Mascot />
            </button>
          )}
          <button type="button" className="st-help-launch" onClick={show} ref={launcher} aria-haspopup="dialog" data-help-open><BotIcon /><span>Help</span></button>
        </div>
      )}
      {open && (
        <div className="st-help-panel" role="dialog" aria-labelledby={`${uid}-t`} aria-describedby={`${uid}-d`} ref={panel} data-help-panel>
          <header className="st-help-head">
            <h2 id={`${uid}-t`}><BotIcon size={22} /><span>Help</span></h2>
            <button type="button" className="st-help-close" onClick={close} aria-label="Close help" data-help-close><span aria-hidden="true">×</span></button>
            <p id={`${uid}-d`} data-help-notice>Automated answers from our help topics. This is not a live chat; to reach our team, send a message and we reply by email.</p>
          </header>
          <div className="st-help-tabs" role="tablist" aria-label="Help">
            {TABS.map(([id, label]) => (
              <button key={id} type="button" role="tab" id={`${uid}-tab-${id}`} aria-selected={tab === id} aria-controls={`${uid}-p-${id}`} tabIndex={tab === id ? 0 : -1}
                className={tab === id ? 'is-on' : undefined} onClick={() => setTab(id)} data-help-tab={id}>{label}</button>
            ))}
          </div>

          <div className="st-help-body" role="tabpanel" id={`${uid}-p-${tab}`} aria-labelledby={`${uid}-tab-${tab}`} data-help-view={tab}>
            {!data && failed && (
              <div className="st-form-alert" role="status" data-help-unavailable>
                <p>Help could not be loaded just now. Check your connection and try again.</p>
                <button type="button" className="button" onClick={load} data-help-retry>Try again</button>
              </div>
            )}
            {!data && !failed && tab !== 'topics' && <p className="st-help-note" aria-live="polite">Loading…</p>}
            {tab === 'topics' && (failed && !data ? null : !data ? <p className="st-help-note" aria-live="polite">Loading…</p> : <>
              <form className="st-help-ask" onSubmit={ask} data-help-ask>
                <label htmlFor={`${uid}-q`}>What do you need help with?</label>
                <div className="st-help-row"><input id={`${uid}-q`} name="q" type="search" maxLength={300} placeholder="e.g. where is my order" autoComplete="off" /><button type="submit" className="button" disabled={pending}>Search</button></div>
              </form>
              <div aria-live="polite">
                {asked?.message && <p className="st-form-alert" role="status">{asked.message}</p>}
                {asked && !asked.message && (asked.topics.length
                  ? <p className="st-help-note" data-help-matched>{asked.topics.length} help topic{asked.topics.length === 1 ? '' : 's'} for “{asked.question}”. <button type="button" className="text-link" onClick={() => setAsked(null)} data-help-all>Show all topics</button></p>
                  : <p className="st-help-note" data-help-nomatch>No help topic matches “{asked.question}”. <button type="button" className="text-link" onClick={() => setTab('message')}>Send us a message</button> or <button type="button" className="text-link" onClick={() => setAsked(null)} data-help-all>see all topics</button>.</p>)}
              </div>
              <ul className="st-help-topics" data-help-topics>
                {list.map(t => (
                  <li key={t.id} data-help-topic={t.id}><details open={!!asked}>
                    <summary>{t.question}</summary>
                    <p>{t.answer}</p>
                    {t.id === 'order-status' && <p><button type="button" className="text-link" onClick={() => setTab('order')} data-help-go="order">Check an order</button></p>}
                    {(t.id === 'contact' || t.id === 'change-order') && <p><button type="button" className="text-link" onClick={() => setTab('message')} data-help-go="message">Send a message</button></p>}
                  </details></li>
                ))}
              </ul>
            </>)}

            {tab === 'order' && data && !data.guest && (
              <p className="st-help-note" data-help-order-closed>Checking an order here is not available right now. {data.signedIn
                ? <>Your orders and their tracking are under <Link href="/account/orders" onClick={close}>My account → Orders</Link>.</>
                : <><Link href="/login" onClick={close}>Sign in</Link> to see your orders and their tracking under My account.</>}</p>
            )}
            {tab === 'order' && data && data.guest && <>
              <form className="st-help-form" onSubmit={lookup} data-help-order-form>
                <label htmlFor={`${uid}-on`}>Order number</label>
                <input id={`${uid}-on`} name="orderNumber" required maxLength={40} autoComplete="off" autoCapitalize="characters" />
                <label htmlFor={`${uid}-oc`}>Email or phone number used for the order</label>
                <input id={`${uid}-oc`} name="contact" required maxLength={254} autoComplete="email" />
                <button type="submit" className="button" disabled={pending}>{pending ? 'Checking…' : 'Check status'}</button>
              </form>
              <div aria-live="polite">
                {order && !order.ok && <p className="st-form-alert" role="status" data-help-order-result="refused">{order.message}</p>}
                {order?.ok && order.order && (
                  <dl className="st-help-order" data-help-order-result="found">
                    <div><dt>Order</dt><dd data-help-order-number>{order.order.orderNumber}</dd></div>
                    <div><dt>Status</dt><dd data-help-order-status>{order.order.statusLabel}</dd></div>
                    <div><dt>Placed</dt><dd>{day(order.order.placedOn)}</dd></div>
                    {order.order.shipment && <>
                      {order.order.shipment.courier && <div><dt>Courier</dt><dd>{order.order.shipment.courier}</dd></div>}
                      {order.order.shipment.trackingNumber && <div><dt>Tracking</dt><dd data-help-order-tracking>{order.order.shipment.trackingUrl
                        ? <a href={order.order.shipment.trackingUrl} target="_blank" rel="noopener noreferrer">{order.order.shipment.trackingNumber}</a> : order.order.shipment.trackingNumber}</dd></div>}
                      {order.order.shipment.shippedOn && <div><dt>Shipped</dt><dd>{day(order.order.shipment.shippedOn)}</dd></div>}
                      {order.order.shipment.deliveredOn && <div><dt>Delivered</dt><dd>{day(order.order.shipment.deliveredOn)}</dd></div>}
                    </>}
                  </dl>
                )}
              </div>
              <p className="st-help-note">Have an account? <Link href="/account/orders" onClick={close}>See all your orders</Link>.</p>
            </>}

            {tab === 'message' && data && !data.guest && !data.signedIn && !sent?.ok && (
              <p className="st-help-note" data-help-message-closed><Link href="/login" onClick={close}>Sign in</Link> or <Link href="/signup" onClick={close}>create an account</Link> to send us a message. We reply by email.</p>
            )}
            {tab === 'message' && data && !(!data.guest && !data.signedIn && !sent?.ok) && (sent?.ok ? (
              <div aria-live="polite"><p className="st-form-ok" role="status" data-help-sent>{sent.message}</p>
                <button type="button" className="text-link" onClick={() => setSent(null)}>Send another message</button></div>
            ) : (
              <form className="st-help-form" onSubmit={send} data-help-message-form>
                {sent && !sent.ok && <p className="st-form-alert" role="alert" data-help-message-error>{sent.message}</p>}
                {data && !data.signedIn && <>
                  <label htmlFor={`${uid}-n`}>Your name</label><input id={`${uid}-n`} name="name" required maxLength={120} autoComplete="name" />
                  <label htmlFor={`${uid}-e`}>Email (we reply here)</label><input id={`${uid}-e`} name="email" type="email" required maxLength={254} autoComplete="email" />
                </>}
                <label htmlFor={`${uid}-c`}>Topic</label>
                <select id={`${uid}-c`} name="categoryCode" required defaultValue="">
                  <option value="" disabled>Choose a topic</option>
                  {(data?.categories ?? []).map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
                </select>
                <label htmlFor={`${uid}-s`}>Subject</label><input id={`${uid}-s`} name="subject" required maxLength={160} />
                <label htmlFor={`${uid}-o`}>Order number (optional)</label><input id={`${uid}-o`} name="orderNumber" maxLength={40} autoComplete="off" />
                <label htmlFor={`${uid}-b`}>Message</label><textarea id={`${uid}-b`} name="body" required maxLength={3800} rows={5} />
                <div className="st-help-hp" aria-hidden="true"><label htmlFor={`${uid}-w`}>Website</label><input id={`${uid}-w`} name="website" tabIndex={-1} autoComplete="off" /></div>
                <button type="submit" className="button" disabled={pending || !data}>{pending ? 'Sending…' : 'Send message'}</button>
              </form>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
