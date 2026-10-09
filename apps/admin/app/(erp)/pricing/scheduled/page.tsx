import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { applyDuePriceChanges, listScheduledChanges } from '@kitsyuu/core';
import { ActionForm, Hidden } from '@/components/forms';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatPaise } from '@/lib/format';
import { one, type SP } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';
import { cancelPriceChangeAction } from '../actions';
import PricingNav from '../PricingNav';
import { Workspace } from '@/components/frame';

export const metadata: Metadata = { title: 'Scheduled price changes' };

export default async function ScheduledPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'pricing.read')) return <><PageHead title="Pricing & discounts" /><Forbidden permission="pricing.read" /></>;
  await applyDuePriceChanges(db()).catch(e => console.error('[pricing] apply due changes', e));
  const status = one((await searchParams).status) === 'all' ? 'all' : 'scheduled';
  const rows = await listScheduledChanges(db(), actor, status);
  const manage = can(actor, 'pricing.manage');
  const money = (v: number | null) => (v === null ? '—' : formatPaise(v));
  return (
    <Workspace name="pricing-scheduled" title="Pricing & discounts" summary="Changes are applied when their time comes (by the scheduled job, or when anyone opens Pricing).">
      <PricingNav current="/pricing/scheduled" />
      <nav className="tabs actions" aria-label="Show">
        <Link className={`btn sm ${status === 'scheduled' ? '' : 'ghost'}`} href="/pricing/scheduled">Upcoming</Link>
        <Link className={`btn sm ${status === 'all' ? '' : 'ghost'}`} href="/pricing/scheduled?status=all">All</Link>
      </nav>
      {rows.length === 0 ? <Empty title="Nothing scheduled" kind="scheduled">Schedule a change from a product’s pricing page.</Empty> : (
        <div className="table-wrap"><table data-scheduled-all>
          <thead><tr><th>From</th><th>Product</th><th className="num">New price</th><th className="num">Compare-at</th><th>Status</th><th>By</th>{manage && <th />}</tr></thead>
          <tbody>{rows.map(c => (
            <tr key={c.id}>
              <td className="nowrap">{formatDateTime(c.effective_at as Date)}</td>
              <td><Link href={`/products/${c.product_id}?tab=pricing`}>{c.product_name}</Link>{c.size && <span className="note"> · size {c.size}</span>}{c.note && <div className="note">{c.note}</div>}</td>
              <td className="num">{money(c.new_price_paise)}</td><td className="num">{c.clear_compare_at ? 'remove' : money(c.new_compare_at_paise)}</td>
              <td><StatusBadge status={c.status} />{c.failure_reason && <div className="note">{c.failure_reason}</div>}</td><td>{c.created_by_email ?? '—'}</td>
              {manage && <td>{c.status === 'scheduled' && <ActionForm action={cancelPriceChangeAction} submitLabel="Cancel" variant="danger" className="inline-form" id={`cancel-${c.id}`} label="Cancel">
                <Hidden name="changeId" value={c.id} /></ActionForm>}</td>}
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </Workspace>
  );
}
