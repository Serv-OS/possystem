// src/lib/stock/kitchenRules.js
//
// MULTI SITE STOCK Drop 3 (contract 3.4, map 4.7, mockup scrKitchen): the plain maths and words of the
// central kitchen screens and the phone's kitchen sheets. PURE: no network, no React, no clock unless
// one is passed in, so node --test drives every branch (kitchenRules.test.js).
//   * the production plan: Make = ordered by sites + catering + standing forecast, less what the
//     kitchen holds (never below 0); Done ticks add up; what is left to make;
//   * pick and send: packs to base units, what was short per line, the lines sent to stock_kitchen_pick;
//   * the delivery note model (site, lines with sent, short, lot and use by) for the print dialog;
//   * the ingredients basket for "Order these" (createOrdersFromBasket's line shape).
// Nothing here moves a stock number: the database does that when a person presses Send.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
/** A quantity to 3 places (0.1 + 0.2 is 0.3, never 0.30000000000000004). */
export const q3 = (v) => Math.round(num(v) * 1000) / 1000;
const money2 = (v) => Math.round(num(v) * 100) / 100;

/** 'YYYY-MM-DD' parts, or null. */
function ymdParts(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ''));
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, mo, d };
}

/** 'Tuesday 21 October' for a venue day (the mockup's plan line). '' for a bad day. */
export function dayWords(ymd) {
  const p = ymdParts(ymd);
  if (!p) return '';
  const dow = new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay();
  return `${DAYS_LONG[dow]} ${p.d} ${MONTHS_LONG[p.mo - 1]}`;
}

/** '21 Oct' for a day or a timestamp's date part. '' for nothing. */
export function shortDay(v) {
  const p = ymdParts(v);
  return p ? `${p.d} ${MONTHS[p.mo - 1]}` : '';
}

/** The venue day plus or minus some days ('YYYY-MM-DD'), for the day select. */
export function addDaysYmd(ymd, days) {
  const p = ymdParts(ymd);
  if (!p) return '';
  const t = new Date(Date.UTC(p.y, p.mo - 1, p.d + Math.trunc(num(days))));
  return t.toISOString().slice(0, 10);
}

/** Make for one plan row: ordered + catering + standing, less holds, never below 0. */
export function makeOf({ ordered = 0, catering = 0, standing = 0, holds = 0 } = {}) {
  return Math.max(0, q3(num(ordered) + num(catering) + num(standing) - num(holds)));
}

/** What the Done ticks add up to. */
export function doneOf(ticks) {
  return q3((Array.isArray(ticks) ? ticks : []).reduce((s, t) => s + Math.max(0, num(t?.qty)), 0));
}

/** What is still to make after the ticks (never below 0). */
export function leftToMake(row) {
  const make = row?.make != null ? num(row.make) : makeOf(row || {});
  const done = row?.done != null ? num(row.done) : doneOf(row?.ticks);
  return Math.max(0, q3(make - done));
}

/** A plan row as the screen draws it: the server's figures, with make and done worked out again
 *  from the parts when the server left them out (an older answer). */
export function planRow(row) {
  const r = row || {};
  const make = r.make != null ? q3(r.make) : makeOf(r);
  const done = r.done != null ? q3(r.done) : doneOf(r.ticks);
  return {
    recipeId: r.recipe_id || null,
    name: String(r.name || 'Recipe'),
    unit: String(r.unit || ''),
    ordered: q3(r.ordered), catering: q3(r.catering), standing: q3(r.standing), holds: q3(r.holds),
    make, done, left: Math.max(0, q3(make - done)),
    bySite: Array.isArray(r.by_site) ? r.by_site : [],
    ticks: Array.isArray(r.ticks) ? r.ticks : [],
  };
}

/** '<site> 72 · <site> 36' (the expand row). Sites with nothing ordered are left out. */
export function bySiteWords(bySite) {
  return (Array.isArray(bySite) ? bySite : [])
    .filter((s) => num(s?.qty) > 0)
    .map((s) => `${String(s.site_name || 'Site')} ${q3(s.qty)}`)
    .join(' · ');
}

/** '40 buns' / '1.5 L' / '' for nothing. */
export function qtyUnit(qty, unit) {
  const n = q3(qty);
  return unit ? `${n} ${unit}` : String(n);
}

/** The Done column words: 'Done', '<done> of <make> <unit>', or 'Nothing to make'. */
export function fillWords(row) {
  const r = planRow(row);
  if (r.make <= 0 && r.done <= 0) return 'Nothing to make';
  if (r.done >= r.make) return 'Done';
  if (r.done <= 0) return `${qtyUnit(r.make, r.unit)} to make`;
  return `${q3(r.done)} of ${qtyUnit(r.make, r.unit)}`;
}

/** Plan totals for the header line: rows, how many done, how many still to make. */
export function planTotals(rows) {
  const list = (Array.isArray(rows) ? rows : []).map(planRow);
  const toMake = list.filter((r) => r.make > 0);
  return { rows: list.length, toMake: toMake.length, done: toMake.filter((r) => r.done >= r.make).length };
}

/** What a typed tick quantity is: a number above 0, else null (the box refuses it). */
export function tickQty(typed) {
  const s = String(typed ?? '').trim().replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? q3(n) : null;
}

/** "Who ticked" words: '20 by Sam at 09:40'. */
export function tickWords(tick, timeOf = (iso) => String(iso || '').slice(11, 16)) {
  const t = tick || {};
  const by = t.done_by_name ? ` by ${t.done_by_name}` : '';
  const at = t.done_at ? ` at ${timeOf(t.done_at)}` : '';
  return `${q3(t.qty)}${by}${at}`;
}

// -- pick and send ---------------------------------------------------------------------------------

/** One pack's content in the item's base unit: perPackBase when the server sent it, else pack x inner. */
export function perPackBase(line) {
  const l = line || {};
  if (num(l.per_pack_base ?? l.perPackBase) > 0) return num(l.per_pack_base ?? l.perPackBase);
  const pack = num(l.pack_qty ?? l.packQty) || 1;
  const inner = num(l.inner_qty ?? l.innerQty) || 1;
  return pack * inner;
}

/** Packs to base units for the pick (3 places). */
export function packsToBase(qtyPacks, line) {
  return q3(Math.max(0, num(qtyPacks)) * perPackBase(line));
}

/** What was short on a line (ordered less sent, never below 0). */
export function shortOf(ordered, sent) {
  return Math.max(0, q3(num(ordered) - num(sent)));
}

/** A typed "sent" figure: a number at or above 0, else null (left as ordered). */
export function sentQty(typed) {
  const s = String(typed ?? '').trim().replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? q3(n) : null;
}

/** The starting "sent" figures of an order: every line as ordered. { [po_line_id]: qty } */
export function sentAsOrdered(order) {
  const out = {};
  for (const l of (order?.lines || [])) if (l?.po_line_id) out[l.po_line_id] = q3(l.qty_packs);
  return out;
}

/**
 * The p_lines of stock_kitchen_pick for one site order: [{ po_line_id, qty_packs_sent, batch_id? }].
 * A line nobody typed is sent as ordered; a bad figure is refused by name.
 * Returns { lines, error }.
 */
export function pickLines(order, sentByLine = {}, batchByLine = {}) {
  const lines = [];
  for (const l of (order?.lines || [])) {
    if (!l?.po_line_id) continue;
    const typed = Object.prototype.hasOwnProperty.call(sentByLine || {}, l.po_line_id) ? sentByLine[l.po_line_id] : l.qty_packs;
    const qty = sentQty(typed);
    if (qty == null) return { lines: [], error: `${l.name || 'A line'}: type how many packs are sent (0 or more).` };
    const row = { po_line_id: l.po_line_id, qty_packs_sent: qty };
    if (batchByLine && batchByLine[l.po_line_id]) row.batch_id = batchByLine[l.po_line_id];
    lines.push(row);
  }
  if (!lines.length) return { lines: [], error: 'This order has no lines to send.' };
  if (!lines.some((l) => l.qty_packs_sent > 0)) return { lines: [], error: 'Nothing is sent. Type at least one amount above 0.' };
  return { lines, error: null };
}

/** The short lines of a pick before it is sent: [{ po_line_id, name, ordered, sent, short }]. */
export function shortLines(order, sentByLine = {}) {
  const out = [];
  for (const l of (order?.lines || [])) {
    const typed = Object.prototype.hasOwnProperty.call(sentByLine || {}, l.po_line_id) ? sentByLine[l.po_line_id] : l.qty_packs;
    const sent = sentQty(typed) ?? q3(l.qty_packs);
    const short = shortOf(l.qty_packs, sent);
    if (short > 0) out.push({ po_line_id: l.po_line_id, name: l.name || '', ordered: q3(l.qty_packs), sent, short });
  }
  return out;
}

/** 'Lot <code> · use by <D Mon>', 'Lot <code>', 'Use by <D Mon>' or ''. */
export function lotWords({ lot_code: lot = null, use_by_at: useBy = null } = {}) {
  const day = shortDay(useBy);
  if (lot && day) return `Lot ${lot} · use by ${day}`;
  if (lot) return `Lot ${lot}`;
  if (day) return `Use by ${day}`;
  return '';
}

/**
 * The delivery note model from stock_kitchen_pick's answer (`note`) and the order it sent:
 * { title, kitchen, site, reference, day, rows: [{ name, pack, ordered, sent, short, lot, useBy, lotLine }],
 *   shortCount, value }. Lines the server left out of its note come from the order with sent 0.
 */
export function deliveryNote(answer, order = null, { kitchenName = '' } = {}) {
  const note = answer?.note || {};
  const fromNote = Array.isArray(note.lines) ? note.lines : [];
  const byLine = {};
  for (const l of fromNote) if (l && (l.po_line_id || l.name)) byLine[l.po_line_id || l.name] = l;
  const orderLines = Array.isArray(order?.lines) ? order.lines : [];
  const base = orderLines.length ? orderLines.map((l) => ({ ...l, ...(byLine[l.po_line_id] || {}) })) : fromNote;
  const rows = base.map((l) => {
    const ordered = q3(l.ordered ?? l.qty_packs);
    const sent = q3(l.sent ?? l.qty_packs_sent ?? 0);
    const lot = l.lot_code || l.lot || null;
    const useBy = l.use_by_at || l.use_by || null;
    return {
      name: String(l.name || l.description || 'Item'),
      pack: String(l.pack_label || ''),
      ordered, sent, short: shortOf(ordered, sent),
      lot, useBy, lotLine: lotWords({ lot_code: lot, use_by_at: useBy }),
      unitPrice: money2(l.unit_price),
      allergens: Array.isArray(l.allergens) ? l.allergens : null,
    };
  });
  return {
    title: 'Delivery note',
    kitchen: String(note.kitchen || kitchenName || ''),
    site: String(note.site || order?.site_name || ''),
    reference: String(answer?.reference || note.reference || order?.reference || ''),
    day: String(note.day || order?.delivery_day || ''),
    rows,
    shortCount: rows.filter((r) => r.short > 0).length,
    value: money2(rows.reduce((s, r) => s + r.sent * r.unitPrice, 0)),
  };
}

/** What a delivery label says when the pick answer carried no allergens: never 'none' by mistake. */
export const ALLERGENS_UNKNOWN = 'check the recipe card';

/**
 * One label per sent line (the Drop 2 label route): [{ name, lot, useBy, qty, pack, site, allergens }].
 * allergens is the line's list when the database sent one, else [ALLERGENS_UNKNOWN], so a label never
 * says 'Allergens: none' for a batch whose allergens it was not told.
 */
export function labelsOf(note) {
  return (note?.rows || []).filter((r) => r.sent > 0).map((r) => ({
    name: r.name, lot: r.lot || '', useBy: r.useBy || '', qty: r.sent, pack: r.pack, site: note.site || '',
    allergens: Array.isArray(r.allergens) ? r.allergens : [ALLERGENS_UNKNOWN],
  }));
}

/** The order's status words in Orders in: 'To pick', 'In transit', 'Received', 'Disputed'. */
export function ordersInStatus(order) {
  const t = String(order?.transfer_status || '').toUpperCase();
  if (!order?.transfer_id) return String(order?.status || '').toUpperCase() === 'RECEIVED' ? 'Received' : 'To pick';
  if (t === 'SENT') return 'In transit';
  if (t === 'RECEIVED' || t === 'DONE') return 'Received';
  if (t === 'DISPUTED') return 'Disputed';
  if (t === 'DRAFT') return 'Picking';
  return 'To pick';
}

// -- ingredients ---------------------------------------------------------------------------------

/**
 * "Order these": the ingredient rows (stock_kitchen_ingredients) to createOrdersFromBasket's line
 * shape at the kitchen. packsById: { supplier_product_id: { pack_qty, inner_qty, inner_unit, pack_price,
 * price_includes_tax, purchase_tax_rate_id } } (the kitchen's own supplier products); ratesById: { id: rate }.
 * A row with no supplier pack, or no packs, is left out and named in `skipped`.
 */
export function ingredientBasket(rows, packsById = {}, ratesById = {}) {
  const lines = [];
  const skipped = [];
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const packs = Math.ceil(num(r?.packs));
    const sp = r?.supplier_product_id ? packsById[r.supplier_product_id] : null;
    if (!r?.supplier_id || !sp || !(packs > 0)) {
      if (num(r?.short_base) > 0) skipped.push(String(r?.name || 'An ingredient'));
      continue;
    }
    const rate = num(ratesById[sp.purchase_tax_rate_id]);
    const price = num(sp.pack_price);
    const net = sp.price_includes_tax === true && rate > 0 ? price / (1 + rate) : price;
    lines.push({
      supplierId: r.supplier_id, supplierProductId: r.supplier_product_id, inventoryItemId: r.inventory_item_id,
      description: String(r.name || ''), qtyPacks: packs,
      packQty: num(sp.pack_qty) || 1, innerQty: num(sp.inner_qty) || 1, innerUnit: sp.inner_unit || 'each',
      unitPrice: Math.round(net * 10000) / 10000, purchaseTaxRateId: sp.purchase_tax_rate_id || null,
    });
  }
  return { lines, skipped };
}

/** '<n> orders to <n> suppliers' for the Order these button. */
export function basketWords(lines) {
  const sups = new Set((lines || []).map((l) => l.supplierId));
  const n = sups.size;
  return n ? `${n} order${n === 1 ? '' : 's'} to ${n} supplier${n === 1 ? '' : 's'}` : 'Nothing to order';
}

// -- recharges -------------------------------------------------------------------------------------

/** The first day of a month ('YYYY-MM-01') from any day in it. */
export function monthStart(ymd) {
  const p = ymdParts(ymd);
  return p ? `${p.y}-${String(p.mo).padStart(2, '0')}-01` : '';
}

/** The last 12 months for the select, newest first: [{ value: 'YYYY-MM-01', label: 'October 2026' }]. */
export function monthChoices(todayYmd, n = 12) {
  const p = ymdParts(todayYmd);
  if (!p) return [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(p.y, p.mo - 1 - i, 1));
    out.push({ value: d.toISOString().slice(0, 10), label: `${MONTHS_LONG[d.getUTCMonth()]} ${d.getUTCFullYear()}` });
  }
  return out;
}

/** A recharge row's state: 'sent' (both Xero ids), 'part' (one), 'no_xero' (a side with no tenant), 'ready'. */
export function rechargeState(row) {
  const p = row?.posted || null;
  if (p && p.xero_invoice_id && p.xero_bill_id) return 'sent';
  if (p && (p.xero_invoice_id || p.xero_bill_id)) return 'part';
  if (!row?.from_tenant || !row?.to_tenant) return 'no_xero';
  return 'ready';
}

/** The rows "Send to Xero as drafts" posts: ready or half sent, with an amount above 0. */
export function rechargeToSend(rows) {
  return (Array.isArray(rows) ? rows : []).filter((r) => ['ready', 'part'].includes(rechargeState(r)) && num(r.amount) > 0);
}
