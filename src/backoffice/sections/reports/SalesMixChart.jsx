// The Sales mix share chart (8 Oct 2026): each group's share of item sales per day, or per
// hour when the range is one day, as a stack that always reaches 100 percent. A copy of
// OrderTypes.StackedBarChart, not an import, because the stack rule differs: every bucket is
// normalised to its own total (salesMix.shareSeries hands the whole percents in), so the eye
// reads the MIX moving over time, not the volume. Plain SVG, as the other reports draw.
//
//   money   mixSeriesLines output (money per bucket per group), for the hover title
//   share   shareSeries output (whole percents per bucket, 100 in all)
//   names   { [groupKey]: name }     tones { [groupKey]: tone }

import { mixLabel } from './_filters';
import { toneVar } from '../../../lib/salesMixView.js';

export function ShareChart({ money, share, names = {}, tones = {}, fmt }) {
  const xKeys = share?.xKeys || [];
  const keys = share?.keys || [];
  const isHourly = !!share?.isHourly;
  const W = 720, H = 220;
  const padL = 40, padR = 12, padT = 12, padB = 30;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const barW = chartW / Math.max(1, xKeys.length);
  const every = Math.max(1, Math.ceil(xKeys.length / 12));
  const label = (k) => mixLabel(k, isHourly);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width:'100%', height:'auto', minWidth:600, display:'block' }} role="img" aria-label={`Share of item sales by group ${isHourly ? 'by hour' : 'by day'}`}>
      {/* Y axis: a share always runs 0 to 100 */}
      {[0, 50, 100].map((p) => {
        const y = padT + chartH * (1 - p / 100);
        return (
          <g key={p}>
            <line x1={padL} y1={y} x2={padL + chartW} y2={y} stroke="var(--bdr)" strokeDasharray="2 3"/>
            <text x={padL - 4} y={y + 3} fontSize="9" fill="var(--t4)" textAnchor="end" fontFamily="var(--font-mono)">{p}%</text>
          </g>
        );
      })}

      {/* One stack per bucket, rank 1 at the bottom, Other sales (last key) on top */}
      {xKeys.map((k, i) => {
        const x = padL + i * barW + 2;
        const w = Math.max(2, barW - 4);
        const b = share.series?.[k] || {};
        const m = money?.series?.[k] || {};
        let y = padT + chartH;
        return (
          <g key={k}>
            {keys.map((g) => {
              const s = Number(b[g]) || 0;
              if (s <= 0) return null;
              const h = (s / 100) * chartH;
              y -= h;
              return (
                <rect key={g} x={x} y={y} width={w} height={h} fill={toneVar(tones[g])} opacity="0.9">
                  <title>{`${label(k)}, ${names[g] || g}: ${fmt ? fmt(m[g] || 0) : (m[g] || 0)} (${s}%)`}</title>
                </rect>
              );
            })}
            {i % every === 0 && (
              <text x={x + w / 2} y={H - 10} fontSize="9" fill="var(--t4)" textAnchor="middle" fontFamily="var(--font-mono)">{label(k)}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** The legend the chart card's header shows: a swatch and a name per group, in the view's order. */
export function ShareLegend({ keys = [], names = {}, tones = {} }) {
  return (
    <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
      {keys.map((k) => (
        <span key={k} style={{ display:'inline-flex', alignItems:'center', gap:4, fontSize:10, color:'var(--t3)', textTransform:'none', letterSpacing:'normal' }}>
          <span style={{ width:10, height:10, borderRadius:2, background: toneVar(tones[k]) }}/>
          {names[k] || k}
        </span>
      ))}
    </div>
  );
}
