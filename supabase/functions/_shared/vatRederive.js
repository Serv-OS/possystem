// supabase/functions/_shared/vatRederive.js
//
// THE TILL'S VAT RULE, RUN AGAIN OVER A STORED SALE (8 Oct 2026, the daily VAT check).
//
// Peter, 8 Oct 2026: "VAT despite the order type should follow the Tax rules set on the back
// office per menu item." The daily check (vat-check) reads yesterday's sales at every venue
// and works each one's VAT out again from its stored lines, the venue's rates and the menu, to
// catch a sale booked with no VAT, with no record of the rate, or with a figure its items do not
// give. Nothing is changed by it; it names the sales.
//
// Edge functions cannot import src/lib, so this file MIRRORS the one rule the till books with:
//   - which rate a line takes: src/lib/tax.js resolveLineTaxRate (the item's override for the
//     order type by its own key, then the alias; the item's own rate; the venue default; a
//     D4 fallback note when a named rate could not be matched), with the same alias table as
//     accountingGroups.js (collection and drive thru read Takeaway, a bar tab reads Bar);
//   - the maths: src/lib/tax.js calculateLineTax (UK VAT inside the price: gross minus gross
//     over one plus the rate; added on: gross times the rate), summed raw per rate;
//   - the share of the goods charged: src/lib/payments/checkTotals.js (item discounts and
//     check discounts off, loyalty and promo credits NOT off) through taxShare.inclusiveTaxOnCharged,
//     and headlessTax.taxForChargedGoods (a bill charged nothing books 0);
//   - the rounding: src/lib/taxRule.js roundHalfUpMinor, half up to the penny, ONCE per sale.
// src/lib/accounting/vatRederive.test.js pins this mirror against the real engine
// (saleVatGuard.rederiveSaleTax) over 200 live till sales and the 14 QR sales of the audit, and
// the alias table and rounding against taxRule.js. Change the till's rule and that test says so.
//
// A line carries its own Back Office rule when the till saved it (taxRateId and taxOverrides on
// the line, as store addItem and the kiosk write them). A line with none (an older kiosk or QR
// line) takes the menu row it names: a size with no overrides of its own reads its parent's
// overrides and, with no rate, its parent's rate (store addItem). A line on no menu row keeps
// what it carries and is flagged.
// PURE: imports accountingGroups.js (pure) for the alias table; runs in Node and Deno.

import { TAX_ORDER_TYPE_ALIASES } from './accountingGroups.js';

export const NOT_IN_MENU = '__not_in_menu__';
export const TAX_FALLBACK_REASONS = Object.freeze({
  RATE_NOT_FOUND: 'rate-not-found',
  OVERRIDE_RATE_NOT_FOUND: 'override-rate-not-found',
  ITEM_NOT_ON_MENU: 'item-not-on-menu',
  CUSTOM_ITEM: 'custom-item',
  NO_DEFAULT_RATE: 'no-default-rate',
});

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Half up at the penny on the true value (mirror of taxRule.roundHalfUpMinor), with sign. */
export function roundHalfUpPence(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  const out = Math.round(Number((Math.abs(n) * 100).toFixed(6))) / 100;
  return n < 0 && out !== 0 ? -out : out;
}

/** The override key a sale's order type reads when the item has none under its own key. */
export function taxOrderTypeKey(orderType) {
  return TAX_ORDER_TYPE_ALIASES[orderType] || orderType;
}

// ── the venue's rates and menu, made ready ───────────────────────────────────

/** A tax_rates row (snake or camel) as this file reads it: { id, name, code, rate, type, isDefault, active }. */
export function readRate(r) {
  if (!r || r.id == null) return null;
  return {
    id: String(r.id), name: r.name || '', code: r.code || '', rate: num(r.rate) ?? 0,
    type: String(r.type || 'inclusive').toLowerCase() === 'exclusive' ? 'exclusive' : 'inclusive',
    isDefault: !!(r.is_default ?? r.isDefault), active: r.active !== false,
    appliesTo: r.applies_to ?? r.appliesTo ?? ['all'],
  };
}

/** The venue's ACTIVE rates (an inactive rate charges nothing, src/lib/tax.js) and its default. */
export function ratesIndex(taxRates) {
  const rates = (Array.isArray(taxRates) ? taxRates : []).map(readRate).filter((r) => r && r.active);
  return { rates, byId: new Map(rates.map((r) => [r.id, r])), def: rates.find((r) => r.isDefault) || null };
}

/** menu_items rows (snake or camel) by id: { id, parentId, taxRateId, taxOverrides }. */
export function menuIndex(menuRows) {
  const m = new Map();
  for (const r of Array.isArray(menuRows) ? menuRows : []) {
    if (!r || r.id == null) continue;
    const ov = r.tax_overrides ?? r.taxOverrides;
    m.set(String(r.id), {
      id: String(r.id), parentId: r.parent_id ?? r.parentId ?? null,
      taxRateId: (r.tax_rate_id ?? r.taxRateId) || null,
      taxOverrides: ov && typeof ov === 'object' && !Array.isArray(ov) ? ov : {},
    });
  }
  return m;
}

// ── one line ─────────────────────────────────────────────────────────────────

/**
 * The Back Office rule a stored line follows: { taxRateId, taxOverrides, note, itemId }.
 * The line's own rule when the till saved one; else the menu row it names (a size inherits its
 * parent's overrides and, with no rate, its parent's rate); else nothing, flagged item-not-on-menu.
 */
export function lineRule(line, menu) {
  const l = line || {};
  const itemId = l.itemId ?? l.item_id ?? l.id ?? null;
  const own = 'taxRateId' in l || 'tax_rate_id' in l || 'taxOverrides' in l || 'tax_overrides' in l;
  if (own) {
    const ov = l.taxOverrides ?? l.tax_overrides;
    return { itemId, taxRateId: (l.taxRateId ?? l.tax_rate_id) || null, taxOverrides: ov && typeof ov === 'object' ? ov : {}, note: null, cleaned: l.taxFallback && typeof l.taxFallback === 'object' ? l.taxFallback : null };
  }
  let row = itemId != null && menu ? menu.get(String(itemId)) || null : null;
  let parent = null;
  if (row && row.parentId) parent = menu.get(String(row.parentId)) || null;
  else if (!row && (l.parentId ?? l.parent_id) && menu) row = menu.get(String(l.parentId ?? l.parent_id)) || null;
  if (!row) return { itemId, taxRateId: null, taxOverrides: {}, note: itemId === 'custom' ? null : TAX_FALLBACK_REASONS.ITEM_NOT_ON_MENU, cleaned: null };
  let taxRateId = row.taxRateId;
  let taxOverrides = row.taxOverrides;
  if (parent && (!taxOverrides || !Object.keys(taxOverrides).length)) {
    taxOverrides = parent.taxOverrides;
    if (!taxRateId) taxRateId = parent.taxRateId;
  }
  return { itemId, taxRateId: taxRateId || null, taxOverrides: taxOverrides || {}, note: null, cleaned: null };
}

/**
 * Which rate a line takes (mirror of src/lib/tax.js resolveLineTaxRate): { rate, fallback }.
 * `fallback` is null when the line followed its own rule, else { source:'fallback', reason,
 * lineId, itemId, name, rateId } as the till records it.
 */
export function resolveLineRate(rule, line, idx, orderType) {
  const none = { rate: null, fallback: null };
  if (!idx.rates.length) return none;
  const note = (reason, rateId) => ({ source: 'fallback', reason, lineId: line?.lineId ?? line?.uid ?? line?.id ?? null, itemId: rule.itemId ?? line?.id ?? null, name: typeof line?.name === 'string' ? line.name : null, rateId: rateId ?? null });
  const ov = rule.taxOverrides || {};
  let overrideId;
  if (ov[orderType] !== undefined) overrideId = ov[orderType];
  else { const alias = taxOrderTypeKey(orderType); if (alias !== orderType && ov[alias] !== undefined) overrideId = ov[alias]; }
  let pending = null;
  let rateId;
  if (overrideId !== undefined) {
    if (overrideId) {
      const r = idx.byId.get(String(overrideId));
      if (r) return { rate: r, fallback: null };
      pending = [TAX_FALLBACK_REASONS.OVERRIDE_RATE_NOT_FOUND, overrideId];
      rateId = rule.taxRateId;
    } else {
      rateId = null;   // an explicit "Use default" override
    }
  } else {
    rateId = rule.taxRateId;
  }
  if (rule.note && !pending) pending = [rule.note, rateId || null];
  if (rateId) {
    const r = idx.byId.get(String(rateId));
    if (r) return { rate: r, fallback: pending ? note(pending[0], pending[1]) : null };
    pending = [rateId === NOT_IN_MENU ? TAX_FALLBACK_REASONS.ITEM_NOT_ON_MENU : TAX_FALLBACK_REASONS.RATE_NOT_FOUND, rateId];
  } else if (!pending) {
    if (rule.cleaned) pending = [rule.cleaned.reason || TAX_FALLBACK_REASONS.RATE_NOT_FOUND, rule.cleaned.rateId ?? null];
    else if (overrideId === undefined && rule.itemId === 'custom') pending = [TAX_FALLBACK_REASONS.CUSTOM_ITEM, null];
  }
  if (idx.def) return { rate: idx.def, fallback: pending ? note(pending[0], pending[1]) : null };
  return { rate: null, fallback: note(TAX_FALLBACK_REASONS.NO_DEFAULT_RATE, rateId || null) };
}

// ── the share of the goods charged ───────────────────────────────────────────

/**
 * The share of the goods a bill charged (mirror of payments/checkTotals.js and
 * taxShare.inclusiveTaxOnCharged): item discounts and check discounts off, loyalty and promo
 * credits not. 1 when nothing was taken off. headlessTax.taxForChargedGoods: a bill whose total
 * less tip is nothing charged nothing, so its share is 0.
 *   { goods, subtotal, discountedSub, share }
 */
export function chargedShare(row, lines) {
  let goods = 0, subtotal = 0;
  for (const i of lines) {
    const base = (num(i.price) || 0) * (num(i.qty) || 1);
    goods += base;
    const d = i.discount;
    if (!d || typeof d !== 'object') subtotal += base;
    else subtotal += d.type === 'percent' ? base * (1 - (num(d.value) || 0) / 100) : Math.max(0, base - (num(d.value) || 0));
  }
  let checkDiscount = 0;
  for (const d of Array.isArray(row?.discounts) ? row.discounts : []) {
    if (!d || typeof d !== 'object') continue;
    if (d.type === 'percent') checkDiscount += subtotal * (num(d.value) || 0) / 100;
    else checkDiscount += num(d.value) ?? num(d.amount) ?? 0;
  }
  const discountedSub = Math.max(0, subtotal - checkDiscount);
  let share = goods > 0 && discountedSub < goods ? Math.max(0, Math.min(1, discountedSub / goods)) : 1;
  const total = num(row?.total);
  if (total != null && total - (num(row?.tip) || 0) <= 0.004) share = 0;
  return { goods, subtotal, discountedSub, share };
}

// ── one sale ─────────────────────────────────────────────────────────────────

/**
 * A sale's VAT worked out again from its stored lines.
 *   row    a closed_checks row (items, discounts, order_type, total, tip)
 *   rates  the venue's tax_rates rows; menu: menu_items rows or a menuIndex Map
 * Returns { ok, totalTax, share, goods, record, fallbacks, reason }: ok false (reason) when the
 * venue has no rates, the sale has no live lines, or a line booked no VAT for want of a default
 * rate. The record has the till's shape (source 'check').
 */
export function rederiveSale(row, { rates, menu } = {}) {
  const idx = ratesIndex(rates);
  if (!idx.rates.length) return { ok: false, reason: 'no-rates', totalTax: null, share: 1, goods: 0, record: null, fallbacks: [] };
  const menuIdx = menu instanceof Map ? menu : menuIndex(menu);
  const lines = (Array.isArray(row?.items) ? row.items : []).filter((i) => i && typeof i === 'object' && !i.voided);
  if (!lines.length) return { ok: false, reason: 'no-lines', totalTax: null, share: 1, goods: 0, record: null, fallbacks: [] };
  const orderType = row?.order_type || row?.orderType || 'dine-in';
  const byRate = new Map();
  const fallbacks = [];
  let sumTax = 0, sumNet = 0, sumGross = 0, exclusive = 0;
  for (const line of lines) {
    const rule = lineRule(line, menuIdx);
    const { rate, fallback } = resolveLineRate(rule, line, idx, orderType);
    if (fallback) fallbacks.push(fallback);
    const gross0 = (num(line.price) || 0) * (num(line.qty) || 1);
    let gross = gross0, net = gross0, tax = 0;
    if (rate && rate.rate !== 0) {
      if (rate.type === 'inclusive') { net = gross0 / (1 + rate.rate); tax = gross0 - net; }
      else { net = gross0; tax = net * rate.rate; gross = net + tax; exclusive += tax; }
    }
    sumGross += gross; sumNet += net; sumTax += tax;
    if (rate) {
      const e = byRate.get(rate.id) || { rate: { id: rate.id, code: rate.code, name: rate.name, rate: rate.rate, type: rate.type, active: true, appliesTo: rate.appliesTo, isDefault: rate.isDefault }, tax: 0, net: 0, gross: 0, items: 0 };
      e.tax += tax; e.net += net; e.gross += gross; e.items += 1;
      byRate.set(rate.id, e);
    }
  }
  const hasExclusive = exclusive > 0;
  const { goods, share: rawShare } = chargedShare(row, lines);
  const share = hasExclusive ? 1 : rawShare;
  const totalTax = roundHalfUpPence(sumTax * share);
  const breakdown = [...byRate.values()].sort((a, b) => b.rate.rate - a.rate.rate)
    .map((e) => ({ ...e, tax: e.tax * share, net: e.net * share, gross: e.gross * share }));
  const record = {
    subtotal: sumNet * share, totalTax, total: sumGross * share, exclusiveTax: roundHalfUpPence(exclusive * share), breakdown, hasExclusiveTax: hasExclusive,
    source: 'check', ...(share < 1 ? { share } : {}), ...(fallbacks.length ? { fallbacks } : {}),
  };
  const noDefault = fallbacks.some((f) => f.reason === TAX_FALLBACK_REASONS.NO_DEFAULT_RATE);
  return { ok: !noDefault, reason: noDefault ? 'no-default-rate' : null, totalTax, share, goods, record, fallbacks };
}
