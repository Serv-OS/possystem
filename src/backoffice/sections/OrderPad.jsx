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
 *
 * v5.11.96 (multi site stock Drop 3, contract 3.2): ONE change for every company: the expected date
 * and the cover follow the one delivery rule (nextDelivery, coverFromRules), so an order placed after
 * the order by time is dated for the next delivery. Everything else new is for multi site companies
 * only and every line of it carries the marker comment `d3 multi` (the one site proof removes those
 * lines: src/lib/stock/oneSiteIdentityPurchasing.test.js): on All sites the Which site card with
 * Order for many sites; at one site the order pad context (rules, budget, lists, standing orders,
 * approval limits), the next delivery line, the budget bar, forecast use and the par for the delivery
 * day, the basket rules under each supplier, Saved lists and Repeat, and Send through the database's
 * submit (approval, kitchen or email).
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
import { coverFromRules, nextDelivery, rulesFromDeliveryDays, daysAfter, normDeliveryDays, packContent, packContentInBase, suggestPacks, createOrdersToast, DAY_LABEL } from '../../lib/stock/purchasingRules';
import { basketRules, padSupplierOf, padNext, parForDay, basketFromLines, linesOfBasket, lastOrderTo, scaleOverDays, moneyWords } from '../../lib/stock/purchasingRules'; // d3 multi
import { historyFromRows, suggestForecast, baselineFor } from '../../../supabase/functions/_shared/salesForecast.js'; // d3 multi
import { PAD_WORDS, HEADERS_MULTI_OF, standingPillWords, submitToast } from '../../lib/stock/purchasingWords'; // d3 multi
import { Pill, Notice, Modal, Btn, ui } from './stock/stockUi'; // d3 multi
import OrderPadWhichSite from './purchasing/OrderPadWhichSite'; // d3 multi
import OrderPadHeaderLine from './purchasing/OrderPadHeaderLine'; // d3 multi
import BudgetBar from './purchasing/BudgetBar'; // d3 multi
import BasketRulesLine from './purchasing/BasketRulesLine'; // d3 multi
import SavedListsMenu from './purchasing/SavedListsMenu'; // d3 multi
import OrderManySites from './purchasing/OrderManySites'; // d3 multi
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
const HEADERS_ONE = HEADERS; // d3 multi: the screen swaps in the multi site columns (HEADERS_MULTI_OF) by name
// The forecast over the usual same weekday sales for the next 7 venue days (1 when unknown). // d3 multi
async function padScale(loc, ctx, tz) { // d3 multi
  const days = daysAfter(ctx?.now?.ymd || buildScheduleCtx(tz).ymd, 7); // d3 multi
  if (!days.length) return 1; // d3 multi
  const [h, w] = await Promise.all([stockApi.salesHistory(loc, 56), stockApi.forecastWeek(loc, days[0])]); // d3 multi
  if (h.error) return 1; // d3 multi
  const history = historyFromRows(h.data?.rows); // d3 multi
  const suggested = suggestForecast(history, days); // d3 multi
  const saved = Object.fromEntries((w.error ? [] : (w.data?.days || [])).filter((d) => d && d.amount != null).map((d) => [String(d.day).slice(0, 10), Number(d.amount)])); // d3 multi
  const forecast = Object.fromEntries(days.map((d) => [d, saved[d] ?? suggested[d]?.amount ?? 0])); // d3 multi
  const baseline = Object.fromEntries(days.map((d) => [d, baselineFor(history, d)])); // d3 multi
  return scaleOverDays(days, forecast, baseline); // d3 multi
} // d3 multi
// One supplier's basket at this site: its total, the basket rules and the standing lines due. // d3 multi
function MultiBasket({ basket, ctx, supName, spNet, itemName }) { // d3 multi
  const groups = Object.entries(basket); // d3 multi
  if (!groups.length) return null; // d3 multi
  return ( // d3 multi
    <div style={{ width: '100%', display: 'grid', gap: 6 }}>{/* // d3 multi */}
      {groups.map(([sid, ls]) => { // d3 multi
        const s = padSupplierOf(ctx, sid); // d3 multi
        const goods = ls.reduce((t, { r, n }) => t + n * spNet(r.sp), 0); // d3 multi
        const rules = basketRules({ goods, minOrder: s?.min_order_value, maxOrder: s?.max_order_value, fee: s?.delivery_fee, feeWaivedOverMin: s?.fee_waived_over_min === true, approvalLimit: s?.approval_limit }); // d3 multi
        const standing = (s?.standing || []).filter((x) => x && x.status !== 'skipped'); // d3 multi
        return ( // d3 multi
          <div key={sid} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5 }}>{/* // d3 multi */}
            <b>{supName(sid)}</b> <span style={{ fontVariantNumeric: 'tabular-nums' }}>{moneyWords(goods)}</span>{/* // d3 multi */}
            <BasketRulesLine rules={rules} />{/* // d3 multi */}
            {standing.flatMap((so) => (so.lines || []).map((l) => <Pill key={`${so.standing_order_id}:${l.inventory_item_id}`} tone="blue">{itemName(l.inventory_item_id)}: {standingPillWords(l.qty_packs)}</Pill>))}{/* // d3 multi */}
          </div> // d3 multi
        ); // d3 multi
      })}{/* // d3 multi */}
    </div> // d3 multi
  ); // d3 multi
} // d3 multi

// Cover days walk the schedule from the VENUE's "today" (v5.7.24): see purchasingRules.js.

// v5.11.89 (multi site stock Drop 1, map 4.3): nothing is paused until the read says so.
const NO_PAUSES = new Map();

// v5.11.89: siteId is the picker's site (always the signed in venue for a one site company). In a
// multi site company the pad reads which items are paused at that site today (stock_paused_items):
// a paused line is grey with its words, never suggested, and Create orders refuses it. One site
// companies make no extra call and see exactly today's pad.
export default function OrderPad({ siteId = null, orgCtx = null } = {}) { // d3 multi
  const sc = useStockScope(); // d3 multi
  const [many, setMany] = useState(false); // d3 multi
  if (sc.multi && !siteId) return (<>{/* // d3 multi */}
    <OrderPadWhichSite sites={(sc.sites || []).filter((x) => x.kind !== 'central_kitchen' && !(sc.kitchens || []).includes(x.id))} onPick={(id) => sc.setChoice({ kind: 'site', id })} onMany={sc.canEditCompany('purchasing') ? () => setMany(true) : null} />{/* // d3 multi */}
    {many && <OrderManySites orgCtx={orgCtx} onClose={() => setMany(false)} />}{/* // d3 multi */}
  </>); // d3 multi
  return <OrderPadScreen key={siteId || 'home'} siteId={siteId} />; // d3 multi
} // d3 multi
function OrderPadScreen({ siteId = null } = {}) {
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
  const [ctx, setCtx] = useState(null); // d3 multi: stock_order_pad_context (one read, multi only)
  const [ctxError, setCtxError] = useState(null); // d3 multi
  const [fScale, setFScale] = useState(1); // d3 multi: forecast over the usual days
  const [recent, setRecent] = useState([]); // d3 multi: this site's recent orders, for Repeat
  const [listName, setListName] = useState(null); // d3 multi: the Save as a list box
  const [nowMs, setNowMs] = useState(() => Date.now()); // d3 multi
  useEffect(() => { if (!multi) return undefined; const t = setInterval(() => setNowMs(Date.now()), 30000); return () => clearInterval(t); }, [multi]); // d3 multi

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
      const cx = await stockApi.orderPadContext(loc); // d3 multi
      setCtx(cx.error ? null : (cx.data || null)); setCtxError(cx.error && !cx.needsUpdate ? cx.error : null); // d3 multi
      setFScale(cx.error ? 1 : await padScale(loc, cx.data, cfg?.timezone)); // d3 multi
      setRecent(pos || []); // d3 multi
    }
    setItems(its || []); setSuppliers(sup || []); setPars(par || {}); setUsage(rate || {}); setWeekday(wk); setOnOrder(oo); setStaleOrders(stale); setLoading(false);
  }, [locId, showToast, multi]);
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  const supById = useMemo(() => { const m = {}; suppliers.forEach(s => { m[s.id] = s; }); return m; }, [suppliers]);
  const supName = useCallback((id) => supById[id]?.name || '—', [supById]);
  const ctxItems = useMemo(() => new Map((ctx?.items || []).map((x) => [x.inventory_item_id, x])), [ctx]); // d3 multi
  const multiRules = useCallback((sid) => { const sup = multi ? padSupplierOf(ctx, sid) : null; return sup && Array.isArray(sup.rules) && sup.rules.length ? { rules: sup.rules, exceptions: sup.exceptions || [] } : {}; }, [multi, ctx]); // d3 multi
  const nextOf = useCallback((sid) => padNext(padSupplierOf(ctx, sid), buildScheduleCtx(venueTz), ctx?.tz || venueTz), [ctx, venueTz]); // d3 multi
  const multiSug = useCallback((it, sp) => { if (!multi || !sp) return {}; const x = ctxItems.get(it.id); const nx = nextOf(sp.supplierId); return { forecastScale: fScale, deliveryDow: nx ? nx.deliveryDow : undefined, ...(x?.par_by_weekday ? { parByWeekday: x.par_by_weekday } : {}), ...(Number(x?.cover_days) > 0 ? { coverDaysPar: Number(x.cover_days) } : {}) }; }, [multi, ctxItems, nextOf, fScale]); // d3 multi

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
    const sched = sp ? coverFromRules({ rules: rulesFromDeliveryDays(supById[sp.supplierId]?.deliveryDays, supById[sp.supplierId]?.cutoffTime), nowVenue: buildScheduleCtx(venueTz), ...multiRules(sp.supplierId) }) : null;
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
      : suggestPacks({ onHand, onOrder: oo, avgDaily, profile: prof, todayDow, coverDays, safetyDays, par, perPack: sp ? perPack : null, ...multiSug(it, sp) });
    return { it, allSps, sp, perPack, onHand, avgDaily, prof: sug.hasShape ? prof : null, par, oo, sched, coverDays, effCover: sug.effCover, needBase: sug.needBase, suggestedPacks: sug.suggestedPacks, covered: sug.covered, paused: pz };
  }); }, [items, usage, weekday, pars, onOrder, days, safetyDays, supplierOverride, supById, venueTz, paused, multiRules, multiSug]);

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
  const HEADERS = multi ? HEADERS_MULTI_OF(supplierFilter !== 'all' ? nextOf(supplierFilter)?.deliveryDow ?? null : null) : HEADERS_ONE; // d3 multi
  const headNext = useMemo(() => { if (!multi) return null; const ids = supplierFilter !== 'all' ? [supplierFilter] : (ctx?.suppliers || []).map((x) => x.supplier_id); const all = ids.map((sid) => ({ sid, nx: nextOf(sid) })); const withNext = all.filter((x) => x.nx).sort((a, b) => String(a.nx.orderByAt).localeCompare(String(b.nx.orderByAt))); if (withNext.length) return { ...withNext[0].nx, supplierName: supName(withNext[0].sid) }; return supplierFilter !== 'all' ? { noRules: true, supplierName: supName(supplierFilter) } : null; }, [multi, supplierFilter, ctx, nextOf, supName]); // d3 multi
  const hasLimit = (ctx?.suppliers || []).some((x) => x && x.approval_limit != null); // d3 multi
  const parOf = (r) => { const x = ctxItems.get(r.it.id); const nx = r.sp ? nextOf(r.sp.supplierId) : null; const dp = parForDay(x?.par_by_weekday, nx?.deliveryDow); if (dp != null) return dp; if (Number(x?.cover_days) > 0 && r.avgDaily > 0) return r.avgDaily * fScale * Number(x.cover_days); return r.par; }; // d3 multi
  const itemName = (id) => (items.find((i) => i.id === id)?.name || 'item'); // d3 multi
  const fillFrom = (lines) => { const b = basketFromLines(lines, items); setQty((q) => ({ ...q, ...b.qty })); setSupplierOverride((o) => ({ ...o, ...b.override })); if (b.missing) showToast?.(`${b.missing} line${b.missing === 1 ? ' is' : 's are'} not on this site's pad and were left out.`, 'info'); }; // d3 multi
  const repeatLast = () => { const o = lastOrderTo(recent, supplierFilter); if (!o) { showToast?.(`No earlier order to ${supName(supplierFilter)} here.`, 'info'); return; } fillFrom(o.lines); }; // d3 multi
  const basketLines = () => Object.values(basket).flat().map(({ r, n }) => ({ inventoryItemId: r.it.id, supplierProductId: r.sp.id, qtyPacks: n })); // d3 multi
  const saveList = async () => { const name = String(listName || '').trim(); if (!name) { showToast?.('Give the list a name.', 'error'); return; } const res = await stockApi.saveOrderList({ location_id: locId, name, supplier_id: supplierFilter !== 'all' ? supplierFilter : null, lines: linesOfBasket(basketLines()) }); if (res.error) { showToast?.(res.error.message, 'error'); return; } setListName(null); showToast?.(`Saved the list ${name}.`, 'success'); await reload(); }; // d3 multi
  // flag suppliers under their minimum order value
  const minWarnings = useMemo(() => Object.entries(basket).map(([sid, ls]) => {
    const min = supById[sid]?.minOrderValue;
    const val = ls.reduce((s, { r, n }) => s + n * spNet(r.sp), 0);
    return (min > 0 && val < min) ? { name: supName(sid), val, min } : null;
  }).filter(Boolean), [basket, supById, supName]);

  // Multi site Send: make the drafts, then the database decides (approval, kitchen or email). // d3 multi
  const sendMulti = async () => { // d3 multi
    const groups = Object.entries(basket); // d3 multi
    for (const [sid, ls] of groups) { const sup = padSupplierOf(ctx, sid); const goods = ls.reduce((t, { r, n }) => t + n * spNet(r.sp), 0); if (basketRules({ goods, maxOrder: sup?.max_order_value }).overMax) { showToast?.(`Over the maximum ${moneyWords(sup.max_order_value)} for ${supName(sid)}. Split the order or ask head office.`, 'error'); return; } } // d3 multi
    const kp = ctx?.kitchen_prices || {}; // d3 multi
    const lines = groups.flatMap(([, ls]) => ls).map(({ r, n }) => ({ supplierId: r.sp.supplierId, supplierProductId: r.sp.id, inventoryItemId: r.it.id, description: r.it.name, qtyPacks: n, packQty: Number(r.sp.packQty) || 1, innerQty: Number(r.sp.innerQty) || 1, innerUnit: r.sp.innerUnit || r.it.baseUnit, unitPrice: kp[r.sp.id] != null ? Number(kp[r.sp.id]) : spNet(r.sp), purchaseTaxRateId: r.sp.purchaseTaxRateId || r.it.purchaseTaxRateId || null })); // d3 multi
    if (!lines.length) { showToast?.('Add some quantities first', 'error'); return; } // d3 multi
    setBusy(true); // d3 multi
    const tomorrow = daysAfter(buildScheduleCtx(venueTz).ymd, 1)[0]; // d3 multi
    const expectedDateBySupplier = Object.fromEntries(groups.map(([sid]) => [sid, nextOf(sid)?.deliveryYmd || nextDelivery({ rules: rulesFromDeliveryDays(supById[sid]?.deliveryDays, supById[sid]?.cutoffTime), nowVenue: buildScheduleCtx(venueTz) })?.deliveryYmd || tomorrow])); // d3 multi
    const { data, error } = await createOrdersFromBasket(lines, 'DRAFT', locId, { expectedDateBySupplier }); // d3 multi
    if (error) { setBusy(false); showToast?.(error.message, 'error'); return; } // d3 multi
    let sent = 0, approvals = 0, internal = 0; const failed = []; // d3 multi
    const poIds = data.poIds || [], supplierIds = data.supplierIds || []; // d3 multi
    for (let i = 0; i < poIds.length; i++) { // d3 multi
      const sub = await stockApi.submitOrder(poIds[i]); // d3 multi
      if (sub.error && !sub.needsUpdate) { failed.push({ supplier: supName(supplierIds[i]), reason: sub.error.message }); continue; } // d3 multi
      if (sub.data?.needs_approval) { approvals++; continue; } // d3 multi
      if (sub.data?.internal) { internal++; continue; } // d3 multi
      const { data: res, error: sendErr } = await supabase.functions.invoke('po-send', { body: { po_id: poIds[i], location_id: locId } }); // d3 multi
      if (!sendErr && res?.ok) sent++; // d3 multi
      else { failed.push({ supplier: supName(supplierIds[i]), reason: await fnErrorText(res, sendErr, 'the email could not be sent'), email: supById[supplierIds[i]]?.email || null }); await setPOStatus(poIds[i], 'SENT', locId); } // d3 multi
    } // d3 multi
    setBusy(false); // d3 multi
    if (failed.length) showToast?.(`${submitToast({ sent, approvals, internal })} ${createOrdersToast({ created: poIds.length, emailed: sent, failed, fallback: 'the email could not be sent' })}`, 'error'); // d3 multi
    else if (approvals && !sent && !internal) showToast?.(`${PAD_WORDS.sentForApprovalBold}${PAD_WORDS.sentForApproval}`, 'success'); // d3 multi
    else if (sent && !approvals && !internal) showToast?.(`${PAD_WORDS.orderSentBold}${PAD_WORDS.orderSent}`, 'success'); // d3 multi
    else showToast?.(submitToast({ sent, approvals, internal }), 'success'); // d3 multi
    setQty({}); await reload(); // d3 multi
  }; // d3 multi
  const createOrders = async () => {
    // unit_price MUST be NET (ex-VAT); the PO line carries the rate so VAT is shown on the order.
    // The line mirrors the supplier pack (pack_qty x inner_qty in the pack's unit) so the
    // supplier reads "6 x 2 l" and receiving books the right base quantity.
    // v5.11.89 (Drop 1): a line of an item paused here today is refused, naming it.
    const pausedLines = Object.values(basket).flat().filter(({ r }) => r.paused);
    if (pausedLines.length) { showToast?.(pausedLines.map(({ r }) => pausedLineWords(r.it.name, r.paused, siteName(locId))).join(' '), 'error'); return; }
    if (pauseUnknown) { showToast?.('Could not check which items are paused here. Reload to try again.', 'error'); return; }
    if (multi) return sendMulti(); // d3 multi
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
    Object.keys(basket).forEach(sid => { expectedDateBySupplier[sid] = nextDelivery({ rules: rulesFromDeliveryDays(supById[sid]?.deliveryDays, supById[sid]?.cutoffTime), nowVenue: buildScheduleCtx(venueTz) })?.deliveryYmd || daysAfter(todayYmd, 1)[0]; });
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
          title={multi ? `Order pad · ${siteName(locId)}` : 'Order pad'}
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
        {multi && <OrderPadHeaderLine next={headNext} nowMs={nowMs} />}{/* // d3 multi */}

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
        {multi && ctxError && <div role="alert" style={{ ...ui.err, marginTop: 10 }}>{ctxError.message || String(ctxError)}</div>}{/* // d3 multi */}
        {multi && <BudgetBar budget={ctx?.budget} basketTotal={basketTotal} />}{/* // d3 multi */}
        {multi && hasLimit && <div style={{ marginTop: 10 }}><Notice tone="info"><b>{PAD_WORDS.approvalsNoticeBold}</b>{PAD_WORDS.approvalsNotice}<b>{PAD_WORDS.approvalsNoticeSend}</b>{PAD_WORDS.approvalsNoticeEnd}</Notice></div>}{/* // d3 multi */}
        {multi && (ctx?.pending_approvals || []).length > 0 && <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--t2)' }}><Pill tone="warn">Waiting approval</Pill> {ctx.pending_approvals.map((x) => x.reference || 'Order').join(', ')}</div>}{/* // d3 multi */}
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
                    {!multi && ( // d3 multi
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
                    )}{/* // d3 multi */}
                    {multi && <td style={{ ...cell, ...numCell, textAlign: 'right', color: 'var(--t3)' }}>{r.avgDaily > 0 || r.prof ? `${r2(displayInUnits(r.avgDaily * fScale, uom).qty)} ${use.label}` : ''}</td>}{/* // d3 multi */}
                    {!multi && ( // d3 multi
                    <td style={{ ...cell, ...numCell, textAlign: 'right', color: 'var(--t4)', fontSize: 12 }} title={r.sched != null ? `Covers to the supplier’s second delivery (${nextDel.map(d => DAY_LABEL[d] || d).join('/')}) + ${safetyDays}d safety` : `No delivery schedule: default ${days}d + ${safetyDays}d safety`}>
                      {r.effCover}d{r.sched != null ? ' 🚚' : ''}
                    </td>
                    )}{/* // d3 multi */}
                    {multi && <td style={{ ...cell, ...numCell, textAlign: 'right', color: 'var(--t3)', fontSize: 12 }}>{(() => { const pv = parOf(r); if (pv == null) return ''; const d = displayInUnits(pv, uom); return `${r2(d.qty)} ${d.label}`; })()}</td>}{/* // d3 multi */}
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
        {multi && <MultiBasket basket={basket} ctx={ctx} supName={supName} spNet={spNet} itemName={itemName} />}{/* // d3 multi */}
        {/* --amber is only declared under [data-skin="servos"], so keep reportKit's fallback. */}
        {!multi && (<>{/* // d3 multi */}
        {minWarnings.length > 0 && <div style={{ fontSize: 12, color: 'var(--amber, #F5A623)', padding: '5px 10px', borderRadius: 9, background: 'color-mix(in srgb, var(--amber, #F5A623) 14%, transparent)' }}>⚠ below min order: {minWarnings.map(w => `${w.name} ${money(w.val)}/${money(w.min)}`).join(' · ')}</div>}
        </>)}{/* // d3 multi */}
        {!multi && ( // d3 multi
        <button onClick={createOrders} disabled={busy || basketCount === 0} style={{ marginLeft: 'auto', padding: '11px 22px', borderRadius: 12, background: basketCount ? 'var(--grn)' : 'var(--bg3)', color: basketCount ? '#0b0c10' : 'var(--t4)', border: 0, fontFamily: 'inherit', fontSize: 14, fontWeight: 700, cursor: basketCount ? 'pointer' : 'default', flexShrink: 0 }}>
          {busy ? 'Creating…' : `Create ${supplierCount || ''} order${supplierCount === 1 ? '' : 's'}`}
        </button>
        )}{/* // d3 multi */}
        {multi && <span style={{ marginLeft: 'auto' }} />}{/* // d3 multi */}
        {multi && <SavedListsMenu lists={ctx?.lists || []} onPick={(l) => fillFrom(l.lines)} onSave={() => setListName('')} onRepeat={repeatLast} canSave={basketCount > 0} canRepeat={supplierFilter !== 'all'} />}{/* // d3 multi */}
        {multi && <Btn kind="primary" onClick={createOrders} disabled={busy || basketCount === 0} style={{ padding: '11px 22px', fontSize: 14 }}>{busy ? 'Sending…' : PAD_WORDS.sendOrder}</Btn>}{/* // d3 multi */}
      </div>
      {multi && listName !== null && <Modal title={PAD_WORDS.saveAsList} onClose={() => setListName(null)} width={420} footer={<><Btn onClick={() => setListName(null)}>Cancel</Btn><Btn kind="primary" onClick={saveList}>Save list</Btn></>}><input autoFocus aria-label="List name" value={listName} onChange={(e) => setListName(e.target.value)} placeholder="Monday dry goods" style={ui.input} /></Modal>}{/* // d3 multi */}
    </div>
  );
}
