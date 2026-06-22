/**
 * OrderPad — fluid purchasing (Purchasing → Order pad). Slice 7+.
 * A product-list "checkout": see every item with on-hand, average daily use and a
 * forecast-based suggested order qty; fill from the forecast in one click; the
 * basket groups by supplier and "Create orders" splits it into one PO per supplier.
 *
 * Suggestion = avg daily use (from real SALE_DEPLETION/PRODUCTION over ~4 weeks) ×
 * days-to-cover − on hand − on order, rounded up to whole packs; falls back to
 * topping up to par when there's no sales history. Each item orders from its
 * preferred supplier; items with no supplier are flagged.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useStore } from '../../store';
import { getActiveLocationSync, getLocationId } from '../../lib/supabase';
import { money } from '../../lib/currency';
import { displayInUnits } from '../../lib/stock/uom';
import { fetchInventoryItems, fetchSuppliers, fetchMovementsRange } from '../../lib/stock/data';
import { fetchParLevels } from '../../lib/stock/counts';
import { fetchPurchaseOrders, createOrdersFromBasket } from '../../lib/stock/purchasing';

const USAGE_DAYS = 28;
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const field = { background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 6, padding: '7px 9px', fontSize: 13, outline: 'none' };
const th = { padding: '7px 8px', borderBottom: '1px solid var(--bdr)', fontWeight: 600, color: 'var(--t3)', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em' };
const td = { padding: '7px 8px', borderBottom: '1px solid var(--bg2)' };

export default function OrderPad() {
  const showToast = useStore(s => s.showToast);
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [items, setItems] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [pars, setPars] = useState({});
  const [usage, setUsage] = useState({});       // itemId -> avg daily base
  const [onOrder, setOnOrder] = useState({});   // itemId -> base on order
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(7);
  const [qty, setQty] = useState({});           // itemId -> order packs
  const [supplierFilter, setSupplierFilter] = useState('all');
  const [needOnly, setNeedOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    if (loc && loc !== locId) setLocId(loc);
    const fromIso = new Date(Date.now() - USAGE_DAYS * 86400000).toISOString();
    const [{ data: its }, { data: sup }, { data: par }, { data: moves }, { data: pos }] = await Promise.all([
      fetchInventoryItems(loc), fetchSuppliers(loc), fetchParLevels(loc), fetchMovementsRange(fromIso, null, loc, 5000), fetchPurchaseOrders(loc),
    ]);
    // average daily use from outbound movements
    const used = {};
    (moves || []).forEach(m => { if (m.movementType === 'SALE_DEPLETION' || m.movementType === 'PRODUCTION_CONSUME') used[m.inventoryItemId] = (used[m.inventoryItemId] || 0) + (-m.qtyBase); });
    const rate = {}; Object.entries(used).forEach(([id, base]) => { rate[id] = base / USAGE_DAYS; });
    // on order from open POs (outstanding packs × base content per pack)
    const oo = {};
    (pos || []).filter(p => ['DRAFT', 'SENT', 'PARTIAL'].includes(p.status)).forEach(p => {
      (p.lines || []).forEach(l => { if (!l.inventoryItemId) return; const out = (Number(l.qtyPacks) || 0) - (Number(l.qtyReceived) || 0); if (out > 0) oo[l.inventoryItemId] = (oo[l.inventoryItemId] || 0) + out * (Number(l.packQty) || 1) * (Number(l.innerQty) || 0); });
    });
    setItems(its || []); setSuppliers(sup || []); setPars(par || {}); setUsage(rate); setOnOrder(oo); setLoading(false);
  }, [locId]);
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  const supName = useCallback((id) => suppliers.find(s => s.id === id)?.name || '—', [suppliers]);

  const rows = useMemo(() => (items || []).filter(i => !i.archivedAt).map(it => {
    const sp = (it.supplierProducts || []).find(s => s.isPreferred) || (it.supplierProducts || [])[0] || null;
    const perPack = sp ? Number(sp.innerQty) : null;
    const onHand = Number(it.onHand) || 0;
    const avgDaily = usage[it.id] || 0;
    const par = pars[it.id]?.parLevel ?? null;
    const oo = onOrder[it.id] || 0;
    let needBase = avgDaily > 0 ? (avgDaily * days - onHand - oo) : (par != null ? (par - onHand - oo) : 0);
    if (!(needBase > 0)) needBase = 0;
    const suggestedPacks = (sp && perPack > 0) ? Math.ceil(needBase / perPack) : 0;
    return { it, sp, perPack, onHand, avgDaily, par, oo, needBase, suggestedPacks };
  }), [items, usage, pars, onOrder, days]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      if (supplierFilter !== 'all') { if ((r.sp?.supplierId || 'none') !== supplierFilter) return false; }
      if (needOnly && !(r.suggestedPacks > 0)) return false;
      if (q && !r.it.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, supplierFilter, needOnly, search]);

  const noSupplier = rows.filter(r => !r.sp).length;
  const fillSuggested = () => { const next = { ...qty }; filtered.forEach(r => { if (r.sp) next[r.it.id] = r.suggestedPacks; }); setQty(next); };
  const clearAll = () => setQty({});

  // basket grouped by supplier
  const basket = useMemo(() => {
    const groups = {};
    rows.forEach(r => { const n = Number(qty[r.it.id]) || 0; if (!r.sp || n <= 0) return; (groups[r.sp.supplierId] ??= []).push({ r, n }); });
    return groups;
  }, [rows, qty]);
  const basketTotal = useMemo(() => Object.values(basket).flat().reduce((s, { r, n }) => s + n * Number(r.sp.packPrice || 0), 0), [basket]);
  const basketCount = Object.values(basket).flat().length;
  const supplierCount = Object.keys(basket).length;

  const createOrders = async () => {
    const lines = Object.values(basket).flat().map(({ r, n }) => ({
      supplierId: r.sp.supplierId, inventoryItemId: r.it.id, description: r.it.name,
      qtyPacks: n, packQty: 1, innerQty: r.perPack, innerUnit: r.it.baseUnit, unitPrice: r.sp.packPrice,
    }));
    if (!lines.length) { showToast?.('Add some quantities first', 'error'); return; }
    setBusy(true);
    const { data, error } = await createOrdersFromBasket(lines, 'DRAFT', locId);
    setBusy(false);
    if (error) { showToast?.(error.message, 'error'); return; }
    showToast?.(`Created ${data.created} order${data.created === 1 ? '' : 's'} (draft) — find them in Purchase orders`, 'success');
    setQty({}); await reload();
  };

  if (loading) return <div style={{ padding: 26, color: 'var(--t3)' }}>Loading…</div>;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg0)' }}>
      <div style={{ padding: '18px 24px 12px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 4px', color: 'var(--t1)' }}>Order pad</h1>
        <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 12 }}>Set quantities (or fill from the forecast); the basket splits into one order per supplier.</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search items…" style={{ ...field, width: 180 }} />
          <select value={supplierFilter} onChange={e => setSupplierFilter(e.target.value)} style={field}>
            <option value="all">All suppliers</option>
            {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, color: 'var(--t2)', cursor: 'pointer' }}>
            <input type="checkbox" checked={needOnly} onChange={e => setNeedOnly(e.target.checked)} /> Only what needs ordering
          </label>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--t3)' }}>Cover</span>
            <input type="number" min="1" value={days} onChange={e => setDays(Number(e.target.value) || 1)} style={{ ...field, width: 56, textAlign: 'right' }} />
            <span style={{ fontSize: 12, color: 'var(--t3)' }}>days</span>
            <button onClick={fillSuggested} style={{ padding: '8px 14px', borderRadius: 7, background: 'var(--acc)', color: '#fff', border: 0, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Fill from forecast</button>
            <button onClick={clearAll} style={{ padding: '8px 12px', borderRadius: 7, background: 'var(--bg2)', border: '1px solid var(--bdr)', color: 'var(--t2)', fontSize: 13, cursor: 'pointer' }}>Clear</button>
          </div>
        </div>
        {noSupplier > 0 && <div style={{ fontSize: 12, color: 'var(--red, #ef4444)', marginTop: 8 }}>⚠ {noSupplier} item{noSupplier === 1 ? '' : 's'} have no supplier — add one on the item’s Suppliers tab to order them.</div>}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 24px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr>{['Item', 'On hand', 'Use/day', 'Suggested', 'Order', 'Supplier', 'Line £'].map((h, i) => <th key={h} style={{ ...th, textAlign: i >= 1 && i <= 4 ? 'right' : 'left', position: 'sticky', top: 0, background: 'var(--bg0)' }}>{h}</th>)}</tr></thead>
          <tbody>
            {filtered.map(r => {
              const oh = displayInUnits(r.onHand, r.it);
              const use = displayInUnits(r.avgDaily, r.it);
              const n = qty[r.it.id] ?? '';
              const low = r.par != null && r.onHand <= (pars[r.it.id]?.reorderPoint ?? -Infinity);
              return (
                <tr key={r.it.id} style={{ color: 'var(--t1)' }}>
                  <td style={td}>{r.it.name}{low && <span style={{ color: 'var(--red, #ef4444)', fontSize: 11, marginLeft: 6 }}>low</span>}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{oh.qty} {oh.label}</td>
                  <td style={{ ...td, textAlign: 'right', color: 'var(--t3)' }}>{r.avgDaily > 0 ? `${r2(use.qty)} ${use.label}` : '—'}</td>
                  <td style={{ ...td, textAlign: 'right', color: r.suggestedPacks > 0 ? 'var(--acc)' : 'var(--t4)' }}>{r.sp ? r.suggestedPacks : '—'}</td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    {r.sp
                      ? <input type="number" min="0" value={n} onChange={e => setQty(q => ({ ...q, [r.it.id]: e.target.value }))} placeholder="0" style={{ ...field, width: 64, textAlign: 'right' }} />
                      : <span style={{ fontSize: 11, color: 'var(--red, #ef4444)' }}>no supplier</span>}
                  </td>
                  <td style={{ ...td, color: 'var(--t3)' }}>{r.sp ? `${supName(r.sp.supplierId)} · ${r.sp.packDescription || r.perPack + ' ' + r.it.baseUnit}` : '—'}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{r.sp && Number(n) > 0 ? money(Number(n) * Number(r.sp.packPrice || 0)) : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 && <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>No items match.</div>}
      </div>

      {/* Basket bar */}
      <div style={{ borderTop: '1px solid var(--bdr)', background: 'var(--bg1)', padding: '12px 24px', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13, color: 'var(--t1)' }}>
          {basketCount === 0 ? 'Nothing in the basket yet' : <><b>{basketCount}</b> line{basketCount === 1 ? '' : 's'} · <b>{supplierCount}</b> supplier{supplierCount === 1 ? '' : 's'} · <b>{money(basketTotal)}</b></>}
        </div>
        {supplierCount > 0 && <div style={{ fontSize: 12, color: 'var(--t3)' }}>{Object.entries(basket).map(([sid, ls]) => `${supName(sid)} (${ls.length})`).join(' · ')}</div>}
        <button onClick={createOrders} disabled={busy || basketCount === 0} style={{ marginLeft: 'auto', padding: '11px 22px', borderRadius: 9, background: basketCount ? 'var(--grn, #16a34a)' : 'var(--bg3)', color: basketCount ? '#fff' : 'var(--t4)', border: 0, fontSize: 14, fontWeight: 700, cursor: basketCount ? 'pointer' : 'default' }}>
          {busy ? 'Creating…' : `Create ${supplierCount || ''} order${supplierCount === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  );
}
