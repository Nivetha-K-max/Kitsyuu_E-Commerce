import type { Metadata } from 'next';
import { getMyReferral } from '@kitsyuu/core';
import { Card } from '@/components/account-ui';
import { formatDate, rupees } from '@/lib/account-format';
import { db, requireCustomer, siteUrl } from '@/lib/server';

export const metadata: Metadata = { title: 'Refer a friend' };
const STATE: Record<string, string> = { pending: 'Waiting for their first delivered order', rewarded: 'Rewarded', rejected: 'Not eligible' };
const REWARD: Record<string, string> = { available: 'Available', used: 'Used', expired: 'Expired' };

/* Referrals (2026-10-12): the customer's own code and link, where each of their referrals stands, and the reward coupons
   they hold. Read-only: referrals are attributed at sign-up and rewards are given by the server. The terms shown are the
   business's settings; nobody else's name or email appears here. */
export default async function ReferralsPage() {
  const me = await requireCustomer('/account/referrals');
  const r = await getMyReferral(db(), me);
  const s = r.settings;
  const link = r.code ? siteUrl(`/signup?ref=${encodeURIComponent(r.code)}`) : null;
  return (
    <>
      <header className="st-plp-head"><h1 id="st-page-title">Refer a friend</h1></header>
      {!s.enabled ? <p className="st-acc-quiet st-acc-banner" data-referrals-off>Referral rewards are not active at the moment.{r.rewards.length > 0 ? ' Your rewards are kept.' : ''}</p> : (
        <Card id="st-ref-code" title="Your referral code">
          <p className="st-ref-code" data-referral-code><b>{r.code}</b></p>
          {link && <p className="st-acc-quiet" data-referral-link>Share this link: <span className="st-ref-link">{link}</span></p>}
          <ul className="st-acc-bullets" data-referral-terms>
            <li>A friend creates their account with your code or link.</li>
            {s.rewardPaise ? <li>When their first order has been delivered and its return period is over, you each receive a {rupees(s.rewardPaise)} coupon{s.minOrderPaise ? ` for an order of ${rupees(s.minOrderPaise)} or more` : ''}{s.validDays ? `, valid for ${s.validDays} days` : ''}.</li>
              : <li>The reward has not been set yet.</li>}
            <li>The code works only for new customers, once, and not for your own account.</li>
          </ul>
        </Card>
      )}
      <Card id="st-ref-rewards" title="Your rewards">
        {r.rewards.length === 0 ? <p className="st-acc-quiet" data-no-rewards>No rewards yet.</p> : (
          <ul className="st-erp-list" data-referral-rewards>{r.rewards.map(w => (
            <li key={w.id} data-reward-state={w.state}>
              <b>{rupees(w.valuePaise)}</b>
              <p>Coupon <span className="st-ref-coupon" data-reward-code>{w.code}</span> · {REWARD[w.state]}
                <span>{w.role === 'referrer' ? 'For referring a friend' : 'Welcome reward'}{w.minOrderPaise ? ` · on orders of ${rupees(w.minOrderPaise)} or more` : ''}{w.endsAt ? ` · until ${formatDate(w.endsAt)}` : ''}</span></p>
            </li>
          ))}</ul>
        )}
        {r.rewards.some(w => w.state === 'available') && <p className="st-acc-quiet">Enter the coupon code at checkout. It works once, for your account only.</p>}
      </Card>
      <Card id="st-ref-list" title="People you referred">
        {r.referrals.length === 0 ? <p className="st-acc-quiet" data-no-referrals>Nobody has joined with your code yet.</p> : (
          <ul className="st-erp-list" data-referrals>{r.referrals.map(x => (
            <li key={x.id} data-referral-state={x.status}><b>{formatDate(x.attributed_at as Date)}</b><p>{STATE[x.status] ?? x.status}</p></li>
          ))}</ul>
        )}
      </Card>
    </>
  );
}
