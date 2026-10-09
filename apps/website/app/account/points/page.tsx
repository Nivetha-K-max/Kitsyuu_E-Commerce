import type { Metadata } from 'next';
import Link from 'next/link';
import { getMyLoyalty, LOYALTY_KIND_LABELS } from '@kitsyuu/core';
import { Card } from '@/components/account-ui';
import { formatDate, rupees } from '@/lib/account-format';
import { db, requireCustomer } from '@/lib/server';

export const metadata: Metadata = { title: 'Points' };

/* Client change request, second pass: the customer's loyalty points (balance and history). Read-only here: points change
   only on the server (orders, and staff with a reason). The rules shown are the business's settings. */
export default async function PointsPage() {
  const me = await requireCustomer('/account/points');
  const l = await getMyLoyalty(db(), me);
  const s = l.settings;
  const rules = [
    s.enabled && s.earnPer100 && s.earnWhen ? `You earn ${s.earnPer100} points for every ₹100 you spend, once an order is ${s.earnWhen === 'paid' ? 'paid' : 'delivered'}.` : null,
    s.enabled && s.pointValuePaise ? `Each point is worth ${rupees(s.pointValuePaise)} at checkout${s.minRedeem ? ` (from ${s.minRedeem} points)` : ''}${s.maxRedeem ? `, up to ${s.maxRedeem} points per order` : ''}.` : null,
    s.enabled && s.expiryMonths ? `Unused points expire ${s.expiryMonths} months after you receive them.` : null,
  ].filter(Boolean);
  return (
    <>
      <header className="st-plp-head"><h1 id="st-page-title">Points</h1></header>
      <section className="st-points-hero" aria-label="Your points">
        <p className="st-points-balance" data-points-balance><b>{l.balance}</b> points</p>
        <dl className="st-points-totals" data-points-totals>
          <div><dt>Available</dt><dd>{l.balance}</dd></div><div><dt>Earned</dt><dd>{l.totals.earned}</dd></div>
          <div><dt>Used</dt><dd>{l.totals.used}</dd></div><div><dt>Expired</dt><dd>{l.totals.expired}</dd></div>
          {l.totals.reversed > 0 && <div><dt>Taken back</dt><dd>{l.totals.reversed}</dd></div>}
        </dl>
      </section>
      {l.expiringSoon && <p className="st-form-alert" role="status" data-points-expiring>{l.expiringSoon.points} points expire on {formatDate(l.expiringSoon.at as Date)}.</p>}
      {!s.enabled ? <p className="st-acc-quiet st-acc-banner" data-points-off>Loyalty points are not active at the moment.{l.balance > 0 ? ' Your points are kept.' : ''}</p>
        : rules.length > 0 && (
          <Card id="st-points-rules" title="How points work">
            <ul className="st-acc-bullets" data-points-rules>{rules.map((r, i) => <li key={i}>{r}</li>)}</ul>
          </Card>
        )}
      <Card id="st-points-history" title="History">
        {l.rows.length === 0 ? <p className="st-acc-quiet" data-no-points>No points yet.</p> : (
          <ul className="st-erp-list st-points-rows" data-points-history>{l.rows.map(r => (
            <li key={r.id} data-sign={r.points > 0 ? 'plus' : 'minus'}>
              <b>{r.points > 0 ? `+${r.points}` : r.points}</b>
              <p>{LOYALTY_KIND_LABELS[r.kind] ?? r.kind}
                {r.order_number && <> · <Link href={`/account/orders/${encodeURIComponent(r.order_number)}`}>Order {r.order_number}</Link></>}
                <span>{formatDate(r.created_at as Date)}{r.kind === 'adjust' && r.reason ? ` · ${r.reason}` : ''}</span></p>
            </li>
          ))}</ul>
        )}
      </Card>
    </>
  );
}
