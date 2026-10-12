import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listReferrals } from '@kitsyuu/core';
import { ActionForm, Field, Hidden } from '@/components/forms';
import FilterForm from '@/components/FilterForm';
import { StateBlock, Workspace } from '@/components/frame';
import { Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatNumber, formatPaise } from '@/lib/format';
import { one, pageOf, type SP } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';
import { rejectReferralAction, runReferralRewardsAction } from '../actions';
import MarketingNav from '../MarketingNav';

export const metadata: Metadata = { title: 'Referrals' };
const STATUSES = ['all', 'pending', 'rewarded', 'rejected'] as const;

/* Referrals (2026-10-12): who referred whom, where each referral stands and why one was rejected. The reward and its
   coupon's terms are Configuration → Referrals; a reward is a personal coupon in the same coupon engine as every other
   coupon. Customers are named only for staff who may read customers. Rejecting and running the check need
   marketing.manage (checked in the core) and are audited. */
export default async function ReferralsPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'marketing.read')) return <><PageHead title="Marketing" /><Forbidden permission="marketing.read" /></>;
  const sp = await searchParams;
  const status = (STATUSES as readonly string[]).includes(one(sp.status)) ? one(sp.status) as typeof STATUSES[number] : 'all';
  const list = await listReferrals(db(), actor, { status, page: pageOf(sp.page) });
  const s = list.settings, manage = can(actor, 'marketing.manage');
  const who = (email: string | null, id: string | null) => (email ? (id ? <Link href={`/customers/${id}`}>{email}</Link> : email) : <span className="note">hidden (needs customers.read)</span>);
  const terms = !s.enabled ? 'Referral rewards are OFF (Configuration → Referrals).'
    : !s.rewardPaise ? 'Referrals are on, but no reward amount is set, so no reward is given.'
    : `On: ${formatPaise(s.rewardPaise)} coupon to each customer${s.minOrderPaise ? `, on orders of ${formatPaise(s.minOrderPaise)} or more` : ''}${s.validDays ? `, valid ${s.validDays} days` : ''}, after the referred customer's first delivered order and its return period.`;
  return (
    <Workspace name="marketing-referrals" title="Marketing" crumbs={[{ href: '/marketing/report', label: '← Report' }]}
      summary={`${formatNumber(list.counts.pending ?? 0)} waiting · ${formatNumber(list.counts.rewarded ?? 0)} rewarded · ${formatNumber(list.counts.rejected ?? 0)} rejected · ${formatNumber(list.rewards.issued)} reward coupons given (${formatPaise(list.rewards.paise)}), ${formatNumber(list.rewards.used)} used`}
      actions={manage ? <ActionForm action={runReferralRewardsAction} submitLabel="Check for rewards now" variant="ghost" id="referral-run-form" label="Check pending referrals for rewards" className="inline-form" /> : undefined}>
      <MarketingNav current="/marketing/report" />
      <p className="note" data-referral-terms>{terms} {can(actor, 'settings.read') && <Link href="/settings">Configuration → Referrals</Link>}</p>
      <FilterForm className="actions" role="search" aria-label="Filter referrals" data-referral-filters>
        <label className="sr-only" htmlFor="rf-s">Status</label>
        <select id="rf-s" name="status" className="input" defaultValue={status}><option value="all">All</option><option value="pending">Waiting</option><option value="rewarded">Rewarded</option><option value="rejected">Rejected</option></select>
        <button className="btn ghost" type="submit">Apply</button>
      </FilterForm>
      {list.rows.length === 0 ? <StateBlock title="No referrals here" name="referrals">A referral appears when someone creates their account with a customer&rsquo;s referral code.</StateBlock> : (
        <div className="table-wrap"><table data-referrals-table>
          <thead><tr><th>Referred by</th><th>New customer</th><th>Code</th><th>Joined</th><th>Status</th><th>Order</th>{manage && <th />}</tr></thead>
          <tbody>{list.rows.map(r => (
            <tr key={r.id} data-referral={r.id} data-referral-status={r.status}>
              <td>{who(r.referrer_email, r.referrer_id)}</td><td>{who(r.referred_email, r.referred_id)}</td>
              <td className="mono">{r.code}</td><td className="nowrap">{formatDateTime(r.attributed_at as Date)}</td>
              <td><StatusBadge status={r.status === 'rewarded' ? 'approved' : r.status === 'rejected' ? 'cancelled' : 'pending'} />
                {r.status === 'rewarded' && <div className="note">rewarded {formatDateTime(r.rewarded_at as Date)}</div>}
                {r.status === 'rejected' && <div className="note" data-reject-reason>{r.reject_reason}</div>}</td>
              <td className="mono">{r.order_id && r.order_number ? (can(actor, 'orders.read') ? <Link href={`/orders/${r.order_id}`}>{r.order_number}</Link> : r.order_number) : <span className="note">—</span>}</td>
              {manage && <td>{r.status === 'pending' && (
                <details><summary className="btn ghost sm">Reject…</summary>
                  <ActionForm action={rejectReferralAction} submitLabel="Reject referral" variant="danger" id={`reject-${r.id}`} label="Reject this referral" confirmText="Reject this referral? No reward will be given for it.">
                    <Hidden name="referralId" value={r.id} /><Field name="reason" label="Reason (kept with the referral)" required />
                  </ActionForm></details>)}</td>}
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <nav className="pager actions" aria-label="Pages">
        {list.page > 1 && <Link className="btn ghost sm" href={`/marketing/referrals?status=${status}&page=${list.page - 1}`}>Previous</Link>}
        {list.hasNext && <Link className="btn ghost sm" href={`/marketing/referrals?status=${status}&page=${list.page + 1}`}>Next</Link>}
      </nav>
    </Workspace>
  );
}
