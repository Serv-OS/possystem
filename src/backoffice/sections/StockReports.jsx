/**
 * StockReports — Nory-style stock analytics (Inventory → Reports), built on the
 * shared report-detail standard in reports/reportKit.jsx.
 *   • Valuation   — on-hand × cost by item / supplier / category
 *   • Recipe GP   — plate cost, food-cost %, GP £/% per dish (menu engineering)
 *   • Movements   — the full ledger over a date range (reconciliation)
 *   • The Gap     — theoretical usage vs count adjustments = unexplained £ loss
 *   • By supplier — which suppliers actually generate margin (v5.5.818)
 * All tabs export CSV.
 *
 * Period scope (deliberate deviation from the handoff): the From/To control is
 * shown ONLY on Movements + The Gap, because that is all it filters. Valuation is
 * current on-hand and Recipe GP uses current costs — putting a date range above
 * them would imply a historical snapshot the query does not actually produce.
 * "By supplier" mixes both, so its period applies to the sales half only and says so.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useStore } from '../../store';
import { getActiveLocationSync, getLocationId } from '../../lib/supabase';
import { money, currencySymbol } from '../../lib/currency';
import { toCsv, downloadCsv } from './reports/_csv';
import { fetchInventoryItems, fetchMovementsRange, fetchSuppliers, movementLabel } from '../../lib/stock/data';
import { fetchRecipes, buildCostingCtx, costRecipeWith } from '../../lib/stock/recipes';
import { foodCostPct, gpAmount, gpPct, costBreakdownByPurchasedItem, resolveItemSupplierId } from '../../lib/stock/costing';
import { fetchClosedChecksRange } from '../../lib/db';
import { displayInUnits } from '../../lib/stock/uom';
import { resolveTaxRate, netOf } from '../../lib/tax';
import {
  Money, Signed, Tag, BarCell, RankChip, GradedChip, gradeOf,
  KpiBand, Callout, Chips, SegToggle, SearchField, PeriodControl, Tabs,
  ReportTable, SubToolbar, useSort, sortRows,
} from './reports/reportKit';

const TABS = ['Valuation', 'Recipe GP', 'Movements', 'The Gap', 'By supplier'];
const fmtCost = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : currencySymbol() + Number(v).toFixed(4).replace(/0+$/, '').replace(/\.$/, ''));
const r3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;
const INBOUND = new Set(['PURCHASE_RECEIPT', 'TRANSFER_IN', 'RETURN', 'PRODUCTION_OUTPUT', 'OPENING_BALANCE']);
const OUTBOUND = new Set(['SALE_DEPLETION', 'PRODUCTION_CONSUME', 'TRANSFER_OUT']);
const isoDaysAgo = (days) => { const d = new Date(); d.setDate(d.getDate() - days); d.setHours(0, 0, 0, 0); return d.toISOString().slice(0, 10); };
const todayIso = () => new Date().toISOString().slice(0, 10);
const RANGED = new Set(['Movements', 'The Gap', 'By supplier']);

function ExportBtn({ rows, headers, name }) {
  return (
    <button onClick={() => downloadCsv(`${name}.csv`, toCsv(rows, headers))} disabled={!rows.length}
      style={{ padding:'8px 14px', borderRadius:12, background:'var(--bg1)', border:'1px solid var(--bdr2)', color:'var(--t2)',
        fontSize:12.5, fontWeight:600, fontFamily:'inherit', cursor: rows.length ? 'pointer' : 'default', opacity: rows.length ? 1 : .5,
        display:'inline-flex', alignItems:'center', gap:7, flexShrink:0 }}>
      ⭳ Export CSV
    </button>
  );
}

export default function StockReports() {
  const menuItems = useStore(s => s.menuItems) || [];
  const taxRates = useStore(s => s.taxRates) || [];
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [tab, setTab] = useState('Valuation');
  const [items, setItems] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [recipes, setRecipes] = useState([]);
  const [ctx, setCtx] = useState({ itemsById: {}, recipesByOutputItem: {} });
  const [from, setFrom] = useState(isoDaysAgo(30));
  const [to, setTo] = useState(todayIso());
  const [moves, setMoves] = useState([]);
  const [checks, setChecks] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadBase = useCallback(async () => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    if (loc && loc !== locId) setLocId(loc);
    const [{ data: its }, { data: recs }, c, sup] = await Promise.all([
      fetchInventoryItems(loc), fetchRecipes(loc), buildCostingCtx(loc), fetchSuppliers(loc).catch(() => ({ data: [] })),
    ]);
    setItems(its || []); setRecipes(recs || []); setCtx(c); setSuppliers(sup?.data || []); setLoading(false);
  }, [locId]);
  useEffect(() => { loadBase(); /* eslint-disable-next-line */ }, []);

  const loadMoves = useCallback(async () => {
    const loc = locId || getActiveLocationSync();
    const { data } = await fetchMovementsRange(`${from}T00:00:00`, `${to}T23:59:59`, loc, 5000);
    setMoves(data || []);
  }, [from, to, locId]);
  useEffect(() => { if (tab === 'Movements' || tab === 'The Gap') loadMoves(); }, [tab, loadMoves]);

  // Sales for the supplier tab only — don't pay for this query on other tabs.
  const loadChecks = useCallback(async () => {
    const loc = locId || getActiveLocationSync();
    if (!loc) return;
    const { data } = await fetchClosedChecksRange(loc, new Date(`${from}T00:00:00`), new Date(`${to}T23:59:59`), 5000);
    setChecks(data || []);
  }, [from, to, locId]);
  useEffect(() => { if (tab === 'By supplier') loadChecks(); }, [tab, loadChecks]);

  const itemName = useCallback((id) => items.find(i => i.id === id)?.name || '—', [items]);
  const itemUnit = useCallback((id) => items.find(i => i.id === id)?.baseUnit || '', [items]);
  const supplierName = useCallback((id) => suppliers.find(s => s.id === id)?.name || null, [suppliers]);

  const periodLabel = `${from} → ${to}`;

  return (
    <div style={{ height:'100%', overflowY:'auto', padding:'22px 26px' }}>
      <div style={{ display:'flex', alignItems:'flex-start', gap:16, flexWrap:'wrap', marginBottom:16 }}>
        <div style={{ flex:1, minWidth:240 }}>
          <div style={{ fontSize:11, fontWeight:700, letterSpacing:'1.2px', color:'var(--t4)' }}>INVENTORY</div>
          <h1 style={{ fontSize:28, fontWeight:700, letterSpacing:'-.7px', margin:'5px 0 4px', color:'var(--t1)' }}>Stock reports</h1>
          <p style={{ margin:0, fontSize:13.5, color:'var(--t3)' }}>
            Valuation, recipe margins, movements and variance{RANGED.has(tab) ? ` — ${periodLabel}.` : ' — as of today.'}
          </p>
        </div>
        {/* Period is shown only where it genuinely filters (see file header). */}
        {RANGED.has(tab) && <PeriodControl from={from} to={to} setFrom={setFrom} setTo={setTo}/>}
      </div>

      <Tabs value={tab} onChange={setTab} options={TABS}/>

      {loading && <div style={{ color:'var(--t3)', fontSize:13 }}>Loading…</div>}
      {!loading && tab === 'Valuation'   && <Valuation items={items} supplierName={supplierName}/>}
      {!loading && tab === 'Recipe GP'   && <RecipeGP recipes={recipes} ctx={ctx} menuItems={menuItems} taxRates={taxRates}/>}
      {!loading && tab === 'Movements'   && <Movements moves={moves} itemName={itemName}/>}
      {!loading && tab === 'The Gap'     && <TheGap moves={moves} itemName={itemName} itemUnit={itemUnit}/>}
      {!loading && tab === 'By supplier' && (
        <BySupplier items={items} suppliers={suppliers} recipes={recipes} ctx={ctx}
          menuItems={menuItems} taxRates={taxRates} checks={checks} periodLabel={periodLabel}/>
      )}
    </div>
  );
}

/* ── 1. Valuation ───────────────────────────────────────────────────────────*/
function Valuation({ items, supplierName }) {
  const [search, setSearch] = useState('');
  const [stock, setStock] = useState('all');
  const [view, setView] = useState('flat');
  const [sort, onSort] = useSort('value');

  const base = useMemo(() => items.filter(i => !i.archivedAt).map(i => {
    const oh = displayInUnits(Number(i.onHand) || 0, { baseUnit: i.baseUnit, formats: i.packaging || [] });
    return {
      id: i.id, name: i.name, category: i.category || '',
      supplier: supplierName(resolveItemSupplierId(i)) || null,
      onHandRaw: Number(i.onHand) || 0, onHand: oh.qty, unit: oh.label,
      cost: i.currentCost == null ? null : Number(i.currentCost),
      value: r3((Number(i.onHand) || 0) * (Number(i.currentCost) || 0)),
    };
  }), [items, supplierName]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return base.filter(r => {
      if (stock === 'in' && !(r.onHandRaw > 0)) return false;
      if (stock === 'zero' && r.onHandRaw > 0) return false;
      if (q && !`${r.name} ${r.supplier || ''} ${r.category}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [base, search, stock]);

  const sorted = useMemo(() => sortRows(filtered, sort, {
    name:(r)=>r.name, supplier:(r)=>r.supplier || '', onHand:(r)=>r.onHandRaw, cost:(r)=>r.cost ?? -1, value:(r)=>r.value,
  }), [filtered, sort]);

  const total = filtered.reduce((s, r) => s + r.value, 0);
  const maxVal = Math.max(...filtered.map(r => r.value), 0);
  const supCount = new Set(base.map(r => r.supplier).filter(Boolean)).size;
  const catCount = new Set(base.map(r => r.category).filter(Boolean)).size;
  const zero = base.filter(r => !(r.onHandRaw > 0)).length;
  const top = [...base].sort((a,b)=>b.value-a.value)[0];

  // Grouped view: supplier header rows with subtotals, biggest first.
  const rows = useMemo(() => {
    if (view === 'flat') return sorted;
    const groups = {};
    sorted.forEach(r => { const k = r.supplier || 'No supplier set'; (groups[k] ??= []).push(r); });
    return Object.entries(groups)
      .map(([label, rs]) => ({ label, rs, subtotal: rs.reduce((s,r)=>s+r.value,0) }))
      .sort((a,b) => b.subtotal - a.subtotal)
      .flatMap(g => [
        { _group:true, label:g.label, meta:`${g.rs.length} item${g.rs.length===1?'':'s'}`, value: money(g.subtotal) },
        ...g.rs,
      ]);
  }, [sorted, view]);

  const columns = [
    { key:'name', label:'Item', sortable:true, render:r => <span style={{ color:'var(--t1)', fontWeight:500 }}>{r.name}</span> },
    { key:'supplier', label:'Supplier', sortable:true, render:r => r.supplier
        ? <span style={{ color:'var(--t2)' }}>{r.supplier}</span>
        : <span style={{ color:'var(--t4)' }}>—</span> },
    { key:'category', label:'Category', render:r => r.category ? <Tag label={r.category}/> : <span style={{ color:'var(--t4)' }}>—</span> },
    { key:'onHand', label:'On hand', align:'right', sortable:true, render:r => <span style={{ fontVariantNumeric:'tabular-nums', color: r.onHandRaw>0?'var(--t2)':'var(--t4)' }}>{r.onHand} {r.unit}</span> },
    { key:'cost', label:'Unit cost', align:'right', sortable:true, render:r => <span style={{ fontVariantNumeric:'tabular-nums', color:'var(--t3)' }}>{fmtCost(r.cost)}</span> },
    { key:'value', label:'Value', align:'right', sortable:true, width:150, render:r => r.value > 0
        ? <BarCell v={r.value} max={maxVal} text={money(r.value)}/>
        : <span style={{ color:'var(--t4)' }}>{money(0)}</span> },
  ];

  const csv = filtered.map(r => ({ ...r, cost: r.cost ?? '' }));
  return (
    <div>
      <KpiBand items={[
        { label:'Total stock value', value: money(total) },
        { label:'Suppliers', value: supCount, sub:`across ${catCount} categor${catCount===1?'y':'ies'}` },
        { label:'Top holding', value: top ? money(top.value) : money(0), sub: top?.name },
        { label:'Zero-stock items', value: zero, tone: zero ? 'warn' : undefined, sub:'not counted this period' },
      ]}/>
      <SubToolbar count={`${filtered.length} item${filtered.length===1?'':'s'}`}>
        <Chips value={stock} onChange={setStock} options={[{id:'all',label:'All'},{id:'in',label:'In stock'},{id:'zero',label:'Zero stock'}]}/>
        <span style={{ marginLeft:'auto' }}/>
        <SegToggle value={view} onChange={setView} options={[{id:'flat',label:'Flat'},{id:'group',label:'By supplier'}]}/>
        <SearchField value={search} onChange={setSearch} placeholder="Search items, suppliers…"/>
        <ExportBtn rows={csv} name="stock-valuation" headers={[
          {label:'Item',key:'name'},{label:'Supplier',key:'supplier'},{label:'Category',key:'category'},
          {label:'On hand',key:'onHand'},{label:'Unit',key:'unit'},{label:'Unit cost',key:'cost'},{label:'Value',key:'value'}]}/>
      </SubToolbar>
      <ReportTable columns={columns} rows={rows} sort={view==='flat'?sort:null} onSort={onSort}
        totals={{ name:'Total stock value', value: money(total) }} empty="No stock items match."/>
    </div>
  );
}
/* ── 2. Recipe GP ───────────────────────────────────────────────────────────*/
function RecipeGP({ recipes, ctx, menuItems, taxRates = [] }) {
  const [filter, setFilter] = useState('all');
  const [sort, onSort] = useSort('gpPct');
  const byId = useMemo(() => { const m = {}; menuItems.forEach(mi => { m[String(mi.id)] = mi; }); return m; }, [menuItems]);

  const netSell = useCallback((mi) => {
    if (!mi) return null;
    const gross = mi?.pricing?.base ?? mi?.price ?? null;
    if (gross == null) return null;
    let taxRateId = mi.taxRateId ?? mi.tax_rate_id ?? null;
    let taxOverrides = mi.taxOverrides ?? mi.tax_overrides ?? {};
    if (!taxRateId && mi.parentId) {
      const p = byId[String(mi.parentId)];
      if (p) { taxRateId = p.taxRateId ?? p.tax_rate_id ?? null; if (!Object.keys(taxOverrides).length) taxOverrides = p.taxOverrides ?? p.tax_overrides ?? {}; }
    }
    return netOf(gross, resolveTaxRate({ taxRateId, taxOverrides }, taxRates, 'dine-in'));
  }, [byId, taxRates]);

  // Menu items that are a parent of live variants (Heineken → Half / Pint).
  const variantParentIds = useMemo(
    () => new Set(menuItems.filter(i => i.parentId && !i.archived).map(i => String(i.parentId))),
    [menuItems]);

  // v5.5.821: this tab lists RECIPES, so a recipe can outlive what made it useful
  // and leave a £0.00 "Unpriced" ghost. Two ways that happens:
  //   • the dish it points at was archived — not sellable any more;
  //   • the dish it points at is a VARIANTS PARENT. A parent carries no price of
  //     its own (its variants do), so its "GP" is meaningless by construction. The
  //     sellable units are the variants, which have their own recipes and appear
  //     correctly. Seen live: a stale "Heineken - Half" recipe hanging off the
  //     "Heineken" parent while "Heineken Half" / "Heineken Pint" cost properly.
  // A recipe not linked to any dish still shows — that's an unfinished setup.
  const base = useMemo(() => recipes.filter(r => {
    if (r.recipeType !== 'MENU') return false;
    if (!r.menuItemId) return true;
    const mi = byId[String(r.menuItemId)];
    if (!mi || mi.archived) return false;
    if (mi.type === 'variants' || variantParentIds.has(String(mi.id))) return false;
    return true;
  }).map(r => {
    const c = costRecipeWith(r, ctx);
    const plate = c?.error ? null : c.totalCost;
    const price = netSell(byId[String(r.menuItemId)]);
    const ok = price != null && plate != null && price > 0;
    return {
      id: r.id, dish: r.name, price, cost: plate,
      foodPct: ok ? Math.round(foodCostPct(plate, price) * 10) / 10 : null,
      gp: ok ? r3(gpAmount(price, plate)) : null,
      gpPct: ok ? Math.round(gpPct(price, plate) * 10) / 10 : null,
      target: r.gpTargetPct ?? null,
      unpriced: plate != null && !(price > 0),
    };
  }), [recipes, ctx, byId, netSell, variantParentIds]);

  const filtered = useMemo(() => filter === 'below'
    ? base.filter(r => r.gpPct != null && r.gpPct < (r.target ?? 60))
    : base, [base, filter]);
  const sorted = useMemo(() => sortRows(filtered, sort, {
    dish:(r)=>r.dish, price:(r)=>r.price, cost:(r)=>r.cost, foodPct:(r)=>r.foodPct, gp:(r)=>r.gp, gpPct:(r)=>r.gpPct,
  }), [filtered, sort]);

  const priced = base.filter(r => r.gpPct != null);
  const avg = priced.length ? priced.reduce((s,r)=>s+r.gpPct,0)/priced.length : null;
  const best = [...priced].sort((a,b)=>b.gpPct-a.gpPct)[0];
  const below = priced.filter(r => r.gpPct < (r.target ?? 60)).length;

  const columns = [
    { key:'dish', label:'Dish', sortable:true, render:r => (
      <span style={{ display:'inline-flex', alignItems:'center', gap:8 }}>
        <span style={{ color:'var(--t1)', fontWeight:500 }}>{r.dish}</span>
        {r.unpriced && <Tag label="Unpriced" tone="warn"/>}
      </span>) },
    { key:'price', label:'Price (ex VAT)', align:'right', sortable:true, render:r => <Money v={r.price}/> },
    { key:'cost',  label:'Plate cost', align:'right', sortable:true, render:r => <Money v={r.cost}/> },
    { key:'foodPct', label:'Food %', align:'right', sortable:true, render:r => <span style={{ fontVariantNumeric:'tabular-nums', color:'var(--t3)' }}>{r.foodPct == null ? '—' : `${r.foodPct}%`}</span> },
    { key:'gp', label:'GP £', align:'right', sortable:true, render:r => <Money v={r.gp}/> },
    { key:'gpPct', label:'GP %', align:'right', sortable:true, width:140, render:r => r.gpPct == null
        ? <span style={{ color:'var(--t4)' }}>—</span>
        : <BarCell v={r.gpPct} max={100} text={`${r.gpPct}%`} grade={gradeOf(r.gpPct)}/> },
  ];

  const csv = base.map(r => ({ dish:r.dish, price:r.price ?? '', cost:r.cost ?? '', foodPct:r.foodPct ?? '', gp:r.gp ?? '', gpPct:r.gpPct ?? '', target:r.target ?? '' }));
  return (
    <div>
      <KpiBand items={[
        { label:'Average GP %', value: avg == null ? '—' : `${avg.toFixed(1)}%`, sub:`across ${priced.length} priced dish${priced.length===1?'':'es'}` },
        { label:'Best margin', value: best ? `${best.gpPct}%` : '—', sub: best?.dish, tone: best ? 'good' : undefined },
        { label:'Below target', value: below, tone: below ? 'warn' : 'good', sub:`of ${priced.length} priced` },
      ]}/>
      <SubToolbar count={`${filtered.length} dish${filtered.length===1?'':'es'}`}>
        <Chips value={filter} onChange={setFilter} options={[{id:'all',label:'All'},{id:'below',label:'Below target'}]}/>
        <span style={{ marginLeft:'auto' }}/>
        <ExportBtn rows={csv} name="recipe-gp" headers={[
          {label:'Dish',key:'dish'},{label:'Price (ex VAT)',key:'price'},{label:'Plate cost',key:'cost'},
          {label:'Food %',key:'foodPct'},{label:'GP £',key:'gp'},{label:'GP %',key:'gpPct'},{label:'GP target %',key:'target'}]}/>
      </SubToolbar>
      <ReportTable columns={columns} rows={sorted} sort={sort} onSort={onSort} empty="No dish recipes yet."/>
    </div>
  );
}

/* ── 3. Movements ───────────────────────────────────────────────────────────*/
const TYPE_TONE = (label) => /waste/i.test(label) ? 'warn' : /count/i.test(label) ? 'good' : 'neutral';

function Movements({ moves, itemName }) {
  const [search, setSearch] = useState('');
  const [type, setType] = useState('all');
  const [sort, onSort] = useSort('date');

  const base = useMemo(() => moves.map((m, i) => ({
    id: m.id ?? i, ts: m.occurredAt ? new Date(m.occurredAt).getTime() : 0,
    date: m.occurredAt ? new Date(m.occurredAt).toLocaleString() : '—',
    item: itemName(m.inventoryItemId), type: movementLabel(m.movementType),
    qty: r3(m.qtyBase), value: m.valueDelta == null ? null : r3(m.valueDelta),
  })), [moves, itemName]);

  const types = useMemo(() => ['all', ...Array.from(new Set(base.map(r => r.type)))], [base]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return base.filter(r => (type === 'all' || r.type === type) && (!q || `${r.item} ${r.type}`.toLowerCase().includes(q)));
  }, [base, type, search]);
  const sorted = useMemo(() => sortRows(filtered, sort, {
    date:(r)=>r.ts, item:(r)=>r.item, type:(r)=>r.type, qty:(r)=>r.qty, value:(r)=>r.value,
  }), [filtered, sort]);

  const waste = base.filter(r => /waste/i.test(r.type));
  const wasteVal = waste.reduce((s,r)=>s+(r.value||0),0);
  const net = filtered.reduce((s,r)=>s+(r.value||0),0);

  const columns = [
    { key:'date', label:'Date', sortable:true, render:r => <span style={{ color:'var(--t3)' }}>{r.date}</span> },
    { key:'item', label:'Item', sortable:true, render:r => <span style={{ color:'var(--t1)', fontWeight:500 }}>{r.item}</span> },
    { key:'type', label:'Type', sortable:true, render:r => <Tag label={r.type} tone={TYPE_TONE(r.type)}/> },
    { key:'qty',  label:'Qty', align:'right', sortable:true, render:r => <Signed v={r.qty}/> },
    { key:'value',label:'Value', align:'right', sortable:true, render:r => r.value == null ? <span style={{ color:'var(--t4)' }}>—</span> : <Money v={r.value}/> },
  ];

  return (
    <div>
      <KpiBand items={[
        { label:'Movements', value: base.length },
        { label:'Sales', value: base.filter(r => /sale/i.test(r.type)).length },
        { label:'Waste value', value: money(wasteVal), tone: wasteVal < 0 ? 'warn' : undefined, sub:`${waste.length} waste event${waste.length===1?'':'s'}` },
        { label:'Net value', value: money(base.reduce((s,r)=>s+(r.value||0),0)) },
      ]}/>
      <SubToolbar count={`${filtered.length} movement${filtered.length===1?'':'s'}`}>
        <Chips value={type} onChange={setType} options={types.map(t => ({ id:t, label: t === 'all' ? 'All' : t }))}/>
        <span style={{ marginLeft:'auto' }}/>
        <SearchField value={search} onChange={setSearch} placeholder="Search item or type…"/>
        <ExportBtn rows={filtered.map(r => ({ ...r, value: r.value ?? '' }))} name="stock-movements" headers={[
          {label:'Date',key:'date'},{label:'Item',key:'item'},{label:'Type',key:'type'},{label:'Qty',key:'qty'},{label:'Value',key:'value'}]}/>
      </SubToolbar>
      <ReportTable columns={columns} rows={sorted} sort={sort} onSort={onSort}
        totals={{ date:'Net value', value: money(net) }} empty="No movements in this period."/>
    </div>
  );
}

/* ── 4. The Gap ─────────────────────────────────────────────────────────────*/
function TheGap({ moves, itemName, itemUnit }) {
  const [sort, onSort] = useSort('varValue', 'asc');
  const base = useMemo(() => {
    const by = {};
    for (const m of moves) {
      const k = m.inventoryItemId;
      if (!k) continue;
      const a = by[k] || (by[k] = { used: 0, received: 0, waste: 0, countQty: 0, varValue: 0 });
      if (OUTBOUND.has(m.movementType)) a.used += -m.qtyBase;
      else if (INBOUND.has(m.movementType)) a.received += m.qtyBase;
      if (m.movementType === 'WASTE') a.waste += -m.qtyBase;
      if (m.movementType === 'STOCK_COUNT_ADJ') { a.countQty += m.qtyBase; a.varValue += (m.valueDelta || 0); }
    }
    return Object.entries(by).map(([id, a]) => ({
      id, item: itemName(id), unit: itemUnit(id), used: r3(a.used), received: r3(a.received),
      waste: r3(a.waste), countQty: r3(a.countQty), varValue: r3(a.varValue),
    })).filter(r => r.countQty !== 0 || r.varValue !== 0);
  }, [moves, itemName, itemUnit]);

  const sorted = useMemo(() => sortRows(base, sort, {
    item:(r)=>r.item, used:(r)=>r.used, received:(r)=>r.received, waste:(r)=>r.waste, countQty:(r)=>r.countQty, varValue:(r)=>r.varValue,
  }), [base, sort]);

  const loss = base.reduce((s, r) => s + Math.min(0, r.varValue), 0);
  const totalVar = base.reduce((s, r) => s + r.varValue, 0);
  const muted = (v, u) => <span style={{ fontVariantNumeric:'tabular-nums', color:'var(--t3)' }}>{v} {u}</span>;

  const columns = [
    { key:'item', label:'Item', sortable:true, render:r => <span style={{ color:'var(--t1)', fontWeight:500 }}>{r.item}</span> },
    { key:'used', label:'Sold/used', align:'right', sortable:true, render:r => muted(r.used, r.unit) },
    { key:'received', label:'Received', align:'right', sortable:true, render:r => muted(r.received, r.unit) },
    { key:'waste', label:'Waste', align:'right', sortable:true, render:r => muted(r.waste, r.unit) },
    { key:'countQty', label:'Count adj', align:'right', sortable:true, render:r => <span style={{ fontVariantNumeric:'tabular-nums', color:'var(--t2)' }}>{r.countQty} {r.unit}</span> },
    { key:'varValue', label:'Variance £', align:'right', sortable:true, render:r => <Money v={r.varValue} bold/> },
  ];

  return (
    <div>
      <Callout>
        <b>“The gap”</b> is the difference between what your recipes and deliveries say you should have and what you actually
        counted. A negative variance is unexplained loss — over-pour, spillage, theft or mis-ringing. Only items you have
        <b> counted</b> in this period appear.
      </Callout>
      <KpiBand items={[
        { label:'Unexplained loss', value: money(loss), tone: loss < 0 ? 'bad' : 'good' },
        { label:'Lines counted', value: base.length },
        { label:'Total variance', value: money(totalVar), tone: totalVar < 0 ? 'warn' : undefined },
      ]}/>
      <SubToolbar count={`${base.length} counted item${base.length===1?'':'s'}`}>
        <span style={{ marginLeft:'auto' }}/>
        <ExportBtn rows={base} name="the-gap" headers={[
          {label:'Item',key:'item'},{label:'Sold/used',key:'used'},{label:'Received',key:'received'},
          {label:'Waste',key:'waste'},{label:'Count adj qty',key:'countQty'},{label:'Variance £',key:'varValue'}]}/>
      </SubToolbar>
      <ReportTable columns={columns} rows={sorted} sort={sort} onSort={onSort}
        empty="No counted items in this period yet. Run a stock count (Stock items → Stock tab) to start measuring the gap."/>
    </div>
  );
}

/* ── 5. By supplier ─────────────────────────────────────────────────────────
   Which suppliers actually generate margin. A dish usually contains ingredients
   from several suppliers, so a dish's GP is SPLIT between them in proportion to
   how much of its plate cost each supplier contributed (owner decision, v5.5.818).
   That keeps the column honest: attributed GP sums back to the real GP, with
   nothing double-counted. Suppliers whose goods aren't sold directly (dairy into
   a prep, packaging) still surface via the dishes their inputs end up in.        */
function BySupplier({ items, suppliers, recipes, ctx, menuItems, taxRates, checks, periodLabel }) {
  const [sort, onSort] = useSort('gp');
  const byMenuId = useMemo(() => { const m = {}; menuItems.forEach(mi => { m[String(mi.id)] = mi; }); return m; }, [menuItems]);
  const supOfItem = useMemo(() => { const m = {}; items.forEach(i => { m[i.id] = resolveItemSupplierId(i); }); return m; }, [items]);
  const supName = useMemo(() => { const m = {}; suppliers.forEach(s => { m[s.id] = s.name; }); return m; }, [suppliers]);

  const netSell = useCallback((mi) => {
    if (!mi) return null;
    const gross = mi?.pricing?.base ?? mi?.price ?? null;
    if (gross == null) return null;
    let taxRateId = mi.taxRateId ?? null, taxOverrides = mi.taxOverrides ?? {};
    if (!taxRateId && mi.parentId) {
      const p = byMenuId[String(mi.parentId)];
      if (p) { taxRateId = p.taxRateId ?? null; if (!Object.keys(taxOverrides).length) taxOverrides = p.taxOverrides ?? {}; }
    }
    return netOf(gross, resolveTaxRate({ taxRateId, taxOverrides }, taxRates || [], 'dine-in'));
  }, [byMenuId, taxRates]);

  // units sold per menu item id in the period
  const soldByMenuId = useMemo(() => {
    const m = {};
    (checks || []).forEach(c => (c.items || []).forEach(li => {
      if (li.voided) return;
      const id = li.itemId != null ? String(li.itemId) : null;
      if (!id) return;
      m[id] = (m[id] || 0) + (li.qty || 1);
    }));
    return m;
  }, [checks]);

  const rows = useMemo(() => {
    const acc = {};   // supplierId → { stockValue, units, revenue, gp }
    const bump = (sid, patch) => {
      const k = sid || '_none';
      const a = acc[k] || (acc[k] = { id:k, name: sid ? (supName[sid] || 'Unknown supplier') : 'No supplier set', stockValue:0, units:0, revenue:0, gp:0, sells:false });
      Object.entries(patch).forEach(([f, v]) => { a[f] += v; });
    };

    // stock held
    items.filter(i => !i.archivedAt).forEach(i => {
      bump(resolveItemSupplierId(i), { stockValue: (Number(i.onHand)||0) * (Number(i.currentCost)||0) });
    });

    // sales → split each dish's GP across the suppliers behind its plate cost
    recipes.filter(r => r.recipeType === 'MENU' && r.menuItemId).forEach(r => {
      const units = soldByMenuId[String(r.menuItemId)] || 0;
      if (!units) return;
      const price = netSell(byMenuId[String(r.menuItemId)]);
      if (price == null || !(price > 0)) return;
      let bd;
      try { bd = costBreakdownByPurchasedItem(r, ctx); } catch { return; }
      if (!bd || !(bd.total > 0)) return;
      const revenue = price * units;
      const dishGp = (price - bd.total) * units;
      Object.entries(bd.byItem).forEach(([itemId, cost]) => {
        const share = cost / bd.total;
        const sid = supOfItem[itemId] || null;
        bump(sid, { revenue: revenue * share, gp: dishGp * share, units: units * share });
        (acc[sid || '_none']).sells = true;
      });
    });

    return Object.values(acc).map(a => ({
      ...a,
      gpPct: a.revenue > 0 ? (a.gp / a.revenue) * 100 : null,
    }));
  }, [items, recipes, ctx, soldByMenuId, netSell, byMenuId, supOfItem, supName]);

  const sorted = useMemo(() => {
    const s = sortRows(rows, sort, {
      name:(r)=>r.name, stockValue:(r)=>r.stockValue, units:(r)=>r.units, revenue:(r)=>r.revenue, gp:(r)=>r.gp, gpPct:(r)=>r.gpPct,
    });
    // rank only the suppliers that actually generated margin
    let n = 0;
    return s.map(r => ({ ...r, rank: r.sells && r.gp !== 0 ? ++n : null }));
  }, [rows, sort]);

  const totalStock = rows.reduce((s,r)=>s+r.stockValue,0);
  const totalRev   = rows.reduce((s,r)=>s+r.revenue,0);
  const totalGp    = rows.reduce((s,r)=>s+r.gp,0);
  const blended    = totalRev > 0 ? (totalGp/totalRev)*100 : null;
  const selling    = rows.filter(r => r.sells).length;
  const best       = [...rows].filter(r=>r.sells).sort((a,b)=>b.gp-a.gp)[0];
  const maxGp      = Math.max(...rows.map(r => r.gp), 0);

  const columns = [
    { key:'rank', label:'#', width:52, render:r => <RankChip n={r.rank}/> },
    { key:'name', label:'Supplier', sortable:true, render:r => (
      <div>
        <div style={{ color:'var(--t1)', fontWeight:500 }}>{r.name}</div>
        <div style={{ fontSize:11.5, color:'var(--t4)', marginTop:2 }}>
          {r.sells ? 'Sold through dishes' : 'Input · not sold directly'}
        </div>
      </div>) },
    { key:'stockValue', label:'Stock value', align:'right', sortable:true, render:r => <Money v={r.stockValue} muted/> },
    { key:'units', label:'Units', align:'right', sortable:true, render:r => r.sells
        ? <span style={{ fontVariantNumeric:'tabular-nums', color:'var(--t3)' }} title="Dish units weighted by this supplier's share of the plate cost">{r.units.toFixed(1)}</span>
        : <span style={{ color:'var(--t4)' }}>—</span> },
    { key:'revenue', label:'Revenue', align:'right', sortable:true, render:r => r.sells ? <Money v={r.revenue}/> : <span style={{ color:'var(--t4)' }}>—</span> },
    { key:'gp', label:'GP (period)', align:'right', sortable:true, width:150, render:r => r.sells
        ? <BarCell v={r.gp} max={maxGp} text={money(r.gp)}/>
        : <span style={{ color:'var(--t4)' }}>—</span> },
    { key:'gpPct', label:'GP %', align:'right', sortable:true, render:r => <GradedChip pct={r.gpPct}/> },
  ];

  const csv = sorted.map(r => ({ rank:r.rank ?? '', name:r.name, stockValue:r3(r.stockValue), units:r3(r.units), revenue:r3(r.revenue), gp:r3(r.gp), gpPct: r.gpPct == null ? '' : Math.round(r.gpPct*10)/10 }));
  return (
    <div>
      <Callout>
        Ranks suppliers by the <b>gross profit</b> their goods generated in {periodLabel}. Most dishes use several suppliers, so
        each dish's GP is <b>split between them in proportion to how much of the plate cost each one contributed</b> — nothing is
        counted twice, and the column totals back to your real GP. Stock value is current on-hand; revenue and GP are for the period.
      </Callout>
      <KpiBand items={[
        { label:'Suppliers', value: rows.length, sub:`${selling} revenue-generating` },
        { label:'Stock value held', value: money(totalStock) },
        { label:'GP (period)', value: money(totalGp), tone:'good', sub: blended == null ? undefined : `${blended.toFixed(1)}% blended` },
        { label:'Most profitable', value: best ? money(best.gp) : '—', sub: best ? `${best.name}${best.gpPct!=null?` · ${best.gpPct.toFixed(1)}% GP`:''}` : 'no sales in period' },
      ]}/>
      <SubToolbar count={`${rows.length} supplier${rows.length===1?'':'s'}`}>
        <span style={{ marginLeft:'auto' }}/>
        <ExportBtn rows={csv} name="by-supplier" headers={[
          {label:'Rank',key:'rank'},{label:'Supplier',key:'name'},{label:'Stock value',key:'stockValue'},
          {label:'Units',key:'units'},{label:'Revenue',key:'revenue'},{label:'GP',key:'gp'},{label:'GP %',key:'gpPct'}]}/>
      </SubToolbar>
      <ReportTable columns={columns} rows={sorted} sort={sort} onSort={onSort}
        totals={{ rank:'', name:'Total', stockValue: money(totalStock), revenue: money(totalRev), gp: money(totalGp), gpPct: blended == null ? '—' : `${blended.toFixed(1)}%` }}
        empty="No suppliers set up yet. Add them in Purchasing → Suppliers, then set each stock item's default supplier."/>
    </div>
  );
}
