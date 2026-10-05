// v4.6.20: KDS Performance report.
//
// Pulls kds_tickets for the report period and computes bump time per ticket
// as bumped_at - sent_at. Shows:
//   - Headline tiles: total tickets, avg bump time, p90, currently open tickets
//   - Per-station breakdown: centre_id -> ticket count, avg, p50, p90
//   - Bump time by hour of day (spot kitchen pressure windows)
//     (v5.11.1: the venue's hour the ticket was sent, sumByVenueHour; was the browser's)
//
// 5 Oct 2026 (Peter, Coffee Boy: "KDS report station name doesn't match what we called them"):
// a ticket's centre id is a PRODUCTION CENTRE (Back Office, Production printing), so the names
// come from print_routing.centres (lib/kdsStationNames.js). The report used to look the id up
// among menu categories and so showed raw ids such as pc-1790752941614-i9vh.
//
// Percentile note: we use a simple sorted-index percentile which is fine for
// the volumes a single restaurant produces in a day / week / month.

import { useMemo, useEffect, useState } from 'react';
import { useStore } from '../../../store';
import { supabase, isMock, getLocationId } from '../../../lib/supabase';
import { stationNameMap, stationLabel as stationLabelFor } from '../../../lib/kdsStationNames';
import { StatTile, ExportBtn, EmptyState, HourBar, BarRow } from './_charts';
import { toCsv, downloadCsv } from './_csv';
import { reportClock, sumByVenueHour, venueHour } from './_filters';

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

export default function KDSPerformance({ kdsTickets = [], fmt, fmtN, locationConfig }) {
  const storeCentres = useStore(s => s.printRouting?.centres);
  const clock = useMemo(() => reportClock(locationConfig), [locationConfig]);

  // The venue's own production centres, read fresh: the copy in this browser can be another
  // venue's (Back Office switches venues) or older than a rename.
  const [venueCentres, setVenueCentres] = useState(null);
  useEffect(() => {
    if (isMock) return undefined;
    let alive = true;
    (async () => {
      try {
        const locId = await getLocationId();
        if (!locId) return;
        const { data } = await supabase.from('print_routing').select('centres').eq('location_id', locId).maybeSingle();
        if (alive && Array.isArray(data?.centres)) setVenueCentres(data.centres);
      } catch { /* the names fall back to this browser's copy */ }
    })();
    return () => { alive = false; };
  }, []);

  const stationLabel = useMemo(() => {
    const m = stationNameMap(storeCentres, venueCentres);
    return (id) => stationLabelFor(id, m);
  }, [storeCentres, venueCentres]);

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

    // Per hour of day, on the venue's clock. Ticket counts by hour (volume view) too.
    const countByHour = sumByVenueHour(bumped, t => t.sentAt, () => 1, clock.timeZone);
    const sumMsByHour = sumByVenueHour(bumped, t => t.sentAt, t => Math.max(0, t.bumpedAt - t.sentAt), clock.timeZone);
    const avgByHour = countByHour.map((n, h) => n ? sumMsByHour[h] / n : 0);

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
  }, [kdsTickets, stationLabel, clock]);

  const onExport = () => {
    const csv = toCsv(analysis.stations, [
      { label:'Station',     key:'label' },
      { label:'Tickets',     key:'count' },
      { label:'Avg (sec)',   key: s => Math.round(s.avgMs / 1000) },
      { label:'Typical (sec)',          key: s => Math.round(s.p50 / 1000) },
      { label:'9 in 10 done by (sec)',  key: s => Math.round(s.p90 / 1000) },
    ]);
    downloadCsv(`kds-performance-${new Date().toISOString().slice(0,10)}.csv`, csv);
  };

  if (analysis.totalCount === 0 && analysis.openCount === 0) {
    return <EmptyState icon="👨‍🍳" message="No KDS tickets in this period. Kitchen display may be off, or the date range has no orders."/>;
  }

  const maxCount = Math.max(1, ...analysis.stations.map(s => s.count));
  const nowHour  = venueHour(new Date(), clock.timeZone); // the venue's hour now, not the browser's

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:12 }}><ExportBtn onClick={onExport}/></div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:18 }}>
        <StatTile label="Tickets bumped"  value={fmtN(analysis.totalCount)}/>
        <StatTile label="Avg bump time"   value={formatMs(analysis.avgMs)} color="var(--acc)" sub={`Typical ${formatMs(analysis.p50)}`}/>
        <StatTile label="9 in 10 done by" value={formatMs(analysis.p90)} color={analysis.p90 > 900000 ? 'var(--red)' : 'var(--t1)'} sub={`Slowest 1 in 100: ${formatMs(analysis.p99)}`}/>
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
          <span style={{ textAlign:'right' }}>Typical</span>
          <span style={{ textAlign:'right' }}>9 in 10 by</span>
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
        Bump time is how long a ticket waits from being sent to being bumped. Typical: half of tickets were quicker than this. 9 in 10 by: nine tickets in ten were done within this time, and it shows red over 15 minutes. Open right now is live and ignores the date filter.
      </div>
    </div>
  );
}
