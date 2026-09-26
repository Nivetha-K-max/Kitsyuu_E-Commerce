import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { paiseToRupees } from '@kitsyuu/contracts';
import { getDashboard, listOrders } from '@kitsyuu/core';
import { Icon } from '@/components/icons';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatNumber, formatPaise } from '@/lib/format';
import { db, requireActor } from '@/lib/server';

export const metadata: Metadata = { title: 'Dashboard' };

export default async function DashboardPage() {
  const actor = await requireActor();
  if (!can(actor, 'dashboard.read')) return <><PageHead title="Dashboard" /><Forbidden permission="dashboard.read" /></>;
  const [d, recent] = await Promise.all([
    getDashboard(db(), actor),
    can(actor, 'orders.read') ? listOrders(db(), actor, { status: 'all', payment: 'all', page: 1, q: undefined, from: undefined, to: undefined }) : Promise.resolve(null),
  ]);
  // [data-kpi key, shown label, value, detail, icon]
  type Kpi = [string, string, string, string, string];
  const primary: Kpi[] = [
    ['Orders', 'Orders', formatNumber(d.orders.total), `${formatNumber(d.orders.open)} open`, 'orders'],
    ['Revenue (paid orders)', 'Revenue', formatPaise(d.revenue.totalPaise), `Paid orders · today ${formatPaise(d.revenue.todayPaise)}`, 'dashboard'],
    ['Products', 'Products', formatNumber(d.products.total), `${formatNumber(d.products.active)} active`, 'products'],
    ['Low / out of stock', 'Low stock', formatNumber(d.lowStock.count), 'Sellable sizes at or below reorder level', 'alert'],
  ];
  const secondary: [string, string, string][] = [
    ['Customers', formatNumber(d.customers.total), `${formatNumber(d.customers.active)} active`],
    ['Sellable SKUs', formatNumber(d.variants.sellable), `${formatNumber(d.variants.units)} units`],
    ['Staff', formatNumber(d.staff.active), `${formatNumber(d.staff.invited)} invited`],
  ];
  const actions = [
    can(actor, 'products.write') && { href: '/products/new', label: 'Add a product', icon: 'plus' },
    can(actor, 'orders.read') && { href: '/orders?status=open', label: 'Review open orders', icon: 'orders' },
    can(actor, 'inventory.read') && { href: '/inventory?status=attention', label: 'Check low stock', icon: 'inventory' },
    can(actor, 'staff.manage') && { href: '/staff/invite', label: 'Invite a staff member', icon: 'staff' },
  ].filter((x): x is { href: string; label: string; icon: string } => !!x);

  return (
    <>
      <PageHead title="Dashboard" eyebrow={`Live figures · updated ${formatDateTime(d.generatedAt)}`} />
      <dl className="kpis" data-kpis>
        {primary.map(([key, label, value, sub, icon]) => (
          <div className="kpi" key={key} data-kpi={key} data-alert={key === 'Low / out of stock' && d.lowStock.count > 0 ? true : undefined}>
            <dt><span className="kpi-icon" aria-hidden="true"><Icon name={icon} size={16} /></span>{label}</dt>
            <dd>{value}<small>{sub}</small></dd>
          </div>
        ))}
      </dl>
      <dl className="kpis minor" aria-label="More figures">
        {secondary.map(([key, value, sub]) => (
          <div className="kpi" key={key} data-kpi={key}><dt>{key}</dt><dd>{value}<small>{sub}</small></dd></div>
        ))}
      </dl>

      <div className="dash-grid">
        <div className="dash-main">
          {recent && (
            <section className="card" aria-labelledby="ro-h">
              <div className="card-head"><h2 id="ro-h" className="section-title">Recent orders</h2>
                <Link className="btn ghost sm" href="/orders">View all orders</Link></div>
              {recent.rows.length === 0 ? <Empty title="No orders yet" compact>Orders appear here once customers check out.</Empty> : (
                <div className="table-wrap"><table>
                  <thead><tr><th>Order</th><th>Customer</th><th>Placed</th><th className="num">Total</th><th>Status</th></tr></thead>
                  <tbody>{recent.rows.slice(0, 5).map(o => (
                    <tr key={o.id}>
                      <td className="mono"><Link className="row-link" href={`/orders/${o.id}`}>{o.order_number}</Link></td>
                      <td>{o.contact_name ?? '—'}</td>
                      <td className="nowrap">{formatDateTime(o.created_at)}</td>
                      <td className="num money">₹{paiseToRupees(o.total_paise)}</td>
                      <td><StatusBadge status={o.status} /></td>
                    </tr>))}
                  </tbody>
                </table></div>
              )}
            </section>
          )}
          <section className="card" aria-labelledby="low-h">
            <div className="card-head"><h2 id="low-h" className="section-title">Low stock</h2>
              {can(actor, 'inventory.read') && <Link className="btn ghost sm" href="/inventory?status=attention">Open inventory</Link>}</div>
            {d.lowStock.rows.length === 0
              ? <Empty title="Stock levels are healthy" kind="low-stock" compact>No sellable variant is at or below its reorder level.</Empty>
              : <div className="table-wrap"><table>
                  <thead><tr><th>Product</th><th>SKU</th><th>Size</th><th className="num">Stock</th><th className="num">Reorder at</th><th>Status</th></tr></thead>
                  <tbody>{d.lowStock.rows.map(r => (
                    <tr key={r.variant_id} data-level={r.stock_status}><td>{r.product_name}</td><td className="mono">{r.variant_sku}</td><td>{r.size}</td>
                      <td className="num qty">{r.stock_qty}</td><td className="num">{r.reorder_level}</td><td><StatusBadge status={r.stock_status} /></td></tr>))}
                  </tbody></table></div>}
          </section>
        </div>

        <div className="dash-side">
          {actions.length > 0 && (
            <section className="card" aria-labelledby="qa-h">
              <h2 id="qa-h" className="section-title">Quick actions</h2>
              <nav className="quick-actions" aria-labelledby="qa-h">
                {actions.map(a => <Link key={a.href} href={a.href}><Icon name={a.icon} size={16} /><span>{a.label}</span><Icon name="arrow" size={14} /></Link>)}
              </nav>
            </section>
          )}
          <section className="card" aria-labelledby="act-h">
            <h2 id="act-h" className="section-title">Recent activity</h2>
            {!d.recentAudit ? <p className="note">Needs the audit.read permission.</p>
              : d.recentAudit.length === 0 ? <Empty title="No activity yet" compact>Admin actions are recorded here as they happen.</Empty>
              : <ul className="activity">{d.recentAudit.map(a => (
                  <li key={a.id}><span className="mono activity-action">{a.action}</span>
                    <span className="activity-meta">{a.staff_email ?? a.actor_type} · {formatDateTime(a.occurred_at)}</span></li>))}
                </ul>}
            {d.recentAudit && d.recentAudit.length > 0 && <p className="section-foot"><Link className="btn ghost sm" href="/audit">Open the audit log</Link></p>}
          </section>
        </div>
      </div>
    </>
  );
}
