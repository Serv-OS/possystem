// v4.6.18: Server scorecard.
// Replaces the legacy "By server" table with a full performance view:
//   - Sortable columns across the core metrics
//   - Derived hours worked (first-check → last-check across each day, summed for the period)
//   - Rates: tip % (tips ÷ net), discount %, void % (events per 100 checks)
//   - Peer rank column on the primary sort axis
//   - Period compare chip on revenue against previous period
//   - CSV export of everything
//
// As with Shifts, hours are derived until clock-in/out data lands.

import { useMemo, useState } from 'react';
import { StatTile, CompareChip, ExportBtn, EmptyState } from './_charts';
import { pctDelta } from './_filters';
import { toCsv, downloadCsv } from './_csv';

const SORT_COLS = [
  { id:'revenue',  label:'Revenue',  fmt: r => r.revenue },
  { id:'checks',   label:'Checks',   fmt: r => r.checks },
  { id:'covers',   label:'Covers',   fmt: r => r.covers },
  { id:'avgCheck', label:'Avg check',fmt: r => r.avgCheck },
  { id:'tipPct',   label:'Tip %',    fmt: r => r.tipPct },
  { id:'discPct',  label:'Disc %',   fmt: r => r.discPct },
  { id:'voidPct',  label:'Void %',   fmt: r => r.voidPct },
  { id:'hours',    label:'Hours',    fmt: r => r.hoursMs },
];

// Aggregate checks into per-server rollup
function rollUp(checks) {
  const map = {};
  checks.forEach(c => {
    // Catering has no real server (server:'Catering' is a channel label) — exclude it
    // so it doesn't masquerade as a top-performing staff member.
    if ((c.source || '') === 'catering') return;
    const s = c.server || c.staff || 'Unknown';
    if (!map[s]) map[s] = {
      server: s, checks: 0, covers: 0, revenue: 0, tips: 0,
      discounts: 0, discountCount: 0, voidCount: 0, voidValue: 0,
      byDay: {},
      orderTimes: [],
    };
    const isVoid = c.status === 'voided';
    if (isVoid) {
      map[s].voidCount++;
      map[s].voidValue += c.total || 0;
    } else {
      map[s].checks++;
      map[s].covers  += c.covers || 1;
      map[s].revenue += c.total || 0;
      map[s].tips    += c.tip   || 0;
      (c.discounts || []).forEach(d => {
        map[s].discounts     += d.amount || d.value || 0;
        map[s].discountCount += 1;
      });
    }
    if (c.closedAt) {
      const d = new Date(c.closedAt);
      const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (!map[s].byDay[dayKey]) map[s].byDay[dayKey] = { first: c.closedAt, last: c.closedAt };
      else {
        if (c.closedAt < map[s].byDay[dayKey].first) map[s].byDay[dayKey].first = c.closedAt;
        if (c.closedAt > map[s].byDay[dayKey].last)  map[s].byDay[dayKey].last  = c.closedAt;
      }
    }
  });

  Object.values(map).forEach(r => {
    // hoursMs = sum of (lastAt - firstAt) across each day worked
    r.hoursMs  = Object.values(r.byDay).reduce((s, d) => s + Math.max(0, d.last - d.first), 0);
    r.daysWorked = Object.keys(r.byDay).length;
    r.avgCheck = r.checks ? r.revenue / r.checks : 0;
    r.avgCover = r.covers ? r.revenue / r.covers : 0;
    r.tipPct   = r.revenue ? (r.tips / r.revenue) * 100 : 0;
    const totalEvents = r.checks + r.voidCount;
    r.discPct  = totalEvents ? (r.discountCount / totalEvents) * 100 : 0;
    r.voidPct  = totalEvents ? (r.voidCount / totalEvents) * 100 : 0;
    delete r.byDay;
    delete r.orderTimes;
  });

  return Object.values(map);
}

function formatHours(ms) {
  if (!ms || ms < 60000) return '—';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function Servers({ checks, prevChecks, fmt, fmtN }) {
  const [sortBy, setSortBy] = useState('revenue');
  const [sortDir, setSortDir] = useState('desc');

  const rows    = useMemo(() => rollUp(checks),     [checks]);
  const prevRows = useMemo(() => rollUp(prevChecks), [prevChecks]);

  const sorted = useMemo(() => {
    const col = SORT_COLS.find(c => c.id === sortBy) || SORT_COLS[0];
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = col.fmt(a), bv = col.fmt(b);
      return sortDir === 'desc' ? bv - av : av - bv;
    });
    return copy;
  }, [rows, sortBy, sortDir]);

  // Headline tiles: totals across all servers
  const totals = useMemo(() => {
    const revenue = rows.reduce((s, r) => s + r.revenue, 0);
    const prevRev = prevRows.reduce((s, r) => s + r.revenue, 0);
    const tips    = rows.reduce((s, r) => s + r.tips, 0);
    const checks  = rows.reduce((s, r) => s + r.checks, 0);
    return { revenue, prevRev, tips, checks, staffCount: rows.length };
  }, [rows, prevRows]);

  const prevByServer = useMemo(() => {
    const m = {}; prevRows.forEach(r => { m[r.server] = r.revenue; }); return m;
  }, [prevRows]);

  const onExport = () => {
    const csv = toCsv(sorted, [
      { label:'Rank',       key: (_, i) => i + 1 },
      { label:'Server',     key:'server' },
      { label:'Days worked',key:'daysWorked' },
      { label:'Hours',      key: r => formatHours(r.hoursMs) },
      { label:'Checks',     key:'checks' },
      { label:'Covers',     key:'covers' },
      { label:'Revenue',    key: r => r.revenue.toFixed(2) },
      { label:'Tips',       key: r => r.tips.toFixed(2) },
      { label:'Avg check',  key: r => r.avgCheck.toFixed(2) },
      { label:'Avg cover',  key: r => r.avgCover.toFixed(2) },
      { label:'Tip %',      key: r => r.tipPct.toFixed(2) },
      { label:'Discount %', key: r => r.discPct.toFixed(2) },
      { label:'Void %',     key: r => r.voidPct.toFixed(2) },
      { label:'Void value', key: r => r.voidValue.toFixed(2) },
    ].map((h, i) => ({ ...h, key: typeof h.key === 'function' && h.key.length === 2
      ? (r => h.key(r, sorted.indexOf(r)))
      : h.key
    })));
    downloadCsv(`server-scorecard-${new Date().toISOString().slice(0,10)}.csv`, csv);
  };

  if (rows.length === 0) return <EmptyState icon="👥" message="No server activity in this period."/>;

  const handleSort = (id) => {
    if (sortBy === id) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortBy(id); setSortDir('desc'); }
  };

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:12 }}><ExportBtn onClick={onExport}/></div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:18 }}>
        <StatTile label="Staff on floor" value={fmtN(totals.staffCount)}/>
        <StatTile label="Revenue"        value={fmt(totals.revenue)}   compare={pctDelta(totals.revenue, totals.prevRev)} color="var(--acc)"/>
        <StatTile label="Tips"           value={fmt(totals.tips)}      sub={totals.revenue ? `${((totals.tips/totals.revenue)*100).toFixed(1)}% of revenue` : null} color="var(--grn)"/>
        <StatTile label="Avg per head"   value={fmt(totals.staffCount ? totals.revenue/totals.staffCount : 0)}/>
      </div>

      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, overflow:'auto' }}>
        <div style={{ display:'grid', gridTemplateColumns:'40px 1.3fr 80px 80px 70px 70px 100px 80px 80px 70px 70px 70px', padding:'9px 14px', background:'var(--bg3)', borderBottom:'1px solid var(--bdr)', fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.05em', gap:6, minWidth:960 }}>
          <span>#</span>
          <span>Server</span>
          <SortBtn id="hours"    label="Hours"    sortBy={sortBy} sortDir={sortDir} onClick={handleSort}/>
          <SortBtn id="checks"   label="Checks"   sortBy={sortBy} sortDir={sortDir} onClick={handleSort}/>
          <SortBtn id="covers"   label="Covers"   sortBy={sortBy} sortDir={sortDir} onClick={handleSort}/>
          <span style={{ textAlign:'right' }}>Tips</span>
          <SortBtn id="revenue"  label="Revenue"  sortBy={sortBy} sortDir={sortDir} onClick={handleSort}/>
          <SortBtn id="avgCheck" label="Avg chk"  sortBy={sortBy} sortDir={sortDir} onClick={handleSort}/>
          <span style={{ textAlign:'right' }}>Avg cvr</span>
          <SortBtn id="tipPct"   label="Tip %"    sortBy={sortBy} sortDir={sortDir} onClick={handleSort}/>
          <SortBtn id="discPct"  label="Disc %"   sortBy={sortBy} sortDir={sortDir} onClick={handleSort}/>
          <SortBtn id="voidPct"  label="Void %"   sortBy={sortBy} sortDir={sortDir} onClick={handleSort}/>
        </div>

        {sorted.map((r, i) => {
          const prevRev = prevByServer[r.server];
          const delta = prevRev ? pctDelta(r.revenue, prevRev) : null;
          return (
            <div key={r.server} style={{ display:'grid', gridTemplateColumns:'40px 1.3fr 80px 80px 70px 70px 100px 80px 80px 70px 70px 70px', padding:'10px 14px', borderBottom:'1px solid var(--bdr)', fontSize:12, alignItems:'center', gap:6, minWidth:960, background: i % 2 === 0 ? 'transparent' : 'var(--bg2)' }}>
              <span style={{ color:'var(--t4)', fontFamily:'var(--font-mono)' }}>{i + 1}</span>
              <div>
                <div style={{ color:'var(--t1)', fontWeight:600 }}>{r.server}</div>
                {delta !== null && <div style={{ marginTop:2 }}><CompareChip pct={delta}/></div>}
              </div>
              <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{formatHours(r.hoursMs)}</span>
              <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{r.checks}</span>
              <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{r.covers}</span>
              <span style={{ textAlign:'right', color:'var(--grn)', fontFamily:'var(--font-mono)' }}>{fmt(r.tips)}</span>
              <span style={{ textAlign:'right', color:'var(--acc)', fontFamily:'var(--font-mono)', fontWeight:700 }}>{fmt(r.revenue)}</span>
              <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{fmt(r.avgCheck)}</span>
              <span style={{ textAlign:'right', color:'var(--t3)', fontFamily:'var(--font-mono)' }}>{fmt(r.avgCover)}</span>
              <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{r.tipPct.toFixed(1)}%</span>
              <span style={{ textAlign:'right', color: r.discPct > 5 ? 'var(--acc)' : 'var(--t3)', fontFamily:'var(--font-mono)' }}>{r.discPct.toFixed(1)}%</span>
              <span style={{ textAlign:'right', color: r.voidPct > 5 ? 'var(--red)' : 'var(--t3)', fontFamily:'var(--font-mono)' }}>{r.voidPct.toFixed(1)}%</span>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop:14, padding:'10px 12px', background:'var(--bg3)', border:'1px dashed var(--bdr)', borderRadius:8, fontSize:11, color:'var(--t4)', lineHeight:1.7 }}>
        ⓘ Hours are derived from first-check-to-last-check per day, summed across the period. Disc % and Void % are events per 100 check events (voids counted). Values above 5% are highlighted as a soft flag.
      </div>
    </div>
  );
}

function SortBtn({ id, label, sortBy, sortDir, onClick }) {
  const active = sortBy === id;
  const arrow  = active ? (sortDir === 'desc' ? '↓' : '↑') : '';
  return (
    <button onClick={() => onClick(id)} style={{
      textAlign:'right', background:'transparent', border:'none', padding:0, cursor:'pointer', fontFamily:'inherit',
      fontSize:10, fontWeight:700, color: active ? 'var(--acc)' : 'var(--t4)', textTransform:'uppercase', letterSpacing:'.05em',
    }}>{label} {arrow}</button>
  );
}
