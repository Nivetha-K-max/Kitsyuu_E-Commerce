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
  /* Redesign 2026-10-15: one small bar per day (like the sales chart), so a day with a sale reads as a day, not a spike.
     Bars start from zero; a day with nothing sold shows a hairline stub. */
  const max = Math.max(...values, 0) || 1, gap = 1.5, w = Math.max(1, (width - gap * (values.length - 1)) / values.length);
  return (
    <svg className={`spark spark-bars${tone ? ` ${tone}` : ''}`} data-tone={tone} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false">
      {values.map((v, i) => { const h = v > 0 ? Math.max(2, (v / max) * (height - 2)) : 1;
        return <rect key={i} className={v > 0 ? 'spark-bar' : 'spark-stub'} x={(i * (w + gap)).toFixed(1)} y={(height - h).toFixed(1)} width={w.toFixed(1)} height={h.toFixed(1)} rx={Math.min(1.5, w / 2)} />; })}
    </svg>
  );
}
