/**
 * StockReports — Nory-style stock analytics (Inventory → Reports). Reads existing
 * tables only (no migration):
 *   • Valuation   — on-hand × cost by item/category
 *   • Recipe GP   — plate cost, food-cost %, GP £/% per dish (menu engineering)
 *   • Movements   — the full ledger over a date range (reconciliation)
 *   • The Gap     — theoretical usage vs count adjustments = unexplained £ loss,
 *                   ranked by biggest loser (the Nory "gap").
 * All tabs export CSV.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useStore } from '../../store';
import { getActiveLocationSync, getLocationId } from '../../lib/supabase';
import { money, currencySymbol } from '../../lib/currency';
import { toCsv, downloadCsv } from './reports/_csv';
import { fetchInventoryItems, fetchMovementsRange, movementLabel } from '../../lib/stock/data';
import { fetchRecipes, buildCostingCtx, costRecipeWith } from '../../lib/stock/recipes';
import { foodCostPct, gpAmount, gpPct } from '../../lib/stock/costing';
import { displayInUnits } from '../../lib/stock/uom';
import { resolveTaxRate, netOf } from '../../lib/tax';

const TABS = ['Valuation', 'Recipe GP', 'Movements', 'The Gap'];
const fmtCost = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : currencySymbol() + Number(v).toFixed(4).replace(/0+$/, '').replace(/\.$/, ''));
const r3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;
const INBOUND = new Set(['PURCHASE_RECEIPT', 'TRANSFER_IN', 'RETURN', 'PRODUCTION_OUTPUT', 'OPENING_BALANCE']);
const OUTBOUND = new Set(['SALE_DEPLETION', 'PRODUCTION_CONSUME', 'TRANSFER_OUT']);
const th = { padding: '7px 8px', borderBottom: '1px solid var(--bdr)', fontWeight: 600, color: 'var(--t3)', textAlign: 'left', position: 'sticky', top: 0, background: 'var(--bg0)' };
const td = { padding: '6px 8px', borderBottom: '1px solid var(--bg2)' };

const isoDaysAgo = (days) => { const d = new Date(); d.setDate(d.getDate() - days); d.setHours(0, 0, 0, 0); return d.toISOString().slice(0, 10); };
const todayIso = () => new Date().toISOString().slice(0, 10);

export default function StockReports() {
  const menuItems = useStore(s => s.menuItems) || [];
  const taxRates = useStore(s => s.taxRates) || [];
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [tab, setTab] = useState('Valuation');
  const [items, setItems] = useState([]);
  const [recipes, setRecipes] = useState([]);
  const [ctx, setCtx] = useState({ itemsById: {}, recipesByOutputItem: {} });
  const [from, setFrom] = useState(isoDaysAgo(30));
  const [to, setTo] = useState(todayIso());
  const [moves, setMoves] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadBase = useCallback(async () => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    if (loc && loc !== locId) setLocId(loc);
    const [{ data: its }, { data: recs }, c] = await Promise.all([fetchInventoryItems(loc), fetchRecipes(loc), buildCostingCtx(loc)]);
    setItems(its || []); setRecipes(recs || []); setCtx(c); setLoading(false);
  }, [locId]);
  useEffect(() => { loadBase(); /* eslint-disable-next-line */ }, []);

  const loadMoves = useCallback(async () => {
    const loc = locId || getActiveLocationSync();
    const { data } = await fetchMovementsRange(`${from}T00:00:00`, `${to}T23:59:59`, loc, 5000);
    setMoves(data || []);
  }, [from, to, locId]);
  useEffect(() => { if (tab === 'Movements' || tab === 'The Gap') loadMoves(); }, [tab, loadMoves]);

  const itemName = useCallback((id) => items.find(i => i.id === id)?.name || '—', [items]);
  const itemUnit = useCallback((id) => items.find(i => i.id === id)?.baseUnit || '', [items]);

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg0)', padding: '22px 26px' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 14px', color: 'var(--t1)' }}>Stock reports</h1>
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--bdr)', marginBottom: 16 }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ padding: '8px 16px', fontSize: 13, cursor: 'pointer', background: 'transparent', border: 0, color: tab === t ? 'var(--t1)' : 'var(--t3)', fontWeight: tab === t ? 700 : 400, borderBottom: '2px solid ' + (tab === t ? 'var(--acc)' : 'transparent'), marginBottom: -1 }}>{t}</button>
        ))}
      </div>

      {loading && <div style={{ color: 'var(--t3)', fontSize: 13 }}>Loading…</div>}
      {!loading && tab === 'Valuation' && <Valuation items={items} />}
      {!loading && tab === 'Recipe GP' && <RecipeGP recipes={recipes} ctx={ctx} menuItems={menuItems} taxRates={taxRates} />}
      {!loading && (tab === 'Movements' || tab === 'The Gap') && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14 }}>
          <span style={{ fontSize: 12, color: 'var(--t3)' }}>From</span>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={dateStyle} />
          <span style={{ fontSize: 12, color: 'var(--t3)' }}>to</span>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} style={dateStyle} />
        </div>
      )}
      {!loading && tab === 'Movements' && <Movements moves={moves} itemName={itemName} />}
      {!loading && tab === 'The Gap' && <TheGap moves={moves} itemName={itemName} itemUnit={itemUnit} />}
    </div>
  );
}

const dateStyle = { background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 6, padding: '6px 8px', fontSize: 13 };

function ExportBtn({ rows, headers, name }) {
  return <button onClick={() => downloadCsv(`${name}.csv`, toCsv(rows, headers))} disabled={!rows.length} style={{ padding: '7px 14px', borderRadius: 7, background: 'var(--bg2)', border: '1px solid var(--bdr)', color: 'var(--t1)', fontSize: 12, fontWeight: 600, cursor: rows.length ? 'pointer' : 'default', opacity: rows.length ? 1 : 0.5 }}>Export CSV</button>;
}

function Valuation({ items }) {
  const rows = useMemo(() => items.filter(i => !i.archivedAt).map(i => {
    const oh = displayInUnits(Number(i.onHand) || 0, { baseUnit: i.baseUnit, formats: i.packaging || [] });
    return {
      name: i.name, category: i.category || '', onHand: oh.qty, unit: oh.label,
      cost: i.currentCost == null ? '' : i.currentCost, value: r3((Number(i.onHand) || 0) * (Number(i.currentCost) || 0)),
    };
  }).sort((a, b) => b.value - a.value), [items]);
  const total = rows.reduce((s, r) => s + r.value, 0);
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontSize: 14, color: 'var(--t1)' }}>Total stock value: <b>{money(total)}</b> · {rows.length} items</div>
        <ExportBtn rows={rows} headers={[{ label: 'Item', key: 'name' }, { label: 'Category', key: 'category' }, { label: 'On hand', key: 'onHand' }, { label: 'Unit', key: 'unit' }, { label: 'Unit cost', key: 'cost' }, { label: 'Value', key: 'value' }]} name="stock-valuation" />
      </div>
      <table style={tableStyle}><thead><tr>{['Item', 'Category', 'On hand', 'Unit cost', 'Value'].map((h, i) => <th key={h} style={{ ...th, textAlign: i >= 2 ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={i}><td style={td}>{r.name}</td><td style={{ ...td, color: 'var(--t3)' }}>{r.category}</td><td style={{ ...td, textAlign: 'right' }}>{r.onHand} {r.unit}</td><td style={{ ...td, textAlign: 'right', color: 'var(--t3)' }}>{fmtCost(r.cost)}</td><td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{money(r.value)}</td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function RecipeGP({ recipes, ctx, menuItems, taxRates = [] }) {
  const byId = useMemo(() => { const m = {}; menuItems.forEach(mi => { m[String(mi.id)] = mi; }); return m; }, [menuItems]);
  // ex-VAT net of the shelf price — GP must be on the net. Variants inherit the parent's rate.
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
  const rows = useMemo(() => recipes.filter(r => r.recipeType === 'MENU').map(r => {
    const c = costRecipeWith(r, ctx);
    const plate = c?.error ? null : c.totalCost;
    const mi = byId[String(r.menuItemId)];
    const price = netSell(mi);   // ex-VAT net selling price
    return {
      dish: r.name, price: price == null ? '' : r3(price), cost: plate == null ? '' : r3(plate),
      foodPct: (price != null && plate != null) ? Math.round(foodCostPct(plate, price) * 10) / 10 : '',
      gp: (price != null && plate != null) ? r3(gpAmount(price, plate)) : '',
      gpPct: (price != null && plate != null) ? Math.round(gpPct(price, plate) * 10) / 10 : '',
      target: r.gpTargetPct ?? '',
    };
  }), [recipes, ctx, byId, netSell]);
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
        <ExportBtn rows={rows} headers={[{ label: 'Dish', key: 'dish' }, { label: 'Price (ex VAT)', key: 'price' }, { label: 'Plate cost', key: 'cost' }, { label: 'Food %', key: 'foodPct' }, { label: 'GP £', key: 'gp' }, { label: 'GP %', key: 'gpPct' }, { label: 'GP target %', key: 'target' }]} name="recipe-gp" />
      </div>
      {rows.length === 0 && <div style={{ fontSize: 13, color: 'var(--t3)' }}>No dish recipes yet.</div>}
      {rows.length > 0 && (
        <table style={tableStyle}><thead><tr>{['Dish', 'Price (ex VAT)', 'Plate cost', 'Food %', 'GP £', 'GP %'].map((h, i) => <th key={h} style={{ ...th, textAlign: i >= 1 ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => {
            const below = r.target !== '' && r.gpPct !== '' && Number(r.gpPct) < Number(r.target);
            return <tr key={i}><td style={td}>{r.dish}</td><td style={{ ...td, textAlign: 'right' }}>{r.price === '' ? '—' : money(r.price)}</td><td style={{ ...td, textAlign: 'right' }}>{r.cost === '' ? '—' : money(r.cost)}</td><td style={{ ...td, textAlign: 'right', color: 'var(--t3)' }}>{r.foodPct === '' ? '—' : r.foodPct + '%'}</td><td style={{ ...td, textAlign: 'right' }}>{r.gp === '' ? '—' : money(r.gp)}</td><td style={{ ...td, textAlign: 'right', fontWeight: 600, color: below ? 'var(--red, #ef4444)' : 'var(--grn, #16a34a)' }}>{r.gpPct === '' ? '—' : r.gpPct + '%'}</td></tr>;
          })}</tbody>
        </table>
      )}
    </div>
  );
}

function Movements({ moves, itemName }) {
  const rows = useMemo(() => moves.map(m => ({
    date: new Date(m.occurredAt).toLocaleString(), item: itemName(m.inventoryItemId), type: movementLabel(m.movementType),
    qty: r3(m.qtyBase), value: m.valueDelta == null ? '' : r3(m.valueDelta),
  })), [moves, itemName]);
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontSize: 13, color: 'var(--t3)' }}>{rows.length} movements</div>
        <ExportBtn rows={rows} headers={[{ label: 'Date', key: 'date' }, { label: 'Item', key: 'item' }, { label: 'Type', key: 'type' }, { label: 'Qty', key: 'qty' }, { label: 'Value', key: 'value' }]} name="stock-movements" />
      </div>
      <table style={tableStyle}><thead><tr>{['Date', 'Item', 'Type', 'Qty', 'Value'].map((h, i) => <th key={h} style={{ ...th, textAlign: i >= 3 ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => (<tr key={i}><td style={{ ...td, color: 'var(--t3)' }}>{r.date}</td><td style={td}>{r.item}</td><td style={td}>{r.type}</td><td style={{ ...td, textAlign: 'right', color: r.qty >= 0 ? 'var(--grn, #16a34a)' : 'var(--red, #ef4444)' }}>{r.qty >= 0 ? '+' : ''}{r.qty}</td><td style={{ ...td, textAlign: 'right' }}>{r.value === '' ? '' : money(r.value)}</td></tr>))}</tbody>
      </table>
    </div>
  );
}

function TheGap({ moves, itemName, itemUnit }) {
  const rows = useMemo(() => {
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
      item: itemName(id), unit: itemUnit(id), used: r3(a.used), received: r3(a.received), waste: r3(a.waste),
      countQty: r3(a.countQty), varValue: r3(a.varValue),
    })).filter(r => r.countQty !== 0 || r.varValue !== 0).sort((x, y) => x.varValue - y.varValue);
  }, [moves, itemName, itemUnit]);
  const totalLoss = rows.reduce((s, r) => s + Math.min(0, r.varValue), 0);
  return (
    <div>
      <p style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 0 }}>
        “The gap” is the difference between what your recipes &amp; deliveries say you should have and what you actually counted.
        A negative <b>variance</b> is unexplained loss (over-pour, spillage, theft, mis-ringing). Only items you’ve <b>counted</b> in this period appear.
      </p>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontSize: 14, color: 'var(--t1)' }}>Unexplained loss: <b style={{ color: 'var(--red, #ef4444)' }}>{money(totalLoss)}</b></div>
        <ExportBtn rows={rows} headers={[{ label: 'Item', key: 'item' }, { label: 'Sold/used', key: 'used' }, { label: 'Received', key: 'received' }, { label: 'Waste', key: 'waste' }, { label: 'Count adj qty', key: 'countQty' }, { label: 'Variance £', key: 'varValue' }]} name="the-gap" />
      </div>
      {rows.length === 0 && <div style={{ fontSize: 13, color: 'var(--t3)' }}>No counted items in this period yet. Set a stock count (Stock items → Stock tab) to start measuring the gap.</div>}
      {rows.length > 0 && (
        <table style={tableStyle}><thead><tr>{['Item', 'Sold/used', 'Received', 'Waste', 'Count adj', 'Variance £'].map((h, i) => <th key={h} style={{ ...th, textAlign: i >= 1 ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => (<tr key={i}><td style={td}>{r.item}</td><td style={{ ...td, textAlign: 'right', color: 'var(--t3)' }}>{r.used} {r.unit}</td><td style={{ ...td, textAlign: 'right', color: 'var(--t3)' }}>{r.received} {r.unit}</td><td style={{ ...td, textAlign: 'right', color: 'var(--t3)' }}>{r.waste} {r.unit}</td><td style={{ ...td, textAlign: 'right' }}>{r.countQty} {r.unit}</td><td style={{ ...td, textAlign: 'right', fontWeight: 700, color: r.varValue < 0 ? 'var(--red, #ef4444)' : 'var(--grn, #16a34a)' }}>{money(r.varValue)}</td></tr>))}</tbody>
        </table>
      )}
    </div>
  );
}

const tableStyle = { width: '100%', maxWidth: 1000, borderCollapse: 'collapse', fontSize: 12.5, color: 'var(--t1)' };
