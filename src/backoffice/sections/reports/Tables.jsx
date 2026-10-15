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
import { isSplit, sumFields, tagPartRows } from '../../../lib/reportSplit.js';
import { useParts, exportSites, titleSt } from './_siteSplit';
import { SplitHeader, Blocks, SiteRows, SiteCell } from './SiteSplit';

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

// 5 Oct 2026 (Peter: "make every report we have multi site when sites are connected
// together"): with more than one site on screen this is the site split at the foot of the
// file. One site is the report exactly as it was.
export default function Tables(props) {
  return isSplit(props.sites) ? <TablesSites {...props}/> : <TablesOne {...props}/>;
}

function TablesOne({ checks, fmt, fmtN }) {
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

// ─────────────────────────────────────────────────────────────────────────────
// Several sites: split by site only. Table 4 at one site and Table 4 at another are two
// tables (aggregate runs once per site), each row says which site it is at, and nothing
// about a table is ever added across sites.
// ─────────────────────────────────────────────────────────────────────────────
const TABLE_SITE_COLS = '36px 1.2fr 1.2fr 70px 70px 110px 90px 90px';

function TablesSites(props) {
  const { fmtN } = props;
  const { parts, blocks } = useParts(props);
  const bySite = useMemo(() => new Map(parts.map(p => {
    const rows = tagPartRows(p, aggregate(p.rows)).map(r => ({ ...r, part: p }));
    return [p.id, { rows, tableCount: rows.length, ...sumFields(rows, ['revenue', 'turns', 'covers']) }];
  })), [parts]);

  const onExport = () => {
    const rows = parts.flatMap(p => [...bySite.get(p.id).rows].sort((a, b) => b.revenue - a.revenue));
    exportSites('tables-performance', rows, [
      { label:'Currency', key: r => r.part.currency || '' },
      { label:'Table',    key:'tableLabel' },
      { label:'Turns',    key:'turns' },
      { label:'Covers',   key:'covers' },
      { label:'Revenue',  key: r => r.revenue.toFixed(2) },
      { label:'Avg check',key: r => r.avgCheck.toFixed(2) },
      { label:'Avg cover',key: r => r.avgCover.toFixed(2) },
    ]);
  };

  if (parts.every(p => bySite.get(p.id).tableCount === 0)) {
    return <EmptyState icon="🪑" message="No table activity at these sites in this period. (Walk-in / takeaway / delivery checks are excluded.)"/>;
  }

  return (
    <div>
      <SplitHeader parts={parts} onExport={onExport}/>
      <Blocks blocks={blocks}>{b => {
        const site = b.parts.map(p => ({ part: p, cells: bySite.get(p.id) }));
        const all = sumFields(site.map(x => x.cells), ['revenue', 'turns', 'covers', 'tableCount']);
        const tables = b.parts.flatMap(p => bySite.get(p.id).rows).sort((x, y) => y.revenue - x.revenue);
        return (
          <>
            <SiteRows block={b} rows={site} total={all} columns={[
              { label:'Tables used', cell: c => fmtN(c.tableCount) },
              { label:'Turns',       cell: c => fmtN(c.turns) },
              { label:'Covers',      cell: c => fmtN(c.covers) },
              { label:'Revenue (table)', cell: (c, f) => f(c.revenue), color:'var(--acc)' },
              { label:'Avg per turn', cell: (c, f) => f(c.turns ? c.revenue / c.turns : 0) },
            ]}/>
            <div style={titleSt}>Every table, by revenue</div>
            <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, overflow:'auto', marginBottom:14 }}>
              <div style={{ display:'grid', gridTemplateColumns:TABLE_SITE_COLS, padding:'9px 14px', background:'var(--bg3)', borderBottom:'1px solid var(--bdr)', fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.05em', gap:8, minWidth:760 }}>
                <span>#</span><span>Table</span><span>Site</span>
                {['Turns', 'Covers', 'Revenue', 'Avg chk', 'Avg cvr'].map(h => <span key={h} style={{ textAlign:'right' }}>{h}</span>)}
              </div>
              {tables.map((r, i) => (
                <div key={r.siteKey} style={{ display:'grid', gridTemplateColumns:TABLE_SITE_COLS, padding:'10px 14px', borderBottom:'1px solid var(--bdr)', fontSize:12, alignItems:'center', gap:8, minWidth:760, background: i % 2 === 0 ? 'transparent' : 'var(--bg2)' }}>
                  <span style={{ color:'var(--t4)', fontFamily:'var(--font-mono)' }}>{i + 1}</span>
                  <span style={{ color:'var(--t1)', fontWeight:600 }}>{r.tableLabel}</span>
                  <SiteCell name={r.siteName}/>
                  <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{r.turns}</span>
                  <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{r.covers}</span>
                  <span style={{ textAlign:'right', color:'var(--acc)', fontFamily:'var(--font-mono)', fontWeight:700 }}>{b.fmt(r.revenue)}</span>
                  <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{b.fmt(r.avgCheck)}</span>
                  <span style={{ textAlign:'right', color:'var(--t3)', fontFamily:'var(--font-mono)' }}>{b.fmt(r.avgCover)}</span>
                </div>
              ))}
            </div>
          </>
        );
      }}</Blocks>
      <div style={{ padding:'10px 12px', background:'var(--bg3)', border:'1px dashed var(--bdr)', borderRadius:8, fontSize:11, color:'var(--t4)', lineHeight:1.7 }}>
        ⓘ Only dine-in checks with a table are included. A table belongs to its site: the same table number at two sites is two rows.
      </div>
    </div>
  );
}
