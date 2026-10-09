/* Server-rendered trend pieces for KPI cards: a change chip (vs the previous period) and a tiny sparkline (plain SVG,
   no script). A change is shown only when the previous period had something to compare with. */

/** Direction of a figure against the previous period: the same rule the change chip shows. */
export function trendDirection(now: number, before: number): 'up' | 'down' | 'flat' {
  if (!before) return 'flat';
  const pct = Math.round(((now - before) / before) * 1000) / 10;
  return pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
}

export function Delta({ now, before, label = 'vs prior 30d' }: { now: number; before: number; label?: string }) {
  if (!before) return <span className="delta flat" title={now ? 'Nothing in the previous 30 days to compare with' : 'No change'}><b>{now ? 'New' : '—'}</b><small>{label}</small></span>;
  const pct = Math.round(((now - before) / before) * 1000) / 10;
  const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  return (
    <span className={`delta ${dir}`} title={label} data-delta={pct}>
      <b>{dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→'} {Math.abs(pct)}%</b><small>{label}</small>
    </span>
  );
}

export function Sparkline({ values, width = 96, height = 32, tone }: { values: number[]; width?: number; height?: number;
  /** Colour it by direction (green up, red down, slate unchanged). Without it the sparkline uses the accent. */
  tone?: 'up' | 'down' | 'flat' }) {
  if (values.length < 2) return null;
  const max = Math.max(...values), min = Math.min(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * width, height - 3 - ((v - min) / span) * (height - 6)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const flat = max === min;
  return (
    <svg className={`spark${tone ? ` ${tone}` : ''}`} data-tone={tone} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false">
      {!flat && <path d={`${line} L${width},${height} L0,${height} Z`} className="spark-fill" />}
      <path d={flat ? `M0,${height - 3} L${width},${height - 3}` : line} className="spark-line" />
    </svg>
  );
}
