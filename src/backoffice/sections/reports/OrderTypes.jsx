// v4.6.18: Order types trend report.
// Shows channel mix (dine-in / takeaway / delivery / bar / counter / other) over the period.
//
// Layout:
//   - Top tiles: total revenue, dominant channel, fastest-growing vs previous period
//   - Stacked bar chart by day (or by hour if single-day) showing channel composition
//   - Per-channel table with check count, revenue, avg check, share %, and period compare

import { useMemo } from 'react';
import { StatTile, ExportBtn, EmptyState, CompareChip } from './_charts';
import { pctDelta } from './_filters';
import { toCsv, downloadCsv } from './_csv';
import { currencySymbol } from '../../../lib/currency';

const TYPE_STYLE = {
  'dine-in':    { label:'Dine-in',    color:'#e8a020', icon:'🪑' },
  'takeaway':   { label:'Takeaway',   color:'#22c55e', icon:'🥡' },
  'collection': { label:'Collection', color:'#22c55e', icon:'📦' },
  'delivery':   { label:'Delivery',   color:'#3b82f6', icon:'🛵' },
  'bar':        { label:'Bar',        color:'#a78bfa', icon:'🍸' },
  'counter':    { label:'Counter',    color:'#f97316', icon:'🏷' },
  'other':      { label:'Other',      color:'var(--t4)', icon:'?' },
};

const styleFor = (t) => TYPE_STYLE[t] || TYPE_STYLE.other;

// Exported (v5.5.856) — shared with the Order sources report (keyFn = grouping).
export function aggregate(checks, keyFn) {
  const byType = {};
  checks.filter(c => c.status !== 'voided').forEach(c => {
    const t = keyFn(c);
    if (!byType[t]) byType[t] = { type: t, checks: 0, revenue: 0 };
    byType[t].checks  += 1;
    byType[t].revenue += c.total || 0;
  });
  return byType;
}

export default function OrderTypes({ checks, prevChecks, fmt, fmtN }) {
  const typeKey = (c) => c.orderType || 'dine-in';
  const cur  = useMemo(() => aggregate(checks,     typeKey), [checks]);
  const prev = useMemo(() => aggregate(prevChecks, typeKey), [prevChecks]);

  const allTypes = Array.from(new Set([...Object.keys(cur), ...Object.keys(prev)]));

  const totalRev  = Object.values(cur).reduce((s, r) => s + r.revenue, 0);
  const totalChks = Object.values(cur).reduce((s, r) => s + r.checks, 0);

  // Build rows with compare
  const rows = useMemo(() => allTypes.map(t => {
    const c = cur[t]  || { checks: 0, revenue: 0 };
    const p = prev[t] || { checks: 0, revenue: 0 };
    return {
      type: t,
      checks: c.checks, revenue: c.revenue,
      prevChecks: p.checks, prevRevenue: p.revenue,
      revDelta: pctDelta(c.revenue, p.revenue),
      share:    totalRev > 0 ? (c.revenue / totalRev) * 100 : 0,
      avgCheck: c.checks ? c.revenue / c.checks : 0,
    };
  }).sort((a, b) => b.revenue - a.revenue), [allTypes, cur, prev, totalRev]);

  // Time series — group by day; if the range is a single day, group by hour
  const { series, xLabels, isHourly } = useMemo(() => {
    const times = checks.filter(c => c.status !== 'voided' && c.closedAt).map(c => c.closedAt);
    if (times.length === 0) return { series: {}, xLabels: [], isHourly: false };
    const min = Math.min(...times);
    const max = Math.max(...times);
    const rangeDays = (max - min) / 86400000;
    const hourly = rangeDays < 1.5;
    const buckets = {};
    checks.filter(c => c.status !== 'voided' && c.closedAt).forEach(c => {
      const d = new Date(c.closedAt);
      const key = hourly
        ? `${d.getHours()}`
        : `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      if (!buckets[key]) buckets[key] = { key, total: 0 };
      const t = c.orderType || 'dine-in';
      buckets[key][t] = (buckets[key][t] || 0) + (c.total || 0);
      buckets[key].total += (c.total || 0);
    });
    const keys = Object.keys(buckets).sort((a, b) => {
      if (hourly) return parseInt(a) - parseInt(b);
      return a.localeCompare(b);
    });
    return {
      series: buckets,
      xLabels: keys.map(k => hourly ? `${k}:00` : new Date(k).toLocaleDateString('en-GB', { day:'numeric', month:'short' })),
      xKeys: keys,
      isHourly: hourly,
    };
  }, [checks]);

  const xKeys = useMemo(() => Object.keys(series).sort((a, b) => {
    if (isHourly) return parseInt(a) - parseInt(b);
    return a.localeCompare(b);
  }), [series, isHourly]);

  const onExport = () => {
    const csv = toCsv(rows, [
      { label:'Order type',       key: r => styleFor(r.type).label },
      { label:'Checks',           key:'checks' },
      { label:'Revenue',          key: r => r.revenue.toFixed(2) },
      { label:'Avg check',        key: r => r.avgCheck.toFixed(2) },
      { label:'Share %',          key: r => r.share.toFixed(2) },
      { label:'Previous revenue', key: r => r.prevRevenue.toFixed(2) },
      { label:'Change %',         key: r => r.revDelta === null ? '' : r.revDelta.toFixed(2) },
    ]);
    downloadCsv(`order-types-${new Date().toISOString().slice(0,10)}.csv`, csv);
  };

  if (rows.length === 0 || totalRev === 0) return <EmptyState icon="📦" message="No orders in this period."/>;

  const dominant = rows[0];
  const fastestGrowth = [...rows].filter(r => r.revDelta !== null && r.prevRevenue > 0).sort((a, b) => (b.revDelta || 0) - (a.revDelta || 0))[0];

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:12 }}><ExportBtn onClick={onExport}/></div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:18 }}>
        <StatTile label="Total revenue"    value={fmt(totalRev)}    sub={`${fmtN(totalChks)} checks`} color="var(--acc)"/>
        <StatTile label="Dominant channel" value={styleFor(dominant.type).label} sub={`${dominant.share.toFixed(1)}% of revenue`} color={styleFor(dominant.type).color}/>
        {fastestGrowth ? (
          <StatTile label="Fastest growing" value={styleFor(fastestGrowth.type).label} compare={fastestGrowth.revDelta} color={styleFor(fastestGrowth.type).color}/>
        ) : (
          <StatTile label="Growth trend" value="—" sub="no prior period data"/>
        )}
      </div>

      {/* Stacked bar chart over time */}
      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, padding:'16px', marginBottom:14 }}>
        <div style={{ fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:14, display:'flex', justifyContent:'space-between' }}>
          <span>Channel mix {isHourly ? 'by hour' : 'by day'}</span>
          <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
            {allTypes.map(t => (
              <span key={t} style={{ display:'inline-flex', alignItems:'center', gap:4, fontSize:10, color:'var(--t3)', textTransform:'none', letterSpacing:'normal' }}>
                <span style={{ width:10, height:10, borderRadius:2, background: styleFor(t).color }}/>
                {styleFor(t).label}
              </span>
            ))}
          </div>
        </div>

        {xKeys.length === 0 ? (
          <div style={{ textAlign:'center', padding:'32px 0', color:'var(--t4)', fontSize:12 }}>No time-series data.</div>
        ) : (
          <StackedBarChart series={series} xKeys={xKeys} xLabels={xKeys.map(k => isHourly ? `${k}:00` : new Date(k).toLocaleDateString('en-GB', { day:'numeric', month:'short' }))} types={allTypes} fmt={fmt}/>
        )}
      </div>

      {/* Per-channel breakdown table */}
      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, overflow:'hidden' }}>
        <div style={{ display:'grid', gridTemplateColumns:'50px 1.3fr 80px 110px 90px 80px 100px', padding:'9px 14px', background:'var(--bg3)', borderBottom:'1px solid var(--bdr)', fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.06em', gap:8 }}>
          <span/>
          <span>Channel</span>
          <span style={{ textAlign:'right' }}>Checks</span>
          <span style={{ textAlign:'right' }}>Revenue</span>
          <span style={{ textAlign:'right' }}>Avg check</span>
          <span style={{ textAlign:'right' }}>Share</span>
          <span>vs previous</span>
        </div>
        {rows.map(r => {
          const st = styleFor(r.type);
          return (
            <div key={r.type} style={{ display:'grid', gridTemplateColumns:'50px 1.3fr 80px 110px 90px 80px 100px', padding:'10px 14px', borderBottom:'1px solid var(--bdr)', fontSize:12, alignItems:'center', gap:8 }}>
              <span style={{ fontSize:16, textAlign:'center' }}>{st.icon}</span>
              <span style={{ color:'var(--t1)', fontWeight:600 }}>{st.label}</span>
              <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{r.checks}</span>
              <span style={{ textAlign:'right', color: st.color, fontFamily:'var(--font-mono)', fontWeight:700 }}>{fmt(r.revenue)}</span>
              <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{fmt(r.avgCheck)}</span>
              <span style={{ textAlign:'right', color:'var(--t3)', fontFamily:'var(--font-mono)' }}>{r.share.toFixed(1)}%</span>
              <span><CompareChip pct={r.revDelta}/></span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Exported (v5.5.856) — shared with the Order sources report; styleFor is injectable
// so each report supplies its own key→{label,color} resolver.
export function StackedBarChart({ series, xKeys, xLabels, types, fmt, styleFor: styleForProp }) {
  const styleFor = styleForProp || ((t) => TYPE_STYLE[t] || TYPE_STYLE.other);
  const W = 720, H = 220;
  const padL = 40, padR = 12, padT = 12, padB = 30;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const barW   = chartW / xKeys.length;
  const max    = Math.max(1, ...xKeys.map(k => series[k].total));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width:'100%', height:'auto', minWidth:600, display:'block' }}>
      {/* Y-axis ticks */}
      {[0, 0.5, 1].map(f => {
        const y = padT + chartH * (1 - f);
        return (
          <g key={f}>
            <line x1={padL} y1={y} x2={padL + chartW} y2={y} stroke="var(--bdr)" strokeDasharray="2 3"/>
            <text x={padL - 4} y={y + 3} fontSize="9" fill="var(--t4)" textAnchor="end" fontFamily="var(--font-mono)">
              {currencySymbol()}{Math.round(max * f)}
            </text>
          </g>
        );
      })}

      {/* Stacked bars */}
      {xKeys.map((k, i) => {
        const x = padL + i * barW + 2;
        const w = Math.max(2, barW - 4);
        let y = padT + chartH;
        return (
          <g key={k}>
            {types.map(t => {
              const v = series[k][t] || 0;
              if (v === 0) return null;
              const h = (v / max) * chartH;
              y -= h;
              return (
                <rect key={t} x={x} y={y} width={w} height={h} fill={styleFor(t).color} opacity="0.9">
                  <title>{`${xLabels[i]} — ${styleFor(t).label}: ${fmt(v)}`}</title>
                </rect>
              );
            })}
            {i % Math.max(1, Math.floor(xKeys.length / 10)) === 0 && (
              <text x={x + w/2} y={H - 10} fontSize="9" fill="var(--t4)" textAnchor="middle" fontFamily="var(--font-mono)">{xLabels[i]}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
