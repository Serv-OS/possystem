/**
 * _shared/purchasingRules.js — the PURE rules behind the Order pad, the Orders screen and the
 * Manager app's Raise order / Receive. No I/O (the only import is the pure unit engine next door):
 * Node's test runner loads this file
 * directly (src/lib/stock/purchasingRules.test.js) and the edge functions import it under Deno
 * (manager-approve, manager-snapshot). src/lib/stock/purchasingRules.js re-exports it for the
 * browser, the same pattern as _shared/businessDay.js and _shared/boSectionRules.js.
 *
 * v5.11.64 (15 Oct 2026, demo venue hunt). Four small faults were living inside OrderPad.jsx
 * where nothing could test them: a pack's content ignored pack_qty (a case of 6 x 2 l counted
 * as 2 l, so the pad ordered six times too many cases), delivery days written as numbers never
 * matched the day names the pad compares, no order ever got an expected date, and the raw SDK
 * text "Edge Function returned a non-2xx status code" reached the toast. Each rule now lives
 * here with a test next to it. The same day the Manager app's Raise order was found writing
 * 1 x 1 each at a price of 0 (its server never read supplier_products), so the pack rule, the
 * price rule and the order totals moved here too, where the server and the pad share one copy.
 */

import { convert } from './stockConversion.js';

const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const DAY_LABEL = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };

/**
 * One delivery day as the app spells it: 'mon'..'sun'. Accepts the day names the Suppliers
 * editor writes ('tue', 'Thursday'), ISO numbers (1 = Mon .. 7 = Sun) and JS numbers (0 = Sun).
 * Anything else → null.
 */
export function normDay(d) {
  if (d == null || d === '') return null;
  const s = String(d).trim().toLowerCase();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (n === 0 || n === 7) return 'sun';
    return n >= 1 && n <= 6 ? DOW[n] : null;
  }
  const k = s.slice(0, 3);
  return DOW.includes(k) ? k : null;
}

/** A supplier's delivery_days as clean day names, in the order given, duplicates dropped. */
export function normDeliveryDays(deliveryDays) {
  if (!Array.isArray(deliveryDays)) return [];
  const out = [];
  for (const d of deliveryDays) { const k = normDay(d); if (k && !out.includes(k)) out.push(k); }
  return out;
}

/**
 * Days to cover from a supplier's weekly delivery schedule: reach the SECOND upcoming
 * delivery, so what arrives at the next delivery lasts until the one after it.
 * todayIdx is the venue's JS day of week (0 = Sun). Null when the supplier has no schedule.
 */
export function coverDaysFromSchedule(deliveryDays, todayIdx) {
  const days = normDeliveryDays(deliveryDays);
  if (!days.length) return null;
  const set = new Set(days);
  const hits = [];
  for (let off = 1; off <= 14 && hits.length < 2; off++) {
    if (set.has(DOW[(todayIdx + off) % 7])) hits.push(off);
  }
  return hits.length >= 2 ? hits[1] : (hits[0] || null);
}

const addDays = (ymd, n) => {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
};
const dowOfYmd = (ymd) => { const [y, m, d] = String(ymd).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };

/**
 * The date an order placed today should arrive: the supplier's first delivery day from
 * tomorrow onwards (up to a week out). A supplier with no schedule delivers tomorrow.
 */
export function nextDeliveryYmd(deliveryDays, todayYmd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(todayYmd || ''))) return null;
  const set = new Set(normDeliveryDays(deliveryDays));
  if (!set.size) return addDays(todayYmd, 1);
  for (let off = 1; off <= 7; off++) {
    const ymd = addDays(todayYmd, off);
    if (set.has(DOW[dowOfYmd(ymd)])) return ymd;
  }
  return addDays(todayYmd, 1);
}

/**
 * What one supplier pack puts on the shelf, in the pack's inner unit: pack_qty x inner_qty.
 * This is the SAME convention costing (packBaseUnitCost) and receiving use. A case of
 * 6 x 2 l is 12 l, never 2 l.
 */
export function packContent(sp) {
  if (!sp) return null;
  const packQty = Number(sp.packQty) || 1;
  const inner = Number(sp.innerQty);
  if (!(inner > 0)) return null;
  return packQty * inner;
}

/**
 * Which supplier PACK do we buy this item in? ONE rule for the Order pad, the Orders screen
 * and the Manager app (v5.11.64: three screens each had their own answer, so the same item
 * sat under a different supplier on each).
 *
 * Order: the pack flagged preferred → the pack from the item's default supplier → the
 * cheapest per base unit. Never "whichever row came back first".
 *
 * @param {object} item inventory item with optional supplierProducts[] and defaultSupplierId
 * @returns {object|null} the supplier product (pack) to order, or null when there is none
 */
export function pickSupplierProduct(item) {
  const packs = (item?.supplierProducts || []).filter(p => p && p.supplierId);
  if (!packs.length) return null;
  const preferred = packs.find(p => p.isPreferred);
  if (preferred) return preferred;
  if (item.defaultSupplierId) {
    const def = packs.find(p => p.supplierId === item.defaultSupplierId);
    if (def) return def;
  }
  const cost = (p) => {
    const c = Number(p.baseUnitCost);
    return Number.isFinite(c) && c >= 0 ? c : Infinity;
  };
  return [...packs].sort((a, b) => cost(a) - cost(b))[0];
}

/**
 * What one pack puts on the shelf in the ITEM's base unit: packContent converted from the pack's
 * inner unit the way costing (packBaseUnitCost) and receiving do. A pack of 1 x 2.5 kg on an item
 * counted in grams is 2500 g, not 2.5. Returns null when the pack has no content or the units
 * cannot be joined (no conversion path), so the caller can say so rather than divide by the wrong
 * number. v5.11.65: the pad and the Manager app divided a need in base units by the content in
 * the pack unit, so a 3 kg need on that pack asked for 1200 packs.
 * @param sp               the pack { packQty, innerQty, innerUnit }
 * @param baseUnit         the item's base unit; missing = the pack's own unit (no conversion)
 * @param itemConversions  the item's cross dimension bridges, as convert() reads them
 */
export function packContentInBase(sp, baseUnit = null, itemConversions = []) {
  const per = packContent(sp);
  if (!(per > 0)) return null;
  const from = sp.innerUnit || baseUnit;
  if (!baseUnit || !from || String(from).trim().toLowerCase() === String(baseUnit).trim().toLowerCase()) return per;
  try {
    const b = convert(per, from, baseUnit, { itemConversions: itemConversions || [] });
    return b > 0 ? b : null;
  } catch { return null; }
}

/**
 * How many packs cover a quantity, rounded UP, never fewer than one.
 * 32 eggs with a pack of 1 x 180 is 1 pack; 27 avocados with a tray of 24 is 2 trays.
 * Returns 0 when the pack has no content (nothing can be ordered in it).
 * With { baseUnit, itemConversions } the quantity is read in the item's base unit and the pack
 * content is converted to match (3000 g on a 1 x 2.5 kg pack is 2 packs); without them both are
 * taken to be in the same unit, as before.
 */
export function packsForBase(baseQty, sp, { baseUnit = null, itemConversions = [] } = {}) {
  const per = packContentInBase(sp, baseUnit, itemConversions);
  if (!(per > 0)) return 0;
  const q = Number(baseQty) || 0;
  return Math.max(1, Math.ceil(q / per - 1e-9));
}

/**
 * Receiving: the order lines that cannot be booked into stock, named. A line whose stock item is
 * missing (or belongs to another venue, so the fenced read did not return it) or whose pack unit
 * will not convert to the item's base unit cannot be represented, and RECEIVED is final, so a
 * receive that cannot book every line must refuse before anything is written. One copy for
 * Back Office receiving, the Ops tablet's Accept to stock and the Manager app (v5.11.65).
 * @param lines  po_lines rows (snake_case, as the database returns them)
 * @param map    item id -> { name, baseUnit, conversions }
 * @returns { bad: string[], perPackOf: { [lineId]: baseContentPerPack } }
 */
export function unreceivableLines(lines, map) {
  const bad = [];
  const perPackOf = {};
  for (const l of lines || []) {
    const item = map?.[l.inventory_item_id];
    if (!item) { bad.push(l.description || 'unlinked line'); continue; }
    try {
      const b = convert(Number(l.pack_qty) * Number(l.inner_qty), l.inner_unit, item.baseUnit, { itemConversions: item.conversions || [] });
      if (!(b > 0)) bad.push(l.description || item.name); else perPackOf[l.id] = b;
    } catch { bad.push(l.description || item.name); }
  }
  return { bad, perPackOf };
}

/**
 * The refusal, in words that point at where the fix lives. Order lines lock once an order is
 * sent, so "fix the lines" sent a venue to the Orders screen to find nothing it could edit.
 */
export function receiveRefusalText(bad) {
  const names = (bad || []).join(', ');
  return `Cannot receive: ${names}. The stock item is missing or its pack unit cannot be converted to the item's unit. Add a unit conversion on the item's Units tab (Stock items), or cancel this order and reorder it. Order lines cannot be edited once sent.`;
}

/**
 * The NET (ex VAT) price of one pack, the cost basis every order line carries. A pack price
 * entered inc VAT is stripped by the purchase rate; the same maths as src/lib/tax.js purchaseNet.
 * @param {object} sp  pack with packPrice and priceIncludesTax
 * @param {number} rate  VAT rate as a fraction (0.2), 0 when none
 */
export function netPackPrice(sp, rate) {
  const p = Number(sp?.packPrice) || 0;
  const r = Number(rate) || 0;
  return sp?.priceIncludesTax === true && r > 0 ? p / (1 + r) : p;
}

/**
 * Order totals from its lines, exactly as savePurchaseOrder has always written them:
 * net line = qtyPacks x unitPrice (NET), line_tax = round2(net x rate), tax = round2(sum of
 * line taxes), subtotal = sum of net lines. ratesById maps a tax rate id to its fraction.
 * @returns {{ lineTaxes: number[], subtotal: number, tax: number }}
 */
export function poTotals(lines, ratesById = {}) {
  const ls = Array.isArray(lines) ? lines : [];
  const lineTaxes = ls.map((l) => {
    const net = (Number(l.qtyPacks) || 0) * (Number(l.unitPrice) || 0);
    const rate = Number((ratesById || {})[l.purchaseTaxRateId] || 0);
    return Math.round(net * rate * 100) / 100;
  });
  const subtotal = ls.reduce((s, l) => s + (Number(l.qtyPacks) || 0) * (Number(l.unitPrice) || 0), 0);
  const tax = Math.round(lineTaxes.reduce((s, t) => s + t, 0) * 100) / 100;
  return { lineTaxes, subtotal, tax };
}

/**
 * The Order pad suggestion for one item.
 *   expectedBase = usage over (coverDays + safetyDays) real calendar days, starting tomorrow,
 *                  from the weekday profile when it exists, else the flat daily average
 *   needBase     = expectedBase − onHand − onOrder (floored at 0); with no sales history at all,
 *                  top up to par instead
 *   suggestedPacks = needBase ÷ perPack, rounded UP to whole packs
 * Returns { expectedBase, needBase, suggestedPacks, covered } where covered is true when the
 * need is already met by stock on hand plus stock on order.
 */
export function suggestPacks({ onHand = 0, onOrder = 0, avgDaily = 0, profile = null, todayDow = 0, coverDays = 7, safetyDays = 0, par = null, perPack = null, forecastScale, parByWeekday, coverDaysPar, deliveryDow }) {
  const scaled = (forecastScale != null && Number(forecastScale) !== 1) || (parByWeekday && typeof parByWeekday === 'object') || coverDaysPar != null;
  if (scaled) return suggestPacksMulti({ onHand, onOrder, avgDaily, profile, todayDow, coverDays, safetyDays, par, perPack, forecastScale, parByWeekday, coverDaysPar, deliveryDow });
  const effCover = (Number(coverDays) || 0) + (Number(safetyDays) || 0);
  const hasShape = Array.isArray(profile) && profile.some(v => v > 0);
  let expectedBase = 0;
  if (hasShape) {
    for (let d = 1; d <= effCover; d++) expectedBase += Number(profile[(todayDow + d) % 7]) || 0;
  } else {
    expectedBase = (Number(avgDaily) || 0) * effCover;
  }
  const oh = Number(onHand) || 0, oo = Number(onOrder) || 0;
  const history = (Number(avgDaily) || 0) > 0 || hasShape;
  let needBase = history ? (expectedBase - oh - oo) : (par != null ? (Number(par) - oh - oo) : 0);
  const covered = history || par != null ? needBase <= 0 : false;
  if (!(needBase > 0)) needBase = 0;
  const suggestedPacks = (perPack > 0) ? Math.ceil(needBase / perPack) : 0;
  return { expectedBase, needBase, suggestedPacks, covered, effCover, hasShape };
}

/**
 * v5.11.96 (multi site stock Drop 3, contract 2.3): the multi site Order pad's suggestion. Only
 * reached when the caller passes forecastScale (not 1), parByWeekday or coverDaysPar; the one site
 * pad passes none and gets today's answer above byte for byte.
 *   forecastScale  the forecast over the usual same weekday sales (forecastUseScale): usage x scale
 *   parByWeekday   { dow: par } (0 Sunday .. 6 Saturday); the par for deliveryDow wins over par
 *   coverDaysPar   a days of cover setting: par = forecast use per day x the days (never stored)
 * The need is the forecast use over the cover, topped up to that par when a par applies.
 */
function suggestPacksMulti({ onHand, onOrder, avgDaily, profile, todayDow, coverDays, safetyDays, par, perPack, forecastScale, parByWeekday, coverDaysPar, deliveryDow }) {
  const scale = Number.isFinite(Number(forecastScale)) && Number(forecastScale) > 0 ? Number(forecastScale) : 1;
  const effCover = (Number(coverDays) || 0) + (Number(safetyDays) || 0);
  const hasShape = Array.isArray(profile) && profile.some(v => v > 0);
  let expectedBase = 0;
  if (hasShape) {
    for (let d = 1; d <= effCover; d++) expectedBase += (Number(profile[(todayDow + d) % 7]) || 0) * scale;
  } else {
    expectedBase = (Number(avgDaily) || 0) * scale * effCover;
  }
  const perDay = hasShape ? (profile.reduce((s, v) => s + (Number(v) || 0), 0) / 7) * scale : (Number(avgDaily) || 0) * scale;
  const dayPar = parByWeekday && deliveryDow != null && parByWeekday[deliveryDow] != null && parByWeekday[deliveryDow] !== '' ? Number(parByWeekday[deliveryDow]) : null;
  const coverPar = Number(coverDaysPar) > 0 && perDay > 0 ? perDay * Number(coverDaysPar) : null;
  const parUsed = Number.isFinite(dayPar) ? dayPar : (coverPar != null ? coverPar : (par != null ? Number(par) : null));
  const oh = Number(onHand) || 0, oo = Number(onOrder) || 0;
  const history = perDay > 0 || hasShape;
  const target = history ? Math.max(expectedBase, Number.isFinite(dayPar) || coverPar != null ? parUsed : 0) : parUsed;
  let needBase = target != null ? target - oh - oo : 0;
  const covered = history || parUsed != null ? needBase <= 0 : false;
  if (!(needBase > 0)) needBase = 0;
  const suggestedPacks = (perPack > 0) ? Math.ceil(needBase / perPack) : 0;
  return { expectedBase, needBase, suggestedPacks, covered, effCover, hasShape, forecastUse: perDay, parUsed };
}

/**
 * Turn whatever an edge function call left behind into one plain sentence for a toast.
 * The Supabase client reports every non-2xx answer as the fixed text "Edge Function returned
 * a non-2xx status code"; the real reason sits in the response body, which the caller passes
 * here. po-send wraps the mail provider's answer as 'email failed: {"error":"send failed: ..."}'
 * and this peels those layers off. Two answers the venue meets most are then said in plain
 * words: po-send's 'supplier_has_no_email' token, and the mail provider refusing the address
 * ("Invalid `to` field", which is what an example.com address gets).
 */
export function cleanFnError(raw, fallback = 'send failed') {
  let s = raw == null ? '' : (typeof raw === 'string' ? raw : (raw.error || raw.message || ''));
  s = String(s).trim();
  if (!s) return fallback;
  for (let i = 0; i < 4; i++) {
    s = s.replace(/^(email failed|send failed|error)\s*:\s*/i, '').trim();
    if (s.startsWith('{')) {
      try { const j = JSON.parse(s); s = String(j.error || j.message || j.detail || s).trim(); continue; } catch { break; }
    }
    if (!/^(email failed|send failed|error)\s*:/i.test(s)) break;
  }
  s = s.replace(/`/g, '');
  if (/non-2xx status code/i.test(s)) return fallback;
  if (s === 'supplier_has_no_email') return 'this supplier has no email address on file (add one in Suppliers)';
  if (/invalid\s*to\s*field/i.test(s)) return "the mail service refused the supplier's email address (check it in Suppliers)";
  return s || fallback;
}

/** Plain English for the Order pad toast after the orders were created. */
export function createOrdersToast({ created = 0, emailed = 0, failed = [], fallback = 'send failed' }) {
  const n = created;
  const orders = `${n} order${n === 1 ? '' : 's'} created`;
  if (!failed.length) {
    return `${orders} and emailed to ${emailed === 1 ? 'the supplier' : 'the suppliers'}. See Orders for delivery.`;
  }
  // Name the address that was refused when the caller knows it, so the venue sees what to fix.
  const who = failed.map(f => f.supplier ? (f.email ? `${f.supplier} (${f.email})` : f.supplier) : null).filter(Boolean);
  const reason = cleanFnError(failed[failed.length - 1]?.reason, fallback).replace(/\.\s*$/, '');
  const names = who.length ? who.join(' and ') : `${failed.length} supplier${failed.length === 1 ? '' : 's'}`;
  return `${orders}. Email to ${names} did not send: ${reason}. The order is saved; open it in Orders and press Resend to supplier.`;
}

// ── Delivery note scanning ────────────────────────────────────────────────────

/** A product code as printed, made comparable: trimmed, upper case, no spaces, dashes, dots. */
export function normCode(s) {
  return String(s || '').trim().toUpperCase().replace(/[\s\-_.]/g, '');
}

/**
 * Match one line read off a delivery note or invoice to the order lines (or stock items) it
 * could be. Order of trust: the supplier's own product code, then our item SKU, then an exact
 * name, then one name containing the other, then shared words (the old Invoices.jsx scoring).
 * @param {object} read        { code?, sku?, description? } as the scanner returned it
 * @param {Array}  candidates  [{ key, name, supplierSku?, itemSku? }]
 * @returns {{ match: object|null, how: 'supplier_sku'|'item_sku'|'name'|null }}
 */
export function matchScannedLine(read, candidates) {
  const cands = Array.isArray(candidates) ? candidates : [];
  const code = normCode(read?.code || read?.sku);
  if (code) {
    const bySup = cands.find(c => normCode(c.supplierSku) === code);
    if (bySup) return { match: bySup, how: 'supplier_sku' };
    const byItem = cands.find(c => normCode(c.itemSku) === code);
    if (byItem) return { match: byItem, how: 'item_sku' };
  }
  const d = String(read?.description || '').toLowerCase().trim();
  if (!d) return { match: null, how: null };
  let best = null, bestScore = 0;
  for (const c of cands) {
    const n = String(c.name || '').toLowerCase().trim();
    if (!n) continue;
    let score = 0;
    if (n === d) score = 100;
    else if (d.includes(n) || n.includes(d)) score = 50 + Math.min(n.length, d.length);
    else score = n.split(/\s+/).filter(w => w.length > 2 && d.includes(w)).length * 10;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return bestScore >= 10 ? { match: best, how: 'name' } : { match: null, how: null };
}

// ── v5.11.79 (multi site stock plan, Phase 0): receiving in one database step ─────────────────────

const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const trimNum = (n) => String(Math.round((Number(n) || 0) * 1000) / 1000);

/**
 * The supplier pack a line was bought in, in words: "6 x 1 l", "12 x 330 ml", "1 kg". Kept on
 * the cost history row with the price paid for one such pack, so a price paid report can say
 * what was paid per pack, per site.
 * @param {{ pack_qty?, inner_qty?, inner_unit?, packQty?, innerQty?, innerUnit? }} l
 */
export function packLabel(l) {
  if (!l) return null;
  const packQty = Number(l.pack_qty ?? l.packQty) || 1;
  const inner = Number(l.inner_qty ?? l.innerQty);
  const unit = String(l.inner_unit ?? l.innerUnit ?? '').trim();
  if (!(inner > 0) || !unit) return null;
  return packQty > 1 ? `${trimNum(packQty)} x ${trimNum(inner)} ${unit}` : `${trimNum(inner)} ${unit}`;
}

/**
 * What one receive of an order sends to the database's stock_receive, in one call: every line
 * that brings stock in, keyed `po:<order>:<line>` exactly as before (so a receive from Back Office,
 * the Ops tablet and the Manager app can never post one line twice), with the base quantity, the
 * NET cost per base unit (0 when the line is not priced: the stock moves in at the known cost and
 * the cost is left alone), and the pack and the price paid per pack for the cost history.
 *
 * @param {string} poId
 * @param {Array} lines     po_lines rows
 * @param {object} opts
 *   byLine:    { [lineId]: { qtyPacks, unitPrice } } for a line by line accept, or null for a
 *              full receive (everything outstanding at the order price)
 *   perPackOf: { [lineId]: base units in one pack } (unreceivableLines)
 * @returns {Array<{ key, item_id, qty_base, unit_cost, supplier_product_id, pack_price, pack_label, line_id, accepted, price }>}
 */
export function poReceiptLines(poId, lines, { byLine = null, perPackOf = {} } = {}) {
  const out = [];
  for (const l of lines || []) {
    if (!l || !l.inventory_item_id) continue;
    const perPack = Number(perPackOf?.[l.id]);
    if (!(perPack > 0)) continue;
    const r = byLine ? byLine[String(l.id)] : null;
    const ordered = Number(l.qty_packs) || 0;
    const accepted = byLine ? Math.max(0, Number(r?.qtyPacks ?? 0) || 0) : Math.max(0, ordered - (Number(l.qty_received) || 0));
    if (!(accepted > 0)) continue;
    const price = byLine && r?.unitPrice != null && r.unitPrice !== '' ? Number(r.unitPrice) : (Number(l.unit_price) || 0);
    out.push({
      key: `po:${poId}:${l.id}`,
      item_id: l.inventory_item_id,
      qty_base: r4(accepted * perPack),
      unit_cost: price > 0 ? price / perPack : 0,
      supplier_product_id: l.supplier_product_id || null,
      pack_price: price > 0 ? price : null,
      pack_label: packLabel(l),
      line_id: l.id,
      accepted,
      price,
    });
  }
  return out;
}

const normInvNo = (s) => String(s ?? '').trim().toLowerCase();

/**
 * A posted invoice with the same number from the same supplier at this venue, or null. The
 * database refuses the second one too (20261019b unique rule); this lets the screen say so before
 * the scan is uploaded. `history`: posted invoices [{ id, supplierId, invoiceNumber, invoiceDate }].
 */
export function findDuplicateInvoice(history, { supplierId = null, invoiceNumber = '' } = {}) {
  const n = normInvNo(invoiceNumber);
  if (!n) return null;
  return (history || []).find((inv) => inv && normInvNo(inv.invoiceNumber) === n
    && String(inv.supplierId || '') === String(supplierId || '')) || null;
}

/** The words for a refused duplicate invoice number. */
export function duplicateInvoiceText(invoiceNumber, supplierName = '') {
  return `Invoice ${String(invoiceNumber || '').trim()}${supplierName ? ` from ${supplierName}` : ''} is posted already at this venue. Nothing was posted again.`;
}

/**
 * Orders from this supplier received in the last `days` that brought in any of the items on an
 * invoice: the delivery the invoice is probably for. Posting the invoice as a separate delivery
 * would count that stock twice, so the screen asks first and offers "Link it to that order".
 * orders: [{ id, reference, supplierId, status, receivedAt, lines: [{ inventoryItemId, qtyReceived }] }]
 * @returns {Array<{ id, reference, receivedAt, overlap }>} newest first
 */
export function receivedOrdersOverlapping(orders, { supplierId = null, itemIds = [], nowMs = Date.now(), days = 14 } = {}) {
  if (!supplierId) return [];
  const want = new Set((itemIds || []).filter(Boolean).map(String));
  if (!want.size) return [];
  const since = nowMs - days * 86400000;
  return (orders || [])
    .filter((po) => po && po.status === 'RECEIVED' && String(po.supplierId || '') === String(supplierId)
      && po.receivedAt && new Date(po.receivedAt).getTime() >= since)
    .map((po) => ({
      id: po.id, reference: po.reference || null, receivedAt: po.receivedAt,
      overlap: new Set((po.lines || []).filter((l) => (Number(l.qtyReceived) || 0) > 0 && want.has(String(l.inventoryItemId))).map((l) => String(l.inventoryItemId))).size,
    }))
    .filter((x) => x.overlap > 0)
    .sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
}

// ── v5.11.96 (multi site stock Drop 3, contract 2.3): delivery days, order by times, basket rules ──
//
// One rule for every company (Peter, 22 Oct 2026): an order placed after the order by time asks for
// the NEXT delivery, and a supplier with no cut off is ordered by midnight at the end of the day
// before the delivery. A one site company's rules come from its two supplier columns
// (rulesFromDeliveryDays, the Drop 1 seed rule, no extra read); a multi site company reads its
// stock_order_rules rows. The database's stock_co__next_delivery is the SQL twin of nextDelivery.
//
// Days are Postgres day numbers (0 Sunday .. 6 Saturday), the same as stock_order_rules.

const SHORT_DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SHORT_MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const STRICT_HM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** 'HH:MM' from 'HH:MM', 'H:MM' or the 'HH:MM:SS' a Postgres time column reads back as; else null. */
function hmOf(t) {
  if (t === null || t === undefined) return null;
  const m = String(t).trim().match(/^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}
const dowNum = (d) => {
  if (d === null || d === undefined || d === '') return null;
  const n = Number(d);
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : null;
};
const daysBetween = (a, b) => {
  const [y1, m1, d1] = String(a).split('-').map(Number);
  const [y2, m2, d2] = String(b).split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
};
const minutesOfHm = (hm) => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; };
const hmOfMinutes = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

/** The venue's now as { ymd, hm } from { ymd, hm } or buildScheduleCtx's { ymd, nowMinutes }. */
function nowOf(nowVenue) {
  const ymd = nowVenue?.ymd;
  if (!YMD.test(String(ymd || ''))) return null;
  let hm = hmOf(nowVenue.hm);
  if (!hm && Number.isFinite(Number(nowVenue.nowMinutes))) {
    const n = Math.max(0, Math.min(1439, Math.floor(Number(nowVenue.nowMinutes))));
    hm = hmOfMinutes(n);
  }
  return { ymd, hm: hm || '00:00' };
}

/**
 * The minutes a time zone is ahead of UTC at one instant (60 for London in summer). Pure: Intl only,
 * which Node, Deno and every browser have. Falls back to 0 for an unknown zone.
 */
export function tzOffsetMinutes(tz, utcMs) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(utcMs));
    const g = (t) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'));
    return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
  } catch { return 0; }
}

/**
 * The real instant of a venue wall clock time ('YYYY-MM-DD', 'HH:MM', zone). A time the clocks skip
 * (01:30 on the spring change) lands an hour later; a time that happens twice (the autumn change)
 * is the first one, as Postgres reads `timestamp at time zone`.
 */
export function venueTimeToMs(ymd, hm, tz) {
  const [y, mo, d] = String(ymd).split('-').map(Number);
  const [h, mi] = String(hm).split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  if (!tz) return wall;
  const before = tzOffsetMinutes(tz, wall - 12 * 3600000);
  const after = tzOffsetMinutes(tz, wall + 12 * 3600000);
  const fits = [...new Set([before, after])]
    .map((off) => wall - off * 60000)
    .filter((utc) => utc + tzOffsetMinutes(tz, utc) * 60000 === wall);
  return fits.length ? Math.min(...fits) : wall - before * 60000;
}

/**
 * A one site company's order rules from its supplier's two columns: exactly the Drop 1 seed
 * (stock_co__seed_order_rules): one rule per delivery day, ordered by the day before at the cut
 * off; no cut off (or not 'HH:MM') gives order_by_dow and order_by_time null. Sorted by day.
 */
export function rulesFromDeliveryDays(deliveryDays, cutoffTime) {
  const cut = typeof cutoffTime === 'string' && STRICT_HM.test(cutoffTime) ? cutoffTime : null;
  const dows = [...new Set(normDeliveryDays(deliveryDays).map((k) => DOW.indexOf(k)))].sort((a, b) => a - b);
  return dows.map((d) => ({ delivery_dow: d, order_by_dow: cut ? (d + 6) % 7 : null, order_by_time: cut }));
}

/** Every delivery candidate the walk finds, sorted by delivery day then order by (internal). */
function deliveryCandidates({ rules, exceptions = [], nowVenue, days = 21 }) {
  const now = nowOf(nowVenue);
  const list = Array.isArray(rules) ? rules : [];
  if (!now || !list.length) return null;
  const byDow = new Map();
  for (const r of list) {
    const d = dowNum(r?.delivery_dow);
    if (d === null || byDow.has(d)) continue;
    byDow.set(d, { obDow: dowNum(r?.order_by_dow), obHm: hmOf(r?.order_by_time) });
  }
  if (!byDow.size) return null;
  const exs = (Array.isArray(exceptions) ? exceptions : [])
    .filter((e) => e && YMD.test(String(e.from_day || '')) && YMD.test(String(e.to_day || '')))
    .sort((a, b) => (a.from_day < b.from_day ? -1 : a.from_day > b.from_day ? 1 : String(a.name || '').localeCompare(String(b.name || ''))));
  const nowAt = `${now.ymd}T${now.hm}`;
  const found = [];
  const skipped = [];
  for (let k = 0; k < days; k++) {
    const day = addDays(now.ymd, k);
    const rule = byDow.get(dowOfYmd(day));
    if (!rule) continue;
    // the order by of this delivery: the order by weekday on or before it, at its time; no time
    // means midnight at the end of the day before (stored as the day before at '24:00')
    let obYmd;
    let obHm;
    if (rule.obDow !== null && rule.obHm) {
      obYmd = addDays(day, -((dowOfYmd(day) - rule.obDow + 7) % 7));
      obHm = rule.obHm;
    } else {
      obYmd = addDays(day, -1);
      obHm = '24:00';
    }
    const covering = exs.filter((e) => e.from_day <= day && day <= e.to_day);
    if (covering.some((e) => e.kind === 'no_delivery')) {
      skipped.push({ ymd: day, name: covering.find((e) => e.kind === 'no_delivery').name || '' });
      continue;
    }
    let deliveryYmd = day;
    const moved = covering.find((e) => e.kind === 'deliver_instead' && YMD.test(String(e.deliver_on || '')));
    if (moved) {
      const shift = daysBetween(day, moved.deliver_on);
      deliveryYmd = moved.deliver_on;
      obYmd = addDays(obYmd, shift);
    }
    const orderByAt = obHm === '24:00' ? `${addDays(obYmd, 1)}T00:00` : `${obYmd}T${obHm}`;
    if (orderByAt <= nowAt) continue; // passed: an order now asks for the following delivery
    found.push({ deliveryYmd, orderByYmd: obYmd, orderByHm: obHm, orderByAt, naturalYmd: day });
  }
  found.sort((a, b) => (a.deliveryYmd < b.deliveryYmd ? -1 : a.deliveryYmd > b.deliveryYmd ? 1 : a.orderByAt < b.orderByAt ? -1 : a.orderByAt > b.orderByAt ? 1 : 0));
  return { now, nowAt, found, skipped };
}

/**
 * The next delivery an order placed now can catch (contract 2.3).
 * @param rules       [{ delivery_dow, order_by_dow, order_by_time }] (stock_order_rules or rulesFromDeliveryDays)
 * @param exceptions  [{ from_day, to_day, kind: 'no_delivery'|'deliver_instead', deliver_on, name }]
 * @param nowVenue    { ymd, hm } or buildScheduleCtx's { ymd, nowMinutes }, the venue's clock
 * @param tz          optional venue time zone: minutesLeft is then real minutes across a clock change
 *                    and the answer carries orderByMs (the instant) for a live countdown
 * @returns {{ deliveryYmd, deliveryDow, orderByYmd, orderByHm, orderByAt, minutesLeft, skipped }|null}
 *   orderByAt is 'YYYY-MM-DDTHH:MM' venue local. A supplier with no cut off has orderByYmd the day
 *   before the delivery, orderByHm '24:00' and orderByAt the delivery day at '00:00'. The walk looks
 *   at 21 venue days from today; the earliest delivery day not passed wins (ties: the earlier order
 *   by). A 'no_delivery' exception skips a day (listed in skipped when before the delivery chosen);
 *   'deliver_instead' moves the day to deliver_on and its order by the same number of days. null
 *   with no rules or nothing in the 21 days.
 */
export function nextDelivery({ rules, exceptions = [], nowVenue, tz = null } = {}) {
  const c = deliveryCandidates({ rules, exceptions, nowVenue });
  if (!c || !c.found.length) return null;
  const n = c.found[0];
  const wallLeft = daysBetween(c.now.ymd, n.orderByAt.slice(0, 10)) * 1440 + minutesOfHm(n.orderByAt.slice(11)) - minutesOfHm(c.now.hm);
  const out = {
    deliveryYmd: n.deliveryYmd,
    deliveryDow: dowOfYmd(n.deliveryYmd),
    orderByYmd: n.orderByYmd,
    orderByHm: n.orderByHm,
    orderByAt: n.orderByAt,
    minutesLeft: wallLeft,
    skipped: c.skipped.filter((s) => s.ymd < n.deliveryYmd),
  };
  if (tz) {
    const at = venueTimeToMs(n.orderByAt.slice(0, 10), n.orderByAt.slice(11), tz);
    const nowMs = venueTimeToMs(c.now.ymd, c.now.hm, tz);
    out.minutesLeft = Math.round((at - nowMs) / 60000);
    out.orderByMs = at;
  }
  return out;
}

/**
 * Days of cover for the Order pad (today's coverDaysFromSchedule meaning, on the new rule): from the
 * venue's today to the delivery AFTER the next one, so what arrives next lasts until the one after.
 * Only one delivery in the walk: the days to it. null without rules (the pad's default cover).
 */
export function coverFromRules({ rules, exceptions = [], nowVenue } = {}) {
  const c = deliveryCandidates({ rules, exceptions, nowVenue, days: 28 });
  if (!c || !c.found.length) return null;
  const first = c.found[0].deliveryYmd;
  const after = c.found.find((f) => f.deliveryYmd > first);
  return daysBetween(c.now.ymd, (after || c.found[0]).deliveryYmd);
}

/** 'Wed 22 Oct' from 'YYYY-MM-DD' (en-GB words, no locale lookup). */
export function dayWords(ymd) {
  if (!YMD.test(String(ymd || ''))) return '';
  const [, m, d] = String(ymd).split('-').map(Number);
  return `${SHORT_DAY[dowOfYmd(ymd)]} ${d} ${SHORT_MONTH[m - 1]}`;
}

/** '3 h 20 m', '45 m', '2 d 3 h' for a number of minutes (0 or less: null). */
export function timeLeftWords(minutes) {
  const n = Math.floor(Number(minutes));
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 60) return `${n} m`;
  if (n < 1440) { const h = Math.floor(n / 60); const m = n % 60; return m ? `${h} h ${m} m` : `${h} h`; }
  const d = Math.floor(n / 1440); const h = Math.floor((n % 1440) / 60);
  return h ? `${d} d ${h} h` : `${d} d`;
}

/**
 * The Order pad's line: 'Next delivery Wed 22 Oct · order by Tue 14:00 (in 3 h 20 m)', '(in 45 m)'
 * or '(passed)'. A supplier with no cut off: 'order by the end of Mon'. nowMs counts down live when
 * the answer has orderByMs (nextDelivery with tz); else the minutes worked out with it. '' for null.
 */
export function orderByWords(next, nowMs = null) {
  if (!next || !next.deliveryYmd) return '';
  let left = next.minutesLeft;
  if (Number.isFinite(Number(next.orderByMs)) && Number.isFinite(Number(nowMs))) left = Math.floor((Number(next.orderByMs) - Number(nowMs)) / 60000);
  const by = next.orderByHm === '24:00'
    ? `order by the end of ${SHORT_DAY[dowOfYmd(next.orderByYmd)]}`
    : `order by ${SHORT_DAY[dowOfYmd(next.orderByYmd)]} ${next.orderByHm}`;
  const t = timeLeftWords(left);
  return `Next delivery ${dayWords(next.deliveryYmd)} · ${by} (${t ? `in ${t}` : 'passed'})`;
}

/** '£150', '£12.50', '£2,140' (whole amounts without pence). */
export function moneyWords(n, symbol = '£') {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const whole = Math.abs(v - Math.round(v)) < 0.005;
  const s = Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 });
  return `${v < 0 ? '-' : ''}${symbol}${s}`;
}

/**
 * One supplier's basket against its order rules (contract 2.3, words of 4.2). goods is the basket
 * ex VAT for that supplier at this site.
 *   minShort        what is missing to reach the minimum (0 when met or no minimum)
 *   overMax         over the maximum: Send is refused
 *   feeCharged      the delivery fee for this order (0 when none, or waived at or over the minimum)
 *   needsApproval   goods plus the fee over the site's approval limit (null limit: never)
 *   words           [{ tone, text }] for under the supplier's total
 *   approval        { tone, text } for the basket row
 */
export function basketRules({ goods = 0, minOrder = null, maxOrder = null, fee = null, feeWaivedOverMin = false, approvalLimit = null, symbol = '£' } = {}) {
  const g = Math.round((Number(goods) || 0) * 100) / 100;
  const min = Number(minOrder) > 0 ? Number(minOrder) : null;
  const max = Number(maxOrder) > 0 ? Number(maxOrder) : null;
  const f = Number(fee) > 0 ? Number(fee) : 0;
  const minShort = min != null && g < min ? Math.round((min - g) * 100) / 100 : 0;
  const overMax = max != null && g > max;
  const waived = f > 0 && feeWaivedOverMin === true && min != null && g >= min;
  const feeCharged = f > 0 && !waived ? f : 0;
  const limit = approvalLimit === null || approvalLimit === undefined || approvalLimit === '' || !Number.isFinite(Number(approvalLimit)) ? null : Number(approvalLimit);
  const needsApproval = limit != null && g + feeCharged > limit;
  const words = [];
  if (minShort > 0) words.push({ tone: 'amber', text: `Minimum order ${moneyWords(min, symbol)}: add ${moneyWords(minShort, symbol)} more` });
  if (overMax) words.push({ tone: 'red', text: `Over the maximum ${moneyWords(max, symbol)}` });
  if (feeCharged > 0) words.push({ tone: 'plain', text: `Delivery fee ${moneyWords(feeCharged, symbol)}` });
  if (waived) words.push({ tone: 'plain', text: 'No delivery fee over the minimum' });
  const approval = limit == null
    ? { tone: 'plain', text: 'No approval limit at this site' }
    : needsApproval
      ? { tone: 'amber', text: `Needs approval: over ${moneyWords(limit, symbol)}` }
      : { tone: 'plain', text: `Approval needed over ${moneyWords(limit, symbol)}` };
  return { minShort, overMax, feeCharged, needsApproval, words, approval };
}

// ── v5.11.96 (Drop 3): the multi site Order pad's context helpers (stock_order_pad_context) ─────

/** The context's row for one site supplier, or null. */
export function padSupplierOf(ctx, supplierId) {
  return (ctx?.suppliers || []).find((s) => s && String(s.supplier_id) === String(supplierId)) || null;
}

/** The database's next delivery ({ delivery_day, order_by_at, order_by_ymd, order_by_hm, minutes_left }) in nextDelivery's shape. */
export function fromDbNext(n) {
  if (!n || !n.delivery_day) return null;
  const ms = n.order_by_at ? Date.parse(n.order_by_at) : NaN;
  // The database says midnight as 00:00 on the next day; the screens say it as 24:00 on the day before
  // (Peter: no cut off orders by midnight the day before). Same moment, one wording.
  const midnight = n.order_by_ymd && n.order_by_hm === '00:00';
  return {
    deliveryYmd: String(n.delivery_day).slice(0, 10),
    deliveryDow: dowOfYmd(String(n.delivery_day).slice(0, 10)),
    orderByYmd: midnight ? addDays(n.order_by_ymd, -1) : (n.order_by_ymd || null),
    orderByHm: midnight ? '24:00' : (n.order_by_hm || null),
    orderByAt: n.order_by_ymd && n.order_by_hm ? (n.order_by_hm === '24:00' ? `${addDays(n.order_by_ymd, 1)}T00:00` : `${n.order_by_ymd}T${n.order_by_hm}`) : null,
    minutesLeft: Number.isFinite(Number(n.minutes_left)) ? Number(n.minutes_left) : null,
    skipped: Array.isArray(n.skipped) ? n.skipped.map((s) => ({ ymd: s.day, name: s.name || '' })) : [],
    ...(Number.isFinite(ms) ? { orderByMs: ms } : {}),
  };
}

/**
 * One site supplier's next delivery for the pad: worked out from its rules and exceptions on the
 * venue clock (the same rule the order is dated by), else the database's answer, else null.
 */
export function padNext(sup, nowVenue, tz = null) {
  if (!sup) return null;
  const mine = Array.isArray(sup.rules) && sup.rules.length ? nextDelivery({ rules: sup.rules, exceptions: sup.exceptions || [], nowVenue, tz }) : null;
  return mine || fromDbNext(sup.next);
}

/** The par for one weekday from a par_by_weekday object (keys 0..6 as numbers or text); null when none. */
export function parForDay(parByWeekday, dow) {
  if (!parByWeekday || typeof parByWeekday !== 'object' || dow === null || dow === undefined) return null;
  const v = parByWeekday[dow] ?? parByWeekday[String(dow)];
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * A saved list or a repeated order into the pad's basket: { qty: { itemId: packs }, override:
 * { itemId: supplierProductId }, missing: n }. items are the pad's site items (with supplierProducts);
 * a line whose item is not on the pad is counted in missing; a pack that is not one of the item's
 * supplier products is left to the pad's own pick.
 */
export function basketFromLines(lines, items) {
  const byId = new Map((items || []).filter(Boolean).map((i) => [String(i.id), i]));
  const qty = {};
  const override = {};
  let missing = 0;
  for (const l of Array.isArray(lines) ? lines : []) {
    const id = String(l?.inventory_item_id ?? l?.inventoryItemId ?? '');
    const n = Number(l?.qty_packs ?? l?.qtyPacks);
    const it = byId.get(id);
    if (!it || !(n > 0)) { if (id) missing++; continue; }
    qty[id] = (qty[id] || 0) + n;
    const sp = String(l?.supplier_product_id ?? l?.supplierProductId ?? '');
    if (sp && (it.supplierProducts || []).some((p) => String(p.id) === sp)) override[id] = sp;
  }
  return { qty, override, missing };
}

/** The pad's basket as a saved list's lines (at most 300). */
export function linesOfBasket(basketLines) {
  return (basketLines || []).filter((l) => l && l.inventoryItemId && Number(l.qtyPacks) > 0).slice(0, 300)
    .map((l) => ({ inventory_item_id: l.inventoryItemId, supplier_product_id: l.supplierProductId || null, qty_packs: Number(l.qtyPacks) }));
}

/** The last order to a supplier that was not cancelled (newest first by created or ordered time). */
export function lastOrderTo(orders, supplierId) {
  const list = (orders || []).filter((o) => o && String(o.supplierId) === String(supplierId) && o.status !== 'CANCELLED' && (o.lines || []).length);
  list.sort((a, b) => String(b.orderedAt || b.createdAt || '').localeCompare(String(a.orderedAt || a.createdAt || '')));
  return list[0] || null;
}

/**
 * Head office's many sites order (G14) as stock_create_orders_many's p_orders. picks: [{ detail
 * (stock_item_detail answer), qtyBySite: { siteId: packs } }]; contexts: { siteId: order pad context }.
 * Each site's line uses the item's supplier here at that site (else its first supplier item sold
 * there that is not off or paused); the order goes to that supplier's site row. Answer { orders:
 * [{ location_id, supplier_id, lines }], problems: [words] } with one order per site and supplier.
 */
export function manyOrdersPlan(picks, contexts, siteName = (id) => id) {
  const orders = new Map();
  const problems = [];
  for (const p of picks || []) {
    const d = p?.detail || {};
    const name = d.item?.name || d.name || 'This item';
    for (const [siteId, raw] of Object.entries(p?.qtyBySite || {})) {
      const qty = Number(raw);
      if (!(qty > 0)) continue;
      const site = (d.sites || []).find((s) => String(s.location_id) === String(siteId));
      if (!site?.site_item_id) { problems.push(`${name} is not at ${siteName(siteId)}.`); continue; }
      const sis = (d.supplier_items || []).filter((si) => (si.sites || []).some((x) => String(x.location_id) === String(siteId) && x.site_supplier_product_id && !x.off_here && !x.paused));
      const here = site.supplier_here?.supplier_item_id ? sis.find((si) => si.id === site.supplier_here.supplier_item_id) : null;
      const si = here || sis[0] || null;
      const sp = si ? (si.sites || []).find((x) => String(x.location_id) === String(siteId))?.site_supplier_product_id : null;
      if (!si || !sp) { problems.push(`${name} has no supplier at ${siteName(siteId)}.`); continue; }
      const sup = (contexts?.[siteId]?.suppliers || []).find((s) => String(s.company_supplier_id) === String(si.supplier_id));
      if (!sup?.supplier_id) { problems.push(`${si.supplier_name || 'The supplier'} is not ticked at ${siteName(siteId)}.`); continue; }
      const key = `${siteId}:${sup.supplier_id}`;
      if (!orders.has(key)) orders.set(key, { location_id: siteId, supplier_id: sup.supplier_id, lines: [] });
      orders.get(key).lines.push({ inventory_item_id: site.site_item_id, supplier_product_id: sp, qty_packs: qty });
    }
  }
  return { orders: [...orders.values()], problems };
}

/**
 * The forecast scale for the pad over the next days: the forecast (saved, else suggested) over the
 * usual same weekday sales, summed over the days (forecastUseScale's 0.25 to 4 rule, 1 when either
 * sum is 0). forecastByDay: { ymd: amount }; baselineByDay: { ymd: amount }.
 */
export function scaleOverDays(days, forecastByDay, baselineByDay) {
  let f = 0;
  let b = 0;
  for (const d of days || []) {
    const fv = Number(forecastByDay?.[d]);
    const bv = Number(baselineByDay?.[d]);
    if (fv > 0 && bv > 0) { f += fv; b += bv; }
  }
  if (!(f > 0) || !(b > 0)) return 1;
  return Math.min(4, Math.max(0.25, f / b));
}

/** The venue days after today: ['YYYY-MM-DD', ...] (n days, starting tomorrow). */
export function daysAfter(ymd, n = 7) {
  if (!YMD.test(String(ymd || ''))) return [];
  return Array.from({ length: Math.max(0, n) }, (_, i) => addDays(ymd, i + 1));
}

/**
 * The By day boxes (one per weekday, typed text) as par_by_weekday: { value: { dow: par } | null }
 * (only the days with a number; null when none) or { error } when a box is not a number 0 or more.
 */
export function parsFromTyped(typed) {
  const out = {};
  for (const [d, v] of Object.entries(typed || {})) {
    const t = String(v ?? '').trim();
    if (t === '') continue;
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) return { error: 'Each par is a number, 0 or more.' };
    out[d] = n;
  }
  return { value: Object.keys(out).length ? out : null };
}
