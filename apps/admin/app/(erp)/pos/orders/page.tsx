import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { findPosOrders } from '@kitsyuu/core';
import FilterForm from '@/components/FilterForm';
import { Empty, Forbidden, PageHead } from '@/components/ui';
import { formatDateTime, formatPaise } from '@/lib/format';
import { one, type SP } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';
import { Workspace } from '@/components/frame';

export const metadata: Metadata = { title: 'Find an order' };

/* Order lookup at the counter (2026-10-13): website orders and branch bills alike, by order number, bill number, phone or
   email. From a result: open the bill / order, or take a return or exchange at this counter. */
export default async function PosOrdersPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/pos', label: 'POS billing' }];
  if (!can(actor, 'pos.access')) return <><PageHead title="Find an order" crumbs={crumbs} /><Forbidden permission="pos.access" /></>;
  if (!can(actor, 'orders.read')) return <><PageHead title="Find an order" crumbs={crumbs} /><Forbidden permission="orders.read" /></>;
  const q = one((await searchParams).q).trim().slice(0, 80);
  const rows = q.length >= 3 ? await findPosOrders(db(), actor, q) : [];
  const state = (s: string) => s.replace(/_/g, ' ');
  return (
    <Workspace name="pos-orders" title="Find an order" summary="Website orders and branch bills" crumbs={crumbs}>
      <FilterForm className="actions" role="search" aria-label="Find an order" data-pos-order-search>
        <label className="sr-only" htmlFor="po-q">Order number, bill number, phone or email</label>
        <input id="po-q" name="q" className="input" placeholder="Order number, bill number, phone or email" defaultValue={q} autoFocus style={{ minWidth: 320 }} />
        <button className="btn" type="submit">Find</button>
      </FilterForm>
      {q.length < 3 ? <Empty compact title="Type at least 3 characters">An order number (KTS-…), a POS bill number (POS/…), the customer&rsquo;s phone or their email.</Empty>
        : rows.length === 0 ? <Empty compact title="No order found">Check the number or try the customer&rsquo;s phone.</Empty> : (
          <div className="table-wrap"><table data-pos-order-results>
            <thead><tr><th>Order</th><th>Where</th><th>Customer</th><th>When</th><th className="num">Total</th><th>Payment</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{rows.map(o => (
              <tr key={o.id} data-pos-order={o.order_number}>
                <td><Link href={o.pos_number ? `/pos/sale/${o.id}` : `/orders/${o.id}`}>{o.pos_number ?? o.order_number}</Link>{o.pos_number && <div className="note mono">{o.order_number}</div>}</td>
                <td>{o.channel === 'online' ? 'Website' : o.location_name ?? 'Branch'}</td>
                <td>{o.customer_name ?? o.contact_name ?? 'Walk-in customer'}</td>
                <td className="nowrap">{formatDateTime(o.created_at as Date)}</td>
                <td className="num">{formatPaise(o.total_paise)}</td>
                <td>{state(o.payment_status ?? '—')}</td>
                <td>{state(o.status)}{o.returns > 0 && <div className="note">{o.returns} return{o.returns === 1 ? '' : 's'}</div>}</td>
                <td>{can(actor, 'returns.manage') && o.status === 'delivered' && <Link className="btn ghost sm" href={`/pos/exchange/${o.id}`} data-pos-order-exchange>Return / exchange</Link>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
    </Workspace>
  );
}
