// taxRule.js: the ONE tax rule every channel follows (8 Oct 2026).
//
// Peter, 8 Oct 2026: "VAT despite the order type should follow the Tax rules set on the back
// office per menu item." The VAT audit of that day found the channels answering differently:
//   - the till read a Collect sale under its own key, so an item's Takeaway override never
//     applied to it, while the delivery partner path mapped collection to takeaway;
//   - a bar tab was taxed as 'bar-tab', a key the item editor never offers, so a Bar override
//     was never read;
//   - a line whose rate could not be matched booked 0 on one channel (HubRise), null on another
//     (kiosk, customer pages) and the venue default with only a console warning on the till;
//   - each path rounded the VAT its own way, so 814 sales sitting on a half penny were stored a
//     penny apart depending on floating point noise (1.6749999999999998 became 1.67).
//
// This file holds the three shared answers. It imports nothing, so tax.js and taxEngine.js (the
// two engines, which must agree to the penny) and every close path can import it, and node --test
// can load it on its own.
//
//   1. WHICH OVERRIDE KEY a sale reads: taxOrderTypeKey / taxOverrideFor.
//   2. HOW VAT IS ROUNDED: roundHalfUpMinor / roundVat, half up to the penny, once per check.
//   3. WHAT A FALLBACK LOOKS LIKE when a line's rate cannot be matched: taxFallbackNote.

/**
 * The Back Office override key a sale's order type reads when the item carries no override under
 * its own key. The item editor offers dine-in, takeaway, delivery, bar, counter and drive-thru;
 * sales also arrive as collection (the till's Collect button, online ordering, catering, ezCater
 * TAKEOUT), drive-thru and bar-tab:
 *   collection  -> takeaway   food taken away is takeaway for VAT (Peter, 8 Oct 2026)
 *   drive-thru  -> takeaway   takeaway by another door (16 Sep 2026)
 *   bar-tab     -> bar        a bar tab follows the item's Bar override (Peter, 8 Oct 2026)
 * Every other order type reads exactly its own key. An override under the sale's own key always
 * wins over the alias (so a venue that one day sets a collection override is honoured).
 */
export const TAX_ORDER_TYPE_ALIASES = Object.freeze({
  collection: 'takeaway',
  'drive-thru': 'takeaway',
  'bar-tab': 'bar',
});

export function taxOrderTypeKey(orderType) {
  return TAX_ORDER_TYPE_ALIASES[orderType] || orderType;
}

/**
 * The per order type override an item carries for this order type, or undefined when it has
 * none (undefined means "no override", so the caller falls to the item's own rate; an explicit
 * null is a real override that means the venue default, as the item editor writes it).
 * Reads the sale's own key first, then its alias (taxOrderTypeKey). `item` may be a menu item,
 * an order line, or the engine's { taxRateId, taxOverrides } legacy block: anything carrying
 * `taxOverrides`.
 */
export function taxOverrideFor(item, orderType) {
  const overrides = item?.taxOverrides;
  if (!overrides || typeof overrides !== 'object') return undefined;
  const own = overrides[orderType];
  if (own !== undefined) return own;
  const alias = taxOrderTypeKey(orderType);
  if (alias !== orderType) return overrides[alias];
  return undefined;
}

/**
 * Half up at the currency's minor unit (pence, cents), applied to the TRUE decimal value: the
 * scaled figure is clamped to 6 decimals first so floating point noise on a half boundary cannot
 * pull it down (10.05 at 20% inside the price is exactly 1.675, which arrives as
 * 1.6749999999999998 and must give 1.68, never 1.67). Symmetric for a negative figure (a refund's
 * VAT): half away from zero. Not a number gives 0. This is the one rounding rule (D3, 8 Oct 2026),
 * chosen half up; it is applied ONCE per check, over the summed raw VAT, never per line.
 */
export function roundHalfUpMinor(x, minorUnit = 2) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** minorUnit;
  const scaled = Number((Math.abs(n) * factor).toFixed(6));
  const out = Math.round(scaled) / factor;
  return n < 0 && out !== 0 ? -out : out;
}

/**
 * The VAT figure a sale stores (closed_checks.tax_amount), rounded with roundHalfUpMinor to a two
 * decimal number. Keeps null: a missing figure stays "not recorded" (null, '' or anything that is
 * not a finite number gives null), it is never turned into 0.
 */
export function roundVat(n) {
  if (n == null || n === '') return null;
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return roundHalfUpMinor(x, 2);
}

/** The sentinel channelMoney stamps on a delivery partner line whose ref is not one of our products. */
export const NOT_IN_MENU = '__not_in_menu__';

/**
 * Why a line fell to the venue default rate instead of its own Back Office rule (D4, 8 Oct 2026).
 * Every reason is recorded on the sale (tax_breakdown.fallbacks) so a report can flag it; none is
 * ever booked as 0 or null quietly.
 */
export const TAX_FALLBACK_REASONS = Object.freeze({
  RATE_NOT_FOUND: 'rate-not-found',                   // the line names a rate this venue does not have (another venue's, deleted, switched off)
  OVERRIDE_RATE_NOT_FOUND: 'override-rate-not-found', // the order type override names a rate this venue does not have; the item's own rate applied
  ITEM_NOT_ON_MENU: 'item-not-on-menu',               // the line is not a product on this venue's menu (a delivery partner line, a stale QR line)
  CUSTOM_ITEM: 'custom-item',                         // an open price item typed at the till: it has no Back Office rule
  NO_DEFAULT_RATE: 'no-default-rate',                 // the venue has rates but none flagged default, so a line with no rate books no VAT
  // 8 Oct 2026 (review): the save time guard's two "whole sale" fallbacks. A PAID sale whose
  // lines cannot be taxed (the row carries no lines, or the maths threw on them) is booked at the
  // venue default on its goods and flagged, never refused for ever (lib/saleVatGuard.js).
  NO_LINES: 'no-lines',                               // the sale carries no lines to tax: the venue default on its goods
  MATHS_FAILED: 'maths-failed',                       // the tax maths threw on the lines: the venue default on its goods
});

/** Plain words for a fallback reason, for the Tax report and the activity feed. */
export const TAX_FALLBACK_WORDS = Object.freeze({
  'rate-not-found': 'rate not found at this venue, venue default used',
  'override-rate-not-found': 'order type rate not found at this venue, the item rate used',
  'item-not-on-menu': 'item not on this menu, venue default used',
  'custom-item': 'open price item, venue default used',
  'no-default-rate': 'no default rate at this venue, no VAT booked',
  'no-lines': 'no lines on the sale, venue default used on the goods',
  'maths-failed': 'the VAT maths failed on the lines, venue default used on the goods',
});

/**
 * The record of one fallback, as the sale carries it in tax_breakdown.fallbacks:
 *   { source: 'fallback', reason, lineId, itemId, name, rateId }
 * lineId is the order line (uid, else id); rateId the id that could not be matched (null when
 * the line had none). Accepts a store line, a channel line or an engine order line.
 */
export function taxFallbackNote(reason, line, rateId = null) {
  const l = line || {};
  return {
    source: 'fallback',
    reason: TAX_FALLBACK_WORDS[reason] ? reason : TAX_FALLBACK_REASONS.RATE_NOT_FOUND,
    lineId: l.lineId ?? l.uid ?? l.id ?? null,
    itemId: l.itemId ?? l.id ?? null,
    name: typeof l.name === 'string' ? l.name : null,
    rateId: rateId ?? null,
  };
}

/** The fallbacks a tax record (computeOrderTaxUnified result or stored tax_breakdown) carries, always a list. */
export function taxFallbacksOf(record) {
  const f = record && typeof record === 'object' ? record.fallbacks : null;
  return Array.isArray(f) ? f.filter((x) => x && typeof x === 'object') : [];
}
