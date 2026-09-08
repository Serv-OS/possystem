// v4.6.20: Tables performance report.
//
// Aggregates closed_checks by table (tableId + tableLabel) to show revenue,
// covers, avg check, and turn count per table for the period. Visualizes as a
// bar chart of top tables by revenue plus a sortable table.
//
// Note: true turn time (how long a table was occupied) needs a seated_at column
// on closed_checks (documented in the schema hardening SQL roadmap). For now
// the report counts turns and shows per-check timing, which is still useful for
// spotting under/over-used tables.

import { useMemo, useState } from 'react';
import { StatTile, ExportBtn, EmptyState, BarRow } from './_charts';
import { toCsv, downloadCsv } from './_csv';

const SORT_COLS = [
  { id:'revenue',  label:'Revenue',  fn: r => r.revenue },
  { id:'turns',    label:'Turns',    fn: r => r.turns },
  { id:'covers',   label:'Covers',   fn: r => r.covers },
  { id:'avgCheck', label:'Avg check',fn: r => r.avgCheck },
  { id:'avgCover', label:'Avg cover',fn: r => r.avgCover },
];

function aggregate(checks) {
  const map = {};
  checks.filter(c => c.status !== 'voided' && (c.tableId || c.tableLabel)).forEach(c => {
    const key = c.tableId || c.tableLabel;
    if (!map[key]) map[key] = {
      key, tableId: c.tableId, tableLabel: c.tableLabel || c.tableId,
      turns: 0, covers: 0, revenue: 0, firstAt: c.closedAt, lastAt: c.closedAt,
    };
    map[key].turns   += 1;
    map[key].covers  += c.covers || 1;
    map[key].revenue += c.total || 0;
    if (c.closedAt) {
      if (c.closedAt < map[key].firstAt) map[key].firstAt = c.closedAt;
      if (c.closedAt > map[key].lastAt)  map[key].lastAt  = c.closedAt;
    }
  });
  return Object.values(map).map(r => ({
    ...r,
    avgCheck: r.turns  ? r.revenue / r.turns  : 0,
    avgCover: r.covers ? r.revenue / r.covers : 0,
  }));
}

export default function Tables({ checks, fmt, fmtN }) {
  const [sortBy, setSortBy]   = useState('revenue');
  const [sortDir, setSortDir] = useState('desc');

  const rows = useMemo(() => aggregate(checks), [checks]);

  const sorted = useMemo(() => {
    const col = SORT_COLS.find(c => c.id === sortBy) || SORT_COLS[0];
    return [...rows].sort((a, b) => sortDir === 'desc' ? col.fn(b) - col.fn(a) : col.fn(a) - col.fn(b));
  }, [rows, sortBy, sortDir]);

  const totals = useMemo(() => ({
    revenue: rows.reduce((s, r) => s + r.revenue, 0),
    turns:   rows.reduce((s, r) => s + r.turns,   0),
    covers:  rows.reduce((s, r) => s + r.covers,  0),
    tableCount: rows.length,
  }), [rows]);

  const maxRev = Math.max(1, ...rows.map(r => r.revenue));

  const onExport = () => {
    const csv = toCsv(sorted, [
      { label:'Rank',     key: (_, i) => i + 1 },
      { label:'Table',    key:'tableLabel' },
      { label:'Turns',    key:'turns' },
      { label:'Covers',   key:'covers' },
      { label:'Revenue',  key: r => r.revenue.toFixed(2) },
      { label:'Avg check',key: r => r.avgCheck.toFixed(2) },
      { label:'Avg cover',key: r => r.avgCover.toFixed(2) },
    ].map(col => ({ ...col, key: typeof col.key === 'function' && col.key.length === 2 ? (r => col.key(r, sorted.indexOf(r))) : col.key })));
    downloadCsv(`tables-performance-${new Date().toISOString().slice(0,10)}.csv`, csv);
  };

  if (rows.length === 0) return <EmptyState icon="🪑" message="No table activity in this period. (Walk-in / takeaway / delivery checks are excluded.)"/>;

  const handleSort = (id) => {
    if (sortBy === id) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortBy(id); setSortDir('desc'); }
  };

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:12 }}><ExportBtn onClick={onExport}/></div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:18 }}>
        <StatTile label="Tables used"     value={fmtN(totals.tableCount)}/>
        <StatTile label="Total turns"     value={fmtN(totals.turns)}    sub={`${totals.tableCount ? (totals.turns/totals.tableCount).toFixed(1) : '0'} avg per table`}/>
        <StatTile label="Total covers"    value={fmtN(totals.covers)}   sub={`${totals.turns ? (totals.covers/totals.turns).toFixed(1) : '0'} avg per turn`}/>
        <StatTile label="Revenue (table)" value={fmt(totals.revenue)} color="var(--acc)"/>
      </div>

      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, padding:'16px', marginBottom:14 }}>
        <div style={{ fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:12 }}>Top tables by revenue</div>
        {[...rows].sort((a,b) => b.revenue - a.revenue).slice(0, 12).map(r => (
          <BarRow key={r.key} label={r.tableLabel} valueRight={fmt(r.revenue)} pct={(r.revenue / maxRev) * 100} color="var(--acc)"/>
        ))}
      </div>

      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, overflow:'auto' }}>
        <div style={{ display:'grid', gridTemplateColumns:'40px 1.4fr 70px 70px 110px 90px 90px', padding:'9px 14px', background:'var(--bg3)', borderBottom:'1px solid var(--bdr)', fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.05em', gap:8, minWidth:620 }}>
          <span>#</span>
          <span>Table</span>
          <SortBtn id="turns"    label="Turns"    sortBy={sortBy} sortDir={sortDir} onClick={handleSort}/>
          <SortBtn id="covers"   label="Covers"   sortBy={sortBy} sortDir={sortDir} onClick={handleSort}/>
          <SortBtn id="revenue"  label="Revenue"  sortBy={sortBy} sortDir={sortDir} onClick={handleSort}/>
          <SortBtn id="avgCheck" label="Avg chk"  sortBy={sortBy} sortDir={sortDir} onClick={handleSort}/>
          <SortBtn id="avgCover" label="Avg cvr"  sortBy={sortBy} sortDir={sortDir} onClick={handleSort}/>
        </div>
        {sorted.map((r, i) => (
          <div key={r.key} style={{ display:'grid', gridTemplateColumns:'40px 1.4fr 70px 70px 110px 90px 90px', padding:'10px 14px', borderBottom:'1px solid var(--bdr)', fontSize:12, alignItems:'center', gap:8, minWidth:620, background: i % 2 === 0 ? 'transparent' : 'var(--bg2)' }}>
            <span style={{ color:'var(--t4)', fontFamily:'var(--font-mono)' }}>{i + 1}</span>
            <span style={{ color:'var(--t1)', fontWeight:600 }}>{r.tableLabel}</span>
            <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{r.turns}</span>
            <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{r.covers}</span>
            <span style={{ textAlign:'right', color:'var(--acc)', fontFamily:'var(--font-mono)', fontWeight:700 }}>{fmt(r.revenue)}</span>
            <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{fmt(r.avgCheck)}</span>
            <span style={{ textAlign:'right', color:'var(--t3)', fontFamily:'var(--font-mono)' }}>{fmt(r.avgCover)}</span>
          </div>
        ))}
      </div>

      <div style={{ marginTop:14, padding:'10px 12px', background:'var(--bg3)', border:'1px dashed var(--bdr)', borderRadius:8, fontSize:11, color:'var(--t4)', lineHeight:1.7 }}>
        ⓘ Only dine-in checks with a table assignment are included. True turn time (how long a table was occupied) needs a seated_at timestamp on closed_checks — in the schema roadmap.
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
