// src/lib/currency.js
//
// v5.5.326: multi-currency support. A single source of truth for money
// formatting + Stripe currency codes, resolved from the active location's
// currency setting.
//
// KEY PROPERTY: money(n) returns exactly `£${n.toFixed(2)}` for GBP — the same
// string the codebase used inline before this change. So the codebase-wide
// sweep that replaced `£${x.toFixed(2)}` with `money(x)` is a NO-OP for GBP
// venues; it only changes the symbol/code for USD/EUR locations. That's what
// makes a 600+ site sweep safe to ship next to a GBP launch customer.

export const CURRENCIES = {
  GBP: { code: 'GBP', stripe: 'gbp', symbol: '£', locale: 'en-GB', label: 'British Pound (£)' },
  USD: { code: 'USD', stripe: 'usd', symbol: '$', locale: 'en-US', label: 'US Dollar ($)' },
  EUR: { code: 'EUR', stripe: 'eur', symbol: '€', locale: 'en-IE', label: 'Euro (€)' },
};

const DEFAULT_CURRENCY = 'GBP';
const STORAGE_KEY = 'rpos-active-currency';

// Resolve the active currency CODE synchronously (render-safe), mirroring the
// getActiveLocationSync() pattern. The location/config loader calls
// setActiveCurrency() when a location resolves; until then we fall back to GBP.
export function getActiveCurrencyCode() {
  try {
    const c = (localStorage.getItem(STORAGE_KEY) || '').toUpperCase();
    if (c && CURRENCIES[c]) return c;
  } catch { /* no localStorage (SSR / sandbox) */ }
  return DEFAULT_CURRENCY;
}

// Persist the active currency so money() resolves it synchronously everywhere.
// Accepts a currency code ('GBP'|'USD'|'EUR'); unknown values are ignored.
export function setActiveCurrency(code) {
  try {
    const c = String(code || '').toUpperCase();
    if (CURRENCIES[c]) localStorage.setItem(STORAGE_KEY, c);
  } catch { /* ignore */ }
}

export function currencyConfig(code) {
  const c = String(code || getActiveCurrencyCode()).toUpperCase();
  return CURRENCIES[c] || CURRENCIES[DEFAULT_CURRENCY];
}

// The currency symbol for the active (or given) currency: '£' | '$' | '€'.
export function currencySymbol(code) {
  return currencyConfig(code).symbol;
}

// Lowercase ISO code Stripe expects ('gbp' | 'usd' | 'eur').
export function stripeCurrency(code) {
  return currencyConfig(code).stripe;
}

// Format a MAJOR-unit amount as a money string: "£12.34" / "$12.34" / "€12.34".
// Intentionally matches the old `£${n.toFixed(2)}` output (symbol + 2dp, no
// thousands separators) so the sweep is byte-for-byte for GBP.
export function money(amount, code) {
  const n = Number(amount);
  return `${currencySymbol(code)}${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
}

// Format a MINOR-unit amount (pence/cents) as money: moneyMinor(1234) -> "£12.34".
export function moneyMinor(minor, code) {
  const n = Number(minor);
  return money((Number.isFinite(n) ? n : 0) / 100, code);
}
