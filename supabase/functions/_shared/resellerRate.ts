// supabase/functions/_shared/resellerRate.ts
//
// What FranPOS keeps on each card payment, per currency. PURE: no Deno APIs,
// no Supabase, no network.
//
// MIRROR: src/lib/payments/resellerRate.js carries the SAME helpers (Deno
// cannot import from src/). KEEP IN SYNC: change both or neither.
// src/lib/payments/resellerRate.test.js is the contract for both copies.
//
// THE MODEL (owner, 10 Sep 2026). FranPOS owns the Adyen platform and keeps
// its margin on every payment: 0.10% of the sale plus a FIXED fee per payment.
// The fixed fee is 5 US cents in the contract, which is 3p in GBP. So the
// fixed fee is per CURRENCY, while the percent is one number.
//
// WHERE IT IS KEPT. platform_settings:
//   adyen_reseller_buy_percent       the current percent
//   adyen_reseller_buy_fixed_minor   the current fixed fee (one number, old readers)
//   adyen_reseller_rate_history      [{ percent, fixed_minor, fixed_minor_by_currency?,
//                                       from_month 'YYYY-MM', set_by, set_at }]
// A history entry governs from its month onward. fixed_minor_by_currency
// ({ GBP, USD, EUR }) arrived 10 Sep 2026; an entry without it reads exactly
// as before.
//
// Used by payments-admin (reseller_statement, reseller_invoice_create,
// reseller_config) and adyen-terminal-admin (payment_breakdown).

export interface ResellerSettings { history?: unknown; buyPercent?: unknown; buyFixedMinor?: unknown }
type Dict = Record<string, any>;
export interface ResellerRate { percent: number; fixedMinor: number; fromMonth: string | null; source: 'history' | 'settings' | 'default' }
export interface ResellerMargin { percentMinor: number; fixedMinor: number; totalMinor: number }

// The signed terms per currency: 5c is 3p. Prefill and placeholder only; the
// rate on file always wins (resellerRateFor never reads these).
export const RESELLER_DEFAULT_FIXED_BY_CURRENCY: Readonly<Record<string, number>> = Object.freeze({ GBP: 3, USD: 5, EUR: 5 });

// The currencies the editor offers, in the order it lists them.
export const RESELLER_CURRENCIES: readonly string[] = Object.freeze(['GBP', 'USD', 'EUR']);

// The fallbacks payments-admin has always used when nothing is on file.
const FALLBACK_PERCENT = 0.10;
const FALLBACK_FIXED_MINOR = 5;

const isObj = (v: unknown): v is Dict => !!v && typeof v === 'object' && !Array.isArray(v);
const curOf = (c: unknown): string => String(c ?? '').trim().toUpperCase() || 'GBP';

// A whole number of minor units, 0 to 100, or null.
function wholeMinor(v: unknown): number | null {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 100 ? n : null;
}

// The rate that governs one currency in one month. See the JS copy for the
// full contract; the choice of the governing entry is payments-admin's own.
export function resellerRateFor(settings: ResellerSettings | null | undefined, currency: unknown, month: unknown): ResellerRate {
  const s: Dict = isObj(settings) ? settings : {};
  const cur = curOf(currency);
  const m = String(month ?? '');
  let percent = FALLBACK_PERCENT;
  let fixedMinor = FALLBACK_FIXED_MINOR;
  let source: ResellerRate['source'] = 'default';
  let fromMonth: string | null = null;
  if (s.buyPercent !== null && s.buyPercent !== undefined) { percent = Number(s.buyPercent); source = 'settings'; }
  if (s.buyFixedMinor !== null && s.buyFixedMinor !== undefined) fixedMinor = Number(s.buyFixedMinor);
  const hist: Dict[] = Array.isArray(s.history) ? s.history : [];
  if (hist.length) {
    const governing = hist
      .filter((h: Dict) => h && typeof h.from_month === 'string' && h.from_month <= m)
      .sort((a: Dict, b: Dict) => String(a.from_month).localeCompare(String(b.from_month)))
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

// What FranPOS keeps on one payment: the percent part rounded half up, plus
// the fixed fee.
export function resellerMarginFor(amountMinor: unknown, rate: { percent?: unknown; fixedMinor?: unknown } | null | undefined): ResellerMargin {
  const amount = Number(amountMinor);
  const pct = Number(rate?.percent);
  const fixed = Number(rate?.fixedMinor);
  const percentMinor = Number.isFinite(amount) && Number.isFinite(pct) ? Math.floor((amount * pct) / 100 + 0.5) : 0;
  const fixedMinor = Number.isFinite(fixed) ? Math.round(fixed) : 0;
  return { percentMinor, fixedMinor, totalMinor: percentMinor + fixedMinor };
}

// A percent the way the terms write it: at least two decimals.
function percentWords(p: unknown): string {
  const n = Number(p);
  if (!Number.isFinite(n)) return '0.00';
  const plain = String(Number(n.toFixed(4)));
  const [whole, dec = ''] = plain.split('.');
  return `${whole}.${dec.padEnd(2, '0')}`;
}

// The minor unit word: p for GBP, c for USD, EUR and anything else.
function minorWord(currency: unknown): string {
  return curOf(currency) === 'GBP' ? 'p' : 'c';
}

// One currency's rate in plain words: "0.10% + 3p", "0.10% + 5c".
export function resellerRateLine(rate: { percent?: unknown; fixedMinor?: unknown } | null | undefined, currency: unknown): string {
  const fixed = Number(rate?.fixedMinor);
  return `${percentWords(rate?.percent)}% + ${Number.isFinite(fixed) ? Math.round(fixed) : 0}${minorWord(currency)}`;
}

// "Interchange + 0.10% + 3p (GBP), 5c (USD), 5c (EUR)".
export function resellerRateSummary(percent: unknown, fixedByCurrency: unknown): string {
  const f: Dict = isObj(fixedByCurrency) ? fixedByCurrency : {};
  const fixed = RESELLER_CURRENCIES
    .filter((c) => f[c] !== null && f[c] !== undefined && Number.isFinite(Number(f[c])))
    .map((c) => `${Math.round(Number(f[c]))}${minorWord(c)} (${c})`);
  return `Interchange + ${percentWords(percent)}%${fixed.length ? ` + ${fixed.join(', ')}` : ''}`;
}

// The fixed fee for every editor currency in one month: { GBP, USD, EUR }.
export function resellerFixedTable(settings: ResellerSettings | null | undefined, month: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of RESELLER_CURRENCIES) out[c] = resellerRateFor(settings, c, month).fixedMinor;
  return out;
}

// The editor's three boxes: whole numbers 0 to 100, only GBP, USD and EUR.
// requireAll: when a map is given, every editor currency must hold a fee.
export function parseFixedByCurrency(raw: unknown, { requireAll = false }: { requireAll?: boolean } = {}): { fixed: Record<string, number> | null; error: string | null } {
  if (raw === null || raw === undefined) return { fixed: null, error: null };
  if (!isObj(raw)) return { fixed: null, error: 'The fixed fee per payment must be given per currency.' };
  const out: Record<string, number> = {};
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
