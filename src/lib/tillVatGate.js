// tillVatGate.js: may this till start a tender? Only when it can book the VAT (8 Oct 2026).
//
// WHY. The VAT audit of 8 Oct 2026 found every till close path only computed VAT when the till
// held rates, and otherwise saved the sale with tax_amount null and told nobody. A till that boots
// while tax_rates cannot be read (no session yet, a failed read, a venue switch that emptied the
// slice) would sell all day with no VAT. The owner's rule: a sale is never saved without VAT when
// the venue has rates. So the till refuses the tender BEFORE a card is charged, never after.
//
// HOW the till knows the venue has rates when it holds none: the menu says so. Every product's
// Back Office rule names a rate (tax_rate_id) or an override, and the menu is loaded before
// anything is sold (lib/customerRates.js venueExpectsRates, the same test the customer pages use).
// A venue whose menu names no rate at all (a US venue set up as tax profiles, a venue with no tax
// set up) is not blocked: it books exactly as before.
//
// PURE: no store, no supabase. The store wraps it (vatGate) and re reads the rates (refreshTaxRates).

import { venueExpectsRates } from './customerRates.js';
import { taxCtxHasConfig } from './taxCompute.js';

/** Plain words for staff. Short, no dashes. */
export const TILL_VAT_WORDS = Object.freeze({
  missing: 'VAT rates have not loaded on this till, so it cannot take payment yet. Nothing has been charged. Press Try again. If it keeps happening, restart the till, or open Back Office, Tax and VAT, and Push to POS.',
  retrying: 'Loading VAT rates. One moment.',
});

/**
 * null when a tender may start; otherwise { code: 'missing', message }.
 *   taxCtx     the till's tax context (getTaxContext()), or null
 *   menuItems  the till's menu rows (store camel or raw snake)
 *   taxRates   optional, the bare rates list when no context is built
 */
export function tillVatGate({ taxCtx = null, menuItems = [], taxRates = null } = {}) {
  const ctx = taxCtx || (Array.isArray(taxRates) ? { taxRates } : null);
  const hasTaxConfig = ctx ? taxCtxHasConfig(ctx) : false;
  if (hasTaxConfig) return null;
  if (!venueExpectsRates(menuItems)) return null;   // nothing in the menu names a rate: no tax set up here, as before
  return { code: 'missing', message: TILL_VAT_WORDS.missing };
}

/**
 * The pauses between automatic re reads of tax_rates while the gate is shut (ms): quick first,
 * then patient, then every five minutes for as long as the till is up. attempt starts at 0.
 */
export const TAX_RATES_RETRY_MS = Object.freeze([5000, 15000, 45000, 120000]);
export function taxRatesRetryMs(attempt) {
  const n = Math.max(0, Number(attempt) || 0);
  return n < TAX_RATES_RETRY_MS.length ? TAX_RATES_RETRY_MS[n] : 300000;
}

/**
 * After a tax_rates read on a till: what to do next. Pure decision, the store acts on it.
 *   res          the supabase answer ({ data, error }) or null when the read threw
 *   trusted      the read was made with a session whose empty answer is real (sessionTrustsEmpty)
 *   expectsRates venueExpectsRates(menuItems)
 *   hasTaxConfig taxCtxHasConfig after the read was applied
 * Returns { retry, alert }:
 *   retry  true when the till still cannot book VAT (gate shut): read again with taxRatesRetryMs
 *   alert  true when the venue really has no rates (a trusted empty answer) although its menu
 *          names some: the owner must seed or push them (venueTaxRates.noTaxRatesAlert words)
 */
export function afterTaxRatesRead({ res = null, trusted = false, expectsRates = false, hasTaxConfig = false } = {}) {
  if (hasTaxConfig || !expectsRates) return { retry: false, alert: false };
  const succeeded = !!(res && !res.error && Array.isArray(res.data));
  const empty = succeeded && res.data.length === 0;
  return {
    retry: true,
    alert: empty && trusted,
  };
}

/** One alert a day per venue: the latch key and whether today's has gone (pure given `today`). */
export const NO_RATES_ALERT_KEY = 'rpos-no-tax-rates-alert-day';
export function noRatesAlertDue(lastDay, today) {
  return !lastDay || String(lastDay) !== String(today);
}
