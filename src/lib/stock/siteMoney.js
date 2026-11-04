/**
 * stock/siteMoney.js: the currency of the site a stock screen shows (5.12.57). Pure: the only import
 * is lib/currency.js, so node --test drives it (siteMoney.test.js).
 *
 * Only the ACTIVE venue sets the Back Office currency (locationTime.js), so money() with no code is
 * always the signed in venue's money. A stock screen that shows a site PICKED in the site picker
 * must pass that site's own code, or a US site picked while signed in at a UK site reads in pounds.
 *
 *   siteCurrencyCode(siteId, { scope, homeId, configCurrency, activeCode })  'GBP' | 'USD' | 'EUR'
 *   siteCurrencyOf(scope, siteId)                                             the same, from the scope alone
 *   siteSymbol(siteId, opts)                                                  '£' | '$' | '€'
 *   moneyIn(code)   lib/currency.js's money helpers bound to one currency (a code passed in still wins)
 *
 * The signed in venue (or no site named) is the active currency, exactly as before. Another site is
 * its own currency from the stock scope (stock_site_scope's sites[].currency), else from its location
 * config (getLocationConfig(siteId).currency, read by the hook useSiteCurrency), else the active one.
 * A missing currency never means pounds by itself.
 */

import { CURRENCIES, getActiveCurrencyCode, currencySymbol, money, signedMoney, moneyMinor } from '../currency.js';

const asId = (v) => (v == null || v === '' ? null : String(v));

/** 'usd' -> 'USD'; anything not a known currency -> null. */
export function knownCode(v) {
  const c = String(v ?? '').trim().toUpperCase();
  return c && CURRENCIES[c] ? c : null;
}

/** The currency the stock scope holds for one site (open or closed), or null. */
export function scopeCurrency(scope, siteId) {
  const id = asId(siteId);
  if (!id || !scope) return null;
  const byId = scope.siteById && typeof scope.siteById.get === 'function' ? scope.siteById.get(id) : null;
  if (byId) return knownCode(byId.currency);
  const all = [...(Array.isArray(scope.sites) ? scope.sites : []), ...(Array.isArray(scope.closedSites) ? scope.closedSites : [])];
  return knownCode(all.find((s) => s && asId(s.id) === id)?.currency);
}

/**
 * The currency code of one site. homeId is the signed in venue (the scope's homeSite); the active
 * code is what money() uses with no code.
 */
export function siteCurrencyCode(siteId, { scope = null, homeId = null, configCurrency = null, activeCode = null } = {}) {
  const active = knownCode(activeCode) || getActiveCurrencyCode();
  const id = asId(siteId);
  const home = asId(homeId) || asId(scope?.homeSite);
  if (!id || (home && id === home)) return active;
  return scopeCurrency(scope, id) || knownCode(configCurrency) || active;
}

/** The scope's answer alone (no config read): for a row in a list that names its own site. */
export function siteCurrencyOf(scope, siteId) {
  return siteCurrencyCode(siteId, { scope });
}

/** The symbol of one site's currency: '£', '$' or '€'. */
export function siteSymbol(siteId, opts = {}) {
  return currencySymbol(siteCurrencyCode(siteId, opts));
}

/**
 * { code, symbol, money, signedMoney, moneyMinor, currencySymbol } bound to one currency code (null:
 * the active venue's). A code handed to a helper still wins, for a row in its own currency.
 */
export function moneyIn(code) {
  const c = knownCode(code) || getActiveCurrencyCode();
  return {
    code: c,
    symbol: currencySymbol(c),
    money: (n, own = null) => money(n, knownCode(own) || c),
    signedMoney: (n, own = null) => signedMoney(n, knownCode(own) || c),
    moneyMinor: (n, own = null) => moneyMinor(n, knownCode(own) || c),
    currencySymbol: (own = null) => currencySymbol(knownCode(own) || c),
  };
}
