'use client';
/* Dashboard charts (Recharts): one palette (the accent for "now", a neutral for "before" and for other slices),
   soft gridlines, custom tooltips, no default chart chrome. Money arrives in paise. */
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

const inr = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const compact = (paise: number) => {
  const r = paise / 100;
  return r >= 1e7 ? `₹${(r / 1e7).toFixed(1)}Cr` : r >= 1e5 ? `₹${(r / 1e5).toFixed(1)}L` : r >= 1e3 ? `₹${(r / 1e3).toFixed(r >= 1e4 ? 0 : 1)}k` : `₹${r.toFixed(0)}`;
};
const dayLabel = (d: string) => new Date(`${d}T00:00:00+05:30`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

type Point = { day: string; revenue: number; prevRevenue: number; orders: number };

export function RevenueChart({ data }: { data: Point[] }) {
  return (
    <div className="chart" style={{ height: 260 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="rev-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.22} />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--hairline)" />
          <XAxis dataKey="day" tickFormatter={dayLabel} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={28}
            tick={{ fill: 'var(--faint)', fontSize: 12 }} dy={6} />
          <YAxis tickFormatter={compact} tickLine={false} axisLine={false} width={56} tick={{ fill: 'var(--faint)', fontSize: 12 }} />
          <Tooltip cursor={{ stroke: 'var(--border-strong)', strokeDasharray: '3 3' }} content={<RevenueTip />} />
          <Area type="monotone" dataKey="prevRevenue" name="Previous 30 days" stroke="var(--faint)" strokeWidth={1.5} strokeDasharray="4 4" fill="none" dot={false} activeDot={false} />
          <Area type="monotone" dataKey="revenue" name="Last 30 days" stroke="var(--accent)" strokeWidth={2} fill="url(#rev-fill)" dot={false}
            activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2, fill: 'var(--accent)' }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function RevenueTip({ active, payload }: { active?: boolean; payload?: { payload: Point }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0]!.payload;
  return (
    <div className="chart-tip">
      <b>{dayLabel(p.day)}</b>
      <span><i style={{ background: 'var(--accent)' }} />Sales {inr(p.revenue)}</span>
      <span><i style={{ background: 'var(--faint)' }} />Same day, previous period {inr(p.prevRevenue)}</span>
      <small>{p.orders} {p.orders === 1 ? 'order' : 'orders'}</small>
    </div>
  );
}

/* Category shares: the accent for the largest, then lighter tints of it and neutrals — one colour family. */
const SLICES = ['var(--accent)', 'color-mix(in srgb, var(--accent) 60%, var(--surface))', 'color-mix(in srgb, var(--accent) 32%, var(--surface))', 'var(--text-2)', 'var(--faint)', 'var(--border-strong)'];

export function CategoryDonut({ data, caption = '30 days' }: { data: { category: string; revenue: number }[]; caption?: string }) {
  const total = data.reduce((s, x) => s + x.revenue, 0);
  const top = data.slice(0, 5);
  const rest = data.slice(5).reduce((s, x) => s + x.revenue, 0);
  const slices = rest > 0 ? [...top, { category: 'Other', revenue: rest }] : top;
  return (
    <div className="donut-wrap">
      <div className="donut" style={{ width: 150, height: 150 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={slices} dataKey="revenue" nameKey="category" innerRadius={50} outerRadius={72} paddingAngle={slices.length > 1 ? 2 : 0} stroke="none" isAnimationActive={false}>
              {slices.map((s, i) => <Cell key={s.category} fill={SLICES[i % SLICES.length]} />)}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="donut-center"><b>{compact(total)}</b><small>{caption}</small></div>
      </div>
      <ul className="legend">
        {slices.map((s, i) => (
          <li key={s.category}><i style={{ background: SLICES[i % SLICES.length] }} />{s.category}
            <span>{inr(s.revenue)}</span><small>{total ? Math.round((s.revenue / total) * 100) : 0}%</small></li>
        ))}
      </ul>
    </div>
  );
}

/* Reports → Sales: one bar per day of the chosen range (days without sales show as empty), or per month when the
   range is longer than three months. */
export function SalesBars({ rows, from, to }: { rows: { day: string; orders: number; revenue: number }[]; from: string; to: string }) {
  const byDay = new Map(rows.map(r => [r.day, r]));
  const days: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`); t <= end && days.length < 4000; t += 86_400_000) days.push(new Date(t).toISOString().slice(0, 10));
  const monthly = days.length > 92;
  const buckets = new Map<string, { key: string; revenue: number; orders: number }>();
  for (const d of days) {
    const key = monthly ? d.slice(0, 7) : d;
    const b = buckets.get(key) ?? { key, revenue: 0, orders: 0 };
    const r = byDay.get(d);
    if (r) { b.revenue += r.revenue; b.orders += r.orders; }
    buckets.set(key, b);
  }
  const data = [...buckets.values()];
  const label = (k: string) => monthly
    ? new Date(`${k}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' })
    : new Date(`${k}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return (
    <div className="chart" style={{ height: 240 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--hairline)" />
          <XAxis dataKey="key" tickFormatter={label} tickLine={false} axisLine={false} minTickGap={24} tick={{ fill: 'var(--faint)', fontSize: 12 }} dy={6} />
          <YAxis tickFormatter={compact} tickLine={false} axisLine={false} width={56} tick={{ fill: 'var(--faint)', fontSize: 12 }} />
          <Tooltip cursor={{ fill: 'var(--surface-3)' }} content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const p = payload[0]!.payload as { key: string; revenue: number; orders: number };
            return <div className="chart-tip"><b>{label(p.key)}</b><span><i style={{ background: 'var(--accent)' }} />Sales {inr(p.revenue)}</span><small>{p.orders} {p.orders === 1 ? 'order' : 'orders'}</small></div>;
          }} />
          <Bar dataKey="revenue" fill="var(--accent)" radius={[6, 6, 0, 0]} maxBarSize={28} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
