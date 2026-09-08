// v4.6.15: Daypart report.
// Replaces the legacy one-dimensional Hourly view with a 7×24 heatmap
// (day of week × hour) plus an hourly bar chart across all days combined.
// Drives staffing decisions — "Friday 7pm is our peak, we need more cover".
//
// v4.6.25: When locationConfig.shifts is defined, a service-period breakdown
// (Breakfast / Lunch / Dinner with revenue + covers + share) sits at the top
// so Peter's configured service periods drive the reading, not just fixed hours.

import { useMemo } from 'react';
import { StatTile, ExportBtn, EmptyState, Heatmap, HourBar } from './_charts';
import { toCsv, downloadCsv } from './_csv';
import { classifyShift } from './_filters';
import { currencySymbol } from '../../../lib/currency';

const DOW_LABELS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

const tileSt = { padding:'14px 16px', background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12 };
const lblSt  = { fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:6 };

export default function Daypart({ checks, fmt, locationConfig }) {
  const { grid, byHour, byDow, peakCell, totalRev } = useMemo(() => {
    const grid   = Array.from({ length:7 }, () => Array(24).fill(0));
    const byHour = Array(24).fill(0);
    const byDow  = Array(7).fill(0);
    (checks || []).filter(c => c.status !== 'voided' && c.closedAt).forEach(c => {
      const d   = new Date(c.closedAt);
      const dow = (d.getDay() + 6) % 7; // Mon = 0
      const h   = d.getHours();
      const amt = c.total || 0;
      grid[dow][h] += amt;
      byHour[h]    += amt;
      byDow[dow]   += amt;
    });
    let peakCell = { dow:0, h:0, value:0 };
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) {
      if (grid[d][h] > peakCell.value) peakCell = { dow:d, h, value: grid[d][h] };
    }
    const totalRev = byHour.reduce((s, v) => s + v, 0);
    return { grid, byHour, byDow, peakCell, totalRev };
  }, [checks]);

  // v4.6.25: per-service aggregates when shifts are configured.
  const serviceStats = useMemo(() => {
    const shifts = locationConfig?.shifts || [];
    const bds    = locationConfig?.businessDayStart || '00:00';
    if (!shifts.length) return null;
    const stats = shifts.map(s => ({
      shift: s,
      revenue: 0, covers: 0, count: 0,
    }));
    const statIdx = {};
    stats.forEach((st, i) => { statIdx[st.shift.id || st.shift.name] = i; });
    let unclassified = { revenue: 0, covers: 0, count: 0 };
    (checks || []).filter(c => c.status !== 'voided' && c.closedAt).forEach(c => {
      const s = classifyShift(c.closedAt, shifts, bds);
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
  }, [checks, locationConfig]);

  const peakHour = byHour.indexOf(Math.max(...byHour));
  const peakDow  = byDow.indexOf(Math.max(...byDow));
  const nowHour  = new Date().getHours();

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
