'use client';
/* The payment step of checkout. The configured provider's browser widget is chosen from WIDGETS by provider code; every
   widget reports back through a server action, where the provider verifies the result. Nothing here decides that an
   order is paid: the page moves on only when the server says so. */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { submitPaymentResultAction, testPaymentAction, type PaymentReply } from '@/app/checkout/actions';

export type PaymentStartProps = { orderNumber: string; provider: string; label: string; amountLabel: string; client: Record<string, unknown> };
type WidgetProps = PaymentStartProps & { busy: boolean; report: (work: () => Promise<PaymentReply>) => Promise<void>; setNote: (m: string) => void };

const NETWORK = 'We could not reach KITSYUU to confirm the payment. If money was taken, your order updates by itself — check the order before paying again.';

/** Development provider: clearly labelled, no money moves; the server simulates the provider's signed answer. */
function TestWidget({ orderNumber, amountLabel, busy, report }: WidgetProps) {
  return (
    <div className="st-pay-test" data-payment-widget="test">
      <p><b>Test payment.</b> No money is taken. This appears only while a real payment provider is not connected.</p>
      <button className="button st-place" type="button" disabled={busy} data-test-pay="success" onClick={() => report(() => testPaymentAction({ orderNumber }, 'success'))}>
        {busy ? 'Confirming…' : `Pay ${amountLabel} (test)`}
      </button>
      <button className="button button-outline" type="button" disabled={busy} data-test-pay="failure" onClick={() => report(() => testPaymentAction({ orderNumber }, 'failure'))}>
        Simulate a declined payment
      </button>
    </div>
  );
}

type RazorpayCtor = new (o: Record<string, unknown>) => { open(): void; on(ev: string, cb: (r: { error?: { metadata?: Record<string, string> } }) => void): void };
/** Razorpay Checkout (used once PAYMENT_PROVIDER=razorpay is configured). */
function RazorpayWidget({ orderNumber, amountLabel, client, busy, report, setNote }: WidgetProps) {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const src = String(client.scriptUrl);
    if (document.querySelector(`script[src="${CSS.escape(src)}"]`)) { setLoaded(true); return; }
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => setLoaded(true);
    s.onerror = () => setNote('The payment window could not be loaded. Check your connection and reload this page.');
    document.head.appendChild(s);
  }, [client.scriptUrl, setNote]);
  const open = () => {
    const Razorpay = (window as unknown as { Razorpay?: RazorpayCtor }).Razorpay;
    if (!Razorpay) { setNote('The payment window could not be loaded. Reload this page and try again.'); return; }
    const rzp = new Razorpay({
      key: client.keyId, order_id: client.razorpayOrderId, amount: client.amountPaise, currency: client.currency, name: 'KITSYUU',
      description: `Order ${orderNumber}`, prefill: client.prefill,
      handler: (r: Record<string, string>) => report(() => submitPaymentResultAction({ orderNumber, result: r })),
      modal: { ondismiss: () => setNote('The payment window was closed. Your order is saved; you can pay now or later from your orders.') },
    });
    rzp.on('payment.failed', r => {
      const m = r.error?.metadata ?? {};
      void report(() => submitPaymentResultAction({ orderNumber, result: { razorpay_payment_id: m.payment_id ?? '', razorpay_order_id: m.order_id ?? '' } }));
    });
    rzp.open();
  };
  return (
    <div data-payment-widget="razorpay">
      <button className="button st-place" type="button" disabled={!loaded || busy} data-pay-open onClick={open}>{busy ? 'Confirming…' : `Pay ${amountLabel}`}</button>
    </div>
  );
}

const WIDGETS: Record<string, (p: WidgetProps) => React.ReactNode> = { test: TestWidget, razorpay: RazorpayWidget };

export default function PaymentStep(props: PaymentStartProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false), [note, setNote] = useState(''), [failed, setFailed] = useState(false);
  const noteRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (note) noteRef.current?.focus(); }, [note]);
  async function report(work: () => Promise<PaymentReply>) {
    setBusy(true); setNote('');
    let reply: PaymentReply;
    try { reply = await work(); } catch { reply = { ok: false, message: NETWORK }; }
    if (reply.ok) { router.replace(`/checkout/complete/${encodeURIComponent(props.orderNumber)}`); return; }
    setBusy(false);
    setFailed(reply.outcome === 'failed');
    setNote(reply.outcome === 'failed' ? 'The payment did not go through, so nothing was charged. You can try again.'
      : reply.message ?? 'The payment could not be confirmed. Check your order before trying again.');
  }
  const Widget = WIDGETS[props.provider];
  return (
    <section className="st-form-group st-pay" aria-labelledby="st-pay-title" aria-busy={busy || undefined}>
      <h2 id="st-pay-title">Payment</h2>
      {note && <div className="st-form-alert" role="alert" tabIndex={-1} ref={noteRef} data-payment-note={failed ? 'declined' : 'error'}>{note}</div>}
      {Widget ? <Widget {...props} busy={busy} report={report} setNote={setNote} /> : <p className="st-form-alert" role="alert">This payment method is not available.</p>}
      <p className="st-note">Paying with {props.label}. <Link className="text-link" href={`/account/orders/${encodeURIComponent(props.orderNumber)}`}>View this order</Link></p>
    </section>
  );
}
