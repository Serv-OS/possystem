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
 *
 * v5.11.64: the rules live in src/lib/stock/purchasingRules.js (pure, tested). A pack is
 * pack_qty × inner_qty like everywhere else, delivery days written as numbers are read, each
 * order is born with its expected delivery date, the On hand cell shows what is already on
 * order (so a suggested 0 explains itself), and the toast speaks plain English.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useStore } from '../../store';
import { getActiveLocationSync, getLocationId , supabase } from '../../lib/supabase';
import { getLocationConfig, buildScheduleCtx } from '../../lib/locationTime';
import { money } from '../../lib/currency';
import { displayInUnits } from '../../lib/stock/uom';
import { fetchInventoryItems, fetchSuppliers, fetchUsageRates, fetchUsageByWeekday } from '../../lib/stock/data';
import { fetchParLevels } from '../../lib/stock/counts';
import { fetchPurchaseOrders, createOrdersFromBasket, setPOStatus, fnErrorText } from '../../lib/stock/purchasing';
import { pickSupplierProduct } from '../../lib/stock/costing';
import { outstandingOnOrder } from '../../lib/stock/onOrder';
import { coverDaysFromSchedule, nextDeliveryYmd, normDeliveryDays, packContent, packContentInBase, suggestPacks, createOrdersToast, DAY_LABEL } from '../../lib/stock/purchasingRules';
import { PageHeader, PrimaryBtn, SearchField, Chips } from './reports/reportKit';
import { useStockScope } from '../StockScope';
import { stockApi } from '../../lib/stock/stockApi';
import { pausedMap, pauseWords, pausedLineWords } from '../../lib/stock/pauseRules';

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

// Cover days walk the schedule from the VENUE's "today" (v5.7.24): see purchasingRules.js.

// v5.11.89 (multi site stock Drop 1, map 4.3): nothing is paused until the read says so.
const NO_PAUSES = new Map();

// v5.11.89: siteId is the picker's site (always the signed in venue for a one site company). In a
// multi site company the pad reads which items are paused at that site today (stock_paused_items):
// a paused line is grey with its words, never suggested, and Create orders refuses it. One site
// companies make no extra call and see exactly today's pad.
export default function OrderPad({ siteId = null } = {}) {
  const showToast = useStore(s => s.showToast);
  const { multi, siteName } = useStockScope();
  const [locId, setLocId] = useState(siteId || getActiveLocationSync());
  const [paused, setPaused] = useState(NO_PAUSES);         // site item id -> { everywhere, until }
  const [pauseUnknown, setPauseUnknown] = useState(false); // the read failed: orders wait
  const [items, setItems] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [pars, setPars] = useState({});
  const [usage, setUsage] = useState({});       // itemId -> avg daily base
  const [weekday, setWeekday] = useState(null); // itemId -> [sun..sat avg daily base]; null until the RPC is migrated
  const [onOrder, setOnOrder] = useState({});   // itemId -> base on order
  const [staleOrders, setStaleOrders] = useState([]);   // open orders long past due, left out of on order (v5.11.65)
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(7);          // default cover for unscheduled suppliers
  const [safetyDays, setSafetyDays] = useState(1);
  const [qty, setQty] = useState({});           // itemId -> order packs
  const [supplierOverride, setSupplierOverride] = useState({}); // itemId -> supplierProductId
  const [supplierFilter, setSupplierFilter] = useState('all');
  const [needOnly, setNeedOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  // v5.7.24 — suggestions key off the VENUE's "today" (project invariant);
  // null until resolved, and buildScheduleCtx(null) is the Europe/London default.
  const [venueTz, setVenueTz] = useState(null);

  const reload = useCallback(async () => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    if (loc && loc !== locId) setLocId(loc);
    getLocationConfig(loc).then(c => setVenueTz(c?.timezone || null)).catch(() => {});
    const [{ data: its }, { data: sup }, { data: par }, { data: rate, error: rateErr }, { data: pos }, { data: wk, error: wkErr }] = await Promise.all([
      fetchInventoryItems(loc), fetchSuppliers(loc), fetchParLevels(loc), fetchUsageRates(USAGE_DAYS, loc), fetchPurchaseOrders(loc), fetchUsageByWeekday(8, loc),
    ]);
    // v5.11.79: usage is read in pages; a page that fails gives no usage rather than part of it, so say so.
    if (rateErr || wkErr) showToast?.('Usage could not be read in full, so suggested quantities may be low. Reload to try again.', 'error');
    // v5.11.65: on order = SENT and PARTIAL only (a draft was never sent), each line converted to
    // the item's base unit as receiving does, and an order more than a week past its date left
    // out and named: a July order that will never arrive stopped its items being suggested again.
    const cfg = await getLocationConfig(loc).catch(() => null);
    const byId = Object.fromEntries((its || []).map(i => [i.id, i]));
    const { byItem: oo, stale } = outstandingOnOrder(pos, byId, { todayYmd: buildScheduleCtx(cfg?.timezone).ymd });
    // v5.11.89 (Drop 1): what is paused at this site today. Multi site companies only (a database
    // before Drop 1 has no pause, so nothing is paused); a failed read holds the orders back.
    if (multi && loc) {
      const pr = await stockApi.pausedItems(loc);
      setPaused(pr.error ? NO_PAUSES : pausedMap(pr.data?.rows));
      setPauseUnknown(!!pr.error && !pr.needsUpdate);
    }
    setItems(its || []); setSuppliers(sup || []); setPars(par || {}); setUsage(rate || {}); setWeekday(wk); setOnOrder(oo); setStaleOrders(stale); setLoading(false);
  }, [locId, showToast, multi]);
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  const supById = useMemo(() => { const m = {}; suppliers.forEach(s => { m[s.id] = s; }); return m; }, [suppliers]);
  const supName = useCallback((id) => supById[id]?.name || '—', [supById]);

  // v5.5.925 — you don't ORDER a made-here item, you MAKE it. A burger patty in a
  // supplier ordering list was the production model leaking into purchasing; its
  // ingredients (the minced beef) are what belongs here, and they already are.
  const rows = useMemo(() => {
    const todayDow = buildScheduleCtx(venueTz).isoDay % 7; // venue JS dow (0=Sun)
    return (items || []).filter(i => !i.archivedAt && i.kind !== 'MADE').map(it => {
    const allSps = it.supplierProducts || [];
    const overrideId = supplierOverride[it.id];
    // ONE rule for "which pack": preferred star, then the item's default supplier, then cheapest.
    const sp = (overrideId && allSps.find(s => s.id === overrideId)) || pickSupplierProduct(it);
    // A pack is pack_qty x inner_qty, the same convention as costing and receiving. Reading
    // inner_qty alone called a case of 6 x 2 l "2 l" and ordered six times the cases needed.
    // v5.11.65: read in the ITEM's base unit, because the need below is in base units. A pack of
    // 1 x 2.5 kg on an item counted in grams is 2500, else a 3 kg need asked for 1200 packs.
    // Falls back to the pack's own figure when the units cannot be joined.
    const perPack = sp ? (packContentInBase(sp, it.baseUnit, it.conversions || []) ?? packContent(sp)) : null;
    const onHand = Number(it.onHand) || 0;
    const avgDaily = usage[it.id] || 0;
    const par = pars[it.id]?.parLevel ?? null;
    const oo = onOrder[it.id] || 0;
    const sched = sp ? coverDaysFromSchedule(supById[sp.supplierId]?.deliveryDays, todayDow) : null;
    const coverDays = sched != null ? sched : days;
    // v5.5.926 — WALK THE ACTUAL DAYS, don't multiply a flat average. A venue selling
    // 12 on Fridays and 3 on Tuesdays was told "6.4/day": over-ordered for Monday,
    // under-ordered for the weekend. When the weekday profile exists we sum expected
    // usage for each real calendar day this order has to cover, starting tomorrow.
    // No profile (RPC not migrated / brand-new item) -> the flat average, as before.
    const prof = weekday?.[it.id];
    // v5.11.89 (Drop 1): an item paused here today is never suggested: nothing is worked out for it.
    const pz = paused.get(it.id) || null;
    const sug = pz
      ? { needBase: 0, suggestedPacks: 0, covered: false, effCover: (Number(coverDays) || 0) + (Number(safetyDays) || 0), hasShape: false }
      : suggestPacks({ onHand, onOrder: oo, avgDaily, profile: prof, todayDow, coverDays, safetyDays, par, perPack: sp ? perPack : null });
    return { it, allSps, sp, perPack, onHand, avgDaily, prof: sug.hasShape ? prof : null, par, oo, sched, coverDays, effCover: sug.effCover, needBase: sug.needBase, suggestedPacks: sug.suggestedPacks, covered: sug.covered, paused: pz };
  }); }, [items, usage, weekday, pars, onOrder, days, safetyDays, supplierOverride, supById, venueTz, paused]);

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
  // Fill writes the forecast into every line that has a supplier; a line with nothing to
  // order is cleared, not left at a stale number. When NOTHING needs ordering the pad says
  // so: a screen full of zeros read as "the button does nothing" when the truth was that
  // everything needed was already on hand or on order.
  const fillSuggested = () => {
    const next = { ...qty };
    let filled = 0, coveredByOrders = 0;
    filtered.forEach(r => {
      if (!r.sp) return;
      if (r.suggestedPacks > 0) { next[r.it.id] = r.suggestedPacks; filled++; }
      else { delete next[r.it.id]; if (r.covered && r.oo > 0) coveredByOrders++; }
    });
    setQty(next);
    if (!filled) {
      showToast?.(coveredByOrders
        ? `Nothing to order: what you need for the cover period is on hand or already on open orders (${coveredByOrders} item${coveredByOrders === 1 ? '' : 's'} on order). See Orders.`
        : 'Nothing to order: stock on hand covers the period for every item shown.', 'info');
    }
  };
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
    // The line mirrors the supplier pack (pack_qty x inner_qty in the pack's unit) so the
    // supplier reads "6 x 2 l" and receiving books the right base quantity.
    // v5.11.89 (Drop 1): a line of an item paused here today is refused, naming it.
    const pausedLines = Object.values(basket).flat().filter(({ r }) => r.paused);
    if (pausedLines.length) { showToast?.(pausedLines.map(({ r }) => pausedLineWords(r.it.name, r.paused, siteName(locId))).join(' '), 'error'); return; }
    if (pauseUnknown) { showToast?.('Could not check which items are paused here. Reload to try again.', 'error'); return; }
    const lines = Object.values(basket).flat().map(({ r, n }) => ({
      supplierId: r.sp.supplierId, inventoryItemId: r.it.id, description: r.it.name,
      qtyPacks: n, packQty: Number(r.sp.packQty) || 1, innerQty: Number(r.sp.innerQty) || 1,
      innerUnit: r.sp.innerUnit || r.it.baseUnit, unitPrice: spNet(r.sp),
      purchaseTaxRateId: r.sp.purchaseTaxRateId || r.it.purchaseTaxRateId || null,
    }));
    if (!lines.length) { showToast?.('Add some quantities first', 'error'); return; }
    setBusy(true);
    // Every order is born with the day it should arrive: the supplier's next delivery day
    // (tomorrow when they have no schedule), on the venue's calendar.
    const todayYmd = buildScheduleCtx(venueTz).ymd;
    const expectedDateBySupplier = {};
    Object.keys(basket).forEach(sid => { expectedDateBySupplier[sid] = nextDeliveryYmd(supById[sid]?.deliveryDays, todayYmd); });
    // v5.5.922 — CREATE MEANS SEND. One click: each supplier's order is emailed to them on the
    // spot and lands in Orders as awaiting delivery. A supplier with no email on file cannot be
    // emailed, so that order is marked sent instead (it still counts as on-order) and the toast
    // says so — silence here would read as "sent" when nothing left the building.
    const { data, error } = await createOrdersFromBasket(lines, 'DRAFT', locId, { expectedDateBySupplier });
    if (error) { setBusy(false); showToast?.(error.message, 'error'); return; }
    let emailed = 0; const failed = [];
    const poIds = data.poIds || [], supplierIds = data.supplierIds || [];
    for (let i = 0; i < poIds.length; i++) {
      const poId = poIds[i];
      const { data: res, error: sendErr } = await supabase.functions.invoke('po-send', {
        body: { po_id: poId, location_id: locId },
      });
      if (!sendErr && res?.ok) emailed++;
      else {
        // v5.5.939: keep the order on the books either way, but STOP claiming "no email
        // on file" for every failure — that wording hid a real send outage. Carry the
        // actual reason into the toast in plain words; Orders has a Resend button for the retry.
        // v5.11.64: every non-2xx answer arrives with data null (the SDK throws before parsing),
        // so the body is read in fnErrorText and cleanFnError puts the two known answers
        // (no email on file, address refused by the mail service) into plain words.
        const reason = await fnErrorText(res, sendErr, 'the email could not be sent');
        failed.push({ supplier: supName(supplierIds[i]), reason, email: supById[supplierIds[i]]?.email || null });
        await setPOStatus(poId, 'SENT', locId);
      }
    }
    setBusy(false);
    showToast?.(createOrdersToast({ created: data.created || poIds.length, emailed, failed, fallback: 'the email could not be sent' }), failed.length ? 'error' : 'success');
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
        {staleOrders.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, padding: '8px 12px', borderRadius: 10, background: 'color-mix(in srgb, var(--amber, #F5A623) 14%, transparent)', border: '1px solid var(--amber, #F5A623)', fontSize: 12, color: 'var(--amber, #F5A623)' }}>
            <span aria-hidden="true">⚠</span>
            <span>{staleOrders.length} open order{staleOrders.length === 1 ? '' : 's'} more than a week past due ({staleOrders.map(s => `${supName(s.supplierId)}${s.reference ? ` ${s.reference}` : ''}`).join(', ')}) {staleOrders.length === 1 ? 'is' : 'are'} not counted as on order. Receive or cancel {staleOrders.length === 1 ? 'it' : 'them'} in Orders.</span>
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
                // v5.11.65: the count unit (Keg, Case), as every other stock screen shows it; the raw item
                // carried `packaging` and `conversions`, names displayInUnits does not read, so this pad
                // alone fell back to litres and grams.
                const uom = { baseUnit: r.it.baseUnit, formats: r.it.packaging || [], itemConversions: r.it.conversions || [] };
                const oh = displayInUnits(r.onHand, uom);
                const use = displayInUnits(r.avgDaily, uom);
                const n = qty[r.it.id] ?? '';
                const low = r.par != null && r.onHand <= (pars[r.it.id]?.reorderPoint ?? -Infinity);
                const nextDel = r.sp ? normDeliveryDays(supById[r.sp.supplierId]?.deliveryDays) : [];
                // Last row drops its rule so it doesn't cut across the card's rounded base.
                const cell = ri === filtered.length - 1 ? { ...td, borderBottom: 'none' } : td;
                return (
                  <tr key={r.it.id} style={r.paused ? { color: 'var(--t4)' } : { color: 'var(--t1)' }}>
                    <td style={{ ...cell, fontWeight: 500 }}>{r.it.name}{low && <span style={{ color: 'var(--red)', fontSize: 10.5, fontWeight: 700, marginLeft: 7, padding: '2px 6px', borderRadius: 6, background: 'var(--red-d)', border: '1px solid var(--red-b)', textTransform: 'uppercase', letterSpacing: '.04em' }}>low</span>}{r.paused && <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--amber, #F5A623)', marginTop: 3 }}>{pauseWords({ siteName: siteName(locId), everywhere: r.paused.everywhere, until: r.paused.until })}</div>}</td>
                    <td style={{ ...cell, ...numCell, textAlign: 'right' }}>
                      {oh.qty} <span style={{ color: 'var(--t4)' }}>{oh.label}</span>
                      {/* What is already on open orders. Without this a correct suggested 0 looked broken. */}
                      {r.oo > 0 && (() => { const o = displayInUnits(r.oo, uom); return (
                        <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 3, whiteSpace: 'nowrap' }} title="Outstanding on open orders (Orders screen)">+{r2(o.qty)} {o.label} on order</div>
                      ); })()}
                    </td>
                    <td style={{ ...cell, ...numCell, textAlign: 'right', color: 'var(--t3)' }}>
                      {r.avgDaily > 0 || r.prof ? `${r2(use.qty)} ${use.label}` : '—'}
                      {/* v5.5.934: the old strip rendered "M0 T0 W0…" — seven 9px letter+number
                          pairs that read as gibberish. Show only what matters: the busiest days,
                          in words, at a readable size. Quiet days are silence, not zeros. */}
                      {r.prof && (() => {
                        const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                        const busy = r.prof.map((v, d) => ({ d, q: displayInUnits(v, uom).qty }))
                          .filter(x => x.q >= 0.5).sort((a, b) => b.q - a.q).slice(0, 3);
                        if (!busy.length) return null;
                        return <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 3, whiteSpace: 'nowrap' }}>
                          busiest {busy.map(x => `${DAY[x.d]} ${r2(x.q)}`).join(' · ')}
                        </div>;
                      })()}
                    </td>
                    <td style={{ ...cell, ...numCell, textAlign: 'right', color: 'var(--t4)', fontSize: 12 }} title={r.sched != null ? `Covers to the supplier’s second delivery (${nextDel.map(d => DAY_LABEL[d] || d).join('/')}) + ${safetyDays}d safety` : `No delivery schedule: default ${days}d + ${safetyDays}d safety`}>
                      {r.effCover}d{r.sched != null ? ' 🚚' : ''}
                    </td>
                    <td style={{ ...cell, ...numCell, textAlign: 'right', fontWeight: r.suggestedPacks > 0 ? 700 : 400, color: r.suggestedPacks > 0 ? 'var(--acc)' : 'var(--t4)' }}>{r.sp ? r.suggestedPacks : '—'}</td>
                    <td style={{ ...cell, textAlign: 'right' }}>
                      {r.sp
                        ? <input type="number" min="0" value={n} onChange={e => setQty(q => ({ ...q, [r.it.id]: e.target.value }))} disabled={!!r.paused} placeholder="0" style={{ ...field, ...numCell, width: 64, textAlign: 'right' }} />
                        : <span style={{ fontSize: 11, color: 'var(--red)' }}>no supplier</span>}
                    </td>
                    <td style={{ ...cell, color: 'var(--t3)' }}>
                      {!r.sp ? '—' : r.allSps.length > 1 ? (
                        <select value={r.sp.id} onChange={e => setSupplierOverride(o => ({ ...o, [r.it.id]: e.target.value }))} style={{ ...field, padding: '5px 7px', fontSize: 12, maxWidth: 200 }}>
                          {r.allSps.map(s => <option key={s.id} value={s.id}>{supName(s.supplierId)} · {money(spNet(s))}{s.isPreferred ? ' ★' : ''}</option>)}
                        </select>
                      ) : `${supName(r.sp.supplierId)} · ${r.sp.packDescription || r.perPack + ' ' + (r.sp.innerUnit || r.it.baseUnit)}`}
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
