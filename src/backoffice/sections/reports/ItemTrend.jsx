// v5.5.88 — Item Sales Trend matrix.
// Items down the left, days across the top, qty (or revenue) in each cell.
// The exact view a baker / coffee shop / kitchen owner asks for: how many
// donuts of each kind did I sell on each day of the period.
//
// Row totals on the right, column totals on the bottom. Top-50 items by
// period qty by default with a toggle to show all. Sticky item-name column
// so the names stay visible while you scroll horizontally across dates.

import { useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { ExportBtn, EmptyState, StatTile } from './_charts';
import { toCsv, downloadCsv } from './_csv';

// Attribution constants for the sources breakdown
const SRC_STANDALONE = '__standalone';

const TOP_N_OPTIONS = [10, 25, 50, 100, 'all'];
const METRICS = [
  { id:'qty', label:'Qty sold' },
  { id:'rev', label:'Revenue' },
];

// Format a Date as YYYY-MM-DD (local timezone — the period the user picked
// is already local, no need to convert).
function fmtDayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
// Short header label for the day column ("Mon 5", "Tue 6", …)
function fmtDayHeader(d) {
  const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
  return `${dow} ${d.getDate()}`;
}
// Tooltip label ("Mon 5 May 2026")
function fmtDayFull(d) {
  return d.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short', year:'numeric' });
}

export default function ItemTrend({ checks, fmt, fmtN, rangeFrom, rangeTo }) {
  const { menuCategories = [], menuItems = [] } = useStore();
  const [metric, setMetric] = useState('qty');
  const [topN, setTopN] = useState(50);
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('all');
  const [dowFilter, setDowFilter] = useState('all'); // 'all' | 0..6 (Sun..Sat)
  const [includeMods, setIncludeMods] = useState(true); // attribute modifier components (Bueno inside Box of 3)
  const [showDebug, setShowDebug] = useState(false); // diagnostic — what mods are actually in the data?
  // Menu item lookups for attributing modifier components back to their item
  // rows. We index by BOTH id and lowercase name. Reason: BO setups vary in
  // whether a modifier option's id equals the corresponding menu_item.id —
  // some installs share the id, some give the option its own id and just
  // mark soldAlone:true on a separate menu row with the same name. Falling
  // back to a name match catches the second case and means the rollup
  // works for the donut shop / Box of 3 / steak-with-fries-or-sweet-potato
  // examples regardless of how the back-office data is structured.
  const menuById = useMemo(() => {
    const map = {};
    (menuItems || []).forEach(m => { if (m.id) map[m.id] = m; });
    return map;
  }, [menuItems]);
  const menuByName = useMemo(() => {
    const map = {};
    (menuItems || []).forEach(m => {
      if (!m?.name) return;
      const key = m.name.toLowerCase().trim();
      // First-write-wins so an exact-name match beats a near-duplicate
      if (!map[key]) map[key] = m;
    });
    return map;
  }, [menuItems]);
  const lookupModItem = (m) => {
    if (m?.id && menuById[m.id]) return menuById[m.id];
    if (m?.name) {
      const hit = menuByName[m.name.toLowerCase().trim()];
      if (hit) return hit;
    }
    // Historical closed_checks (from before InlineItemFlow started preserving
    // id/name) only have `label`. Try that, stripping any "×N" qty suffix
    // first so "Bueno ×3" still matches "Bueno".
    if (m?.label) {
      const cleaned = m.label.replace(/\s*[×x]\s*\d+\s*$/i, '').toLowerCase().trim();
      const hit = menuByName[cleaned];
      if (hit) return hit;
    }
    return null;
  };

  // Day axis — every day in the range, even days with zero sales (zeros are
  // signal too; don't hide them).
  const days = useMemo(() => {
    if (!rangeFrom || !rangeTo) return [];
    const start = new Date(rangeFrom); start.setHours(0,0,0,0);
    const end   = new Date(rangeTo);   end.setHours(0,0,0,0);
    const out = [];
    for (let t = start.getTime(); t <= end.getTime(); t += 24*60*60*1000) {
      const d = new Date(t);
      if (dowFilter === 'all' || Number(dowFilter) === d.getDay()) out.push(d);
    }
    return out;
  }, [rangeFrom, rangeTo, dowFilter]);

  // Category id → label
  const catLabel = useMemo(() => {
    const map = {};
    menuCategories.forEach(c => { map[c.id] = c.label || c.name || c.id; });
    return map;
  }, [menuCategories]);

  // Build the matrix.
  // Row shape: { name, cat, total, totalRev, byDay, byDayRev, sources }
  // sources = { [parentName | SRC_STANDALONE]: qty }  → drives the
  // "27 sold (3 in Box of 3, 24 standalone)" breakdown.
  // When includeMods is on, each line item contributes:
  //   • a row keyed by its OWN name (sources[SRC_STANDALONE] += qty)
  //   • for each modifier whose option id matches a menu item, a row keyed by
  //     that COMPONENT item (sources[parentName] += qty)
  // This way a "Box of 3" containing a Bueno + 2 Glazed counts the box AND
  // the components in their respective rows, with provenance.
  const { rows, totalsByDay, periodTotal } = useMemo(() => {
    const map = {};
    const totalsByDay = {};
    let periodTotal = 0;
    const dayKeys = new Set(days.map(fmtDayKey));

    const bump = (key, name, cat, qty, rev, dayKey, source) => {
      if (!map[key]) {
        map[key] = { name, cat: cat || null, total: 0, totalRev: 0, byDay: {}, byDayRev: {}, sources: {} };
      }
      map[key].total += qty;
      map[key].totalRev += rev;
      map[key].byDay[dayKey]    = (map[key].byDay[dayKey]    || 0) + qty;
      map[key].byDayRev[dayKey] = (map[key].byDayRev[dayKey] || 0) + rev;
      map[key].sources[source]  = (map[key].sources[source]  || 0) + qty;
    };

    checks.filter(c => c.status !== 'voided').forEach(c => {
      if (!c.closedAt) return;
      const d = new Date(c.closedAt);
      const dayKey = fmtDayKey(d);
      if (!dayKeys.has(dayKey)) return;
      (c.items || []).forEach(i => {
        if (i.voided) return;
        const lineQty = i.qty || 1;
        const lineRev = (i.price || 0) * lineQty;
        const lineName = i.name || 'Unknown';
        // 1) Parent line itself
        bump(lineName, lineName, i.cat, lineQty, lineRev, dayKey, SRC_STANDALONE);
        totalsByDay[dayKey] = (totalsByDay[dayKey] || 0) + (metric === 'qty' ? lineQty : lineRev);
        periodTotal += (metric === 'qty' ? lineQty : lineRev);

        // 2) Modifier components — only if the option is a real menu item
        //    (cart records mods as { id, name, price, label, groupLabel } and
        //    the id matches a menu_items.id when the option is sold-alone).
        if (!includeMods) return;
        (i.mods || []).forEach(m => {
          if (!m || m._instruction) return;
          const mItem = lookupModItem(m);
          if (!mItem) return; // option isn't its own menu item — skip
          // For most mods, flatMods is built per parent qty already (one entry
          // per pick), so the entry represents one unit. For quantity-mode
          // mods (e.g. "Bueno ×3" inside Box of 3), the mod carries a qty
          // field — multiply by that. Multiply by lineQty in either case so
          // 2× Box of 3 with 3 Bueno each = 6 Bueno.
          const modQty = Number(m.qty) || 1;
          const compQty = modQty * lineQty;
          const compRev = (Number(m.price) || 0) * lineQty;
          bump(mItem.name, mItem.name, mItem.cat || null, compQty, compRev, dayKey, lineName);
          totalsByDay[dayKey] = (totalsByDay[dayKey] || 0) + (metric === 'qty' ? compQty : compRev);
          periodTotal += (metric === 'qty' ? compQty : compRev);
        });
      });
    });
    let arr = Object.values(map);
    // Apply category filter
    if (catFilter !== 'all') arr = arr.filter(r => r.cat === catFilter);
    // Apply search
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      arr = arr.filter(r => r.name.toLowerCase().includes(q));
    }
    // Sort by chosen metric
    arr.sort((a, b) => (metric === 'qty' ? b.total - a.total : b.totalRev - a.totalRev));
    return { rows: arr, totalsByDay, periodTotal };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checks, days, metric, catFilter, search, includeMods, menuById, menuByName]);

  // Top-N truncation
  const visibleRows = topN === 'all' ? rows : rows.slice(0, Number(topN));
  const cellOf = (r, dayKey) => metric === 'qty' ? (r.byDay[dayKey] || 0) : (r.byDayRev[dayKey] || 0);
  const rowTotal = (r) => metric === 'qty' ? r.total : r.totalRev;

  // For colour intensity: cap at the 95th percentile so one outlier day
  // doesn't crush the rest of the gradient.
  const cellMax = useMemo(() => {
    const vals = [];
    visibleRows.forEach(r => days.forEach(d => {
      const v = cellOf(r, fmtDayKey(d));
      if (v > 0) vals.push(v);
    }));
    if (!vals.length) return 1;
    vals.sort((a, b) => a - b);
    return vals[Math.floor(vals.length * 0.95)] || vals[vals.length - 1] || 1;
  }, [visibleRows, days, metric]);

  const cats = useMemo(() => {
    const set = new Set();
    rows.forEach(r => r.cat && set.add(r.cat));
    return [...set].sort((a, b) => (catLabel[a] || '').localeCompare(catLabel[b] || ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, catLabel]);

  // ── DIAGNOSTIC: survey every mod seen in the period ──────────────────────
  // Surfaces exactly what shape closed_checks.items[].mods is in. If this
  // panel shows "Box of 3" lines but every mod has empty id/name/label or
  // nothing at all, the cart-add flow that built those rows wasn't preserving
  // the option's identity (this is what 5.5.91 fixed for InlineItemFlow —
  // but other code paths may still strip it).
  const modSurvey = useMemo(() => {
    const all = []; // { id, name, label, parentName, count, resolved }
    const seen = new Map(); // key -> entry
    let parentLinesWithMods = 0;
    let parentLinesWithoutMods = 0;
    checks.filter(c => c.status !== 'voided').forEach(c => {
      (c.items || []).forEach(i => {
        if (i.voided) return;
        const mods = i.mods || [];
        if (mods.length) parentLinesWithMods++; else parentLinesWithoutMods++;
        mods.forEach(m => {
          if (!m || m._instruction) return;
          const key = `${m.id || ''}|${m.name || ''}|${m.label || ''}`;
          const resolved = !!lookupModItem(m);
          if (!seen.has(key)) {
            const entry = { id: m.id || null, name: m.name || null, label: m.label || null, parentName: i.name, count: 0, resolved };
            seen.set(key, entry);
            all.push(entry);
          }
          seen.get(key).count += 1;
        });
      });
    });
    return { entries: all.sort((a, b) => b.count - a.count), parentLinesWithMods, parentLinesWithoutMods };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checks, menuById, menuByName]);

  // ── Stats ──────────────────────────────────────────────────────────────────
  const avgPerDay = days.length ? periodTotal / days.length : 0;
  const topItem = rows[0];
  const dayCount = days.length;
  const itemCount = rows.length;

  // ── CSV export ─────────────────────────────────────────────────────────────
  const exportCsv = () => {
    const headers = [
      { key:'name', label:'Item' },
      { key:'cat',  label:'Category' },
      ...days.map(d => ({ key: fmtDayKey(d), label: fmtDayFull(d) })),
      { key:'_total', label: metric === 'qty' ? 'Period qty' : 'Period revenue' },
    ];
    const csvRows = visibleRows.map(r => {
      const out = { name: r.name, cat: catLabel[r.cat] || '' };
      days.forEach(d => { out[fmtDayKey(d)] = cellOf(r, fmtDayKey(d)) || ''; });
      out._total = rowTotal(r).toFixed(metric === 'qty' ? 0 : 2);
      return out;
    });
    // Append a column-totals footer row
    const footer = { name: 'TOTAL', cat: '' };
    days.forEach(d => { footer[fmtDayKey(d)] = (totalsByDay[fmtDayKey(d)] || 0).toFixed(metric === 'qty' ? 0 : 2); });
    footer._total = periodTotal.toFixed(metric === 'qty' ? 0 : 2);
    csvRows.push(footer);
    downloadCsv(`item-trend-${metric}-${fmtDayKey(new Date(rangeFrom))}-to-${fmtDayKey(new Date(rangeTo))}.csv`, toCsv(csvRows, headers));
  };

  if (!days.length || rows.length === 0) {
    return <EmptyState icon="📈" message="No item sales in this range. Try widening the period."/>;
  }

  return (
    <div>
      {/* Header + filter row */}
      <div style={{ display:'flex', gap:10, alignItems:'center', marginBottom:14, flexWrap:'wrap' }}>
        <select value={metric} onChange={e => setMetric(e.target.value)} style={selectSt}>
          {METRICS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        <select value={catFilter} onChange={e => setCatFilter(e.target.value)} style={selectSt}>
          <option value="all">All categories</option>
          {cats.map(c => <option key={c} value={c}>{catLabel[c] || c}</option>)}
        </select>
        <select value={dowFilter} onChange={e => setDowFilter(e.target.value)} style={selectSt}>
          <option value="all">Every day of week</option>
          <option value={1}>Mondays only</option>
          <option value={2}>Tuesdays only</option>
          <option value={3}>Wednesdays only</option>
          <option value={4}>Thursdays only</option>
          <option value={5}>Fridays only</option>
          <option value={6}>Saturdays only</option>
          <option value={0}>Sundays only</option>
        </select>
        <select value={topN} onChange={e => setTopN(e.target.value === 'all' ? 'all' : Number(e.target.value))} style={selectSt}>
          {TOP_N_OPTIONS.map(n => <option key={n} value={n}>{n === 'all' ? 'Show all items' : `Top ${n}`}</option>)}
        </select>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search items…" style={{ ...selectSt, minWidth:160 }}/>
        <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, color:'var(--t3)', cursor:'pointer', userSelect:'none' }}
          title="When on, items sold inside a modifier group (e.g. Bueno picked as part of Box of 3) are counted under their own row, with a 'X via Box of 3' breakdown.">
          <input type="checkbox" checked={includeMods} onChange={e => setIncludeMods(e.target.checked)}/>
          Include modifier components
        </label>
        <button onClick={() => setShowDebug(s => !s)} style={{
          padding:'6px 10px', borderRadius:8, background: showDebug ? 'var(--acc-d)' : 'var(--bg3)',
          border:`1px solid ${showDebug ? 'var(--acc-b)' : 'var(--bdr)'}`,
          color: showDebug ? 'var(--acc)' : 'var(--t3)', fontSize:12, cursor:'pointer', fontFamily:'inherit',
        }} title="Diagnostic — shows every mod seen in the period and whether it resolved to a menu item">
          🔍 Debug mods
        </button>
        <div style={{ flex:1 }}/>
        <ExportBtn onClick={exportCsv}/>
      </div>

      {/* Debug: modifier survey */}
      {showDebug && (
        <div style={{ background:'var(--bg2)', border:'1px solid var(--bdr2)', borderRadius:12, padding:'14px 16px', marginBottom:14 }}>
          <div style={{ fontSize:12, fontWeight:800, color:'var(--t1)', marginBottom:6 }}>
            🔍 Modifier diagnostic — what's actually in your closed_checks
          </div>
          <div style={{ fontSize:11, color:'var(--t4)', marginBottom:10, lineHeight:1.5 }}>
            <b>{modSurvey.parentLinesWithMods}</b> parent line item{modSurvey.parentLinesWithMods === 1 ? '' : 's'} have mods,
            <b> {modSurvey.parentLinesWithoutMods}</b> have none.
            Each row below is one unique mod entry. <b>Resolved</b> = matched a menu item by id, name, or label.
            If your Box of 3 sale is missing here, the parent line itself was added without any mods recorded — meaning the cart-add path didn't preserve the donut picks. If it shows as <b>unresolved</b>, the mod is there but the donut name doesn't match any menu_items row (check spelling / casing).
          </div>
          {modSurvey.entries.length === 0 ? (
            <div style={{ fontSize:12, color:'var(--red)', padding:'10px 0' }}>
              ⚠ Zero mod entries in this period. Every closed_check items[] row has empty mods[]. The cart-add path that produced these rows did not store mod selections at all. The Box of 3 component picks were lost at add-time.
            </div>
          ) : (
            <div style={{ maxHeight:280, overflowY:'auto', fontFamily:'var(--font-mono)', fontSize:11 }}>
              <table style={{ width:'100%', borderCollapse:'collapse' }}>
                <thead>
                  <tr style={{ background:'var(--bg3)' }}>
                    <th style={dThSt}>count</th>
                    <th style={dThSt}>id</th>
                    <th style={dThSt}>name</th>
                    <th style={dThSt}>label</th>
                    <th style={dThSt}>parent</th>
                    <th style={dThSt}>matched?</th>
                  </tr>
                </thead>
                <tbody>
                  {modSurvey.entries.slice(0, 50).map((e, idx) => (
                    <tr key={idx} style={{ background: e.resolved ? 'transparent' : 'rgba(239,68,68,0.06)' }}>
                      <td style={dTdSt}>{e.count}</td>
                      <td style={dTdSt}>{e.id || <span style={{ color:'var(--red)' }}>—</span>}</td>
                      <td style={dTdSt}>{e.name || <span style={{ color:'var(--red)' }}>—</span>}</td>
                      <td style={dTdSt}>{e.label || '—'}</td>
                      <td style={dTdSt}>{e.parentName}</td>
                      <td style={{ ...dTdSt, color: e.resolved ? 'var(--grn)' : 'var(--red)', fontWeight:700 }}>
                        {e.resolved ? '✓' : '✗ no menu item'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {modSurvey.entries.length > 50 && (
                <div style={{ marginTop:6, color:'var(--t4)', fontSize:10 }}>… {modSurvey.entries.length - 50} more entries hidden.</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* KPI tiles */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(180px, 1fr))', gap:10, marginBottom:14 }}>
        <StatTile label={metric === 'qty' ? 'Total units' : 'Total revenue'}
          value={metric === 'qty' ? fmtN(periodTotal) : fmt(periodTotal)}
          sub={`across ${dayCount} day${dayCount === 1 ? '' : 's'}`}/>
        <StatTile label="Items sold" value={fmtN(itemCount)} sub={`top ${visibleRows.length} shown`}/>
        <StatTile label={metric === 'qty' ? 'Avg / day' : 'Avg / day'}
          value={metric === 'qty' ? fmtN(avgPerDay) : fmt(avgPerDay)}
          sub="period total ÷ days"/>
        {topItem && (
          <StatTile label="Top seller"
            value={topItem.name.length > 18 ? topItem.name.slice(0,18) + '…' : topItem.name}
            sub={metric === 'qty' ? `${fmtN(topItem.total)} units` : `${fmt(topItem.totalRev)}`}/>
        )}
      </div>

      {/* Matrix */}
      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, overflow:'hidden' }}>
        <div style={{ overflowX:'auto', WebkitOverflowScrolling:'touch' }}>
          <table style={{ borderCollapse:'collapse', width:'max-content', minWidth:'100%', fontSize:12, fontFamily:'inherit' }}>
            <thead>
              <tr>
                <th style={thStickySt}>Item</th>
                <th style={{ ...thSt, textAlign:'left', minWidth:120, position:'sticky', left:200, background:'var(--bg2)', zIndex:2, borderRight:'1px solid var(--bdr2)' }}>Category</th>
                {days.map(d => (
                  <th key={fmtDayKey(d)} title={fmtDayFull(d)} style={thDaySt}>{fmtDayHeader(d)}</th>
                ))}
                <th style={{ ...thSt, textAlign:'right', borderLeft:'2px solid var(--bdr2)', position:'sticky', right:0, background:'var(--bg2)' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r, idx) => (
                <tr key={r.name} style={{ background: idx % 2 ? 'var(--bg)' : 'transparent' }}>
                  <td style={{ ...tdStickySt, background: idx % 2 ? 'var(--bg)' : 'var(--bg1)' }}>
                    <div>{r.name}</div>
                    {(() => {
                      const entries = Object.entries(r.sources || {});
                      const viaParents = entries.filter(([s]) => s !== SRC_STANDALONE);
                      const standalone = r.sources?.[SRC_STANDALONE] || 0;
                      if (!viaParents.length) return null;
                      const parts = [];
                      viaParents
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 3) // cap to avoid runaway widths
                        .forEach(([parent, q]) => parts.push(`${fmtN(q)} in ${parent}`));
                      if (standalone > 0) parts.push(`${fmtN(standalone)} standalone`);
                      return (
                        <div style={{ fontSize:10, color:'var(--t4)', marginTop:2, fontStyle:'italic' }}>
                          {parts.join(' · ')}
                          {viaParents.length > 3 ? ` · +${viaParents.length - 3} more sources` : ''}
                        </div>
                      );
                    })()}
                  </td>
                  <td style={{ ...tdSt, color:'var(--t4)', fontSize:11, position:'sticky', left:200, background: idx % 2 ? 'var(--bg)' : 'var(--bg1)', borderRight:'1px solid var(--bdr2)' }}>
                    {catLabel[r.cat] || '—'}
                  </td>
                  {days.map(d => {
                    const v = cellOf(r, fmtDayKey(d));
                    const intensity = v > 0 ? Math.min(1, v / cellMax) : 0;
                    const bg = v === 0 ? 'transparent' : `rgba(232, 160, 32, ${0.08 + intensity * 0.55})`;
                    return (
                      <td key={fmtDayKey(d)} title={`${r.name} · ${fmtDayFull(d)}: ${metric === 'qty' ? fmtN(v) : fmt(v)}`}
                        style={{ ...tdDaySt, background:bg }}>
                        {v > 0 ? (metric === 'qty' ? fmtN(v) : fmt(v)) : ''}
                      </td>
                    );
                  })}
                  <td style={{ ...tdSt, textAlign:'right', fontWeight:800, color:'var(--acc)', fontFamily:'var(--font-mono)', borderLeft:'2px solid var(--bdr2)', position:'sticky', right:0, background: idx % 2 ? 'var(--bg)' : 'var(--bg1)' }}>
                    {metric === 'qty' ? fmtN(rowTotal(r)) : fmt(rowTotal(r))}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ background:'var(--bg2)', borderTop:'2px solid var(--bdr2)' }}>
                <td style={{ ...tdStickySt, background:'var(--bg2)', fontWeight:800, color:'var(--t1)' }}>TOTAL</td>
                <td style={{ ...tdSt, position:'sticky', left:200, background:'var(--bg2)', borderRight:'1px solid var(--bdr2)' }}/>
                {days.map(d => {
                  const v = totalsByDay[fmtDayKey(d)] || 0;
                  return (
                    <td key={fmtDayKey(d)} style={{ ...tdDaySt, fontWeight:800, color:'var(--t1)' }}>
                      {v > 0 ? (metric === 'qty' ? fmtN(v) : fmt(v)) : ''}
                    </td>
                  );
                })}
                <td style={{ ...tdSt, textAlign:'right', fontWeight:800, color:'var(--acc)', fontFamily:'var(--font-mono)', borderLeft:'2px solid var(--bdr2)', position:'sticky', right:0, background:'var(--bg2)' }}>
                  {metric === 'qty' ? fmtN(periodTotal) : fmt(periodTotal)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {topN !== 'all' && rows.length > visibleRows.length && (
        <div style={{ marginTop:10, fontSize:11, color:'var(--t4)' }}>
          Showing top {visibleRows.length} of {rows.length} items.
          <button onClick={() => setTopN('all')} style={{
            marginLeft:8, background:'transparent', border:'none', color:'var(--acc)',
            fontFamily:'inherit', fontSize:11, cursor:'pointer', textDecoration:'underline',
          }}>Show all</button>
        </div>
      )}
    </div>
  );
}

// ── Cell styles ──────────────────────────────────────────────────────────────
const selectSt  = { padding:'6px 10px', borderRadius:8, background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t2)', fontSize:12, cursor:'pointer', fontFamily:'inherit' };
const thSt      = { padding:'10px 12px', textAlign:'right', fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.05em', borderBottom:'1px solid var(--bdr2)', background:'var(--bg2)', whiteSpace:'nowrap' };
const thStickySt = { ...thSt, textAlign:'left', position:'sticky', left:0, zIndex:3, minWidth:200, borderRight:'1px solid var(--bdr2)' };
const thDaySt   = { ...thSt, minWidth:54, padding:'10px 6px' };
const tdSt      = { padding:'8px 12px', whiteSpace:'nowrap' };
const tdStickySt = { ...tdSt, position:'sticky', left:0, zIndex:1, fontWeight:600, color:'var(--t1)', borderRight:'1px solid var(--bdr2)' };
const tdDaySt   = { ...tdSt, textAlign:'right', fontFamily:'var(--font-mono)', fontSize:11, color:'var(--t2)', padding:'8px 6px', borderRight:'1px solid var(--bdr)' };
const dThSt = { padding:'6px 8px', textAlign:'left', fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.05em', borderBottom:'1px solid var(--bdr2)' };
const dTdSt = { padding:'4px 8px', borderBottom:'1px solid var(--bdr)', whiteSpace:'nowrap', maxWidth:200, overflow:'hidden', textOverflow:'ellipsis' };
