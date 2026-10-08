// v4.6.15: Daypart report.
// Replaces the legacy one-dimensional Hourly view with a 7×24 heatmap
// (day of week × hour) plus an hourly bar chart across all days combined.
// Drives staffing decisions — "Friday 7pm is our peak, we need more cover".
//
// v4.6.25: When locationConfig.shifts is defined, a service-period breakdown
// (Breakfast / Lunch / Dinner with revenue + covers + share) sits at the top
// so Peter's configured service periods drive the reading, not just fixed hours.
//
// v5.10.3: every hour, weekday and service is the VENUE's (locationConfig.timezone +
// businessDayStart, via _filters daypartGrid / classifyShift). Until then they were the
// browser's, so a London lunch rush showed at 04:00 to Peter in California.

import { useMemo } from 'react';
import { StatTile, ExportBtn, EmptyState, Heatmap, HourBar } from './_charts';
import { toCsv, downloadCsv } from './_csv';
import { classifyShift, daypartGrid, reportClock, venueHour } from './_filters';
import { currencySymbol } from '../../../lib/currency';
import { isSplit } from '../../../lib/reportSplit.js';
import { useParts, exportSites } from './_siteSplit';
import { SplitHeader, Blocks, SiteMatrix } from './SiteSplit';

const DOW_LABELS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

const tileSt = { padding:'14px 16px', background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12 };
const lblSt  = { fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:6 };

// 5 Oct 2026 (Peter: "make every report we have multi site when sites are connected
// together"): with more than one site on screen this is the site split at the foot of the
// file. One site is the report exactly as it was.
export default function Daypart(props) {
  return isSplit(props.sites) ? <DaypartSites {...props}/> : <DaypartOne {...props}/>;
}

function DaypartOne({ checks, fmt, locationConfig }) {
  const clock = useMemo(() => reportClock(locationConfig), [locationConfig]);
  const { grid, byHour, byDow, peakCell, totalRev } = useMemo(() => {
    const { grid, byHour, byDow } = daypartGrid(checks, clock);
    let peakCell = { dow:0, h:0, value:0 };
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) {
      if (grid[d][h] > peakCell.value) peakCell = { dow:d, h, value: grid[d][h] };
    }
    const totalRev = byHour.reduce((s, v) => s + v, 0);
    return { grid, byHour, byDow, peakCell, totalRev };
  }, [checks, clock]);

  // v4.6.25: per-service aggregates when shifts are configured.
  const serviceStats = useMemo(() => {
    const shifts = locationConfig?.shifts || [];
    if (!shifts.length) return null;
    const stats = shifts.map(s => ({
      shift: s,
      revenue: 0, covers: 0, count: 0,
    }));
    const statIdx = {};
    stats.forEach((st, i) => { statIdx[st.shift.id || st.shift.name] = i; });
    let unclassified = { revenue: 0, covers: 0, count: 0 };
    (checks || []).filter(c => c.status !== 'voided' && c.closedAt).forEach(c => {
      const s = classifyShift(c.closedAt, shifts, clock.timeZone);
      const tot = c.total || 0;
      const cov = c.covers || 1;
      if (s) {
        const i = statIdx[s.id || s.name];
        stats[i].revenue += tot; stats[i].covers += cov; stats[i].count += 1;
      } else {
        unclassified.revenue += tot; unclassified.covers += cov; unclassified.count += 1;
      }
    });
    const totalClassified = stats.reduce((s, st) => s + st.revenue, 0);
    const grand = totalClassified + unclassified.revenue;
    return { stats, unclassified, total: grand };
  }, [checks, locationConfig, clock]);

  const peakHour = byHour.indexOf(Math.max(...byHour));
  const peakDow  = byDow.indexOf(Math.max(...byDow));
  const nowHour  = venueHour(new Date(), clock.timeZone); // the venue's hour now, not the browser's

  const onExport = () => {
    const rows = [];
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) {
      if (grid[d][h] > 0) rows.push({ day: DOW_LABELS[d], hour: `${h}:00`, revenue: grid[d][h].toFixed(2) });
    }
    const csv = toCsv(rows, [
      { label:'Day',     key:'day' },
      { label:'Hour',    key:'hour' },
      { label:'Revenue', key:'revenue' },
    ]);
    downloadCsv(`daypart-${new Date().toISOString().slice(0,10)}.csv`, csv);
  };

  if (totalRev === 0) {
    return <EmptyState icon="🕓" message="No sales in this period to chart."/>;
  }

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:12 }}><ExportBtn onClick={onExport}/></div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:18 }}>
        <StatTile label="Busiest hour"  value={peakHour >= 0 ? `${peakHour}:00` : '—'}        sub={fmt(Math.max(...byHour))} color="var(--acc)"/>
        <StatTile label="Busiest day"   value={DOW_LABELS[peakDow] || '—'}                     sub={fmt(Math.max(...byDow))}/>
        <StatTile label="Peak slot"     value={`${DOW_LABELS[peakCell.dow]} ${peakCell.h}:00`}      sub={fmt(peakCell.value)}/>
      </div>

      {serviceStats && serviceStats.stats.length > 0 && (
        <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, padding:'16px', marginBottom:14 }}>
          <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:12 }}>
            <div style={{ fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em' }}>Revenue by service period</div>
            <div style={{ fontSize:11, color:'var(--t4)' }}>Configured in Location settings</div>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:`repeat(${Math.min(serviceStats.stats.length, 4)},1fr)`, gap:10 }}>
            {serviceStats.stats.map(st => {
              const share = serviceStats.total > 0 ? (st.revenue / serviceStats.total) * 100 : 0;
              const avgCheck = st.count > 0 ? st.revenue / st.count : 0;
              return (
                <div key={st.shift.id || st.shift.name} style={tileSt}>
                  <div style={lblSt}>{st.shift.name} · {st.shift.start}–{st.shift.end}</div>
                  <div style={{ fontSize:20, fontWeight:800, color:'var(--t1)', fontFamily:'var(--font-mono)' }}>{fmt(st.revenue)}</div>
                  <div style={{ fontSize:11, color:'var(--t3)', marginTop:4 }}>{st.count} checks · {st.covers} covers</div>
                  <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>avg {fmt(avgCheck)} · {share.toFixed(0)}% of total</div>
                </div>
              );
            })}
          </div>
          {serviceStats.unclassified.count > 0 && (
            <div style={{ fontSize:11, color:'var(--t4)', marginTop:12, paddingTop:10, borderTop:'1px solid var(--bdr)' }}>
              {serviceStats.unclassified.count} checks ({fmt(serviceStats.unclassified.revenue)}) closed outside any configured service period.
            </div>
          )}
        </div>
      )}

      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, padding:'16px', marginBottom:14 }}>
        <div style={{ fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:16 }}>Revenue · hour × day of week</div>
        <Heatmap grid={grid} formatCell={v => fmt(v)}/>
      </div>

      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, padding:'16px' }}>
        <div style={{ fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:16 }}>Revenue by hour (all days combined)</div>
        <HourBar values={byHour} maxLabel={v => `${currencySymbol()}${Math.round(v)}`} nowHour={nowHour}/>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Several sites: the group's hours and weekdays on top, then a column per site.
// Every sale is put in an hour and a weekday on ITS OWN site's clock (part.clock), so
// "12:00" is each site's own lunchtime and a late sale counts on that site's business day.
// Services are not shown here: each site names and times its own, so pick one site for them.
// ─────────────────────────────────────────────────────────────────────────────
function DaypartSites(props) {
  const { parts, blocks } = useParts(props);
  const bySite = useMemo(() => new Map(parts.map(p => [p.id, daypartGrid(p.rows, p.clock)])), [parts]);

  const onExport = () => {
    const rows = [];
    for (const p of parts) {
      const { grid } = bySite.get(p.id);
      for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) {
        if (grid[d][h] > 0) rows.push({ siteName: p.name, currency: p.currency || '', day: DOW_LABELS[d], hour: `${h}:00`, revenue: grid[d][h].toFixed(2) });
      }
    }
    exportSites('daypart', rows, [
      { label:'Currency', key:'currency' },
      { label:'Day',      key:'day' },
      { label:'Hour',     key:'hour' },
      { label:'Revenue',  key:'revenue' },
    ]);
  };

  if (parts.every(p => bySite.get(p.id).byHour.every(v => v === 0))) {
    return <EmptyState icon="🕓" message="No sales at these sites in this period to chart."/>;
  }

  return (
    <div>
      <SplitHeader parts={parts} onExport={onExport}>
        <div style={{ color:'var(--t4)' }}>Hours are each site's own wall clock. Pick one site to see its service periods and heatmap.</div>
      </SplitHeader>
      <Blocks blocks={blocks}>{b => {
        const line = (pick, key, label) => {
          const cells = Object.fromEntries(b.parts.map(p => [p.id, pick(bySite.get(p.id))]));
          return { key, label, bySite: cells, total: Object.values(cells).reduce((s, v) => s + v, 0) };
        };
        const hours = Array.from({ length:24 }, (_, h) => line(g => g.byHour[h], `h${h}`, `${h}:00`));
        const dows  = DOW_LABELS.map((l, d) => line(g => g.byDow[d], `d${d}`, l));
        const total = line(g => g.byHour.reduce((s, v) => s + v, 0), '__total', 'Revenue');
        const peakH = hours.reduce((a, r) => (r.total > a.total ? r : a), hours[0]);
        const peakD = dows.reduce((a, r) => (r.total > a.total ? r : a), dows[0]);
        return (
          <>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:18 }}>
              <StatTile label="Revenue"      value={b.fmt(total.total)} color="var(--acc)"/>
              <StatTile label="Busiest hour" value={peakH.label} sub={b.fmt(peakH.total)}/>
              <StatTile label="Busiest day"  value={peakD.label} sub={b.fmt(peakD.total)}/>
            </div>
            <SiteMatrix block={b} rows={[{ ...total, strong:true }, ...hours.filter(r => r.total > 0)]} first="Hour (site's own clock)" title="Revenue by hour"/>
            <SiteMatrix block={b} rows={dows} first="Business day of the week" title="Revenue by day of week"/>
          </>
        );
      }}</Blocks>
    </div>
  );
}
