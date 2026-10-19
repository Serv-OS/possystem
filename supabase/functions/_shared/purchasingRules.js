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
export function suggestPacks({ onHand = 0, onOrder = 0, avgDaily = 0, profile = null, todayDow = 0, coverDays = 7, safetyDays = 0, par = null, perPack = null }) {
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
 * database refuses the second one too (20261019a unique rule); this lets the screen say so before
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
