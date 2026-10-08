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
//   - when the VAT cannot be worked out at all (no lines, the maths throws, no default rate):
//     the save is REFUSED with a named error (SaleVatError, code 'vat_missing'). Never a silent
//     null. The caller keeps the sale (DataSafe's pending copy, the offline queue) and says so.
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
import { taxCtxHasConfig } from './taxCompute.js';
import { isUsableBreakdown, linesGoods } from './taxShare.js';
import { taxForChargedGoods } from './headlessTax.js';
import { roundVat } from './taxRule.js';

/** Plain words for staff. Short, no dashes. */
export const SALE_VAT_WORDS = Object.freeze({
  refused: 'This sale has no VAT and it could not be worked out from its lines. The sale is kept on this device and will be saved once the VAT rates load.',
  repaired: 'VAT was filled in from the Back Office item rules before this sale was saved.',
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

/** The venue tax of a store state (the till's rates and context). Pure given the state. */
export function venueTaxFromStore(state) {
  if (!state) return null;
  let taxCtx = null;
  try { taxCtx = typeof state.getTaxContext === 'function' ? state.getTaxContext() : null; } catch { taxCtx = null; }
  const taxRates = Array.isArray(state.taxRates) ? state.taxRates : [];
  if (!taxCtx && !taxRates.length) return null;
  return {
    taxRates,
    taxCtx: taxCtx || { taxRates },
    hasTaxConfig: taxCtx ? taxCtxHasConfig(taxCtx) : taxRates.length > 0,
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

function emit(ev) {
  for (const fn of _subs) { try { fn(ev); } catch { /* the subscriber's problem */ } }
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
  if (!fresh) {
    if (failure && typeof console !== 'undefined') console.error(`[${tag}] VAT could not be worked out for ${r.ref || r.id}:`, failure?.message || failure);
    return refuse(failure ? 'maths-failed' : 'no-lines');
  }
  const ruleAmount = roundVat(fresh.totalTax);
  if (ruleAmount == null) return refuse('no-figure');

  let amount = ruleAmount;
  let reason = SALE_VAT_REPAIR_REASONS.TAX_MISSING;
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
  emit({ kind: 'repaired', ref: r.ref, checkId: r.id, reason, message: SALE_VAT_WORDS.repaired, tag });
  return withTax(row, r.snake, amount, rec);
}

/** True when `error` is the guard's refusal (whatever wrapped it). */
export function isSaleVatError(error) {
  return !!error && (error.name === 'SaleVatError' || error.code === 'vat_missing');
}
