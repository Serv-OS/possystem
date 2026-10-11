// saleVatGuard.js: the LAST line before a sale is written. A sale is never saved without VAT
// when the venue has rates (Peter, 8 Oct 2026: "VAT despite the order type should follow the
// Tax rules set on the back office per menu item"; "Fix once and right").
//
// WHY. The VAT audit of 8 Oct 2026 found every close path wrapped its tax maths in a catch that
// turned any error into tax_amount null and told nobody: the till (buildCloseRecord,
// recordWalkInClosed), the reader reconciler's headless record, bar tabs, Orders Hub, MPOS and
// the kiosk (which also kept an empty rates list after one failed read and booked null for every
// sale until a restart). 138 Barnsley kiosk sales carried the right VAT with no record of the
// rate; Preston QR-4OGI7 carried none at all.
//
// WHAT. assertSaleVat(row, venueTax) is called by writeClosedCheckRow (lib/closedCheckWrite.js,
// the ONE way a closed_checks row is written) right before the insert:
//   - a venue with no tax set up: the row passes untouched (that venue books "not recorded",
//     as before; the surfaces decide separately whether a venue that EXPECTS rates may sell);
//   - goods above 0 with tax_amount null, or with no record of the rate (tax_breakdown empty):
//     the VAT is worked out again from the stored lines with the one rule every till close
//     uses (payments/checkTotals.js: Back Office rate per item, per order type override, the
//     bill's own discounts, taxShare.inclusiveTaxOnCharged; a 100% comp books 0), rounded once
//     (taxRule.roundVat), and the record is tagged source 'repair' with why;
//   - a figure the channel booked itself is kept when it is within 1p of the rule (the record
//     is filled in beside it); further off, the rule's figure is booked and the channel's is
//     kept in the note (the same rule the server applies to a page's figure, 20261009a);
//   - when the lines cannot be taxed (the row carries none, or the maths throw on them) the
//     venue default is booked on the goods and the record says so (8 Oct 2026 review, so a paid
//     card sale is never stranded); only when there is no rate to book at all (the till has not
//     loaded them: venueTaxFromStore answers `true`) is the save REFUSED with a named error
//     (SaleVatError, code 'vat_missing'). Never a silent null. The caller keeps the sale
//     (DataSafe's pending copy, the offline queue) and says so, once per sale (the event latch).
// Voided rows (tombstones) and rows with no goods are never touched.
//
// The surfaces gate BEFORE a card tender starts (lib/tillVatGate.js, lib/kioskVat.js), so this
// guard is the belt, not the braces: it should rarely fire, and when it does the sale still
// books the right VAT.
//
// Pure apart from its sibling imports (no store, no supabase), so node --test proves it. The
// store registers how to read the till's rates (setVenueTaxSource) for writers that hold no
// venue context of their own (the offline replays, db.js).

import { computeCheckTotals } from './payments/checkTotals.js';
import { computeOrderTaxUnified, taxCtxHasConfig } from './taxCompute.js';
import { inclusiveTaxOnCharged, isUsableBreakdown, linesGoods } from './taxShare.js';
import { taxForChargedGoods } from './headlessTax.js';
import { roundVat, TAX_FALLBACK_REASONS, taxFallbackNote, taxFallbacksOf } from './taxRule.js';
import { venueExpectsRates } from './customerRates.js';

/** Plain words for staff. Short, no dashes. */
export const SALE_VAT_WORDS = Object.freeze({
  refused: 'This sale has no VAT and it could not be worked out from its lines. The sale is kept on this device and will be saved once the VAT rates load.',
  repaired: 'VAT was filled in from the Back Office item rules before this sale was saved.',
  defaulted: 'This sale had no lines to tax, so VAT was booked at the venue default rate on the goods. It is flagged in the Tax report.',
});

/** The error a refused save carries: named, so every caller can tell it from a network fault. */
export class SaleVatError extends Error {
  constructor(message, { ref = null, checkId = null, reason = null } = {}) {
    super(message);
    this.name = 'SaleVatError';
    this.code = 'vat_missing';
    this.ref = ref;
    this.checkId = checkId;
    this.reason = reason;
  }
}

/** Why a record was repaired, as tax_breakdown.repair.reason says it. */
export const SALE_VAT_REPAIR_REASONS = Object.freeze({
  TAX_MISSING: 'tax-missing',          // tax_amount was null: worked out from the lines
  TAX_FROM_RECORD: 'tax-from-record',  // tax_amount was null but the record carried the figure
  RECORD_MISSING: 'record-missing',    // the figure was booked with no split by rate: filled in
  TAX_DIFFERS: 'tax-differs',          // the booked figure was more than 1p from the item rules: the rule's figure booked
  // 8 Oct 2026 (review): the lines could not be taxed, so the venue default was booked on the goods
  // (the record also carries a fallback note with the same reason). A paid sale is never stranded.
  NO_LINES: TAX_FALLBACK_REASONS.NO_LINES,          // the row carries no lines
  MATHS_FAILED: TAX_FALLBACK_REASONS.MATHS_FAILED,  // the maths threw on the lines
});

// ── venue tax: what the guard needs to know about the venue ───────────────────────────────────

/**
 * The venue tax a writer hands the guard, normalised:
 *   null / undefined / false   nothing known about this venue: the guard judges nothing
 *   true                       the venue has rates, but no maths were handed over: refuse only
 *   an array                   the venue's tax rates (a bare rates context)
 *   { taxRates, taxCtx, hasTaxConfig, deviceConfig, discountRules, timezone }
 * Returns { hasRates, taxCtx, ... } or null.
 */
export function normaliseVenueTax(venueTax) {
  if (venueTax == null || venueTax === false) return null;
  if (venueTax === true) return { hasRates: true, taxCtx: null };
  if (Array.isArray(venueTax)) {
    const rates = venueTax.filter((r) => r && r.active !== false);
    return rates.length ? { hasRates: true, taxCtx: { taxRates: rates }, taxRates: rates } : null;
  }
  if (typeof venueTax !== 'object') return null;
  const taxCtx = venueTax.taxCtx || (Array.isArray(venueTax.taxRates) ? { taxRates: venueTax.taxRates } : null);
  const hasRates = venueTax.hasTaxConfig === true || (Array.isArray(venueTax.taxRates) && venueTax.taxRates.length > 0) || (taxCtx ? taxCtxHasConfig(taxCtx) : false);
  if (!hasRates) return null;
  return {
    hasRates: true,
    taxCtx,
    taxRates: venueTax.taxRates || taxCtx?.taxRates || [],
    deviceConfig: venueTax.deviceConfig,
    discountRules: venueTax.discountRules,
    timezone: venueTax.timezone,
  };
}

/**
 * The venue tax of a store state (the till's rates and context). Pure given the state.
 * 8 Oct 2026 (review): a till holding NO tax set up whose menu names rates answers `true` (the
 * venue has rates, this till has not loaded them: a failed or empty read the store keeps retrying),
 * so every writer judged through the store (DataSafe's replay, the offline queue, bookChannelSale)
 * REFUSES a row with goods and no VAT by name and keeps the sale until the rates load. Before this
 * it answered null ("nothing known") and a prepaid Deliveroo order accepted during that window was
 * saved with tax_amount null, silently. A menu naming no rate is a venue with no tax set up: null.
 */
export function venueTaxFromStore(state) {
  if (!state) return null;
  let taxCtx = null;
  try { taxCtx = typeof state.getTaxContext === 'function' ? state.getTaxContext() : null; } catch { taxCtx = null; }
  const taxRates = Array.isArray(state.taxRates) ? state.taxRates : [];
  const hasTaxConfig = taxCtx ? taxCtxHasConfig(taxCtx) : taxRates.length > 0;
  if (!hasTaxConfig) return venueExpectsRates(state.menuItems) ? true : null;
  return {
    taxRates,
    taxCtx: taxCtx || { taxRates },
    hasTaxConfig: true,
    deviceConfig: state.deviceConfig,
    discountRules: state.discountRules,
    timezone: state.locationConfig?.timezone,
  };
}

let _venueTaxSource = null;

/** The store registers how to read the till's venue tax, once, so writers with no context are judged too. */
export function setVenueTaxSource(fn) {
  _venueTaxSource = typeof fn === 'function' ? fn : null;
}

/** The venue tax right now from the registered source, or null when none is registered (or it throws). */
export function venueTaxNow() {
  if (!_venueTaxSource) return null;
  try { return _venueTaxSource() ?? null; } catch { return null; }
}

// ── sale VAT events: the lib is pure, so it tells the app through a subscriber ────────────────

const _subs = new Set();

/** Hear about every repair and every refusal: fn({ kind: 'repaired' | 'refused', ref, checkId, reason, message, tag }). */
export function onSaleVatEvent(fn) {
  if (typeof fn !== 'function') return () => {};
  _subs.add(fn);
  return () => _subs.delete(fn);
}

// 8 Oct 2026 (review): each sale is told ONCE per outcome. DataSafe retries a kept sale every
// minute (and on boot, reconnect and relink); before this every retry raised a 12 second red toast
// and an urgent activity row, about 1,440 a day for one sale. A repeat is logged quietly instead.
const _told = new Set();
const TOLD_CAP = 5000;
function emit(ev) {
  const key = `${ev.checkId ?? ev.ref ?? ''}|${ev.kind}|${ev.reason ?? ''}`;
  if (_told.has(key)) {
    if (typeof console !== 'undefined') console.warn(`[${ev.tag || 'closed_checks'}] ${ev.ref || ev.checkId || 'a sale'}: ${ev.kind} again (${ev.reason || ev.kind}), staff were told already`);
    return;
  }
  if (_told.size >= TOLD_CAP) _told.clear();
  _told.add(key);
  for (const fn of _subs) { try { fn(ev); } catch { /* the subscriber's problem */ } }
}

/** Forget which sales have been told about (tests; a venue switch). */
export function resetSaleVatEvents() {
  _told.clear();
}

// ── reading a row of either shape ────────────────────────────────────────────────────────────

const isSnake = (row) => 'tax_amount' in row || 'location_id' in row || 'order_type' in row || 'tax_breakdown' in row;

function readRow(row) {
  const snake = isSnake(row);
  const num = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  return {
    snake,
    taxAmount: num(snake ? row.tax_amount : row.taxAmount),
    taxBreakdown: snake ? row.tax_breakdown : row.taxBreakdown,
    items: Array.isArray(row.items) ? row.items : [],
    discounts: Array.isArray(row.discounts) ? row.discounts : [],
    subtotal: num(row.subtotal),
    total: num(row.total),
    tip: num(row.tip) ?? 0,
    service: num(row.service) ?? 0,
    covers: Number(row.covers) || 1,
    orderType: (snake ? row.order_type : row.orderType) || 'dine-in',
    ref: row.ref ?? null,
    id: row.id ?? null,
    status: row.status || 'paid',
    voided: row.voided === true,
  };
}

function withTax(row, snake, taxAmount, taxBreakdown) {
  return snake
    ? { ...row, tax_amount: taxAmount, tax_breakdown: taxBreakdown }
    : { ...row, taxAmount, taxBreakdown };
}

/** The goods a row sold: its live lines at price x qty (the stored subtotal is the shelf price too; the lines are the truth). */
export function saleGoods(row) {
  const r = readRow(row);
  const live = r.items.filter((i) => i && !i.voided);
  const fromLines = linesGoods(live);
  if (fromLines > 0) return fromLines;
  return r.subtotal != null && r.subtotal > 0 ? r.subtotal : 0;
}

/**
 * Does this row need the guard's attention at a venue with rates?
 *   { goods, taxMissing, recordMissing }: taxMissing when tax_amount is not a number;
 *   recordMissing when there is no usable split by rate (the Barnsley kiosk case).
 * A voided row (a tombstone) or a row with no goods needs nothing.
 */
export function saleVatNeeds(row) {
  const r = readRow(row || {});
  const goods = saleGoods(row || {});
  if (r.voided || /^void/i.test(String(r.status)) || !(goods > 0)) return { goods, taxMissing: false, recordMissing: false };
  const taxMissing = r.taxAmount == null;
  const recordMissing = !isUsableBreakdown(r.taxBreakdown) || !Array.isArray(r.taxBreakdown.breakdown) || r.taxBreakdown.breakdown.length === 0;
  return { goods, taxMissing, recordMissing };
}

/**
 * The VAT of a row worked out again from its stored lines with the one rule every till close
 * uses (computeCheckTotals: item rate, per order type override, the bill's discounts; UK VAT on
 * what was charged; a 100% comp books 0). Null when it cannot be worked out.
 */
export function rederiveSaleTax(row, venue) {
  const r = readRow(row);
  const live = r.items.filter((i) => i && !i.voided);
  if (!live.length || !venue?.taxCtx) return null;
  const t = computeCheckTotals({
    items: live,
    checkDiscounts: r.discounts,
    covers: r.covers,
    orderType: r.orderType,
    deviceConfig: venue.deviceConfig,
    discountRules: [],   // the row's discounts already hold the auto deals that applied
    timezone: venue.timezone,
    taxRates: venue.taxRates,
    taxCtx: venue.taxCtx,
  }).tax;
  if (!isUsableBreakdown(t)) return null;
  const booked = taxForChargedGoods(t, { grand: r.total, tip: r.tip });
  return isUsableBreakdown(booked) ? booked : null;
}

/**
 * 8 Oct 2026 (review): the VAT of a sale whose LINES cannot be taxed (the row carries none, or the
 * maths threw on them), booked at the venue's default rate on the goods it sold, scaled to what was
 * charged for them (total less tip and service) and flagged with `why` (tax_breakdown.fallbacks, D4
 * for the whole sale). This is how a PAID sale always lands: refusing it for ever stranded a card
 * sale whose frozen draft carried no items (the money taken, nothing in closed_checks), and the
 * reports could never flag what they never saw. Null when the venue has no default rate to book,
 * or the maths throw even on one plain line.
 */
export function defaultRateTax(row, venue, why) {
  const rates = Array.isArray(venue?.taxRates) && venue.taxRates.length ? venue.taxRates : (Array.isArray(venue?.taxCtx?.taxRates) ? venue.taxCtx.taxRates : []);
  const def = rates.find((x) => x && x.active !== false && (x.isDefault === true || x.is_default === true)) || null;
  if (!def || !venue?.taxCtx) return null;
  const r = readRow(row);
  const goods = saleGoods(row);
  if (!(goods > 0)) return null;
  try {
    const line = { uid: 'sale', id: 'sale', itemId: 'sale', name: 'Sale (no lines recorded)', price: goods, qty: 1, taxRateId: def.id, taxOverrides: {} };
    const t = computeOrderTaxUnified([line], venue.taxCtx, r.orderType);
    if (!isUsableBreakdown(t)) return null;
    const charged = r.total != null ? Math.max(0, r.total - r.tip - r.service) : null;
    const scaled = charged != null ? inclusiveTaxOnCharged(t, goods, charged) : t;
    return { ...scaled, fallbacks: [...taxFallbacksOf(scaled), taxFallbackNote(why, { lineId: null, itemId: null, name: null }, def.id)] };
  } catch {
    return null;
  }
}

/**
 * THE GUARD. Returns the row to write: the same object when nothing was needed, a repaired copy
 * otherwise. Throws SaleVatError when the venue has rates and the VAT cannot be worked out.
 *   row       a closed_checks row (snake, as writeClosedCheckRow gets it) or a store record (camel)
 *   venueTax  see normaliseVenueTax
 *   opts.tag  the writer's name, for the log and the event
 *   opts.now  () => ms (tests)
 */
export function assertSaleVat(row, venueTax, opts = {}) {
  if (!row || typeof row !== 'object') return row;
  const r = readRow(row);
  const tag = opts.tag || 'closed_checks';
  const at = new Date(typeof opts.now === 'function' ? opts.now() : Date.now()).toISOString();
  const refuse = (reason) => {
    const err = new SaleVatError(SALE_VAT_WORDS.refused, { ref: r.ref, checkId: r.id, reason });
    emit({ kind: 'refused', ref: r.ref, checkId: r.id, reason, message: err.message, tag });
    throw err;
  };
  // A venue tax that cannot even be read is a fault, not "no rates": a sale with goods and no VAT
  // is refused rather than saved null on the strength of it.
  let venue = null;
  let venueFailure = null;
  try { venue = normaliseVenueTax(venueTax); } catch (e) { venueFailure = e; }
  const needs = saleVatNeeds(row);
  if (!needs.taxMissing && !needs.recordMissing) return row;
  if (venueFailure) {
    if (typeof console !== 'undefined') console.error(`[${tag}] the venue tax could not be read for ${r.ref || r.id}:`, venueFailure?.message || venueFailure);
    return refuse('venue-unreadable');
  }
  if (!venue) return row;   // nothing known about this venue's tax: the surfaces decide, not the guard

  // The record itself carries the figure: book it (the headless path once wrote null beside a record).
  if (needs.taxMissing && !needs.recordMissing) {
    const amount = roundVat(r.taxBreakdown.totalTax);
    if (amount == null) return refuse('record-unreadable');
    const rec = { ...r.taxBreakdown, source: 'repair', repair: { reason: SALE_VAT_REPAIR_REASONS.TAX_FROM_RECORD, at, was: null, engine: r.taxBreakdown.source ?? null } };
    emit({ kind: 'repaired', ref: r.ref, checkId: r.id, reason: rec.repair.reason, message: SALE_VAT_WORDS.repaired, tag });
    return withTax(row, r.snake, amount, rec);
  }

  let fresh = null;
  let failure = null;
  try { fresh = rederiveSaleTax(row, venue); } catch (e) { failure = e; }
  let landed = null;   // the lines could not be taxed: the venue default was booked on the goods, and why
  if (!fresh) {
    const why = failure ? SALE_VAT_REPAIR_REASONS.MATHS_FAILED : SALE_VAT_REPAIR_REASONS.NO_LINES;
    if (failure && typeof console !== 'undefined') console.error(`[${tag}] VAT could not be worked out for ${r.ref || r.id}:`, failure?.message || failure);
    // 8 Oct 2026 (review): a paid sale is never stranded. With a default rate to book, the sale
    // lands at that rate on its goods, flagged (defaultRateTax); refused only when there is no rate
    // to book at all (the till has not loaded them yet: kept and sent again once they load).
    fresh = defaultRateTax(row, venue, why);
    if (!fresh) return refuse(why);
    landed = why;
  }
  const ruleAmount = roundVat(fresh.totalTax);
  if (ruleAmount == null) return refuse('no-figure');

  let amount = ruleAmount;
  let reason = landed || SALE_VAT_REPAIR_REASONS.TAX_MISSING;
  if (!needs.taxMissing) {
    // The channel booked a figure with no record of the rate. Within 1p of the item rules it
    // stands and the split is filled in beside it; further off, the rule's figure is booked.
    if (Math.abs(r.taxAmount - ruleAmount) <= 0.01 + 1e-9) {
      amount = r.taxAmount;
      reason = SALE_VAT_REPAIR_REASONS.RECORD_MISSING;
    } else {
      reason = SALE_VAT_REPAIR_REASONS.TAX_DIFFERS;
    }
  }
  const rec = {
    ...fresh,
    source: 'repair',
    repair: { reason, at, was: needs.taxMissing ? null : r.taxAmount, engine: fresh.source ?? null },
  };
  emit({ kind: 'repaired', ref: r.ref, checkId: r.id, reason, message: landed ? SALE_VAT_WORDS.defaulted : SALE_VAT_WORDS.repaired, tag });
  return withTax(row, r.snake, amount, rec);
}

/** True when `error` is the guard's refusal (whatever wrapped it). */
export function isSaleVatError(error) {
  return !!error && (error.name === 'SaleVatError' || error.code === 'vat_missing');
}
