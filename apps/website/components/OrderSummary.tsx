/* Items and amounts of a placed order (order page and order confirmation). Amounts are the order's own snapshot. */
import type { CustomerOrderDetail } from '@kitsyuu/core';
import { productImageUrl, rupees } from '@/lib/account-format';

export function OrderItems({ o }: { o: CustomerOrderDetail }) {
  return (
    <ul className="st-order-items">
      {o.items.map(i => {
        const img = productImageUrl(i.imagePath);
        return (
          <li key={i.sku} className="st-order-item">
            {img ? <img src={img} alt="" width={64} height={80} loading="lazy" /> : <span className="st-order-noimg" aria-hidden="true" />}
            <div><p className="st-order-item-name">{i.name}</p><p className="st-order-item-meta">{i.colour && <>{i.colour} · </>}Size {i.size} · {i.qty} × {rupees(i.unitPricePaise)}</p></div>
            <p className="st-order-item-total">{rupees(i.lineTotalPaise)}</p>
          </li>
        );
      })}
    </ul>
  );
}

export function OrderSums({ o }: { o: CustomerOrderDetail }) {
  return (
    <dl className="st-order-sums">
      <dt>Subtotal</dt><dd data-subtotal>{rupees(o.subtotalPaise)}</dd>
      {/* Each discount on its own line (coupon / rule, staff, cash on delivery, points); older orders show the total. */}
      {o.discounts.length > 0
        ? o.discounts.map((d, n) => <span key={n} style={{ display: 'contents' }}><dt data-discount-line={d.code}>{d.label}</dt><dd>−{rupees(d.amountPaise)}</dd></span>)
        : o.discountPaise > 0 && <><dt>{o.pointsUsed > 0 ? `Discount (incl. ${o.pointsUsed} points)` : 'Discount'}</dt><dd>−{rupees(o.discountPaise)}</dd></>}
      {(o.shippingPaise > 0 || o.delivery) && <><dt data-delivery-option>{o.delivery ? `${o.delivery.pickup ? 'Store pickup' : 'Delivery'}: ${o.delivery.label}${o.delivery.estimate ? ` (${o.delivery.estimate})` : ''}` : 'Shipping'}</dt><dd>{o.shippingPaise > 0 ? rupees(o.shippingPaise) : 'Free'}</dd></>}
      {o.codFeePaise > 0 && <><dt>Cash on delivery fee</dt><dd>{rupees(o.codFeePaise)}</dd></>}
      <dt>Taxes</dt><dd>{o.pricesIncludeTax ? (o.taxPaise > 0 ? `Included (${rupees(o.taxPaise)})` : 'Included in the prices') : rupees(o.taxPaise)}</dd>
      <dt className="st-order-grand">{o.paymentMethod === 'cod' && o.codStatus === 'to_collect' && o.status !== 'cancelled' ? 'To pay on delivery' : 'Total'}</dt><dd className="st-order-grand" data-total>{rupees(o.totalPaise)}</dd>
    </dl>
  );
}
