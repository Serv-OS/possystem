// v5.5.88 — Daily Trend dashboard.
// Line charts of revenue / covers / avg check / tip rate per day, with
// optional previous-period overlay so "is business growing" answers itself.
// Best/worst day callouts + 7-day rolling-average line on revenue chart.
//
// v5.10.3: a day is the VENUE's business day (range.timeZone + range.dayStart, the same
// days the period was built from). Until then the axis and the buckets were the browser's
// midnights, so from California a London day ran 08:00 to 08:00 and a 06:30 day start
// was ignored.

import { useMemo } from 'react';
import { StatTile, ExportBtn, EmptyState } from './_charts';
import { toCsv, downloadCsv } from './_csv';
import { dayOfCheck, dayText, prevRangeDays, rangeDays, weekdayOf } from './_filters';
import { isSplit, sumFields, trendFromSums } from '../../../lib/reportSplit.js';
import { useParts, exportSites } from './_siteSplit';
import { SplitHeader, Blocks, GroupChange, SiteChange, SiteMatrix } from './SiteSplit';

const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

// Days are business days as 'YYYY-MM-DD' (no clock involved in any label).
function fmtDayShort(ymd) {
  return `${DOW[weekdayOf(ymd)]} ${Number(ymd.slice(8, 10))}/${Number(ymd.slice(5, 7))}`;
}
function fmtDayFull(ymd) {
  return dayText(ymd, { weekday:'short', day:'numeric', month:'short' });
}

// Aggregate checks → per-day buckets keyed by the business day (YYYY-MM-DD)
function buildDayBuckets(checks, days, clock) {
  const init = () => ({ revenue:0, covers:0, checks:0, tips:0, voids:0, refunds:0, items:0 });
  const buckets = Object.fromEntries(days.map(k => [k, init()]));
  checks.forEach(c => {
    if (!c.closedAt) return;
    const k = dayOfCheck(c.closedAt, clock);
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

// range = getPeriodRange's answer: fromDay/toDay are the venue business days, and
// timeZone/dayStart the clock each check is put on a day with.
// 5 Oct 2026 (Peter: "make every report we have multi site when sites are connected
// together"): with more than one site on screen this is the site split at the foot of the
// file. One site is the report exactly as it was.
export default function DailyTrend(props) {
  return isSplit(props.sites) ? <DailyTrendSites {...props}/> : <DailyTrendOne {...props}/>;
}

function DailyTrendOne({ checks, prevChecks = [], fmt, fmtN, range }) {
  // Day axis for the active range, and for what it is compared to (range.compare, the one
  // percent rule: the same days of the week or month before, or the whole period before)
  const days     = useMemo(() => rangeDays(range),     [range]);
  const prevDays = useMemo(() => prevRangeDays(range), [range]);

  const buckets     = useMemo(() => buildDayBuckets(checks,     days,     range), [checks,     days,     range]);
  const prevBuckets = useMemo(() => buildDayBuckets(prevChecks, prevDays, range), [prevChecks, prevDays, range]);

  // ── Series ────────────────────────────────────────────────────────────────
  const series = useMemo(() => {
    const revenue   = days.map(d => buckets[d].revenue);
    const covers    = days.map(d => buckets[d].covers);
    const checksNum = days.map(d => buckets[d].checks);
    const avgCheck  = days.map((d, i) => checksNum[i] ? revenue[i] / checksNum[i] : 0);
    const tipRate   = days.map((d, i) => revenue[i] ? (buckets[d].tips / revenue[i]) * 100 : 0);
    const items     = days.map(d => buckets[d].items);

    const prevRevenue   = prevDays.map(d => prevBuckets[d]?.revenue || 0);
    const prevCovers    = prevDays.map(d => prevBuckets[d]?.covers || 0);
    const prevAvg       = prevDays.map((d, i) => {
      const c = prevBuckets[d]?.checks || 0;
      const r = prevBuckets[d]?.revenue || 0;
      return c ? r / c : 0;
    });
    const prevTipRate   = prevDays.map((d, i) => {
      const r = prevBuckets[d]?.revenue || 0;
      const t = prevBuckets[d]?.tips || 0;
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
    const totalTips    = sum(days.map(d => buckets[d].tips));
    const prevTotalRev = sum(series.prevRevenue);
    const prevTotalCov = sum(series.prevCovers);
    const avgCheck     = totalChecks ? totalRevenue / totalChecks : 0;
    const tipRate      = totalRevenue ? (totalTips / totalRevenue) * 100 : 0;
    return { totalRevenue, totalCovers, totalChecks, totalTips, avgCheck, tipRate, prevTotalRev, prevTotalCov };
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
      const b = buckets[d];
      return {
        date: d,
        dow: DOW[weekdayOf(d)],
        rev: b.revenue.toFixed(2),
        covers: b.covers,
        checks: b.checks,
        avg: series.avgCheck[i].toFixed(2),
        tips: b.tips.toFixed(2),
        tipRate: series.tipRate[i].toFixed(1),
        items: b.items,
      };
    });
    downloadCsv(`daily-trend-${days[0]}-to-${days[days.length-1]}.csv`, toCsv(rows, headers));
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
          vs={range?.compare} values={[totals.totalRevenue, totals.prevTotalRev]}/>
        <StatTile label="Covers"  value={fmtN(totals.totalCovers)}
          vs={range?.compare} values={[totals.totalCovers, totals.prevTotalCov]} noun="covers"/>
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
        <ChartCard title="Daily revenue" sub={`orange = revenue · faint = ${(range?.compare?.label || 'vs previous period').replace(/^vs /, '')} · dotted = 7d rolling avg`}
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
            <title>{`${fmtDayFull(days[i])}: ${format(v)}`}</title>
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

// ─────────────────────────────────────────────────────────────────────────────
// Several sites: the group's days on top, then a column per site.
// A sale is put on a day by ITS OWN site's clock and business day start (part.clock), so
// a 02:00 sale at a site that starts its day at 06:30 is the day before, and the same
// instant at a site that starts at 00:00 is the new day. For a long period the days come
// from the server day sums, which cut each site's days the same way in the database.
// ─────────────────────────────────────────────────────────────────────────────
const DAY_FIELDS = ['revenue', 'covers', 'checks', 'tips'];

function DailyTrendSites(props) {
  const { fmtN, range } = props;
  const { parts, blocks, fromSums } = useParts(props);
  const days = useMemo(() => rangeDays(range), [range]);

  const bySite = useMemo(() => new Map(parts.map(p => {
    const buckets = p.sums
      ? Object.fromEntries(p.sums.days.map(d => [d.day, trendFromSums(d)]))
      : buildDayBuckets(p.rows, days, p.clock);
    const prevDays = p.site.range ? prevRangeDays(p.site.range) : [];
    const prev = p.sums
      ? trendFromSums(p.prevSums?.totals)
      : sumFields(Object.values(buildDayBuckets(p.prevRows, prevDays, p.clock)), DAY_FIELDS);
    return [p.id, { buckets, total: sumFields(days.map(d => buckets[d]), DAY_FIELDS), prev }];
  })), [parts, days]);

  const onExport = () => {
    const rows = [];
    for (const p of parts) for (const d of days) {
      const b = bySite.get(p.id).buckets[d] || {};
      rows.push({ siteName: p.name, currency: p.currency || '', date: d, dow: DOW[weekdayOf(d)], ...b });
    }
    exportSites('daily-trend', rows, [
      { label:'Currency',  key:'currency' },
      { label:'Date',      key:'date' },
      { label:'Day',       key:'dow' },
      { label:'Revenue',   key: r => (r.revenue || 0).toFixed(2) },
      { label:'Covers',    key: r => r.covers || 0 },
      { label:'Checks',    key: r => r.checks || 0 },
      { label:'Avg check', key: r => (r.checks ? r.revenue / r.checks : 0).toFixed(2) },
      { label:'Tips',      key: r => (r.tips || 0).toFixed(2) },
      { label:'Tip %',     key: r => (r.revenue ? (r.tips / r.revenue) * 100 : 0).toFixed(1) },
      // Items are counted from the checks themselves; the day sums do not carry them.
      ...(fromSums ? [] : [{ label:'Items sold', key: r => r.items || 0 }]),
    ]);
  };

  if (!days.length || parts.every(p => bySite.get(p.id).total.checks === 0)) {
    return <EmptyState icon="📈" message="No closed checks at these sites in this range. Try widening the period."/>;
  }

  return (
    <div>
      <SplitHeader parts={parts} fromSums={fromSums} onExport={onExport}/>
      <Blocks blocks={blocks}>{b => {
        const all = sumFields(b.parts.map(p => bySite.get(p.id).total), DAY_FIELDS);
        const perDay = days.map(d => b.parts.reduce((s, p) => s + (bySite.get(p.id).buckets[d]?.revenue || 0), 0));
        const rows = days.map((d, i) => ({
          key: d, label: fmtDayFull(d), total: perDay[i],
          bySite: Object.fromEntries(b.parts.map(p => [p.id, bySite.get(p.id).buckets[d]?.revenue || 0])),
        }));
        rows.unshift(
          { key:'total', label:'Revenue', strong:true, total: all.revenue, bySite: Object.fromEntries(b.parts.map(p => [p.id, bySite.get(p.id).total.revenue])) },
          { key:'change', label:'Change', render: p => <SiteChange part={p} values={[bySite.get(p.id).total.revenue, bySite.get(p.id).prev.revenue]}/> },
        );
        return (
          <>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(180px, 1fr))', gap:10, marginBottom:18 }}>
              <StatTile label="Revenue" value={b.fmt(all.revenue)}
                sub={<GroupChange block={b} pairs={b.parts.map(p => ({ current: bySite.get(p.id).total.revenue, previous: bySite.get(p.id).prev.revenue }))}/>}/>
              <StatTile label="Covers" value={fmtN(all.covers)}/>
              <StatTile label="Avg check" value={b.fmt(all.checks ? all.revenue / all.checks : 0)}
                sub={`across ${fmtN(all.checks)} check${all.checks === 1 ? '' : 's'}`}/>
              <StatTile label="Tip rate" value={`${(all.revenue ? (all.tips / all.revenue) * 100 : 0).toFixed(1)}%`}
                sub={b.fmt(all.tips) + ' total tips'}/>
            </div>
            <div style={{ marginBottom:14 }}>
              <ChartCard title={`Daily revenue, all ${b.parts.length} sites`} sub="each site's days are its own business days"
                values={perDay} format={b.fmt} days={days}/>
            </div>
            <SiteMatrix block={b} rows={rows} first="Business day" fmtN={fmtN}/>
          </>
        );
      }}</Blocks>
    </div>
  );
}
