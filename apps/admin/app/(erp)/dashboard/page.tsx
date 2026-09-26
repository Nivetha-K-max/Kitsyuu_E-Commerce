import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { getDashboard } from '@kitsyuu/core';
import { Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatNumber, formatPaise } from '@/lib/format';
import { db, requireActor } from '@/lib/server';

export const metadata: Metadata = { title: 'Dashboard' };

export default async function DashboardPage() {
  const actor = await requireActor();
  if (!can(actor, 'dashboard.read')) return <><PageHead section="Operations / Overview" title="Dashboard" /><Forbidden permission="dashboard.read" /></>;
  const d = await getDashboard(db(), actor);
  // [data-kpi key, shown label, value, detail]
  type Kpi = [string, string, string, string?];
  const primary: Kpi[] = [
    ['Orders', 'Orders', formatNumber(d.orders.total), `${formatNumber(d.orders.open)} open`],
    ['Revenue (paid orders)', 'Revenue', formatPaise(d.revenue.totalPaise), `paid orders · today ${formatPaise(d.revenue.todayPaise)}`],
    ['Products', 'Products', formatNumber(d.products.total), `${formatNumber(d.products.active)} active`],
    ['Low / out of stock', 'Low stock', formatNumber(d.lowStock.count), 'sellable sizes at or below reorder'],
  ];
  const secondary: Kpi[] = [
    ['Customers', 'Customers', formatNumber(d.customers.total), `${formatNumber(d.customers.active)} active`],
    ['Sellable SKUs', 'Sellable SKUs', formatNumber(d.variants.sellable), `${formatNumber(d.variants.units)} units`],
    ['Staff', 'Staff', formatNumber(d.staff.active), `${formatNumber(d.staff.invited)} invited`],
  ];
  const metric = ([key, label, value, sub]: Kpi) => (
    <div className="kpi" key={key} data-kpi={key} data-alert={key === 'Low / out of stock' && d.lowStock.count > 0 ? true : undefined}>
      <dt>{label}</dt><dd>{value}{sub && <small>{sub}</small>}</dd>
    </div>
  );
  const shortcuts = [
    can(actor, 'orders.read') && { href: '/orders?status=open', label: 'Open orders' },
    can(actor, 'inventory.read') && { href: '/inventory?status=attention', label: 'Sizes needing attention' },
    can(actor, 'products.write') && { href: '/products/new', label: 'New product' },
    can(actor, 'products.read') && { href: '/products', label: 'Catalogue' },
  ].filter((x): x is { href: string; label: string } => !!x);
  return (
    <>
      <PageHead section="Operations / Overview" title="Dashboard" eyebrow={`Live figures · ${formatDateTime(d.generatedAt)}`} />
      <dl className="kpis" data-kpis>{primary.map(metric)}</dl>
      <dl className="kpis minor" aria-label="More figures">{secondary.map(metric)}</dl>
      {shortcuts.length > 0 && (
        <nav className="shortcuts" aria-label="Shortcuts">
          {shortcuts.map(s => <Link key={s.href} href={s.href}>{s.label}<span aria-hidden="true">→</span></Link>)}
        </nav>
      )}
      <div className="grid two">
        <section className="card" aria-labelledby="low-h">
          <h2 id="low-h" className="section-title">Inventory alerts</h2>
          {d.lowStock.rows.length === 0
            ? <p className="empty" data-empty="low-stock">No sellable variant is at or below its reorder level.</p>
            : <div className="table-wrap"><table>
                <thead><tr><th>SKU</th><th>Product</th><th>Size</th><th className="num">Stock</th><th className="num">Reorder at</th><th>Status</th></tr></thead>
                <tbody>{d.lowStock.rows.map(r => (
                  <tr key={r.variant_id}><td className="mono">{r.variant_sku}</td><td>{r.product_name}</td><td>{r.size}</td>
                    <td className="num">{r.stock_qty}</td><td className="num">{r.reorder_level}</td><td><StatusBadge status={r.stock_status} /></td></tr>))}
                </tbody></table></div>}
        </section>
        <section className="card" aria-labelledby="act-h">
          <h2 id="act-h" className="section-title">Recent activity</h2>
          {!d.recentAudit ? <p className="note">Needs the audit.read permission.</p>
            : d.recentAudit.length === 0 ? <p className="empty">No activity recorded yet.</p>
            : <div className="table-wrap"><table>
                <thead><tr><th>When</th><th>Who</th><th>Action</th></tr></thead>
                <tbody>{d.recentAudit.map(a => (
                  <tr key={a.id}><td>{formatDateTime(a.occurred_at)}</td><td>{a.staff_email ?? a.actor_type}</td><td className="mono">{a.action}</td></tr>))}
                </tbody></table></div>}
          {d.recentAudit && d.recentAudit.length > 0 && <p className="section-foot"><Link className="btn ghost" href="/audit">Open the audit log</Link></p>}
        </section>
      </div>
    </>
  );
}
