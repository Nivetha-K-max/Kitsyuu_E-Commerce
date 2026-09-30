import type { SegmentRules } from '@kitsyuu/contracts';
import { formatPaise } from '@/lib/format';

/** A segment's rules in words, e.g. "at least 2 paid order(s) · no order for 90+ days". */
export function describeRules(r: SegmentRules) {
  const out: string[] = [];
  if (r.joinedWithinDays !== null) out.push(`joined in the last ${r.joinedWithinDays} days`);
  if (r.minOrders !== null) out.push(`at least ${r.minOrders} paid order(s)`);
  if (r.maxOrders !== null) out.push(`at most ${r.maxOrders} paid order(s)`);
  if (r.minSpendPaise !== null) out.push(`spent at least ${formatPaise(r.minSpendPaise)}`);
  if (r.lastOrderWithinDays !== null) out.push(`ordered in the last ${r.lastOrderWithinDays} days`);
  if (r.lastOrderOlderThanDays !== null) out.push(`no order for ${r.lastOrderOlderThanDays}+ days`);
  if (r.hasAbandonedCart) out.push('has an abandoned cart');
  return out.join(' · ');
}
