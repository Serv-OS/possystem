// The site split kit: what every report draws with once more than one site is ticked
// (Peter, 5 Oct 2026: "make every report we have multi site when sites are connected
// together, and you can filter them down to just one site").
//
// The layout is the same on every report: a group total on top, then a row or a column per
// site. Money in two currencies is never one number, so everything sits inside a currency
// block (one block, and no heading, when every site shares a currency).
//
// The maths is in src/lib/reportSplit.js (pure, tested); this file only draws (the hook and
// the CSV helper that go with it are in ./_siteSplit.js). A report with
// ONE site on screen never comes here: it renders exactly as it did before the split.

import { CompareChip, ExportBtn } from './_charts';
import { blockTitle } from '../../../lib/reportSplit.js';
import { titleSt } from './_siteSplit';
import { groupCompare } from '../../../lib/reportScope.js';

const cardSt = { background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, overflow:'auto', marginBottom:14 };
const headSt = { padding:'9px 14px', background:'var(--bg3)', borderBottom:'1px solid var(--bdr)', fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.05em', gap:8 };
const rowSt  = { padding:'9px 14px', borderBottom:'1px solid var(--bdr)', fontSize:12, alignItems:'center', gap:8 };
const numSt  = { textAlign:'right', fontFamily:'var(--font-mono)', color:'var(--t2)' };

// The line above a split report: how many sites, the clock rule, and the one Export.
// chips = the report shows a percent against the comparison (so it must say when it cannot).
export function SplitHeader({ parts, fromSums = false, chips = true, onExport, children }) {
  const noPercent = chips && fromSums && parts.some(p => p.site?.range?.compare && !p.compare);
  return (
    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:12, marginBottom:12 }}>
      <div style={{ fontSize:11, color:'var(--t3)', lineHeight:1.6 }}>
        <strong style={{ color:'var(--t1)' }}>{parts.length} sites</strong>, each read on its own clock and business day.
        {fromSums && <div style={{ color:'var(--t4)' }}>A long period across several sites: these totals are added up by the database, in whole business days.</div>}
        {noPercent && <div style={{ color:'var(--t4)' }}>No percent is shown: the comparison stops part way through a day, and these totals are whole days.</div>}
        {children}
      </div>
      {onExport && <ExportBtn onClick={onExport}/>}
    </div>
  );
}

// One section per currency. The heading only shows when there is more than one.
export function Blocks({ blocks, children }) {
  return blocks.map(b => (
    <div key={b.key} style={{ marginBottom: blocks.length > 1 ? 28 : 0 }}>
      {blocks.length > 1 && (
        <div style={{ fontSize:13, fontWeight:800, color:'var(--t1)', marginBottom:8 }}>
          {blockTitle(b)} <span style={{ fontWeight:400, color:'var(--t4)', fontSize:11 }}>· totals are never added across currencies</span>
        </div>
      )}
      {children(b)}
    </div>
  ));
}

// The group against its comparison, like for like: only sites with both sides count.
//   pairs  [{ current, previous }], one per site of the block, in the block's order
export function GroupChange({ block, pairs }) {
  const grey = { fontSize:10, color:'var(--t4)', fontFamily:'var(--font-mono)' };
  const vs = block.parts.map(p => p.compare);
  if (vs.some(c => !c)) return null;
  if (vs.some(c => c.loaded === false)) return <span style={grey}>Comparison did not load</span>;
  const g = groupCompare(pairs);
  if (g.pct == null) return <span style={grey}>Nothing to compare with{g.fresh ? ` (${g.fresh} new)` : ''}</span>;
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:6, flexWrap:'wrap' }}>
      <CompareChip pct={g.pct} vs={vs[0]}/>
      {g.text && <span style={grey}>{g.text}</span>}
    </span>
  );
}

// One site's percent, on its own comparison. Nothing when there is no fair comparison.
export function SiteChange({ part, values, noun, short = true }) {
  return part.compare ? <CompareChip vs={part.compare} values={values} noun={noun} short={short}/> : <span style={{ color:'var(--t4)' }}>—</span>;
}

// A row per site under the group's total.
//   rows     [{ part, cells }] in the block's order; total = the block's cells (or null)
//   columns  [{ label, cell: (cells, fmt, part) => node, color }]  (part is null on the total row)
export function SiteRows({ block, rows, total, columns, title = 'By site' }) {
  const cols = `1.6fr ${columns.map(() => 'minmax(84px, 1fr)').join(' ')}`;
  const min = 220 + columns.length * 96;
  const line = (label, cells, part, strong) => (
    <div key={part ? part.id : 'total'} style={{ ...rowSt, display:'grid', gridTemplateColumns:cols, minWidth:min, background: strong ? 'var(--bg2)' : 'transparent' }}>
      <span style={{ color:'var(--t1)', fontWeight: strong ? 800 : 600 }}>{label}</span>
      {columns.map(c => (
        <span key={c.label} style={{ ...numSt, color: c.color || numSt.color, fontWeight: strong ? 800 : 500 }}>{c.cell(cells, block.fmt, part)}</span>
      ))}
    </div>
  );
  return (
    <div style={cardSt}>
      <div style={{ ...headSt, display:'grid', gridTemplateColumns:cols, minWidth:min }}>
        <span>{title}</span>
        {columns.map(c => <span key={c.label} style={{ textAlign:'right' }}>{c.label}</span>)}
      </div>
      {total && block.parts.length > 1 && line(`All ${block.parts.length} sites`, total, null, true)}
      {rows.map(r => line(r.part.name, r.cells, r.part, false))}
    </div>
  );
}

// A column per site, with the group's total first.
//   rows  [{ key, label, bySite: { [siteId]: number }, total, kind: 'money' | 'count', strong,
//            render: (part) => node, totalNode }]  (render/totalNode replace the numbers)
export function SiteMatrix({ block, rows, first = '', fmtN = (n) => (n || 0).toLocaleString(), title }) {
  const many = block.parts.length > 1;
  const cols = `1.4fr ${many ? 'minmax(96px, 1fr) ' : ''}${block.parts.map(() => 'minmax(96px, 1fr)').join(' ')}`;
  const min = 200 + (block.parts.length + 1) * 104;
  const show = (r, v) => (r.kind === 'count' ? fmtN(v) : block.fmt(v));
  return (
    <div style={cardSt}>
      {title && <div style={{ padding:'10px 14px 0', ...titleSt, margin:0 }}>{title}</div>}
      <div style={{ ...headSt, display:'grid', gridTemplateColumns:cols, minWidth:min, background: title ? 'transparent' : headSt.background }}>
        <span>{first}</span>
        {many && <span style={{ textAlign:'right', color:'var(--t2)' }}>All {block.parts.length} sites</span>}
        {block.parts.map(p => <span key={p.id} style={{ textAlign:'right' }} title={p.name}>{p.short || p.name}</span>)}
      </div>
      {rows.map(r => (
        <div key={r.key} style={{ ...rowSt, display:'grid', gridTemplateColumns:cols, minWidth:min, background: r.strong ? 'var(--bg2)' : 'transparent' }}>
          <span style={{ color: r.strong ? 'var(--t1)' : 'var(--t2)', fontWeight: r.strong ? 800 : 500 }}>{r.label ?? r.key}</span>
          {many && <span style={{ ...numSt, color:'var(--t1)', fontWeight:800 }}>{r.render ? (r.totalNode ?? '') : show(r, r.total)}</span>}
          {block.parts.map(p => (
            <span key={p.id} style={{ ...numSt, fontWeight: r.strong ? 700 : 500 }}>{r.render ? r.render(p) : show(r, r.bySite[p.id])}</span>
          ))}
        </div>
      ))}
    </div>
  );
}

// The Site cell of a list that has one row per thing per site.
export function SiteCell({ name }) {
  return <span style={{ color:'var(--t3)', fontSize:11, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={name}>{name}</span>;
}
