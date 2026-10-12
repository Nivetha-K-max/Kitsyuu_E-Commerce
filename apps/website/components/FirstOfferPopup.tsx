'use client';
/* The welcome popup for the first-order offer (2026-10-12).

   What it shows is the business's own coupon (Pricing → Discounts, named in Configuration → Discounts), read from the
   server (/api/offer) when the visitor has scrolled into the store: no amount, minimum, cap or date is written here.
   Showing it promises nothing and issues nothing. Whether a customer may use the offer is decided on the server from
   their orders: the popup is not shown to a signed-in customer who is not eligible, and the coupon is checked again at the
   cart and when the order is placed.
   A visitor who is not signed in sees it too (2026-10-12: with its own welcome wording). For them it is an invitation,
   not a promise: nobody can tell whether a guest has ordered before, so nothing is granted, held or redeemed by showing
   it. They are asked to create an account or sign in, and the same server checks then decide.

   It interrupts once: closing it is remembered for this browser session (sessionStorage), which is only a courtesy, never
   a check. It never opens on checkout, payment, sign-in or account pages. It is a modal dialog: focus moves into it and
   stays there, Escape and the close button dismiss it, focus returns where it was, and it does not animate for visitors
   who ask for reduced motion (store.css). */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { claimFirstOfferAction } from '@/app/offer-actions';

type Offer = { code: string; kind: 'percent' | 'fixed'; value: number; minOrderPaise: number | null; maxDiscountPaise: number | null; endsAt: string | null };
const DISMISSED = 'kitsyuu.first-offer.dismissed';
/** Pages where a visitor is paying, signing in or managing their account: never interrupted. */
const QUIET = ['/checkout', '/account', '/login', '/signup', '/forgot-password', '/reset-password', '/verify-email', '/auth', '/confirmation'];
const rupees = (paise: number) => '₹' + (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const seen = () => { try { return sessionStorage.getItem(DISMISSED) === '1'; } catch { return false; } };
const remember = () => { try { sessionStorage.setItem(DISMISSED, '1'); } catch { /* storage unavailable: it may show again, nothing else depends on it */ } };

export default function FirstOfferPopup() {
  const path = usePathname() ?? '/';
  const quiet = QUIET.some(p => path === p || path.startsWith(p + '/'));
  const [offer, setOffer] = useState<Offer | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, start] = useTransition();
  const asked = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLElement | null>(null);

  // Scroll trigger: once the visitor has scrolled into the store (past the landing film on the home page), ask the server once.
  useEffect(() => {
    if (quiet || asked.current || seen()) return;
    const far = () => {
      const store = path === '/' ? document.getElementById('store') : null;
      return store ? store.getBoundingClientRect().top <= innerHeight * 0.5 : scrollY > Math.max(320, innerHeight * 0.4);
    };
    const check = () => {
      if (asked.current || !far()) return;
      asked.current = true;
      removeEventListener('scroll', check);
      fetch('/api/offer', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).then((d: { signedIn?: boolean; offer?: Offer | null } | null) => {
        if (!d?.offer || seen()) return;
        setSignedIn(!!d.signedIn); setOffer(d.offer); setOpen(true);
      }).catch(() => { /* no offer is shown when the server cannot be asked */ });
    };
    addEventListener('scroll', check, { passive: true });
    return () => removeEventListener('scroll', check);
  }, [path, quiet]);

  const close = useCallback(() => { remember(); setOpen(false); back.current?.focus?.(); }, []);

  // Modal behaviour while open: focus goes in and stays in; Escape closes.
  useEffect(() => {
    if (!open) return;
    back.current = document.activeElement as HTMLElement | null;
    const el = box.current;
    el?.querySelector<HTMLElement>('[data-offer-primary]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key !== 'Tab' || !el) return;
      const f = [...el.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
      if (!f.length) return;
      const first = f[0]!, last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!el.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  // Moving to a quiet page (checkout, sign-in) closes it without counting as a dismissal.
  useEffect(() => { if (quiet) setOpen(false); }, [quiet]);

  if (!open || !offer || quiet) return null;
  const amount = offer.kind === 'percent' ? `${(offer.value / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}% off` : `${rupees(offer.value)} off`;
  const until = offer.endsAt ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'Asia/Kolkata' }).format(new Date(offer.endsAt)) : null;
  const claim = () => start(async () => { setResult(await claimFirstOfferAction()); });

  return (
    <div className="st-offer-layer" data-first-offer>
      <div className="st-offer-backdrop" onClick={close} aria-hidden="true" />
      <div className="st-offer" role="dialog" aria-modal="true" aria-labelledby="st-offer-title" aria-describedby="st-offer-terms" ref={box} data-offer-dialog>
        <button type="button" className="st-offer-close" onClick={close} aria-label="Close this offer" data-offer-close><span aria-hidden="true">×</span></button>
        <p className="eyebrow" data-offer-eyebrow>{signedIn ? 'Welcome to KITSYUU' : 'First time here? Enjoy a special welcome offer!'}</p>
        <h2 id="st-offer-title" data-offer-title>{amount} your first order</h2>
        <ul className="st-offer-terms" id="st-offer-terms" data-offer-terms>
          {offer.minOrderPaise ? <li>On orders of {rupees(offer.minOrderPaise)} or more.</li> : null}
          {offer.kind === 'percent' && offer.maxDiscountPaise ? <li>Up to {rupees(offer.maxDiscountPaise)} off.</li> : null}
          {until ? <li>Until {until}.</li> : null}
          <li>For customers who have not ordered from KITSYUU before. Checked when you place your order.</li>
          {!signedIn && <li data-offer-guest-terms>Create an account or sign in to use it. Whether it applies to you is checked then, from your orders.</li>}
        </ul>
        <p className="st-offer-code">Coupon code <b data-offer-code>{offer.code}</b></p>
        {result && <p className={result.ok ? 'st-form-ok' : 'st-form-alert'} role="status" data-offer-result={result.ok ? 'ok' : 'refused'}>{result.message}</p>}
        <div className="st-offer-actions">
          {signedIn ? (
            result?.ok
              ? <Link className="button" href="/shop" onClick={close} data-offer-primary>Continue shopping</Link>
              : <button type="button" className="button" onClick={claim} disabled={pending} data-offer-primary data-offer-claim>{pending ? 'Adding…' : 'Use it on my order'}</button>
          ) : (
            <>
              <Link className="button" href="/signup" onClick={close} data-offer-primary data-offer-signup>Create account</Link>
              <Link className="text-link" href="/login" onClick={close} data-offer-login>Sign in</Link>
            </>
          )}
          <button type="button" className="text-link" onClick={close} data-offer-dismiss>{signedIn ? 'No thanks' : 'Continue shopping'}</button>
        </div>
      </div>
    </div>
  );
}
