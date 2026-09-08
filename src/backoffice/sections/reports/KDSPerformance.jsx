// v4.6.20: KDS Performance report.
//
// Pulls kds_tickets for the report period and computes bump time per ticket
// as bumped_at - sent_at. Shows:
//   - Headline tiles: total tickets, avg bump time, p90, currently open tickets
//   - Per-station breakdown: centre_id -> ticket count, avg, p50, p90
//   - Bump time by hour of day (spot kitchen pressure windows)
//
// Centre ids resolve to station names via the menuCategories store if the centre
// id happens to be a category id; falls back to the raw id label otherwise.
//
// Percentile note: we use a simple sorted-index percentile which is fine for
// the volumes a single restaurant produces in a day / week / month.

import { useMemo } from 'react';
import { useStore } from '../../../store';
import { StatTile, ExportBtn, EmptyState, HourBar, BarRow } from './_charts';
import { toCsv, downloadCsv } from './_csv';

function percentile(sortedMs, p) {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.floor((p / 100) * sortedMs.length));
  return sortedMs[idx];
}

function formatMs(ms) {
  if (!ms || ms < 0) return '—';
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

export default function KDSPerformance({ kdsTickets = [], fmt, fmtN }) {
  const { menuCategories = [] } = useStore();

  const stationLabel = useMemo(() => {
    const m = {};
    menuCategories.forEach(c => { m[c.id] = c.label || c.name || c.id; });
    return (id) => id ? (m[id] || id) : 'No station';
  }, [menuCategories]);

  const analysis = useMemo(() => {
    const bumped = kdsTickets.filter(t => t.status === 'bumped' && t.sentAt && t.bumpedAt);
    const open   = kdsTickets.filter(t => t.status === 'pending');

    const allBumpMs = bumped.map(t => Math.max(0, t.bumpedAt - t.sentAt)).sort((a, b) => a - b);
    const totalCount = bumped.length;

    // Per station
    const byStation = {};
    bumped.forEach(t => {
      const key = t.centreId || '__no_station';
      if (!byStation[key]) byStation[key] = { centreId: t.centreId, count: 0, bumpMs: [] };
      byStation[key].count++;
      byStation[key].bumpMs.push(Math.max(0, t.bumpedAt - t.sentAt));
    });
    const stations = Object.values(byStation).map(s => {
      const sorted = [...s.bumpMs].sort((a, b) => a - b);
      const avg = sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1);
      return {
        centreId: s.centreId,
        label: stationLabel(s.centreId),
        count: s.count,
        avgMs: avg,
        p50: percentile(sorted, 50),
        p90: percentile(sorted, 90),
      };
    }).sort((a, b) => b.count - a.count);

    // Per hour of day
    const byHour = Array.from({ length: 24 }, () => ({ count: 0, sumMs: 0 }));
    bumped.forEach(t => {
      const h = new Date(t.sentAt).getHours();
      byHour[h].count++;
      byHour[h].sumMs += Math.max(0, t.bumpedAt - t.sentAt);
    });
    const avgByHour = byHour.map(b => b.count ? b.sumMs / b.count : 0);

    // Ticket counts by hour (volume view)
    const countByHour = byHour.map(b => b.count);

    return {
      totalCount,
      openCount: open.length,
      avgMs: allBumpMs.reduce((a, b) => a + b, 0) / (allBumpMs.length || 1),
      p50: percentile(allBumpMs, 50),
      p90: percentile(allBumpMs, 90),
      p99: percentile(allBumpMs, 99),
      stations,
      avgByHour,
      countByHour,
    };
  }, [kdsTickets, stationLabel]);

  const onExport = () => {
    const csv = toCsv(analysis.stations, [
      { label:'Station',     key:'label' },
      { label:'Tickets',     key:'count' },
      { label:'Avg (sec)',   key: s => Math.round(s.avgMs / 1000) },
      { label:'p50 (sec)',   key: s => Math.round(s.p50 / 1000) },
      { label:'p90 (sec)',   key: s => Math.round(s.p90 / 1000) },
    ]);
    downloadCsv(`kds-performance-${new Date().toISOString().slice(0,10)}.csv`, csv);
  };

  if (analysis.totalCount === 0 && analysis.openCount === 0) {
    return <EmptyState icon="👨‍🍳" message="No KDS tickets in this period. Kitchen display may be off, or the date range has no orders."/>;
  }

  const maxCount = Math.max(1, ...analysis.stations.map(s => s.count));
  const nowHour  = new Date().getHours();

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:12 }}><ExportBtn onClick={onExport}/></div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:18 }}>
        <StatTile label="Tickets bumped"  value={fmtN(analysis.totalCount)}/>
        <StatTile label="Avg bump time"   value={formatMs(analysis.avgMs)} color="var(--acc)" sub={`p50 ${formatMs(analysis.p50)}`}/>
        <StatTile label="p90 bump time"   value={formatMs(analysis.p90)} color={analysis.p90 > 900000 ? 'var(--red)' : 'var(--t1)'} sub={`p99 ${formatMs(analysis.p99)}`}/>
        <StatTile label="Open right now"  value={fmtN(analysis.openCount)} color={analysis.openCount > 20 ? 'var(--red)' : analysis.openCount > 10 ? 'var(--acc)' : 'var(--t1)'}/>
      </div>

      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, padding:'16px', marginBottom:14 }}>
        <div style={{ fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:14 }}>Avg bump time by hour</div>
        <HourBar values={analysis.avgByHour} maxLabel={v => formatMs(v)} nowHour={nowHour}/>
        <div style={{ marginTop:10, fontSize:11, color:'var(--t4)', textAlign:'center' }}>
          Ticket volume by hour: {analysis.countByHour.map((c, h) => c > 0 ? `${h}:00 ${c}` : null).filter(Boolean).slice(0, 8).join(' · ')}{analysis.countByHour.filter(c => c > 0).length > 8 ? ' …' : ''}
        </div>
      </div>

      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, overflow:'hidden' }}>
        <div style={{ padding:'10px 14px', background:'var(--bg3)', borderBottom:'1px solid var(--bdr)', fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.06em' }}>
          By station
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1.4fr 80px 100px 100px 100px 1fr', padding:'8px 14px', borderBottom:'1px solid var(--bdr)', fontSize:10, fontWeight:700, color:'var(--t4)', letterSpacing:'.05em', textTransform:'uppercase', gap:8 }}>
          <span>Station</span>
          <span style={{ textAlign:'right' }}>Tickets</span>
          <span style={{ textAlign:'right' }}>Avg</span>
          <span style={{ textAlign:'right' }}>p50</span>
          <span style={{ textAlign:'right' }}>p90</span>
          <span>Volume</span>
        </div>
        {analysis.stations.map((s, i) => (
          <div key={s.centreId || '__none'} style={{ display:'grid', gridTemplateColumns:'1.4fr 80px 100px 100px 100px 1fr', padding:'10px 14px', borderBottom: i === analysis.stations.length - 1 ? 'none' : '1px solid var(--bdr)', fontSize:12, alignItems:'center', gap:8, background: i % 2 === 0 ? 'transparent' : 'var(--bg2)' }}>
            <span style={{ color:'var(--t1)', fontWeight:600 }}>{s.label}</span>
            <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{s.count}</span>
            <span style={{ textAlign:'right', color:'var(--acc)', fontFamily:'var(--font-mono)', fontWeight:700 }}>{formatMs(s.avgMs)}</span>
            <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{formatMs(s.p50)}</span>
            <span style={{ textAlign:'right', color: s.p90 > 900000 ? 'var(--red)' : 'var(--t3)', fontFamily:'var(--font-mono)' }}>{formatMs(s.p90)}</span>
            <div style={{ display:'flex', alignItems:'center', gap:6 }}>
              <div style={{ flex:1, height:5, background:'var(--bg3)', borderRadius:3, overflow:'hidden' }}>
                <div style={{ height:'100%', width:`${(s.count / maxCount) * 100}%`, background:'var(--acc)' }}/>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop:14, padding:'10px 12px', background:'var(--bg3)', border:'1px dashed var(--bdr)', borderRadius:8, fontSize:11, color:'var(--t4)', lineHeight:1.7 }}>
        ⓘ Bump time = bumped_at − sent_at. p90 over 15 minutes is flagged red as a kitchen pressure signal. Open-right-now counts use live data and are not bounded by the date filter.
      </div>
    </div>
  );
}
