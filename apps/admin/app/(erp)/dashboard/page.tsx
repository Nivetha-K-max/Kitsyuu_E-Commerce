import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { dashboardTrends, getDashboard, listOrders } from '@kitsyuu/core';
import { CategoryDonut, RevenueChart } from '@/components/charts';
import { Icon } from '@/components/icons';
import { Delta, Sparkline, trendDirection } from '@/components/trend';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatNumber, formatPaise } from '@/lib/format';
import { db, productImageUrl, requireActor } from '@/lib/server';

export const metadata: Metadata = { title: 'Dashboard' };

const greeting = () => {
  const h = Number(new Intl.DateTimeFormat('en-IN', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date()));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};
const initials = (s: string | null) => (s ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map(x => x[0]!.toUpperCase()).join('') || '?';
// Calendar days of the trend series (YYYY-MM-DD, India time) as "16 Sep"; shifting by whole days for the previous period.
const dayText = (d: string) => new Date(`${d}T00:00:00+05:30`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
const shiftDay = (d: string, by: number) => new Date(Date.parse(`${d}T00:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);

/* Dashboard (Minimal White, 2026-10-15): the four headline figures in one row, then a balanced grid: sales beside the
   order pipeline, recent orders beside what needs attention, then best sellers, category shares and the store at a
   glance, and the low-stock list. Every number is the live figure from getDashboard / dashboardTrends; nothing here is
   a sample. No quick-action buttons and no activity feed (client, 2026-10-03). */
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
  const first = s[0]?.day, last = s[s.length - 1]?.day;
  const range = first && last ? `${dayText(first)} – ${dayText(last)}` : `Last ${t.days} days`;
  const prevRange = first && last ? `${dayText(shiftDay(first, -t.days))} – ${dayText(shiftDay(last, -t.days))}` : `Previous ${t.days} days`;

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
  /* What needs doing first: one compact row each, opening the work (only for staff who can act on it). The same live
     counts as the pipeline and the low-stock list; a row at zero reads "All clear". */
  const tasks: { key: string; label: string; value: number; icon: Parameters<typeof Icon>[0]['name']; href: string; hint: string; alert?: boolean }[] = [
    ...(can(actor, 'orders.read') ? [{ key: 'fulfil', label: 'Orders to fulfil', value: d.fulfilment.awaiting, icon: 'orders' as const, href: '/orders?status=open', hint: 'Pack and ship' }] : []),
    ...(d.payments && can(actor, 'orders.read') ? [{ key: 'collect', label: 'Payments to collect', value: d.payments.pending, icon: 'payments' as const, href: '/orders?status=pending_payment', hint: 'Awaiting payment' }] : []),
    ...(d.payments && can(actor, 'billing.read') ? [{ key: 'exceptions', label: 'Payment exceptions', value: d.payments.exceptions, icon: 'alert' as const, href: '/payments?view=exceptions', hint: 'Review and resolve', alert: d.payments.exceptions > 0 }] : []),
    ...(can(actor, 'inventory.read') ? [{ key: 'stock', label: 'Low stock', value: d.lowStock.count, icon: 'products' as const, href: '/inventory?status=attention', hint: 'Sizes to restock', alert: d.lowStock.count > 0 }] : []),
  ];
  const open = tasks.filter(x => x.value > 0).length;

  const kpis = [
    { key: 'Revenue (paid orders)', label: 'Revenue', icon: 'value' as const, value: formatPaise(d.revenue.totalPaise),
      sub: <>All time · {formatPaise(t.current.revenue)} in {t.days} days</>, now: t.current.revenue, before: t.previous.revenue, series: s.map(x => x.revenue) },
    { key: 'Orders', label: 'Orders', icon: 'orders' as const, value: formatNumber(d.orders.total),
      sub: <>{formatNumber(d.orders.open)} open · {formatNumber(t.current.orders)} sold in {t.days} days</>, now: t.current.orders, before: t.previous.orders, series: s.map(x => x.orders) },
    { key: 'Average order', label: 'Average order value', icon: 'payments' as const, value: formatPaise(t.current.averageOrder),
      sub: <>{formatNumber(t.current.units)} units sold in {t.days} days</>, now: t.current.averageOrder, before: t.previous.averageOrder, series: s.map(x => (x.orders ? x.revenue / x.orders : 0)) },
    { key: 'Customers', label: 'Customers', icon: 'customers' as const, value: formatNumber(d.customers.total),
      sub: <>{formatNumber(d.customers.active)} active · {formatNumber(d.customers.disabled)} disabled</>, now: t.current.newCustomers, before: t.previous.newCustomers, series: s.map(x => x.newCustomers), deltaLabel: 'new vs prior' },
  ];

  return (
    <div className="dash-page dash" data-dashboard>
      <PageHead title={`${greeting()}, ${firstName}`} eyebrow={`Live figures · updated ${formatDateTime(d.generatedAt)}`} />
      {/* No quick-action buttons here: removed at the client's request (2026-10-03). */}

      <dl className="dkpis" data-kpis>
        {kpis.map(k => (
          <div className="dkpi" key={k.key} data-kpi={k.key}>
            <dt><span className="dkpi-icon" aria-hidden="true"><Icon name={k.icon} size={15} /></span>{k.label}</dt>
            <dd>{k.value}<small>{k.sub}</small></dd>
            <div className="dkpi-foot"><Delta now={k.now} before={k.before} label={k.deltaLabel} /><Sparkline tone={trendDirection(k.now, k.before)} values={k.series} width={84} height={26} /></div>
          </div>
        ))}
      </dl>

      <div className="dgrid">
        <section className="card dcard dg-sales" aria-labelledby="sales-h" data-section="sales-chart">
          <div className="dcard-head">
            <div>
              <h2 id="sales-h" className="section-title">Sales</h2>
              <p className="card-sub">{range} · paid, processing, shipped and delivered orders by day</p>
            </div>
            <Delta now={t.current.revenue} before={t.previous.revenue} label={`vs ${prevRange}`} />
          </div>
          <dl className="dsales-sum">
            <div><dt><i className="dkey now" aria-hidden="true" />This period</dt><dd>{formatPaise(t.current.revenue)}<small>{range}</small></dd></div>
            <div><dt><i className="dkey prev" aria-hidden="true" />Previous period</dt><dd>{formatPaise(t.previous.revenue)}<small>{prevRange}</small></dd></div>
            <div><dt>Orders</dt><dd>{formatNumber(t.current.orders)}<small>{formatNumber(t.previous.orders)} before</small></dd></div>
          </dl>
          {t.current.revenue === 0 && t.previous.revenue === 0
            ? <Empty title={`No sales in the last ${t.days * 2} days`} compact>The chart fills in as paid orders arrive.</Empty>
            : <RevenueChart data={s.map(x => ({ day: x.day, revenue: x.revenue, prevRevenue: x.prevRevenue, orders: x.orders }))} />}
        </section>

        <section className="card dcard dg-pipe" aria-labelledby="pipe-h">
          <div className="dcard-head"><h2 id="pipe-h" className="section-title">Order pipeline</h2><span className="card-sub">Now</span></div>
          <dl className="dpipe" data-kpis-ops>
            {pipeline.map(p => (
              <div className="dpipe-row" key={p.key} data-kpi={p.key} data-alert={p.alert || undefined}>
                <dt>{p.href && can(actor, p.key.startsWith('Payment') ? 'billing.read' : 'orders.read') ? <Link href={p.href}>{p.key}</Link> : p.key}</dt>
                <dd>{formatNumber(p.value)}</dd>
                <span className="dpipe-bar" aria-hidden="true"><span style={{ width: `${Math.round((p.value / pipeMax) * 100)}%` }} /></span>
                <span className="dpipe-sub">{p.sub}</span>
              </div>
            ))}
          </dl>
        </section>

        {recent && (
          <section className="card dcard dg-recent" aria-labelledby="ro-h">
            <div className="dcard-head"><h2 id="ro-h" className="section-title">Recent orders</h2>
              <Link className="btn ghost sm" href="/orders">View all<Icon name="arrow" size={14} /></Link></div>
            {recent.rows.length === 0 ? <Empty title="No orders yet" compact>Orders appear here once customers check out.</Empty> : (
              <div className="table-wrap flush"><table>
                <thead><tr><th>Order</th><th className="dhide-sm">Customer</th><th className="dhide-md">Placed</th><th className="num">Total</th><th>Status</th></tr></thead>
                <tbody>{recent.rows.slice(0, 6).map(o => (
                  <tr key={o.id}>
                    <td><Link className="row-link mono-strong" href={`/orders/${o.id}`}>{o.order_number}</Link></td>
                    <td className="dhide-sm"><span className="who"><span className="mini-avatar" aria-hidden="true">{initials(o.contact_name)}</span>{o.contact_name ?? '—'}</span></td>
                    <td className="nowrap note dhide-md">{formatDateTime(o.created_at)}</td>
                    <td className="num money">{formatPaise(o.total_paise)}</td>
                    <td><StatusBadge status={o.status} /></td>
                  </tr>))}
                </tbody>
              </table></div>
            )}
          </section>
        )}

        {tasks.length > 0 && (
          <section className="card dcard dg-alerts" aria-labelledby="att-h" data-dashboard-tasks>
            <div className="dcard-head"><h2 id="att-h" className="section-title">Needs attention</h2>
              <span className={`dcount${open ? '' : ' clear'}`}>{open ? `${open} open` : 'All clear'}</span></div>
            <ul className="dalerts">
              {tasks.map(x => (
                <li key={x.key}>
                  <Link href={x.href} className="dalert" data-task={x.key} data-zero={x.value === 0 || undefined} data-alert={x.alert || undefined}>
                    <span className="dalert-icon" aria-hidden="true"><Icon name={x.value === 0 ? 'check' : x.icon} size={15} /></span>
                    <span className="dalert-text"><b>{x.label}</b><small>{x.value === 0 ? 'All clear' : x.hint}</small></span>
                    <span className="dalert-value">{formatNumber(x.value)}</span>
                    <Icon name="arrow" size={14} />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="card dcard dg-top" aria-labelledby="top-h" data-section="top-products">
          <div className="dcard-head"><h2 id="top-h" className="section-title">Top products</h2><span className="card-sub">Units · {t.days} days</span></div>
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

        <section className="card dcard dg-cat" aria-labelledby="cat-h" data-section="by-category">
          <div className="dcard-head"><h2 id="cat-h" className="section-title">Sales by category</h2><span className="card-sub">{t.days} days</span></div>
          {t.byCategory.length === 0 ? <Empty title="No category sales yet" compact>Shares appear once orders are paid.</Empty> : <CategoryDonut data={t.byCategory} caption={`${t.days} days`} />}
        </section>

        <section className="card dcard dg-store" aria-labelledby="store-h">
          <div className="dcard-head"><h2 id="store-h" className="section-title">Store at a glance</h2></div>
          <dl className="dstore">
            <div data-kpi="Products"><dt>Products</dt><dd>{formatNumber(d.products.total)}<small>{formatNumber(d.products.active)} active</small></dd></div>
            <div data-kpi="Sellable SKUs"><dt>Sellable SKUs</dt><dd>{formatNumber(d.variants.sellable)}<small>{formatNumber(d.variants.units)} units</small></dd></div>
            <div data-kpi="Low / out of stock" data-alert={d.lowStock.count > 0 || undefined}><dt>Low stock</dt><dd>{formatNumber(d.lowStock.count)}<small>sizes at or below reorder level</small></dd></div>
            <div data-kpi="Staff"><dt>Staff</dt><dd>{formatNumber(d.staff.active)}<small>{formatNumber(d.staff.invited)} invited</small></dd></div>
          </dl>
        </section>

        <section className="card dcard dg-low" aria-labelledby="low-h">
          <div className="dcard-head"><h2 id="low-h" className="section-title">Low stock</h2>
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
    </div>
  );
}
