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
  if (!can(actor, 'dashboard.read')) return <><PageHead title="Dashboard" /><Forbidden permission="dashboard.read" /></>;
  const d = await getDashboard(db(), actor);
  const kpis: [string, string, string?][] = [
    ['Revenue (paid orders)', formatPaise(d.revenue.totalPaise), `today ${formatPaise(d.revenue.todayPaise)}`],
    ['Orders', formatNumber(d.orders.total), `${formatNumber(d.orders.open)} open`],
    ['Customers', formatNumber(d.customers.total), `${formatNumber(d.customers.active)} active`],
    ['Products', formatNumber(d.products.total), `${formatNumber(d.products.active)} active`],
    ['Sellable SKUs', formatNumber(d.variants.sellable), `${formatNumber(d.variants.units)} units`],
    ['Low / out of stock', formatNumber(d.lowStock.count)],
    ['Staff', formatNumber(d.staff.active), `${formatNumber(d.staff.invited)} invited`],
  ];
  return (
    <>
      <PageHead title="Dashboard" eyebrow={`Live figures · ${formatDateTime(d.generatedAt)}`} />
      <dl className="grid kpis" data-kpis>
        {kpis.map(([label, value, sub]) => (
          <div className="card kpi" key={label} data-kpi={label}>
            <dt>{label}</dt><dd>{value}{sub && <small>{sub}</small>}</dd>
          </div>
        ))}
      </dl>
      <div className="grid two" style={{ marginTop: 14 }}>
        <section className="card" aria-labelledby="low-h">
          <h2 id="low-h">Inventory alerts</h2>
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
          <h2 id="act-h">Recent activity</h2>
          {!d.recentAudit ? <p className="note">Needs the audit.read permission.</p>
            : d.recentAudit.length === 0 ? <p className="empty">No activity recorded yet.</p>
            : <div className="table-wrap"><table>
                <thead><tr><th>When</th><th>Who</th><th>Action</th></tr></thead>
                <tbody>{d.recentAudit.map(a => (
                  <tr key={a.id}><td>{formatDateTime(a.occurred_at)}</td><td>{a.staff_email ?? a.actor_type}</td><td className="mono">{a.action}</td></tr>))}
                </tbody></table></div>}
          {d.recentAudit && d.recentAudit.length > 0 && <p style={{ marginTop: 10 }}><Link className="btn ghost" href="/audit">Open the audit log</Link></p>}
        </section>
      </div>
    </>
  );
}
