/**
 * resellerRate.js: what FranPOS keeps on each card payment, per currency.
 * PURE: no network, no React, no Deno.
 *
 * MIRROR: supabase/functions/_shared/resellerRate.ts carries the SAME
 * helpers (Deno cannot import from src/). KEEP IN SYNC: change both or
 * neither. resellerRate.test.js is the contract for both copies.
 *
 * THE MODEL (owner, 10 Sep 2026). FranPOS owns the Adyen platform and keeps
 * its margin on every payment: 0.10% of the sale plus a FIXED fee per payment.
 * The fixed fee is 5 US cents in the contract, which is 3p in GBP ("I believe
 * the adyen charge per transaction is 5c so 3p"). So the fixed fee is per
 * CURRENCY, while the percent is one number.
 *
 * WHERE IT IS KEPT. platform_settings:
 *   adyen_reseller_buy_percent       the current percent
 *   adyen_reseller_buy_fixed_minor   the current fixed fee (one number, old readers)
 *   adyen_reseller_rate_history      [{ percent, fixed_minor, fixed_minor_by_currency?,
 *                                       from_month 'YYYY-MM', set_by, set_at }]
 * A history entry governs from its month onward, so an old month is always
 * priced at the rate that governed it. fixed_minor_by_currency ({ GBP, USD,
 * EUR }) arrived 10 Sep 2026; an entry without it reads exactly as before.
 */

// The signed terms per currency: 5c is 3p. Prefill and placeholder only; the
// rate on file always wins (resellerRateFor never reads these).
export const RESELLER_DEFAULT_FIXED_BY_CURRENCY = Object.freeze({ GBP: 3, USD: 5, EUR: 5 });

// The currencies the editor offers, in the order it lists them.
export const RESELLER_CURRENCIES = Object.freeze(['GBP', 'USD', 'EUR']);

// The fallbacks payments-admin has always used when nothing is on file.
const FALLBACK_PERCENT = 0.10;
const FALLBACK_FIXED_MINOR = 5;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const curOf = (c) => String(c ?? '').trim().toUpperCase() || 'GBP';

// A whole number of minor units, 0 to 100, or null. '' , null, booleans and
// fractions are not a fee.
function wholeMinor(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 100 ? n : null;
}

// The rate that governs one currency in one month.
//   settings  { history, buyPercent, buyFixedMinor } as platform_settings holds them
//   currency  'GBP' | 'USD' | 'EUR' (any case)
//   month     'YYYY-MM'
// Chooses the governing history entry EXACTLY as payments-admin always has:
// the entry with the latest from_month at or before the month, used only when
// its percent and fixed_minor are numbers. Then the fixed fee is the entry's
// fixed_minor_by_currency for the currency when that is a whole number 0 to
// 100, else the entry's fixed_minor, else the settings fixed, else 5.
// Answers { percent, fixedMinor, fromMonth, source }: source is 'history',
// 'settings' or 'default' (nothing on file).
export function resellerRateFor(settings, currency, month) {
  const s = isObj(settings) ? settings : {};
  const cur = curOf(currency);
  const m = String(month ?? '');
  let percent = FALLBACK_PERCENT;
  let fixedMinor = FALLBACK_FIXED_MINOR;
  let source = 'default';
  let fromMonth = null;
  if (s.buyPercent !== null && s.buyPercent !== undefined) { percent = Number(s.buyPercent); source = 'settings'; }
  if (s.buyFixedMinor !== null && s.buyFixedMinor !== undefined) fixedMinor = Number(s.buyFixedMinor);
  const hist = Array.isArray(s.history) ? s.history : [];
  if (hist.length) {
    const governing = hist
      .filter((h) => h && typeof h.from_month === 'string' && h.from_month <= m)
      .sort((a, b) => String(a.from_month).localeCompare(String(b.from_month)))
      .pop();
    if (governing && Number.isFinite(Number(governing.percent)) && Number.isFinite(Number(governing.fixed_minor))) {
      percent = Number(governing.percent);
      const byCur = isObj(governing.fixed_minor_by_currency) ? wholeMinor(governing.fixed_minor_by_currency[cur]) : null;
      fixedMinor = byCur !== null ? byCur : Number(governing.fixed_minor);
      fromMonth = governing.from_month;
      source = 'history';
    }
  }
  return { percent, fixedMinor, fromMonth, source };
}

// What FranPOS keeps on one payment: the percent part rounded half up (the
// same Math.floor(x + 0.5) commissionForAmount uses), plus the fixed fee.
export function resellerMarginFor(amountMinor, rate) {
  const amount = Number(amountMinor);
  const pct = Number(rate?.percent);
  const fixed = Number(rate?.fixedMinor);
  const percentMinor = Number.isFinite(amount) && Number.isFinite(pct) ? Math.floor((amount * pct) / 100 + 0.5) : 0;
  const fixedMinor = Number.isFinite(fixed) ? Math.round(fixed) : 0;
  return { percentMinor, fixedMinor, totalMinor: percentMinor + fixedMinor };
}

// A percent the way the terms write it: at least two decimals, never more
// than it needs. 0.1 is "0.10", 0.125 is "0.125", 1 is "1.00".
function percentWords(p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return '0.00';
  const plain = String(Number(n.toFixed(4)));
  const [whole, dec = ''] = plain.split('.');
  return `${whole}.${dec.padEnd(2, '0')}`;
}

// The minor unit word: p for GBP, c for USD, EUR and anything else.
function minorWord(currency) {
  return curOf(currency) === 'GBP' ? 'p' : 'c';
}

// One currency's rate in plain words: "0.10% + 3p" for GBP, "0.10% + 5c" for
// USD or EUR.
export function resellerRateLine(rate, currency) {
  const fixed = Number(rate?.fixedMinor);
  return `${percentWords(rate?.percent)}% + ${Number.isFinite(fixed) ? Math.round(fixed) : 0}${minorWord(currency)}`;
}

// The whole rate on one line for the FranPOS screen:
// "Interchange + 0.10% + 3p (GBP), 5c (USD), 5c (EUR)".
export function resellerRateSummary(percent, fixedByCurrency) {
  const f = isObj(fixedByCurrency) ? fixedByCurrency : {};
  const fixed = RESELLER_CURRENCIES
    .filter((c) => f[c] !== null && f[c] !== undefined && Number.isFinite(Number(f[c])))
    .map((c) => `${Math.round(Number(f[c]))}${minorWord(c)} (${c})`);
  return `Interchange + ${percentWords(percent)}%${fixed.length ? ` + ${fixed.join(', ')}` : ''}`;
}

// The fixed fee for every editor currency in one month: { GBP, USD, EUR }.
export function resellerFixedTable(settings, month) {
  const out = {};
  for (const c of RESELLER_CURRENCIES) out[c] = resellerRateFor(settings, c, month).fixedMinor;
  return out;
}

// The editor's three boxes, checked the same way on the screen and in
// payments-admin: whole numbers 0 to 100, only GBP, USD and EUR. Answers
// { fixed, error }: fixed is the clean map (null when nothing was given),
// error one plain sentence naming the box.
// requireAll (the server's setter): when a map is given at all, every editor
// currency must hold a fee. A blank or missing one is refused ("Type the
// fixed fee for USD."), so one currency's pence can never stand in for
// another currency's cents.
export function parseFixedByCurrency(raw, { requireAll = false } = {}) {
  if (raw === null || raw === undefined) return { fixed: null, error: null };
  if (!isObj(raw)) return { fixed: null, error: 'The fixed fee per payment must be given per currency.' };
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const cur = curOf(k);
    if (!RESELLER_CURRENCIES.includes(cur)) return { fixed: null, error: `The fixed fee can only be set for ${RESELLER_CURRENCIES.join(', ')}.` };
    if (v === null || v === undefined || v === '') continue;
    const n = wholeMinor(v);
    if (n === null) {
      return { fixed: null, error: `The fixed fee for ${cur} must be a whole number of ${cur === 'GBP' ? 'pence' : 'cents'}, 0 to 100.` };
    }
    out[cur] = n;
  }
  if (requireAll) {
    const missing = RESELLER_CURRENCIES.find((c) => out[c] === undefined);
    if (missing) return { fixed: null, error: `Type the fixed fee for ${missing}.` };
  }
  return { fixed: Object.keys(out).length ? out : null, error: null };
}
