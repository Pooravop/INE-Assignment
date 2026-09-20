import { useMemo, useState } from 'react';
import { dateTime, inr } from '../format';
import type { HistoryPoint } from '../types';

interface Props {
  points: HistoryPoint[];
  field: 'price' | 'stock';
  height?: number;
  color?: string;
  stepped?: boolean;
}

const W = 720;
const PAD = { l: 62, r: 16, t: 14, b: 30 };

const niceTicks = (lo: number, hi: number, n = 4, integers = false): number[] => {
  if (lo === hi) return [lo];
  const step = (hi - lo) / n;
  const ticks = Array.from({ length: n + 1 }, (_, i) => lo + step * i);
  // Whole-number axes (stock units) must not show "7, 7, 6, 6": round, then drop duplicates.
  return integers ? [...new Set(ticks.map((t) => Math.round(t)))] : ticks;
};

/** Dependency-free SVG line chart with hover read-out. */
export function Chart({ points, field, height = 220, color = 'var(--accent)', stepped = false }: Props) {
  const [hover, setHover] = useState<number | null>(null);

  const geo = useMemo(() => {
    const ys = points.map((p) => p[field]);
    if (!ys.length) return null;
    let lo = Math.min(...ys);
    let hi = Math.max(...ys);
    if (lo === hi) {
      const pad = Math.max(1, Math.abs(lo) * 0.05);
      lo -= pad;
      hi += pad;
    } else {
      const pad = (hi - lo) * 0.1;
      lo = Math.max(0, lo - pad);
      hi += pad;
    }
    const ts = points.map((p) => new Date(p.scrapedAt).getTime());
    const t0 = Math.min(...ts);
    const t1 = Math.max(...ts);
    const x = (t: number) => (t1 === t0 ? (PAD.l + (W - PAD.r)) / 2 : PAD.l + ((t - t0) / (t1 - t0)) * (W - PAD.l - PAD.r));
    const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (height - PAD.t - PAD.b);
    const xy = points.map((p, i) => ({ x: x(ts[i]!), y: y(p[field]), p }));
    let d = '';
    xy.forEach((pt, i) => {
      if (i === 0) d += `M${pt.x},${pt.y}`;
      else if (stepped) d += `H${pt.x}V${pt.y}`;
      else d += `L${pt.x},${pt.y}`;
    });
    return { xy, d, lo, hi, t0, t1, y };
  }, [points, field, height, stepped]);

  if (!geo) return <div className="chart-empty">No readings yet. The first one appears after the first successful scrape.</div>;

  const fmt = field === 'price' ? inr : (n: number) => String(Math.round(n));
  const yTicks = niceTicks(geo.lo, geo.hi, 4, field === 'stock');
  const xTicks = geo.t1 === geo.t0 ? [geo.t0] : niceTicks(geo.t0, geo.t1, Math.min(4, points.length - 1));
  const active = hover !== null ? geo.xy[hover] : null;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    geo.xy.forEach((pt, i) => {
      if (Math.abs(pt.x - px) < Math.abs(geo.xy[best]!.x - px)) best = i;
    });
    setHover(best);
  };

  return (
    <div className="chart-wrap">
      <svg
        viewBox={`0 0 ${W} ${height}`}
        className="chart"
        role="img"
        aria-label={`${field} history chart with ${points.length} readings`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={geo.y(v)} y2={geo.y(v)} className="grid" />
            <text x={PAD.l - 8} y={geo.y(v) + 4} textAnchor="end" className="tick">
              {fmt(v)}
            </text>
          </g>
        ))}
        {xTicks.map((t) => {
          const x = geo.t1 === geo.t0 ? geo.xy[0]!.x : PAD.l + ((t - geo.t0) / (geo.t1 - geo.t0)) * (W - PAD.l - PAD.r);
          return (
            <text key={t} x={x} y={height - 8} textAnchor="middle" className="tick">
              {dateTime(new Date(t).toISOString())}
            </text>
          );
        })}
        {points.length > 1 ? <path d={geo.d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" /> : null}
        {geo.xy.map((pt, i) => (
          <circle key={i} cx={pt.x} cy={pt.y} r={hover === i ? 5 : 3} fill={color} />
        ))}
        {active ? <line x1={active.x} x2={active.x} y1={PAD.t} y2={height - PAD.b} className="cursor" /> : null}
      </svg>
      <div className="chart-readout" aria-live="polite">
        {active ? (
          <>
            <strong>{fmt(active.p[field])}</strong> · {dateTime(active.p.scrapedAt)}
          </>
        ) : (
          <span className="muted">Hover the chart to read a value</span>
        )}
      </div>
    </div>
  );
}
