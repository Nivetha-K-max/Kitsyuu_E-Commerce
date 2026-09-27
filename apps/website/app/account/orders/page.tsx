import type { Metadata } from 'next';
import Link from 'next/link';
import { listCustomerOrders } from '@kitsyuu/core';
import { db, requireCustomer } from '@/lib/server';
import { formatDate, ORDER_STATUS_LABEL, PAYMENT_STATUS_LABEL, rupees } from '@/lib/account-format';

export const metadata: Metadata = { title: 'Orders' };

export default async function OrdersPage() {
  const me = await requireCustomer('/account/orders');
  const orders = await listCustomerOrders(db(), me);
  return (
    <>
      <header className="st-plp-head">
        <h1 id="st-page-title">Orders</h1>
        <div className="st-plp-aside"><p className="st-result-count">{orders.length} {orders.length === 1 ? 'order' : 'orders'}</p><p>Newest first. Open an order for its items, payment and delivery details.</p></div>
      </header>
      {orders.length === 0 ? (
        <div className="st-account-empty" data-empty="orders"><p>You have not placed any orders yet.</p><Link className="button" href="/shop">Start shopping</Link></div>
      ) : (
        <div className="st-table-wrap"><table className="st-order-table" data-orders-table>
          <caption className="sr-only">Your orders</caption>
          <thead><tr><th scope="col">Order</th><th scope="col">Placed</th><th scope="col">Items</th><th scope="col">Status</th><th scope="col">Payment</th><th scope="col" className="num">Total</th></tr></thead>
          <tbody>{orders.map(o => (
            <tr key={o.orderNumber} data-order={o.orderNumber}>
              <th scope="row"><Link href={`/account/orders/${encodeURIComponent(o.orderNumber)}`}>{o.orderNumber}</Link></th>
              <td>{formatDate(o.createdAt)}</td>
              <td>{o.units}</td>
              <td>{ORDER_STATUS_LABEL[o.status] ?? o.status}</td>
              <td>{o.paymentStatus ? PAYMENT_STATUS_LABEL[o.paymentStatus] ?? o.paymentStatus : '—'}</td>
              <td className="num">{rupees(o.totalPaise)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </>
  );
}
