// v5.5.856: Order sources report — where each sale was taken: POS till, kiosk, online,
// QR, catering, and EACH delivery platform by name (Deliveroo / Uber Eats / Just Eat…).
// 'hubrise' is the pipe, never a source — channel checks split by the platform on the
// order (customer.channel). Split out of Order types into its own catalog entry so it's
// findable; the Overview's "Sales by channel" card shows the same split for today.
//
// Layout mirrors Order types: tiles → stacked time chart → per-source table → CSV.

import { useMemo } from 'react';
import { StatTile, ExportBtn, EmptyState, CompareChip } from './_charts';
import { pctDelta } from './_filters';
import { toCsv, downloadCsv } from './_csv';
import { aggregate, StackedBarChart } from './OrderTypes';

const SOURCE_STYLE = {
  pos:      { label:'POS',      color:'#e8a020', icon:'🖥' },
  mpos:     { label:'Mobile POS', color:'#22d3ee', icon:'📲' },
  kiosk:    { label:'Kiosk',    color:'#0ea5e9', icon:'📟' },
  online:   { label:'Online',   color:'#10b981', icon:'🌐' },
  qr:       { label:'QR code',  color:'#a855f7', icon:'📱' },
  catering: { label:'Catering', color:'#f97316', icon:'🍽' },
};
// Distinct colours for the delivery platforms (assigned in revenue order).
const PLATFORM_COLORS = ['#ef4444', '#3b82f6', '#84cc16', '#ec4899', '#14b8a6', '#eab308'];

export const srcKey = (c) => c.source === 'hubrise' ? (c.customer?.channel || 'Delivery channel') : (c.source || 'pos');

export default function OrderSources({ checks, prevChecks, fmt, fmtN }) {
  const cur  = useMemo(() => aggregate(checks,     srcKey), [checks]);
  const prev = useMemo(() => aggregate(prevChecks, srcKey), [prevChecks]);

  const totalRev  = Object.values(cur).reduce((s, r) => s + r.revenue, 0);
  const totalChks = Object.values(cur).reduce((s, r) => s + r.checks, 0);

  // Style resolver — platform keys (not in SOURCE_STYLE) get stable colours by revenue rank.
  const styleFor = useMemo(() => {
    const platformKeys = [...new Set([...Object.keys(cur), ...Object.keys(prev)])]
      .filter(k => !SOURCE_STYLE[k])
      .sort((a, b) => (cur[b]?.revenue || 0) - (cur[a]?.revenue || 0));
    const map = {};
    platformKeys.forEach((k, i) => { map[k] = { label: k, color: PLATFORM_COLORS[i % PLATFORM_COLORS.length], icon: '🛵' }; });
    return (k) => SOURCE_STYLE[k] || map[k] || { label: k, color: 'var(--t4)', icon: '?' };
  }, [cur, prev]);

  const rows = useMemo(() => {
    const keys = Array.from(new Set([...Object.keys(cur), ...Object.keys(prev)]));
    return keys.map(k => {
      const c = cur[k]  || { checks: 0, revenue: 0 };
      const p = prev[k] || { checks: 0, revenue: 0 };
      return {
        key: k, checks: c.checks, revenue: c.revenue, prevRevenue: p.revenue,
        revDelta: pctDelta(c.revenue, p.revenue),
        share: totalRev > 0 ? (c.revenue / totalRev) * 100 : 0,
        avgCheck: c.checks ? c.revenue / c.checks : 0,
      };
    }).sort((a, b) => b.revenue - a.revenue);
  }, [cur, prev, totalRev]);

  // Time series — by day, or by hour for a single-day range (same rule as Order types).
  const { series, xKeys, isHourly, allKeys } = useMemo(() => {
    const live = checks.filter(c => c.status !== 'voided' && c.closedAt);
    if (!live.length) return { series: {}, xKeys: [], isHourly: false, allKeys: [] };
    const times = live.map(c => c.closedAt);
    const hourly = (Math.max(...times) - Math.min(...times)) / 86400000 < 1.5;
    const buckets = {};
    const seen = new Set();
    live.forEach(c => {
      const d = new Date(c.closedAt);
      const key = hourly ? `${d.getHours()}` : `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      if (!buckets[key]) buckets[key] = { key, total: 0 };
      const s = srcKey(c);
      seen.add(s);
      buckets[key][s] = (buckets[key][s] || 0) + (c.total || 0);
      buckets[key].total += (c.total || 0);
    });
    const keys = Object.keys(buckets).sort((a, b) => hourly ? parseInt(a) - parseInt(b) : a.localeCompare(b));
    return { series: buckets, xKeys: keys, isHourly: hourly, allKeys: [...seen] };
  }, [checks]);

  const onExport = () => {
    const csv = toCsv(rows, [
      { label:'Source',           key: r => styleFor(r.key).label },
      { label:'Checks',           key:'checks' },
      { label:'Revenue',          key: r => r.revenue.toFixed(2) },
      { label:'Avg check',        key: r => r.avgCheck.toFixed(2) },
      { label:'Share %',          key: r => r.share.toFixed(2) },
      { label:'Previous revenue', key: r => r.prevRevenue.toFixed(2) },
      { label:'Change %',         key: r => r.revDelta === null ? '' : r.revDelta.toFixed(2) },
    ]);
    downloadCsv(`order-sources-${new Date().toISOString().slice(0,10)}.csv`, csv);
  };

  if (rows.length === 0 || totalRev === 0) return <EmptyState icon="🛵" message="No orders in this period."/>;

  const dominant = rows[0];
  const fastestGrowth = [...rows].filter(r => r.revDelta !== null && r.prevRevenue > 0).sort((a, b) => (b.revDelta || 0) - (a.revDelta || 0))[0];

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:12 }}><ExportBtn onClick={onExport}/></div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:18 }}>
        <StatTile label="Total revenue"  value={fmt(totalRev)} sub={`${fmtN(totalChks)} checks`} color="var(--acc)"/>
        <StatTile label="Biggest source" value={styleFor(dominant.key).label} sub={`${dominant.share.toFixed(1)}% of revenue`} color={styleFor(dominant.key).color}/>
        {fastestGrowth ? (
          <StatTile label="Fastest growing" value={styleFor(fastestGrowth.key).label} compare={fastestGrowth.revDelta} color={styleFor(fastestGrowth.key).color}/>
        ) : (
          <StatTile label="Growth trend" value="—" sub="no prior period data"/>
        )}
      </div>

      {/* Stacked source mix over time */}
      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, padding:'16px', marginBottom:14 }}>
        <div style={{ fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:14, display:'flex', justifyContent:'space-between' }}>
          <span>Source mix {isHourly ? 'by hour' : 'by day'}</span>
          <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
            {allKeys.map(k => (
              <span key={k} style={{ display:'inline-flex', alignItems:'center', gap:4, fontSize:10, color:'var(--t3)', textTransform:'none', letterSpacing:'normal' }}>
                <span style={{ width:10, height:10, borderRadius:2, background: styleFor(k).color }}/>
                {styleFor(k).label}
              </span>
            ))}
          </div>
        </div>
        {xKeys.length === 0 ? (
          <div style={{ textAlign:'center', padding:'32px 0', color:'var(--t4)', fontSize:12 }}>No time-series data.</div>
        ) : (
          <StackedBarChart series={series} xKeys={xKeys}
            xLabels={xKeys.map(k => isHourly ? `${k}:00` : new Date(k).toLocaleDateString('en-GB', { day:'numeric', month:'short' }))}
            types={allKeys} fmt={fmt} styleFor={styleFor}/>
        )}
      </div>

      {/* Per-source table */}
      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, overflow:'hidden' }}>
        <div style={{ display:'grid', gridTemplateColumns:'50px 1.3fr 80px 110px 90px 80px 100px', padding:'9px 14px', background:'var(--bg3)', borderBottom:'1px solid var(--bdr)', fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.06em', gap:8 }}>
          <span/>
          <span>Order source</span>
          <span style={{ textAlign:'right' }}>Checks</span>
          <span style={{ textAlign:'right' }}>Revenue</span>
          <span style={{ textAlign:'right' }}>Avg check</span>
          <span style={{ textAlign:'right' }}>Share</span>
          <span>vs previous</span>
        </div>
        {rows.map(r => {
          const st = styleFor(r.key);
          return (
            <div key={r.key} style={{ display:'grid', gridTemplateColumns:'50px 1.3fr 80px 110px 90px 80px 100px', padding:'10px 14px', borderBottom:'1px solid var(--bdr)', fontSize:12, alignItems:'center', gap:8 }}>
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
