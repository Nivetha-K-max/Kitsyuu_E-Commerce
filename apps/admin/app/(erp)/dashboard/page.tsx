import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { dashboardTrends, getDashboard, listOrders } from '@kitsyuu/core';
import { CategoryDonut, RevenueChart } from '@/components/charts';
import { Icon } from '@/components/icons';
import { Delta, Sparkline } from '@/components/trend';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatNumber, formatPaise } from '@/lib/format';
import { db, productImageUrl, requireActor } from '@/lib/server';

export const metadata: Metadata = { title: 'Dashboard' };

const greeting = () => {
  const h = Number(new Intl.DateTimeFormat('en-IN', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date()));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};
const initials = (s: string | null) => (s ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map(x => x[0]!.toUpperCase()).join('') || '?';

export default async function DashboardPage() {
  const actor = await requireActor();
  if (!can(actor, 'dashboard.read')) return <><PageHead title="Dashboard" /><Forbidden permission="dashboard.read" /></>;
  const [d, t, recent] = await Promise.all([
    getDashboard(db(), actor),
    dashboardTrends(db(), actor),
    can(actor, 'orders.read') ? listOrders(db(), actor, { status: 'all', payment: 'all', page: 1, q: undefined, from: undefined, to: undefined, view: 'all' }) : Promise.resolve(null),
  ]);
  const s = t.series;
  const firstName = (actor.fullName || '').split(/\s+/)[0] || 'there';

  // Order pipeline (M8 figures): each row is a live count; the bar shows its share of the largest.
  const pipeline: { key: string; value: number; sub: React.ReactNode; alert?: boolean; href?: string }[] = [
    { key: 'Awaiting fulfilment', value: d.fulfilment.awaiting, href: '/orders?status=open',
      sub: <>{formatNumber(d.fulfilment.paid)} paid · {formatNumber(d.fulfilment.not_started + d.fulfilment.packing + d.fulfilment.packed)} processing ({formatNumber(d.fulfilment.packed)} packed)</> },
    { key: 'Shipped', value: d.fulfilment.shipped, href: '/orders?status=shipped',
      sub: d.fulfilment.shipped_without_tracking ? `${formatNumber(d.fulfilment.shipped_without_tracking)} without tracking` : 'In transit' },
    { key: 'Delivered', value: d.fulfilment.delivered, href: '/orders?status=delivered', sub: 'Orders completed' },
    ...(d.payments ? [
      { key: 'Pending payments', value: d.payments.pending, href: '/orders?status=pending_payment', sub: 'Orders awaiting payment' },
      { key: 'Payment exceptions', value: d.payments.exceptions, alert: d.payments.exceptions > 0, href: '/payments?view=exceptions',
        sub: d.payments.exceptions ? 'Needs review' : 'None open' },
    ] : []),
  ];
  const pipeMax = Math.max(1, ...pipeline.map(p => p.value));

  return (
    <>
      <PageHead title={`${greeting()}, ${firstName}`} eyebrow={`Here is how KITSYUU is doing · live figures, updated ${formatDateTime(d.generatedAt)}`}>
        <span className="range-chip"><Icon name="reports" size={14} />Last {t.days} days</span>
        {can(actor, 'reports.read') && <Link className="btn ghost" href="/reports">Open reports</Link>}
        {can(actor, 'products.write') && <Link className="btn" href="/products/new"><Icon name="plus" size={15} />New product</Link>}
      </PageHead>

      <dl className="kpis hero" data-kpis>
        <div className="kpi" data-kpi="Revenue (paid orders)">
          <dt><span className="kpi-icon" aria-hidden="true"><Icon name="value" size={17} /></span>Revenue</dt>
          <dd>{formatPaise(d.revenue.totalPaise)}<small>All time · {formatPaise(t.current.revenue)} in {t.days} days</small></dd>
          <div className="kpi-foot"><Delta now={t.current.revenue} before={t.previous.revenue} /><Sparkline values={s.map(x => x.revenue)} /></div>
        </div>
        <div className="kpi" data-kpi="Orders">
          <dt><span className="kpi-icon" aria-hidden="true"><Icon name="orders" size={17} /></span>Orders</dt>
          <dd>{formatNumber(d.orders.total)}<small>{formatNumber(d.orders.open)} open · {formatNumber(t.current.orders)} sold in {t.days} days</small></dd>
          <div className="kpi-foot"><Delta now={t.current.orders} before={t.previous.orders} /><Sparkline values={s.map(x => x.orders)} /></div>
        </div>
        <div className="kpi" data-kpi="Average order">
          <dt><span className="kpi-icon" aria-hidden="true"><Icon name="payments" size={17} /></span>Average order</dt>
          <dd>{formatPaise(t.current.averageOrder)}<small>{formatNumber(t.current.units)} units sold in {t.days} days</small></dd>
          <div className="kpi-foot"><Delta now={t.current.averageOrder} before={t.previous.averageOrder} /><Sparkline values={s.map(x => (x.orders ? x.revenue / x.orders : 0))} /></div>
        </div>
        <div className="kpi" data-kpi="Customers">
          <dt><span className="kpi-icon" aria-hidden="true"><Icon name="customers" size={17} /></span>Customers</dt>
          <dd>{formatNumber(d.customers.total)}<small>{formatNumber(d.customers.active)} active · {formatNumber(d.customers.disabled)} disabled</small></dd>
          <div className="kpi-foot"><Delta now={t.current.newCustomers} before={t.previous.newCustomers} label="new vs prior" /><Sparkline values={s.map(x => x.newCustomers)} /></div>
        </div>
      </dl>

      <div className="dash-grid">
        <div className="dash-main">
          <section className="card" aria-labelledby="sales-h" data-section="sales-chart">
            <div className="card-head">
              <div>
                <h2 id="sales-h" className="section-title">Sales</h2>
                <p className="card-sub">Paid, processing, shipped and delivered orders, by day (India time)</p>
              </div>
              <div className="chart-legend">
                <span><i className="dot accent" />Last {t.days} days <b>{formatPaise(t.current.revenue)}</b></span>
                <span><i className="dot muted" />Previous {t.days} days <b>{formatPaise(t.previous.revenue)}</b></span>
              </div>
            </div>
            {t.current.revenue === 0 && t.previous.revenue === 0
              ? <Empty title="No sales in the last 60 days" compact>The chart fills in as paid orders arrive.</Empty>
              : <RevenueChart data={s.map(x => ({ day: x.day, revenue: x.revenue, prevRevenue: x.prevRevenue, orders: x.orders }))} />}
          </section>

          {recent && (
            <section className="card" aria-labelledby="ro-h">
              <div className="card-head"><h2 id="ro-h" className="section-title">Recent orders</h2>
                <Link className="btn ghost sm" href="/orders">View all<Icon name="arrow" size={14} /></Link></div>
              {recent.rows.length === 0 ? <Empty title="No orders yet" compact>Orders appear here once customers check out.</Empty> : (
                <div className="table-wrap flush"><table>
                  <thead><tr><th>Order</th><th>Customer</th><th>Placed</th><th className="num">Total</th><th>Status</th></tr></thead>
                  <tbody>{recent.rows.slice(0, 6).map(o => (
                    <tr key={o.id}>
                      <td><Link className="row-link mono-strong" href={`/orders/${o.id}`}>{o.order_number}</Link></td>
                      <td><span className="who"><span className="mini-avatar" aria-hidden="true">{initials(o.contact_name)}</span>{o.contact_name ?? '—'}</span></td>
                      <td className="nowrap note">{formatDateTime(o.created_at)}</td>
                      <td className="num money">{formatPaise(o.total_paise)}</td>
                      <td><StatusBadge status={o.status} /></td>
                    </tr>))}
                  </tbody>
                </table></div>
              )}
            </section>
          )}

          <div className="dash-pair">
            <section className="card" aria-labelledby="top-h" data-section="top-products">
              <div className="card-head"><h2 id="top-h" className="section-title">Top products</h2><span className="card-sub">Units sold · {t.days} days</span></div>
              {t.topProducts.length === 0 ? <Empty title="Nothing sold yet" compact>Best sellers appear here once orders are paid.</Empty> : (
                <ol className="top-list">{t.topProducts.map((p, i) => {
                  const img = productImageUrl(p.image);
                  const inner = <>
                    <span className="top-rank">{i + 1}</span>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <span className="pthumb">{img ? <img src={img} alt="" width={40} height={50} loading="lazy" /> : <Icon name="no-image" size={16} />}</span>
                    <span className="top-name"><b>{p.name}</b><small>{p.category ?? '—'}</small></span>
                    <span className="top-fig"><b>{formatNumber(p.units)}</b><small>{formatPaise(p.revenue)}</small></span>
                  </>;
                  return <li key={p.productId ?? p.name}>{p.productId && can(actor, 'products.read') ? <Link href={`/products/${p.productId}`}>{inner}</Link> : <div>{inner}</div>}</li>;
                })}</ol>
              )}
            </section>
            <section className="card" aria-labelledby="cat-h" data-section="by-category">
              <div className="card-head"><h2 id="cat-h" className="section-title">Sales by category</h2><span className="card-sub">{t.days} days</span></div>
              {t.byCategory.length === 0 ? <Empty title="No category sales yet" compact>Shares appear once orders are paid.</Empty> : <CategoryDonut data={t.byCategory} />}
            </section>
          </div>

          <section className="card" aria-labelledby="low-h">
            <div className="card-head"><h2 id="low-h" className="section-title">Low stock</h2>
              {can(actor, 'inventory.read') && <Link className="btn ghost sm" href="/inventory?status=attention">Open inventory<Icon name="arrow" size={14} /></Link>}</div>
            {d.lowStock.rows.length === 0
              ? <Empty title="Stock levels are healthy" kind="low-stock" compact>No sellable variant is at or below its reorder level.</Empty>
              : <div className="table-wrap flush"><table>
                  <thead><tr><th>Product</th><th>SKU</th><th>Size</th><th className="num">Stock</th><th className="num">Reorder at</th><th>Status</th></tr></thead>
                  <tbody>{d.lowStock.rows.map(r => (
                    <tr key={r.variant_id} data-level={r.stock_status}><td>{r.product_name}</td><td className="mono">{r.variant_sku}</td><td>{r.size}</td>
                      <td className="num qty">{r.stock_qty}</td><td className="num">{r.reorder_level}</td><td><StatusBadge status={r.stock_status} /></td></tr>))}
                  </tbody></table></div>}
          </section>
        </div>

        <aside className="dash-side" aria-label="Operations">
          <section className="card" aria-labelledby="pipe-h">
            <div className="card-head"><h2 id="pipe-h" className="section-title">Order pipeline</h2></div>
            <dl className="pipeline" data-kpis-ops>
              {pipeline.map(p => (
                <div className="kpi pipe" key={p.key} data-kpi={p.key} data-alert={p.alert || undefined}>
                  <dt>{p.href && can(actor, p.key.startsWith('Payment') ? 'billing.read' : 'orders.read') ? <Link href={p.href}>{p.key}</Link> : p.key}</dt>
                  <dd>{formatNumber(p.value)}<small>{p.sub}</small></dd>
                  <span className="pipe-bar" aria-hidden="true"><span style={{ width: `${Math.round((p.value / pipeMax) * 100)}%` }} /></span>
                </div>
              ))}
            </dl>
          </section>

          <section className="card" aria-labelledby="store-h">
            <div className="card-head"><h2 id="store-h" className="section-title">Store overview</h2></div>
            <dl className="overview">
              <div className="kpi" data-kpi="Products"><dt><span className="kpi-icon" aria-hidden="true"><Icon name="products" size={16} /></span>Products</dt>
                <dd>{formatNumber(d.products.total)}<small>{formatNumber(d.products.active)} active</small></dd></div>
              <div className="kpi" data-kpi="Sellable SKUs"><dt><span className="kpi-icon" aria-hidden="true"><Icon name="inventory" size={16} /></span>Sellable SKUs</dt>
                <dd>{formatNumber(d.variants.sellable)}<small>{formatNumber(d.variants.units)} units</small></dd></div>
              <div className="kpi" data-kpi="Low / out of stock" data-alert={d.lowStock.count > 0 || undefined}><dt><span className="kpi-icon" aria-hidden="true"><Icon name="alert" size={16} /></span>Low stock</dt>
                <dd>{formatNumber(d.lowStock.count)}<small>sizes at or below reorder level</small></dd></div>
              <div className="kpi" data-kpi="Staff"><dt><span className="kpi-icon" aria-hidden="true"><Icon name="staff" size={16} /></span>Staff</dt>
                <dd>{formatNumber(d.staff.active)}<small>{formatNumber(d.staff.invited)} invited</small></dd></div>
            </dl>
          </section>

          <section className="card" aria-labelledby="act-h">
            <div className="card-head"><h2 id="act-h" className="section-title">Recent activity</h2>
              {d.recentAudit && d.recentAudit.length > 0 && <Link className="btn quiet sm" href="/audit">All</Link>}</div>
            {!d.recentAudit ? <p className="note">Needs the audit.read permission.</p>
              : d.recentAudit.length === 0 ? <Empty title="No activity yet" compact>Admin actions are recorded here as they happen.</Empty>
              : <ul className="activity">{d.recentAudit.map(a => (
                  <li key={a.id}><span className="activity-dot" aria-hidden="true" /><span className="mono activity-action">{a.action}</span>
                    <span className="activity-meta">{a.staff_email ?? a.actor_type} · {formatDateTime(a.occurred_at)}</span></li>))}
                </ul>}
          </section>
        </aside>
      </div>
    </>
  );
}
