import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { priceHistory } from '@kitsyuu/core';
import { Empty, Forbidden, PageHead } from '@/components/ui';
import { formatDateTime, formatPaise } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import PricingNav from '../PricingNav';
import { Workspace } from '@/components/frame';

export const metadata: Metadata = { title: 'Price history' };

export default async function PriceHistoryPage() {
  const actor = await requireActor();
  if (!can(actor, 'pricing.read')) return <><PageHead title="Pricing & discounts" /><Forbidden permission="pricing.read" /></>;
  const rows = await priceHistory(db(), actor, { limit: 200 });
  const money = (v: number | null) => (v === null ? '—' : formatPaise(v));
  return (
    <Workspace name="pricing-history" title="Pricing & discounts" summary="Every price and compare-at change, from any screen or job (the last 200).">
      <PricingNav current="/pricing/history" />
      {rows.length === 0 ? <Empty title="No price changes recorded yet" kind="price-history" /> : (
        <div className="table-wrap"><table data-price-history>
          <thead><tr><th>When</th><th>Product</th><th>What</th><th className="num">From</th><th className="num">To</th><th>How</th><th>By</th></tr></thead>
          <tbody>{rows.map(h => (
            <tr key={h.id}><td className="nowrap">{formatDateTime(h.created_at as Date)}</td>
              <td><Link href={`/products/${h.product_id}?tab=pricing`}>{h.product_name}</Link>{h.size && <span className="note"> · size {h.size}</span>}</td>
              <td>{h.field === 'price' ? 'Price' : 'Compare-at'}</td><td className="num">{money(h.old_paise)}</td><td className="num">{money(h.new_paise)}</td>
              <td>{h.source}</td><td>{h.staff_email ?? <span className="note">see audit log</span>}</td></tr>
          ))}</tbody>
        </table></div>
      )}
    </Workspace>
  );
}
