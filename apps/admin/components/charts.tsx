'use client';
/* Dashboard charts (Recharts): soft gridlines, custom tooltips, no default chart chrome. Money arrives in paise.
   The Sales line is coloured by what sales did between one day and the next: green where they rose, red where they
   fell, slate where they stayed about the same. The colours come from the data on every render, never from a fixed
   rule about the period as a whole. */
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

const inr = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const compact = (paise: number) => {
  const r = paise / 100;
  return r >= 1e7 ? `₹${(r / 1e7).toFixed(1)}Cr` : r >= 1e5 ? `₹${(r / 1e5).toFixed(1)}L` : r >= 1e3 ? `₹${(r / 1e3).toFixed(r >= 1e4 ? 0 : 1)}k` : `₹${r.toFixed(0)}`;
};
const dayLabel = (d: string) => new Date(`${d}T00:00:00+05:30`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

type Point = { day: string; revenue: number; prevRevenue: number; orders: number };

type Direction = 'up' | 'down' | 'flat';
/* Lines and dots use the soft trend tones; the sentence in the tooltip uses the stronger text tokens so it stays readable. */
const TONE: Record<Direction, string> = { up: 'var(--trend-up)', down: 'var(--trend-down)', flat: 'var(--trend-flat)' };
const TEXT_TONE: Record<Direction, string> = { up: 'var(--success)', down: 'var(--danger)', flat: 'var(--muted)' };
const WORD: Record<Direction, string> = { up: 'Up', down: 'Down', flat: 'No change' };
/** How sales moved from one value to the next. "About the same" is a move smaller than 2% of the largest day in view
    (so tiny wobbles, and days with nothing sold either side, read as stable). */
export function direction(from: number, to: number, scale: number): Direction {
  const diff = to - from;
  if (Math.abs(diff) <= Math.max(1, scale * 0.02)) return 'flat';
  return diff > 0 ? 'up' : 'down';
}

export function RevenueChart({ data }: { data: Point[] }) {
  const scale = Math.max(0, ...data.map(d => d.revenue));
  // Segment i runs from day i to day i + 1. The days are evenly spaced, so segment i covers i/(n-1) â€¦ (i+1)/(n-1) of
  // the line's width: a left-to-right gradient with a hard stop at each day gives every segment its own colour.
  const segments = data.slice(1).map((d, i) => direction(data[i]!.revenue, d.revenue, scale));
  const dirAt = new Map(data.map((d, i) => [d.day, i === 0 ? 'flat' as Direction : segments[i - 1]!]));
  const n = Math.max(1, segments.length);
  const stops = segments.flatMap((dir, i) => [{ at: i / n, dir }, { at: (i + 1) / n, dir }]);
  // A line with no rise or fall at all has no height for a gradient to map onto: it is simply drawn in slate.
  const varied = segments.some(s => s !== 'flat');
  const stroke = varied ? 'url(#rev-line)' : TONE.flat;
  return (
    <div className="chart" style={{ height: 260 }} data-sales-chart data-segments={segments.join(',')}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="rev-line" x1="0" y1="0" x2="1" y2="0">
              {stops.map((s, i) => <stop key={i} offset={`${(s.at * 100).toFixed(3)}%`} stopColor={TONE[s.dir]} />)}
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--hairline)" />
          <XAxis dataKey="day" tickFormatter={dayLabel} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={28}
            tick={{ fill: 'var(--faint)', fontSize: 12 }} dy={6} />
          <YAxis tickFormatter={compact} tickLine={false} axisLine={false} width={56} tick={{ fill: 'var(--faint)', fontSize: 12 }} />
          <Tooltip cursor={{ stroke: 'var(--border-strong)', strokeDasharray: '3 3' }} content={<RevenueTip data={data} dirAt={dirAt} />} />
          <Area type="monotone" dataKey="prevRevenue" name="Previous 30 days" stroke="var(--faint)" strokeWidth={1.5} strokeDasharray="4 4" fill="none" dot={false} activeDot={false} />
          <Area type="monotone" dataKey="revenue" name="Last 30 days" stroke={stroke} strokeWidth={2} fill={stroke} fillOpacity={0.12} dot={false} isAnimationActive={false}
            activeDot={(p: { cx?: number; cy?: number; payload?: Point }) => <circle cx={p.cx} cy={p.cy} r={4} stroke="var(--surface)" strokeWidth={2} fill={TONE[dirAt.get(p.payload?.day ?? '') ?? 'flat']} />} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function RevenueTip({ active, payload, data, dirAt }: { active?: boolean; payload?: { payload: Point }[]; data: Point[]; dirAt: Map<string, Direction> }) {
  if (!active || !payload?.length) return null;
  const p = payload[0]!.payload;
  const i = data.findIndex(d => d.day === p.day);
  const dir = dirAt.get(p.day) ?? 'flat';
  const diff = i > 0 ? p.revenue - data[i - 1]!.revenue : 0;
  return (
    <div className="chart-tip" data-direction={dir}>
      <b>{dayLabel(p.day)}</b>
      <span><i style={{ background: TONE[dir] }} />Sales {inr(p.revenue)}</span>
      {i > 0 && <span style={{ color: TEXT_TONE[dir] }}>{WORD[dir]}{dir === 'flat' ? '' : ` ${inr(Math.abs(diff))}`} from the day before</span>}
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
