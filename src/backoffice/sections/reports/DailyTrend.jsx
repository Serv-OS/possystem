// v5.5.88 — Daily Trend dashboard.
// Line charts of revenue / covers / avg check / tip rate per day, with
// optional previous-period overlay so "is business growing" answers itself.
// Best/worst day callouts + 7-day rolling-average line on revenue chart.

import { useMemo } from 'react';
import { useStore } from '../../../store';
import { StatTile, ExportBtn, EmptyState } from './_charts';
import { toCsv, downloadCsv } from './_csv';

function fmtDayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function fmtDayShort(d) {
  return `${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()]} ${d.getDate()}/${d.getMonth()+1}`;
}
function fmtDayFull(d) {
  return d.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' });
}

// Aggregate checks → per-day buckets keyed by YYYY-MM-DD
function buildDayBuckets(checks, days) {
  const dayKeys = days.map(fmtDayKey);
  const init = () => ({ revenue:0, covers:0, checks:0, tips:0, voids:0, refunds:0, items:0 });
  const buckets = Object.fromEntries(dayKeys.map(k => [k, init()]));
  checks.forEach(c => {
    if (!c.closedAt) return;
    const k = fmtDayKey(new Date(c.closedAt));
    if (!buckets[k]) return;
    if (c.status === 'voided') { buckets[k].voids += 1; return; }
    buckets[k].revenue += Number(c.total) || 0;
    buckets[k].covers  += Number(c.covers) || 1;
    buckets[k].checks  += 1;
    buckets[k].tips    += Number(c.tip) || 0;
    buckets[k].items   += (c.items || []).filter(i => !i.voided).reduce((s, i) => s + (i.qty || 1), 0);
    if (Array.isArray(c.refunds)) buckets[k].refunds += c.refunds.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  });
  return buckets;
}

export default function DailyTrend({ checks, prevChecks = [], fmt, fmtN, rangeFrom, rangeTo }) {
  const { locationConfig } = useStore();

  // Day axis for the active range
  const days = useMemo(() => {
    if (!rangeFrom || !rangeTo) return [];
    const start = new Date(rangeFrom); start.setHours(0,0,0,0);
    const end   = new Date(rangeTo);   end.setHours(0,0,0,0);
    const out = [];
    for (let t = start.getTime(); t <= end.getTime(); t += 24*60*60*1000) {
      out.push(new Date(t));
    }
    return out;
  }, [rangeFrom, rangeTo]);

  // Day axis for the comparison period (same length, immediately before)
  const prevDays = useMemo(() => {
    if (!days.length) return [];
    return days.map(d => new Date(d.getTime() - days.length * 24 * 60 * 60 * 1000));
  }, [days]);

  const buckets     = useMemo(() => buildDayBuckets(checks,     days),     [checks,     days]);
  const prevBuckets = useMemo(() => buildDayBuckets(prevChecks, prevDays), [prevChecks, prevDays]);

  // ── Series ────────────────────────────────────────────────────────────────
  const series = useMemo(() => {
    const revenue   = days.map(d => buckets[fmtDayKey(d)].revenue);
    const covers    = days.map(d => buckets[fmtDayKey(d)].covers);
    const checksNum = days.map(d => buckets[fmtDayKey(d)].checks);
    const avgCheck  = days.map((d, i) => checksNum[i] ? revenue[i] / checksNum[i] : 0);
    const tipRate   = days.map((d, i) => revenue[i] ? (buckets[fmtDayKey(d)].tips / revenue[i]) * 100 : 0);
    const items     = days.map(d => buckets[fmtDayKey(d)].items);

    const prevRevenue   = prevDays.map(d => prevBuckets[fmtDayKey(d)]?.revenue || 0);
    const prevCovers    = prevDays.map(d => prevBuckets[fmtDayKey(d)]?.covers || 0);
    const prevAvg       = prevDays.map((d, i) => {
      const c = prevBuckets[fmtDayKey(d)]?.checks || 0;
      const r = prevBuckets[fmtDayKey(d)]?.revenue || 0;
      return c ? r / c : 0;
    });
    const prevTipRate   = prevDays.map((d, i) => {
      const r = prevBuckets[fmtDayKey(d)]?.revenue || 0;
      const t = prevBuckets[fmtDayKey(d)]?.tips || 0;
      return r ? (t / r) * 100 : 0;
    });

    // 7-day rolling average on revenue
    const rolling = revenue.map((_, i) => {
      const start = Math.max(0, i - 6);
      const slice = revenue.slice(start, i + 1);
      return slice.reduce((s, v) => s + v, 0) / slice.length;
    });

    return { revenue, covers, checksNum, avgCheck, tipRate, items, prevRevenue, prevCovers, prevAvg, prevTipRate, rolling };
  }, [buckets, prevBuckets, days, prevDays]);

  // ── KPI deltas ────────────────────────────────────────────────────────────
  const totals = useMemo(() => {
    const sum = (arr) => arr.reduce((s, v) => s + v, 0);
    const totalRevenue = sum(series.revenue);
    const totalCovers  = sum(series.covers);
    const totalChecks  = sum(series.checksNum);
    const totalTips    = sum(days.map(d => buckets[fmtDayKey(d)].tips));
    const prevTotalRev = sum(series.prevRevenue);
    const prevTotalCov = sum(series.prevCovers);
    const avgCheck     = totalChecks ? totalRevenue / totalChecks : 0;
    const tipRate      = totalRevenue ? (totalTips / totalRevenue) * 100 : 0;
    const revenueDelta = prevTotalRev ? ((totalRevenue - prevTotalRev) / prevTotalRev) * 100 : null;
    const coversDelta  = prevTotalCov ? ((totalCovers  - prevTotalCov) / prevTotalCov) * 100 : null;
    return { totalRevenue, totalCovers, totalChecks, totalTips, avgCheck, tipRate, revenueDelta, coversDelta };
  }, [series, buckets, days]);

  // Best / worst day
  const bestWorst = useMemo(() => {
    if (!series.revenue.length) return null;
    let bi = 0, wi = 0;
    series.revenue.forEach((v, i) => {
      if (v > series.revenue[bi]) bi = i;
      if (v < series.revenue[wi]) wi = i;
    });
    return {
      best: { date: days[bi], revenue: series.revenue[bi] },
      worst: { date: days[wi], revenue: series.revenue[wi] },
    };
  }, [series, days]);

  // ── CSV export ────────────────────────────────────────────────────────────
  const exportCsv = () => {
    const headers = [
      { key:'date', label:'Date' },
      { key:'dow',  label:'Day' },
      { key:'rev',  label:'Revenue' },
      { key:'covers', label:'Covers' },
      { key:'checks', label:'Checks' },
      { key:'avg',  label:'Avg check' },
      { key:'tips', label:'Tips' },
      { key:'tipRate', label:'Tip %' },
      { key:'items', label:'Items sold' },
    ];
    const rows = days.map((d, i) => {
      const k = fmtDayKey(d);
      const b = buckets[k];
      return {
        date: k,
        dow: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()],
        rev: b.revenue.toFixed(2),
        covers: b.covers,
        checks: b.checks,
        avg: series.avgCheck[i].toFixed(2),
        tips: b.tips.toFixed(2),
        tipRate: series.tipRate[i].toFixed(1),
        items: b.items,
      };
    });
    downloadCsv(`daily-trend-${fmtDayKey(days[0])}-to-${fmtDayKey(days[days.length-1])}.csv`, toCsv(rows, headers));
  };

  if (!days.length || totals.totalChecks === 0) {
    return <EmptyState icon="📈" message="No closed checks in this range. Try widening the period."/>;
  }

  return (
    <div>
      <div style={{ display:'flex', alignItems:'center', marginBottom:14 }}>
        <div style={{ flex:1 }}/>
        <ExportBtn onClick={exportCsv}/>
      </div>

      {/* KPI tiles with vs-prev compare chips */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(180px, 1fr))', gap:10, marginBottom:18 }}>
        <StatTile label="Revenue" value={fmt(totals.totalRevenue)}
          compare={totals.revenueDelta} sub="vs previous period"/>
        <StatTile label="Covers"  value={fmtN(totals.totalCovers)}
          compare={totals.coversDelta} sub="vs previous period"/>
        <StatTile label="Avg check" value={fmt(totals.avgCheck)}
          sub={`across ${fmtN(totals.totalChecks)} check${totals.totalChecks === 1 ? '' : 's'}`}/>
        <StatTile label="Tip rate" value={`${totals.tipRate.toFixed(1)}%`}
          sub={fmt(totals.totalTips) + ' total tips'}/>
      </div>

      {/* Best / worst day callouts */}
      {bestWorst && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(220px, 1fr))', gap:10, marginBottom:14 }}>
          <Callout icon="🏆" label="Best day" value={fmt(bestWorst.best.revenue)} sub={fmtDayFull(bestWorst.best.date)} good/>
          <Callout icon="🪨" label="Slowest day" value={fmt(bestWorst.worst.revenue)} sub={fmtDayFull(bestWorst.worst.date)}/>
        </div>
      )}

      {/* Charts grid */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(420px, 1fr))', gap:14 }}>
        <ChartCard title="Daily revenue" sub="orange = revenue · faint = previous period · dotted = 7d rolling avg"
          values={series.revenue} prev={series.prevRevenue} rolling={series.rolling}
          format={fmt} days={days}/>
        <ChartCard title="Covers per day" sub="seated guests"
          values={series.covers} prev={series.prevCovers} format={fmtN} days={days} integer/>
        <ChartCard title="Avg check value" sub="revenue ÷ checks per day"
          values={series.avgCheck} prev={series.prevAvg} format={fmt} days={days}/>
        <ChartCard title="Tip rate %" sub="tips ÷ revenue per day"
          values={series.tipRate} prev={series.prevTipRate} format={(v) => `${v.toFixed(1)}%`} days={days} percent/>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
function Callout({ icon, label, value, sub, good }) {
  return (
    <div style={{
      padding:'12px 14px', background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12,
      display:'flex', alignItems:'center', gap:12,
    }}>
      <div style={{ fontSize:24 }}>{icon}</div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em' }}>{label}</div>
        <div style={{ fontSize:18, fontWeight:800, color: good ? 'var(--grn)' : 'var(--t1)', fontFamily:'var(--font-mono)', marginTop:2 }}>{value}</div>
        <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>{sub}</div>
      </div>
    </div>
  );
}

// ── SVG line chart with optional previous-period overlay + rolling avg ────────
function ChartCard({ title, sub, values, prev, rolling, format, days, integer, percent }) {
  const max = Math.max(1, ...values, ...(prev || []), ...(rolling || []));
  const W = 600, H = 180, P = 24;
  const xFor = (i) => P + (i / Math.max(1, values.length - 1)) * (W - 2 * P);
  const yFor = (v) => H - P - (v / max) * (H - 2 * P);

  const linePath = (vals) => vals.length === 0 ? '' :
    vals.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i).toFixed(2)} ${yFor(v).toFixed(2)}`).join(' ');

  // Y-axis ticks
  const ticks = [0, 0.5, 1].map(t => ({ y: yFor(max * t), v: max * t }));
  // X-axis labels — show first, middle, last so it doesn't get cluttered
  const xLabels = values.length <= 1 ? [0] :
    values.length <= 7 ? values.map((_, i) => i) :
    [0, Math.floor((values.length - 1) / 4), Math.floor((values.length - 1) / 2), Math.floor(3 * (values.length - 1) / 4), values.length - 1];

  return (
    <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, padding:'14px 16px' }}>
      <div style={{ marginBottom:6 }}>
        <div style={{ fontSize:12, fontWeight:800, color:'var(--t1)' }}>{title}</div>
        <div style={{ fontSize:10, color:'var(--t4)', marginTop:1 }}>{sub}</div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width:'100%', height:180 }}>
        {/* Grid lines + y-axis labels */}
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={P} x2={W - P} y1={t.y} y2={t.y} stroke="var(--bdr)" strokeWidth="0.5"/>
            <text x={4} y={t.y + 3} fill="var(--t4)" fontSize="9" fontFamily="var(--font-mono)">
              {integer ? Math.round(t.v) : percent ? `${t.v.toFixed(0)}%` : format(t.v).replace(/[£$€]/, '')}
            </text>
          </g>
        ))}
        {/* Previous-period overlay (faint) */}
        {prev && prev.length > 0 && (
          <path d={linePath(prev)} stroke="var(--t4)" strokeWidth="1" fill="none" strokeDasharray="3,3" opacity="0.4"/>
        )}
        {/* 7d rolling average (dotted, accent-tinted) */}
        {rolling && rolling.length > 0 && (
          <path d={linePath(rolling)} stroke="var(--acc)" strokeWidth="1.2" fill="none" strokeDasharray="2,2" opacity="0.55"/>
        )}
        {/* Main series — area fill + line */}
        <path d={`${linePath(values)} L ${xFor(values.length - 1)} ${H - P} L ${xFor(0)} ${H - P} Z`} fill="var(--acc)" opacity="0.12"/>
        <path d={linePath(values)} stroke="var(--acc)" strokeWidth="2" fill="none"/>
        {/* Data points */}
        {values.map((v, i) => (
          <circle key={i} cx={xFor(i)} cy={yFor(v)} r="2.5" fill="var(--acc)">
            <title>{`${days[i].toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' })}: ${format(v)}`}</title>
          </circle>
        ))}
        {/* X-axis date labels */}
        {xLabels.map((i) => (
          <text key={i} x={xFor(i)} y={H - 4} fill="var(--t4)" fontSize="9" textAnchor="middle" fontFamily="var(--font-mono)">
            {fmtDayShort(days[i])}
          </text>
        ))}
      </svg>
    </div>
  );
}
