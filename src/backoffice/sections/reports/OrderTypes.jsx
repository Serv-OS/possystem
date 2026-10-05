// v4.6.18: Order types trend report.
// Shows channel mix (dine-in / takeaway / delivery / bar / counter / drive-thru / other) over the period.
//
// Layout:
//   - Top tiles: total revenue, dominant channel, fastest-growing vs previous period
//   - Stacked bar chart by day (or by hour if single-day) showing channel composition
//     (v5.11.1: the venue's business days and hours, mixSeries in _filters.js)
//   - Per-channel table with check count, revenue, avg check, share %, and period compare

import { useMemo } from 'react';
import { StatTile, ExportBtn, EmptyState, CompareChip } from './_charts';
import { pctDelta, reportClock, mixSeries, mixLabel } from './_filters';
import { toCsv, downloadCsv } from './_csv';
import { currencySymbol } from '../../../lib/currency';
import { isSplit, keyedMatrix, orderTypesFromSums } from '../../../lib/reportSplit.js';
import { useParts, exportSites } from './_siteSplit';
import { SplitHeader, Blocks, GroupChange, SiteChange, SiteMatrix } from './SiteSplit';

const TYPE_STYLE = {
  'dine-in':    { label:'Dine-in',    color:'#e8a020', icon:'🪑' },
  'takeaway':   { label:'Takeaway',   color:'#22c55e', icon:'🥡' },
  'collection': { label:'Collection', color:'#22c55e', icon:'📦' },
  'delivery':   { label:'Delivery',   color:'#3b82f6', icon:'🛵' },
  'bar':        { label:'Bar',        color:'#a78bfa', icon:'🍸' },
  'counter':    { label:'Counter',    color:'#f97316', icon:'🏷' },
  // Drive thru (16 Sep 2026): pink, the one hue no other row here uses.
  'drive-thru': { label:'Drive thru', color:'#ec4899', icon:'🚗' },
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

// 5 Oct 2026 (Peter: "make every report we have multi site when sites are connected
// together"): with more than one site on screen this is the site split (MixSites, shared
// with Order sources). One site is the report exactly as it was.
const orderTypeKey = (c) => c.orderType || 'dine-in';
const orderTypeStyles = () => styleFor;
export default function OrderTypes(props) {
  if (!isSplit(props.sites)) return <OrderTypesOne {...props}/>;
  return <MixSites {...props} name="order-types" keyOf={orderTypeKey} fromSums={orderTypesFromSums}
    styleOf={orderTypeStyles} first="Channel" keyLabel="Order type" leadLabel="Dominant channel" icon="📦"/>;
}

// Several sites, for a report that is a mix of named things (order types, order sources):
// the group's mix on top, then a column per site. Each site's rows are added with the same
// `aggregate` one site uses; a long period reads the server day sums instead (fromSums).
//   keyOf       a check's key           styleOf(cur)  => (key) => { label, color }
//   fromSums    (sums) => { [key]: { checks, revenue } }, or null when the sums cannot answer
export function MixSites(props) {
  const { fmtN, name, keyOf, fromSums: sumsRows, styleOf, first, keyLabel, leadLabel, icon } = props;
  const { parts, blocks, fromSums } = useParts(props);
  const bySite = useMemo(() => new Map(parts.map(p => [p.id, {
    cur:  p.sums && sumsRows ? sumsRows(p.sums.totals)      : aggregate(p.rows, keyOf),
    prev: p.sums && sumsRows ? sumsRows(p.prevSums?.totals) : aggregate(p.prevRows, keyOf),
  }])), [parts, keyOf, sumsRows]);
  const revenueOf = (map) => Object.values(map).reduce((s, r) => s + r.revenue, 0);
  const checksOf  = (map) => Object.values(map).reduce((s, r) => s + r.checks, 0);
  const styleFor = useMemo(() => {
    const all = {};
    for (const { cur } of bySite.values()) for (const [k, r] of Object.entries(cur)) (all[k] ||= { revenue: 0 }).revenue += r.revenue;
    return styleOf(all);
  }, [bySite, styleOf]);

  const onExport = () => {
    const rows = [];
    for (const p of parts) {
      const { cur, prev } = bySite.get(p.id);
      const total = revenueOf(cur);
      const compared = !!p.compare && p.compare.loaded !== false;
      for (const k of new Set([...Object.keys(cur), ...Object.keys(prev)])) {
        const c = cur[k] || { checks: 0, revenue: 0 }, pr = prev[k] || { checks: 0, revenue: 0 };
        rows.push({ siteName: p.name, currency: p.currency || '', label: styleFor(k).label, checks: c.checks, revenue: c.revenue,
          avgCheck: c.checks ? c.revenue / c.checks : 0, share: total > 0 ? (c.revenue / total) * 100 : 0,
          prevRevenue: compared ? pr.revenue : null, revDelta: compared ? pctDelta(c.revenue, pr.revenue) : null });
      }
    }
    exportSites(name, rows, [
      { label:'Currency',         key:'currency' },
      { label: keyLabel,          key:'label' },
      { label:'Checks',           key:'checks' },
      { label:'Revenue',          key: r => r.revenue.toFixed(2) },
      { label:'Avg check',        key: r => r.avgCheck.toFixed(2) },
      { label:'Share %',          key: r => r.share.toFixed(2) },
      { label:'Previous revenue', key: r => (r.prevRevenue == null ? '' : r.prevRevenue.toFixed(2)) },
      { label:'Change %',         key: r => (r.revDelta == null ? '' : r.revDelta.toFixed(2)) },
    ]);
  };

  if (parts.every(p => revenueOf(bySite.get(p.id).cur) === 0)) return <EmptyState icon={icon} message="No orders at these sites in this period."/>;

  return (
    <div>
      <SplitHeader parts={parts} fromSums={fromSums} onExport={onExport}/>
      <Blocks blocks={blocks}>{b => {
        const m = keyedMatrix(b.parts, p => Object.fromEntries(Object.entries(bySite.get(p.id).cur).map(([k, r]) => [k, r.revenue])));
        const checks = b.parts.reduce((s, p) => s + checksOf(bySite.get(p.id).cur), 0);
        const lead = m.rows[0];
        const rows = [
          { key:'__total', label:'Total revenue', strong:true, total: m.total, bySite: m.bySite },
          ...m.rows.map(r => ({ ...r, label: <span><span style={{ display:'inline-block', width:10, height:10, borderRadius:2, background: styleFor(r.key).color, marginRight:6 }}/>{styleFor(r.key).label}</span> })),
          { key:'__checks', label:'Checks', kind:'count', total: checks, bySite: Object.fromEntries(b.parts.map(p => [p.id, checksOf(bySite.get(p.id).cur)])) },
          { key:'__change', label:'Change', render: p => <SiteChange part={p} values={[revenueOf(bySite.get(p.id).cur), revenueOf(bySite.get(p.id).prev)]}/> },
        ];
        return (
          <>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:18 }}>
              <StatTile label="Total revenue" value={b.fmt(m.total)} sub={`${fmtN(checks)} checks`} color="var(--acc)"/>
              {lead && <StatTile label={leadLabel} value={styleFor(lead.key).label} sub={`${(m.total > 0 ? (lead.total / m.total) * 100 : 0).toFixed(1)}% of revenue`} color={styleFor(lead.key).color}/>}
              {b.parts.every(p => p.compare) && (
                <StatTile label="Against the comparison" value={<GroupChange block={b} pairs={b.parts.map(p => ({ current: revenueOf(bySite.get(p.id).cur), previous: revenueOf(bySite.get(p.id).prev) }))}/>}/>
              )}
            </div>
            <SiteMatrix block={b} rows={rows} first={first} fmtN={fmtN}/>
          </>
        );
      }}</Blocks>
    </div>
  );
}

function OrderTypesOne({ checks, prevChecks, fmt, fmtN, locationConfig, compare }) {
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

  // Time series: one bar per venue business day, or per venue hour when every sale is on
  // one business day (v5.11.1: was the browser's midnights and hours).
  const clock = useMemo(() => reportClock(locationConfig), [locationConfig]);
  const { series, xKeys, isHourly } = useMemo(() => mixSeries(checks, typeKey, clock), [checks, clock]);

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
          <StatTile label="Fastest growing" value={styleFor(fastestGrowth.type).label} vs={compare} values={[fastestGrowth.revenue, fastestGrowth.prevRevenue]} color={styleFor(fastestGrowth.type).color}/>
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
          <StackedBarChart series={series} xKeys={xKeys} xLabels={xKeys.map(k => mixLabel(k, isHourly))} types={allTypes} fmt={fmt}/>
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
          <span>{compare?.label || 'vs previous'}</span>
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
              <span><CompareChip vs={compare} values={[r.revenue, r.prevRevenue]} short/></span>
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
