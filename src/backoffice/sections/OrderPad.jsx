/**
 * OrderPad — fluid purchasing (Purchasing → Order pad). Slice 7+ / v2.
 * A product-list "checkout": see every item with on-hand, average daily use and a
 * forecast-based suggested order qty; fill from the forecast in one click; the
 * basket groups by supplier and "Create orders" splits it into one PO per supplier.
 *
 * v2 suggestion logic:
 *   • Cover is per-supplier: if the supplier has delivery days set, we cover up to
 *     the *second* upcoming delivery (so what arrives at the next delivery lasts
 *     until the one after). Suppliers with no schedule use the default-cover slider.
 *   • Safety days add a buffer on top of the cover for every line.
 *   • Each item orders from its preferred supplier, but you can switch the supplier
 *     per line when an item has more than one.
 *   • Usage rate comes from the stock_usage_rates RPC (server-side aggregate),
 *     falling back to a client aggregate when the RPC isn't deployed.
 *
 * Suggested packs = avg daily use × (cover + safety) − on hand − on order, rounded
 * up to whole packs; falls back to topping up to par when there's no sales history.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useStore } from '../../store';
import { getActiveLocationSync, getLocationId , supabase } from '../../lib/supabase';
import { money } from '../../lib/currency';
import { displayInUnits } from '../../lib/stock/uom';
import { fetchInventoryItems, fetchSuppliers, fetchUsageRates } from '../../lib/stock/data';
import { fetchParLevels } from '../../lib/stock/counts';
import { fetchPurchaseOrders, createOrdersFromBasket, setPOStatus } from '../../lib/stock/purchasing';
import { PageHeader, PrimaryBtn, SearchField, Chips } from './reports/reportKit';

const USAGE_DAYS = 28;
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
// NET (ex-VAT) pack price — the cost basis. fetchInventoryItems strips inc-VAT prices.
const spNet = (sp) => (sp && sp.netPackPrice != null) ? Number(sp.netPackPrice) : Number(sp?.packPrice || 0);
const field = { background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 8, padding: '7px 9px', fontSize: 13, outline: 'none', fontFamily: 'inherit' };
// Borderless number input for the "Default cover / Safety" pill in the page header.
const bareNum = { border: 'none', background: 'transparent', color: 'var(--t1)', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600, outline: 'none', textAlign: 'right', padding: 0 };
const ghostBtn = { padding: '9px 14px', borderRadius: 12, background: 'var(--bg1)', border: '1px solid var(--bdr2)', color: 'var(--t2)', fontFamily: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer', flexShrink: 0 };
const numCell = { fontVariantNumeric: 'tabular-nums' };
const th = { padding: '11px 14px', borderBottom: '1px solid var(--bdr)', fontWeight: 600, color: 'var(--t3)', textAlign: 'left', fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.05em', whiteSpace: 'nowrap' };
const td = { padding: '11px 14px', borderBottom: '1px solid var(--bdr)', verticalAlign: 'middle' };
const HEADERS = ['Item', 'On hand', 'Use/day', 'Cover', 'Suggested', 'Order', 'Supplier', 'Line £ (ex VAT)'];

const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_LBL = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };
// Days to cover from a supplier's weekly delivery schedule: reach the *second*
// upcoming delivery, so the next delivery's stock lasts until the one after it.
const coverDaysFromSchedule = (deliveryDays) => {
  if (!Array.isArray(deliveryDays) || deliveryDays.length === 0) return null;
  const set = new Set(deliveryDays.map(d => String(d).toLowerCase()));
  const todayIdx = new Date().getDay();
  const hits = [];
  for (let off = 1; off <= 14 && hits.length < 2; off++) {
    if (set.has(DOW[(todayIdx + off) % 7])) hits.push(off);
  }
  return hits.length >= 2 ? hits[1] : (hits[0] || null);
};

export default function OrderPad() {
  const showToast = useStore(s => s.showToast);
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [items, setItems] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [pars, setPars] = useState({});
  const [usage, setUsage] = useState({});       // itemId -> avg daily base
  const [onOrder, setOnOrder] = useState({});   // itemId -> base on order
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(7);          // default cover for unscheduled suppliers
  const [safetyDays, setSafetyDays] = useState(1);
  const [qty, setQty] = useState({});           // itemId -> order packs
  const [supplierOverride, setSupplierOverride] = useState({}); // itemId -> supplierProductId
  const [supplierFilter, setSupplierFilter] = useState('all');
  const [needOnly, setNeedOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    if (loc && loc !== locId) setLocId(loc);
    const [{ data: its }, { data: sup }, { data: par }, { data: rate }, { data: pos }] = await Promise.all([
      fetchInventoryItems(loc), fetchSuppliers(loc), fetchParLevels(loc), fetchUsageRates(USAGE_DAYS, loc), fetchPurchaseOrders(loc),
    ]);
    // on order from open POs (outstanding packs × base content per pack)
    const oo = {};
    (pos || []).filter(p => ['DRAFT', 'SENT', 'PARTIAL'].includes(p.status)).forEach(p => {
      (p.lines || []).forEach(l => { if (!l.inventoryItemId) return; const out = (Number(l.qtyPacks) || 0) - (Number(l.qtyReceived) || 0); if (out > 0) oo[l.inventoryItemId] = (oo[l.inventoryItemId] || 0) + out * (Number(l.packQty) || 1) * (Number(l.innerQty) || 0); });
    });
    setItems(its || []); setSuppliers(sup || []); setPars(par || {}); setUsage(rate || {}); setOnOrder(oo); setLoading(false);
  }, [locId]);
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  const supById = useMemo(() => { const m = {}; suppliers.forEach(s => { m[s.id] = s; }); return m; }, [suppliers]);
  const supName = useCallback((id) => supById[id]?.name || '—', [supById]);

  const rows = useMemo(() => (items || []).filter(i => !i.archivedAt).map(it => {
    const allSps = it.supplierProducts || [];
    const overrideId = supplierOverride[it.id];
    const sp = (overrideId && allSps.find(s => s.id === overrideId)) || allSps.find(s => s.isPreferred) || allSps[0] || null;
    const perPack = sp ? Number(sp.innerQty) : null;
    const onHand = Number(it.onHand) || 0;
    const avgDaily = usage[it.id] || 0;
    const par = pars[it.id]?.parLevel ?? null;
    const oo = onOrder[it.id] || 0;
    const sched = sp ? coverDaysFromSchedule(supById[sp.supplierId]?.deliveryDays) : null;
    const coverDays = sched != null ? sched : days;
    const effCover = coverDays + (Number(safetyDays) || 0);
    let needBase = avgDaily > 0 ? (avgDaily * effCover - onHand - oo) : (par != null ? (par - onHand - oo) : 0);
    if (!(needBase > 0)) needBase = 0;
    const suggestedPacks = (sp && perPack > 0) ? Math.ceil(needBase / perPack) : 0;
    return { it, allSps, sp, perPack, onHand, avgDaily, par, oo, sched, coverDays, effCover, needBase, suggestedPacks };
  }), [items, usage, pars, onOrder, days, safetyDays, supplierOverride, supById]);

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
  const basketTotal = useMemo(() => Object.values(basket).flat().reduce((s, { r, n }) => s + n * spNet(r.sp), 0), [basket]);
  const basketVat = useMemo(() => Object.values(basket).flat().reduce((s, { r, n }) => s + n * spNet(r.sp) * Number(r.sp.vatRate || 0), 0), [basket]);
  const basketCount = Object.values(basket).flat().length;
  const supplierCount = Object.keys(basket).length;
  // flag suppliers under their minimum order value
  const minWarnings = useMemo(() => Object.entries(basket).map(([sid, ls]) => {
    const min = supById[sid]?.minOrderValue;
    const val = ls.reduce((s, { r, n }) => s + n * spNet(r.sp), 0);
    return (min > 0 && val < min) ? { name: supName(sid), val, min } : null;
  }).filter(Boolean), [basket, supById, supName]);

  const createOrders = async () => {
    // unit_price MUST be NET (ex-VAT); the PO line carries the rate so VAT is shown on the order.
    const lines = Object.values(basket).flat().map(({ r, n }) => ({
      supplierId: r.sp.supplierId, inventoryItemId: r.it.id, description: r.it.name,
      qtyPacks: n, packQty: 1, innerQty: r.perPack, innerUnit: r.it.baseUnit, unitPrice: spNet(r.sp),
      purchaseTaxRateId: r.sp.purchaseTaxRateId || r.it.purchaseTaxRateId || null,
    }));
    if (!lines.length) { showToast?.('Add some quantities first', 'error'); return; }
    setBusy(true);
    // v5.5.922 — CREATE MEANS SEND. One click: each supplier's order is emailed to them on the
    // spot and lands in Orders as awaiting delivery. A supplier with no email on file cannot be
    // emailed, so that order is marked sent instead (it still counts as on-order) and the toast
    // says so — silence here would read as "sent" when nothing left the building.
    const { data, error } = await createOrdersFromBasket(lines, 'DRAFT', locId);
    if (error) { setBusy(false); showToast?.(error.message, 'error'); return; }
    let emailed = 0, markedOnly = 0;
    for (const poId of (data.poIds || [])) {
      const { data: res, error: sendErr } = await supabase.functions.invoke('po-send', {
        body: { po_id: poId, location_id: locId },
      });
      if (!sendErr && res?.ok) emailed++;
      else { await setPOStatus(poId, 'SENT', locId); markedOnly++; }
    }
    setBusy(false);
    showToast?.(
      markedOnly
        ? `${emailed} order${emailed === 1 ? '' : 's'} emailed · ${markedOnly} marked sent (no supplier email on file)`
        : `${emailed} order${emailed === 1 ? '' : 's'} emailed to suppliers — now in Orders awaiting delivery`,
      'success');
    setQty({}); await reload();
  };

  if (loading) return <div style={{ padding: 26, color: 'var(--t3)' }}>Loading…</div>;

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <div style={{ flexShrink: 0, padding: '22px 26px 14px' }}>
        <PageHeader
          eyebrow="PURCHASING"
          title="Order pad"
          subtitle="Suggested quantities cover you to each supplier’s next delivery (plus a safety buffer). Fill from the forecast, tweak, and the basket splits into one order per supplier."
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg1)', border: '1px solid var(--bdr2)', borderRadius: 12, padding: '7px 12px' }}>
            <span style={{ fontSize: 11.5, color: 'var(--t4)' }} title="Used for suppliers with no delivery schedule set">Default cover</span>
            <input type="number" min="1" value={days} onChange={e => setDays(Number(e.target.value) || 1)} style={{ ...bareNum, width: 34 }} />
            <span style={{ fontSize: 11.5, color: 'var(--t4)' }}>d</span>
            <span style={{ width: 1, height: 16, background: 'var(--bdr)' }} />
            <span style={{ fontSize: 11.5, color: 'var(--t4)' }}>Safety</span>
            <input type="number" min="0" value={safetyDays} onChange={e => setSafetyDays(Number(e.target.value) || 0)} style={{ ...bareNum, width: 30 }} />
            <span style={{ fontSize: 11.5, color: 'var(--t4)' }}>d</span>
          </div>
          <PrimaryBtn onClick={fillSuggested}>Fill from forecast</PrimaryBtn>
          <button onClick={clearAll} style={ghostBtn}>Clear</button>
        </PageHeader>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <SearchField value={search} onChange={setSearch} placeholder="Search items…" width={220} />
          <Chips value={supplierFilter} onChange={setSupplierFilter}
            options={[{ id: 'all', label: 'All suppliers' }, ...suppliers.map(s => ({ id: s.id, label: s.name }))]} />
          <span style={{ width: 1, height: 20, background: 'var(--bdr)', flexShrink: 0 }} />
          <Chips value={needOnly ? 'need' : 'all'} onChange={v => setNeedOnly(v === 'need')}
            options={[{ id: 'all', label: 'All items' }, { id: 'need', label: 'Only what needs ordering' }]} />
          <span style={{ marginLeft: 'auto', fontSize: 12.5, color: 'var(--t3)', ...numCell }}>{filtered.length} of {rows.length} items</span>
        </div>

        {noSupplier > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, padding: '8px 12px', borderRadius: 10, background: 'var(--red-d)', border: '1px solid var(--red-b)', fontSize: 12, color: 'var(--red)' }}>
            <span aria-hidden="true">⚠</span>
            <span>{noSupplier} item{noSupplier === 1 ? '' : 's'} have no supplier — add one on the item’s Suppliers tab to order them.</span>
          </div>
        )}
      </div>

      {/* Scroll pane. minHeight:0 keeps this the only scroller so the sticky <thead>
          and the pinned basket footer both survive. The surface card deliberately has
          NO overflow:hidden — that would kill both the sticky header and the per-row
          supplier <select>. */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 26px 22px' }}>
        <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 16 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr>{HEADERS.map((h, i) => (
              <th key={h} style={{
                ...th, textAlign: i >= 1 && i <= 5 ? 'right' : 'left',
                position: 'sticky', top: 0, zIndex: 2, background: 'var(--bg2)',
                // border-collapse drops borders on sticky cells — paint it as a shadow.
                boxShadow: 'inset 0 -1px 0 var(--bdr)',
                borderTopLeftRadius: i === 0 ? 15 : 0,
                borderTopRightRadius: i === HEADERS.length - 1 ? 15 : 0,
              }}>{h}</th>
            ))}</tr></thead>
            <tbody>
              {filtered.map((r, ri) => {
                const oh = displayInUnits(r.onHand, r.it);
                const use = displayInUnits(r.avgDaily, r.it);
                const n = qty[r.it.id] ?? '';
                const low = r.par != null && r.onHand <= (pars[r.it.id]?.reorderPoint ?? -Infinity);
                const nextDel = r.sp ? (supById[r.sp.supplierId]?.deliveryDays || []) : [];
                // Last row drops its rule so it doesn't cut across the card's rounded base.
                const cell = ri === filtered.length - 1 ? { ...td, borderBottom: 'none' } : td;
                return (
                  <tr key={r.it.id} style={{ color: 'var(--t1)' }}>
                    <td style={{ ...cell, fontWeight: 500 }}>{r.it.name}{low && <span style={{ color: 'var(--red)', fontSize: 10.5, fontWeight: 700, marginLeft: 7, padding: '2px 6px', borderRadius: 6, background: 'var(--red-d)', border: '1px solid var(--red-b)', textTransform: 'uppercase', letterSpacing: '.04em' }}>low</span>}</td>
                    <td style={{ ...cell, ...numCell, textAlign: 'right' }}>{oh.qty} <span style={{ color: 'var(--t4)' }}>{oh.label}</span></td>
                    <td style={{ ...cell, ...numCell, textAlign: 'right', color: 'var(--t3)' }}>{r.avgDaily > 0 ? `${r2(use.qty)} ${use.label}` : '—'}</td>
                    <td style={{ ...cell, ...numCell, textAlign: 'right', color: 'var(--t4)', fontSize: 12 }} title={r.sched != null ? `Covers to the supplier’s second delivery (${nextDel.map(d => DAY_LBL[d] || d).join('/')}) + ${safetyDays}d safety` : `No delivery schedule — default ${days}d + ${safetyDays}d safety`}>
                      {r.effCover}d{r.sched != null ? ' 🚚' : ''}
                    </td>
                    <td style={{ ...cell, ...numCell, textAlign: 'right', fontWeight: r.suggestedPacks > 0 ? 700 : 400, color: r.suggestedPacks > 0 ? 'var(--acc)' : 'var(--t4)' }}>{r.sp ? r.suggestedPacks : '—'}</td>
                    <td style={{ ...cell, textAlign: 'right' }}>
                      {r.sp
                        ? <input type="number" min="0" value={n} onChange={e => setQty(q => ({ ...q, [r.it.id]: e.target.value }))} placeholder="0" style={{ ...field, ...numCell, width: 64, textAlign: 'right' }} />
                        : <span style={{ fontSize: 11, color: 'var(--red)' }}>no supplier</span>}
                    </td>
                    <td style={{ ...cell, color: 'var(--t3)' }}>
                      {!r.sp ? '—' : r.allSps.length > 1 ? (
                        <select value={r.sp.id} onChange={e => setSupplierOverride(o => ({ ...o, [r.it.id]: e.target.value }))} style={{ ...field, padding: '5px 7px', fontSize: 12, maxWidth: 200 }}>
                          {r.allSps.map(s => <option key={s.id} value={s.id}>{supName(s.supplierId)} · {money(spNet(s))}{s.isPreferred ? ' ★' : ''}</option>)}
                        </select>
                      ) : `${supName(r.sp.supplierId)} · ${r.sp.packDescription || r.perPack + ' ' + r.it.baseUnit}`}
                    </td>
                    <td style={{ ...cell, ...numCell, textAlign: 'right', fontWeight: 600 }}>{r.sp && Number(n) > 0 ? money(Number(n) * spNet(r.sp)) : ''}</td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={HEADERS.length} style={{ ...td, borderBottom: 'none', textAlign: 'center', color: 'var(--t4)', padding: '44px 18px', fontSize: 13 }}>No items match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Basket bar — pinned: flexShrink:0 keeps it out of the scroll pane. */}
      <div style={{ flexShrink: 0, borderTop: '1px solid var(--bdr)', background: 'var(--bg1)', padding: '13px 26px', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13, color: basketCount === 0 ? 'var(--t3)' : 'var(--t1)' }}>
          {basketCount === 0 ? 'Nothing in the basket yet' : <><b>{basketCount}</b> line{basketCount === 1 ? '' : 's'} · <b>{supplierCount}</b> supplier{supplierCount === 1 ? '' : 's'} · <b style={numCell}>{money(basketTotal)}</b> <span style={{ color: 'var(--t3)' }}>ex VAT{basketVat > 0.005 ? ` · VAT ${money(basketVat)} · pay ${money(basketTotal + basketVat)}` : ''}</span></>}
        </div>
        {supplierCount > 0 && <div style={{ fontSize: 12, color: 'var(--t3)' }}>{Object.entries(basket).map(([sid, ls]) => `${supName(sid)} (${ls.length})`).join(' · ')}</div>}
        {/* --amber is only declared under [data-skin="servos"], so keep reportKit's fallback. */}
        {minWarnings.length > 0 && <div style={{ fontSize: 12, color: 'var(--amber, #F5A623)', padding: '5px 10px', borderRadius: 9, background: 'color-mix(in srgb, var(--amber, #F5A623) 14%, transparent)' }}>⚠ below min order: {minWarnings.map(w => `${w.name} ${money(w.val)}/${money(w.min)}`).join(' · ')}</div>}
        <button onClick={createOrders} disabled={busy || basketCount === 0} style={{ marginLeft: 'auto', padding: '11px 22px', borderRadius: 12, background: basketCount ? 'var(--grn)' : 'var(--bg3)', color: basketCount ? '#0b0c10' : 'var(--t4)', border: 0, fontFamily: 'inherit', fontSize: 14, fontWeight: 700, cursor: basketCount ? 'pointer' : 'default', flexShrink: 0 }}>
          {busy ? 'Creating…' : `Create ${supplierCount || ''} order${supplierCount === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  );
}
