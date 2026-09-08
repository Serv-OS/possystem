// v4.6.17: Menu Engineering 2×2 report.
//
// Classic Kasavana-Smith matrix:
//   X-axis = popularity (units sold)
//   Y-axis = contribution (avg price per unit — the margin proxy we have
//            until COGS is captured on menu_items)
// The median on each axis splits items into four quadrants:
//   Stars        — high popularity, high contribution (promote, feature, protect)
//   Plow Horses  — high popularity, low contribution (reengineer pricing, upsell to Stars)
//   Puzzles      — low popularity, high contribution (reposition, rename, rephotograph)
//   Dogs         — low popularity, low contribution (cut unless strategic)
//
// When real item cost ships on menu_items, swap avgPrice for (price - cost) contribution
// margin — the rest of the report stays identical.

import { useMemo } from 'react';
import { useStore } from '../../../store';
import { StatTile, ExportBtn, EmptyState } from './_charts';
import { toCsv, downloadCsv } from './_csv';

const QUADRANTS = {
  star:   { label:'Stars',       blurb:'High popularity, high contribution.', color:'var(--grn)', bg:'var(--grn-d)', action:'Promote, feature, protect.' },
  plow:   { label:'Plow Horses', blurb:'High volume, low contribution.',       color:'var(--acc)', bg:'var(--acc-d)', action:'Reengineer pricing, upsell.' },
  puzzle: { label:'Puzzles',     blurb:'Low volume, high contribution.',       color:'#3b82f6',    bg:'rgba(59,130,246,.15)', action:'Reposition, rename, rephotograph.' },
  dog:    { label:'Dogs',        blurb:'Low volume, low contribution.',        color:'var(--red)', bg:'var(--red-d)', action:'Cut unless strategic.' },
};

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function classify(item, popMed, contribMed) {
  const highPop     = item.qty       >= popMed;
  const highContrib = item.avgPrice  >= contribMed;
  if (highPop  && highContrib) return 'star';
  if (highPop  && !highContrib) return 'plow';
  if (!highPop && highContrib) return 'puzzle';
  return 'dog';
}

export default function MenuEngineering({ checks, fmt, fmtN }) {
  const { menuCategories = [] } = useStore();
  const catLabel = useMemo(() => {
    const map = {};
    menuCategories.forEach(c => { map[c.id] = c.label || c.name || c.id; });
    return map;
  }, [menuCategories]);

  const { items, popMed, contribMed } = useMemo(() => {
    const map = {};
    checks.filter(c => c.status !== 'voided').forEach(c => {
      (c.items || []).forEach(i => {
        if (i.voided) return;
        const key = i.name || 'Unknown';
        if (!map[key]) map[key] = { name:key, cat:i.cat || null, qty:0, rev:0 };
        const qty = i.qty || 1;
        map[key].qty += qty;
        map[key].rev += (i.price || 0) * qty;
      });
    });
    const items = Object.values(map).map(it => ({ ...it, avgPrice: it.qty ? it.rev / it.qty : 0 }));
    const popMed     = median(items.map(i => i.qty));
    const contribMed = median(items.map(i => i.avgPrice));
    items.forEach(i => { i.quadrant = classify(i, popMed, contribMed); });
    items.sort((a, b) => b.rev - a.rev);
    return { items, popMed, contribMed };
  }, [checks]);

  const byQuadrant = useMemo(() => {
    const g = { star:[], plow:[], puzzle:[], dog:[] };
    items.forEach(i => g[i.quadrant].push(i));
    Object.values(g).forEach(arr => arr.sort((a, b) => b.rev - a.rev));
    return g;
  }, [items]);

  const onExport = () => {
    const rows = items.map(i => ({
      item: i.name,
      category: i.cat ? (catLabel[i.cat] || '') : '',
      quadrant: QUADRANTS[i.quadrant].label,
      qty: i.qty,
      avgPrice: i.avgPrice.toFixed(2),
      revenue: i.rev.toFixed(2),
    }));
    const csv = toCsv(rows, [
      { label:'Item',               key:'item' },
      { label:'Category',           key:'category' },
      { label:'Quadrant',           key:'quadrant' },
      { label:'Units sold',         key:'qty' },
      { label:'Avg price (contrib proxy)', key:'avgPrice' },
      { label:'Revenue',            key:'revenue' },
    ]);
    downloadCsv(`menu-engineering-${new Date().toISOString().slice(0,10)}.csv`, csv);
  };

  if (items.length === 0) return <EmptyState icon="🎯" message="No items sold in this period. Widen the date range."/>;

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:12 }}><ExportBtn onClick={onExport}/></div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:14 }}>
        <StatTile label="Stars"       value={fmtN(byQuadrant.star.length)}   color={QUADRANTS.star.color}/>
        <StatTile label="Plow Horses" value={fmtN(byQuadrant.plow.length)}   color={QUADRANTS.plow.color}/>
        <StatTile label="Puzzles"     value={fmtN(byQuadrant.puzzle.length)} color={QUADRANTS.puzzle.color}/>
        <StatTile label="Dogs"        value={fmtN(byQuadrant.dog.length)}    color={QUADRANTS.dog.color}/>
      </div>

      <MatrixChart items={items} popMed={popMed} contribMed={contribMed} fmt={fmt}/>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginTop:16 }}>
        <QuadrantCard id="star"   rows={byQuadrant.star}   fmt={fmt}/>
        <QuadrantCard id="puzzle" rows={byQuadrant.puzzle} fmt={fmt}/>
        <QuadrantCard id="plow"   rows={byQuadrant.plow}   fmt={fmt}/>
        <QuadrantCard id="dog"    rows={byQuadrant.dog}    fmt={fmt}/>
      </div>

      <div style={{ marginTop:14, padding:'10px 12px', background:'var(--bg3)', border:'1px dashed var(--bdr)', borderRadius:8, fontSize:11, color:'var(--t4)', lineHeight:1.7 }}>
        ⓘ Contribution is proxied by average price per unit until we capture item cost on menu_items. Median splits are computed on the items in this period, so narrow date ranges move the thresholds — use a month or more for decisions.
      </div>
    </div>
  );
}

function QuadrantCard({ id, rows, fmt }) {
  const q = QUADRANTS[id];
  return (
    <div style={{ background:'var(--bg1)', border:`1px solid var(--bdr)`, borderRadius:12, overflow:'hidden' }}>
      <div style={{ padding:'10px 14px', background:q.bg, borderBottom:`1px solid ${q.color}55`, display:'flex', alignItems:'baseline', gap:10 }}>
        <span style={{ fontSize:13, fontWeight:800, color:q.color, letterSpacing:'.02em' }}>{q.label}</span>
        <span style={{ fontSize:11, color:'var(--t4)' }}>{q.blurb}</span>
        <span style={{ marginLeft:'auto', fontSize:10, fontWeight:700, color:'var(--t3)', fontFamily:'var(--font-mono)' }}>{rows.length} items</span>
      </div>
      <div style={{ padding:'6px 14px 4px', fontSize:11, color:'var(--t3)', fontStyle:'italic', borderBottom:'1px solid var(--bdr)' }}>
        Action — {q.action}
      </div>
      {rows.length === 0 ? (
        <div style={{ padding:'16px 14px', fontSize:12, color:'var(--t4)', textAlign:'center' }}>No items in this quadrant.</div>
      ) : rows.slice(0, 12).map(r => (
        <div key={r.name} style={{ display:'grid', gridTemplateColumns:'2fr 50px 80px 80px', padding:'8px 14px', borderBottom:'1px solid var(--bdr)', fontSize:12, alignItems:'center', gap:8 }}>
          <span style={{ color:'var(--t1)', fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.name}</span>
          <span style={{ textAlign:'right', color:'var(--t3)', fontFamily:'var(--font-mono)' }}>{r.qty}×</span>
          <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{fmt(r.avgPrice)}</span>
          <span style={{ textAlign:'right', color:q.color, fontFamily:'var(--font-mono)', fontWeight:700 }}>{fmt(r.rev)}</span>
        </div>
      ))}
      {rows.length > 12 && (
        <div style={{ padding:'8px 14px', fontSize:11, color:'var(--t4)', textAlign:'center' }}>
          + {rows.length - 12} more — in the CSV export.
        </div>
      )}
    </div>
  );
}

function MatrixChart({ items, popMed, contribMed, fmt }) {
  // SVG scatter. Domain = data min/max with padding, clamped so medians aren't at edges.
  const W = 720, H = 360;
  const padL = 48, padR = 16, padT = 20, padB = 30;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const maxQty   = Math.max(1, ...items.map(i => i.qty));
  const maxPrice = Math.max(0.01, ...items.map(i => i.avgPrice));

  const x = q => padL + (q / maxQty) * chartW;
  const y = p => padT + chartH - (p / maxPrice) * chartH;

  const xMed = x(popMed);
  const yMed = y(contribMed);

  // Radii scaled by sqrt(revenue) to avoid dominance by a couple of huge items
  const maxRev = Math.max(1, ...items.map(i => i.rev));
  const r = rev => 3 + Math.sqrt(rev / maxRev) * 6;

  return (
    <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, padding:'16px', overflowX:'auto' }}>
      <div style={{ fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:10 }}>
        Popularity × contribution — {items.length} items
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width:'100%', minWidth:600, height:'auto', display:'block' }}>
        {/* Quadrant backgrounds */}
        <rect x={padL}  y={padT}  width={xMed - padL}             height={yMed - padT}              fill="rgba(59,130,246,.05)"/>
        <rect x={xMed}  y={padT}  width={W - padR - xMed}         height={yMed - padT}              fill="rgba(34,197,94,.05)"/>
        <rect x={padL}  y={yMed}  width={xMed - padL}             height={padT + chartH - yMed}     fill="rgba(239,68,68,.04)"/>
        <rect x={xMed}  y={yMed}  width={W - padR - xMed}         height={padT + chartH - yMed}     fill="rgba(232,160,32,.05)"/>

        {/* Median lines */}
        <line x1={xMed} y1={padT} x2={xMed} y2={padT + chartH} stroke="var(--bdr)" strokeDasharray="3 3"/>
        <line x1={padL} y1={yMed} x2={padL + chartW} y2={yMed} stroke="var(--bdr)" strokeDasharray="3 3"/>

        {/* Quadrant labels */}
        <text x={padL + 8} y={padT + 14} fontSize="11" fill="#3b82f6" fontWeight="700" fontFamily="var(--font-mono)">PUZZLES</text>
        <text x={W - padR - 8} y={padT + 14} fontSize="11" fill="var(--grn)" fontWeight="700" textAnchor="end" fontFamily="var(--font-mono)">STARS</text>
        <text x={padL + 8} y={padT + chartH - 6} fontSize="11" fill="var(--red)" fontWeight="700" fontFamily="var(--font-mono)">DOGS</text>
        <text x={W - padR - 8} y={padT + chartH - 6} fontSize="11" fill="var(--acc)" fontWeight="700" textAnchor="end" fontFamily="var(--font-mono)">PLOW HORSES</text>

        {/* Axis labels */}
        <text x={padL} y={H - 10} fontSize="10" fill="var(--t4)" fontFamily="var(--font-mono)">0</text>
        <text x={W - padR} y={H - 10} fontSize="10" fill="var(--t4)" textAnchor="end" fontFamily="var(--font-mono)">{maxQty} units</text>
        <text x={W/2} y={H - 10} fontSize="11" fill="var(--t3)" textAnchor="middle" fontFamily="var(--font-mono)">popularity →</text>

        <text x={8} y={padT + 8} fontSize="10" fill="var(--t4)" fontFamily="var(--font-mono)">{fmt(maxPrice)}</text>
        <text x={8} y={padT + chartH} fontSize="10" fill="var(--t4)" fontFamily="var(--font-mono)">0</text>
        <text x={16} y={padT + chartH / 2} fontSize="11" fill="var(--t3)" transform={`rotate(-90, 16, ${padT + chartH / 2})`} textAnchor="middle" fontFamily="var(--font-mono)">avg price →</text>

        {/* Data points */}
        {items.map(it => {
          const q = QUADRANTS[it.quadrant];
          return (
            <g key={it.name}>
              <circle
                cx={x(it.qty)} cy={y(it.avgPrice)} r={r(it.rev)}
                fill={q.color} fillOpacity="0.55" stroke={q.color} strokeWidth="1"
              >
                <title>{`${it.name}\nQty: ${it.qty}\nAvg price: ${fmt(it.avgPrice)}\nRevenue: ${fmt(it.rev)}\nQuadrant: ${q.label}`}</title>
              </circle>
            </g>
          );
        })}
      </svg>
      <div style={{ marginTop:8, fontSize:10, color:'var(--t4)', fontFamily:'var(--font-mono)' }}>
        Median popularity: {popMed.toFixed(1)} units · Median avg price: {fmt(contribMed)} · Dot size ∝ √revenue · Hover a dot for details.
      </div>
    </div>
  );
}
