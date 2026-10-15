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
import { isSplit } from '../../../lib/reportSplit.js';
import { siteEngineeringItems, classifyItems } from '../../../lib/reportSiteMenu.js';
import { useParts, exportSites, titleSt } from './_siteSplit';
import { useSiteMenus, useOtherSiteMenu } from './_siteMenus';
import { SplitHeader, Blocks, SiteRows } from './SiteSplit';

// One empty list, so a view with nothing to show does not rebuild its tables every render.
const NONE = Object.freeze([]);

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

// 5 Oct 2026 (Peter: "make every report we have multi site when sites are connected
// together"): with more than one site on screen this is the site split at the foot of the
// file, each site's lines read against ITS OWN menu (src/lib/reportSiteMenu.js). One site is
// the report exactly as it was.
export default function MenuEngineering(props) {
  return isSplit(props.sites) ? <MenuEngineeringSites {...props}/> : <MenuEngineeringOne {...props}/>;
}

function MenuEngineeringOne({ checks, fmt, fmtN, sites }) {
  const store = useStore();
  // 5 Oct 2026: one OTHER site ticked. Its categories are its own, read fresh (the store holds
  // the signed in site's). The signed in site reads the store as it always has.
  const other = useOtherSiteMenu(sites);
  const menuCategories = other.other ? (other.menu?.categories || NONE) : (store.menuCategories || NONE);
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

  if (other.loading) return <div style={{ textAlign:'center', padding:'48px 0', color:'var(--t4)', fontSize:13 }}>Loading this site's menu…</div>;
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

// ─────────────────────────────────────────────────────────────────────────────
// Several sites: the matrix and the quadrants for the GROUP (one per currency: a price in
// pounds and a price in dollars are never one median), a shared product one dot, with each
// site's own quadrant counts underneath. Each site's lines are read against its own menu, so
// a category id names the right category and a product shared across sites is one item.
// ─────────────────────────────────────────────────────────────────────────────
function MenuEngineeringSites(props) {
  const { fmtN } = props;
  const { parts, blocks } = useParts(props);
  const { menus, loading, failed } = useSiteMenus(parts);

  // Each site's items, classified on that site's own medians (what its single site report says).
  const bySite = useMemo(() => new Map(parts.map(p => [p.id, classifyItems(siteEngineeringItems(p.rows, menus[p.id] || null))])), [parts, menus]);
  // The group of one currency block: the same items added up across its sites, then classified on the group's medians.
  const groupOf = (block) => {
    const map = {};
    for (const p of block.parts) {
      for (const it of bySite.get(p.id).items) {
        const g = map[it.key] || (map[it.key] = { key: it.key, name: it.name, catLabel: it.catLabel, qty: 0, rev: 0, bySite: {} });
        g.qty += it.qty; g.rev += it.rev; g.bySite[p.id] = it;
      }
    }
    return classifyItems(Object.values(map).map(it => ({ ...it, avgPrice: it.qty ? it.rev / it.qty : 0 })));
  };
  const counts = (items) => {
    const g = { star: 0, plow: 0, puzzle: 0, dog: 0 };
    for (const it of items) g[it.quadrant] += 1;
    return g;
  };

  const onExport = () => {
    const line = (it, siteName, currency) => ({ siteName, currency, item: it.name, category: it.catLabel || '', quadrant: QUADRANTS[it.quadrant].label, qty: it.qty, avgPrice: it.avgPrice.toFixed(2), revenue: it.rev.toFixed(2) });
    const rows = [];
    for (const p of parts) for (const it of bySite.get(p.id).items) rows.push(line(it, p.name, p.currency || ''));
    for (const b of blocks) if (b.parts.length > 1) for (const it of groupOf(b).items) rows.push(line(it, `All ${b.parts.length} sites`, b.currency || ''));
    exportSites('menu-engineering', rows, [
      { label:'Currency',           key:'currency' },
      { label:'Item',               key:'item' },
      { label:'Category',           key:'category' },
      { label:'Quadrant',           key:'quadrant' },
      { label:'Units sold',         key:'qty' },
      { label:'Avg price (contrib proxy)', key:'avgPrice' },
      { label:'Revenue',            key:'revenue' },
    ]);
  };

  if (loading) return <div style={{ textAlign:'center', padding:'48px 0', color:'var(--t4)', fontSize:13 }}>Loading each site's menu…</div>;
  if (parts.every(p => bySite.get(p.id).items.length === 0)) return <EmptyState icon="🎯" message="No items sold at these sites in this period. Widen the date range."/>;

  return (
    <div>
      <SplitHeader parts={parts} chips={false} onExport={onExport}>
        {failed.map(id => <div key={id} style={{ color:'var(--amber)' }}>{parts.find(x => x.id === id)?.name || id}: the menu could not be read, so its products are matched by name.</div>)}
      </SplitHeader>
      <Blocks blocks={blocks}>{b => {
        const group = groupOf(b);
        const byQ = { star: [], plow: [], puzzle: [], dog: [] };
        group.items.forEach(i => byQ[i.quadrant].push(i));
        const site = b.parts.map(p => ({ part: p, cells: { ...counts(bySite.get(p.id).items), items: bySite.get(p.id).items.length } }));
        const all = { ...counts(group.items), items: group.items.length };
        if (!group.items.length) return <EmptyState icon="🎯" message="No items sold at these sites in this period."/>;
        return (
          <>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:14 }}>
              <StatTile label="Stars"       value={fmtN(all.star)}   color={QUADRANTS.star.color}/>
              <StatTile label="Plow Horses" value={fmtN(all.plow)}   color={QUADRANTS.plow.color}/>
              <StatTile label="Puzzles"     value={fmtN(all.puzzle)} color={QUADRANTS.puzzle.color}/>
              <StatTile label="Dogs"        value={fmtN(all.dog)}    color={QUADRANTS.dog.color}/>
            </div>
            <SiteRows block={b} rows={site} total={all} title="Quadrants by site (each on its own medians)" columns={[
              { label:'Items',       cell: c => fmtN(c.items) },
              { label:'Stars',       cell: c => fmtN(c.star),   color: QUADRANTS.star.color },
              { label:'Plow horses', cell: c => fmtN(c.plow),   color: QUADRANTS.plow.color },
              { label:'Puzzles',     cell: c => fmtN(c.puzzle), color: QUADRANTS.puzzle.color },
              { label:'Dogs',        cell: c => fmtN(c.dog),    color: QUADRANTS.dog.color },
            ]}/>
            <div style={titleSt}>All {b.parts.length} sites together</div>
            <MatrixChart items={group.items} popMed={group.popMed} contribMed={group.contribMed} fmt={b.fmt}/>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginTop:16, marginBottom:14 }}>
              <QuadrantCard id="star"   rows={byQ.star}   fmt={b.fmt}/>
              <QuadrantCard id="puzzle" rows={byQ.puzzle} fmt={b.fmt}/>
              <QuadrantCard id="plow"   rows={byQ.plow}   fmt={b.fmt}/>
              <QuadrantCard id="dog"    rows={byQ.dog}    fmt={b.fmt}/>
            </div>
          </>
        );
      }}</Blocks>
      <div style={{ padding:'10px 12px', background:'var(--bg3)', border:'1px dashed var(--bdr)', borderRadius:8, fontSize:11, color:'var(--t4)', lineHeight:1.7 }}>
        ⓘ The group row of "All sites" classifies each product on the group's medians; the site rows classify each site's products on its own medians, as its single site report does, so the counts need not add up. Contribution is proxied by average price per unit. The CSV has every item per site, then the group.
      </div>
    </div>
  );
}
