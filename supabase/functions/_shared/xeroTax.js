// supabase/functions/_shared/xeroTax.js
//
// WHICH XERO TAX RATE EACH SERVOS SALE POSTS AT. Pure JS with no imports: xero-sales and
// xero-config ship it, the Back Office mapping screen and `npm test` load the same file.
//
// Why it exists (28 Sep 2026):
//   - the old picker took the first ACTIVE Xero rate at 20%. In a UK org that is INPUT2
//     "20% (VAT on Expenses)", which Xero refuses on a revenue account, so Leeds could not
//     post 26 Sep. Only rates Xero allows on REVENUE are ever picked now, and a cached INPUT2
//     heals on the next real run (healedTaxType);
//   - every sale posted at ONE rate, so zero rated food carried 20% VAT. Each ServOS tax rate
//     now maps to its own Xero rate (mapping.taxRateMap, else a match by percentage), and a
//     rate with no match is never guessed: the day is refused until it is mapped;
//   - service charge posted at the sales rate, but ServOS books no VAT on it. It posts No VAT
//     unless the operator opts in (mapping.serviceTax, or serviceTaxable true).
// Line labels come from ServOS percentages and our own TaxType codes, never from Xero's rate
// names (people rename them), so a retry sends the same payload.
//
// A "bucket" (built by accountingDay.js) is { key, pct, mode, rateId, name, code, zeroKind }:
// key 'rate:<id>' a venue tax rate, 'pct:<p>' a percentage no venue rate has, 'none' goods
// with no rate, 'excl' added-on (US) sales tax, 'default' the venue's rates are unknown.

/** Xero codes that only ever apply to purchases, capital or liabilities: never a sales rate. */
export const EXPENSE_TAX_RE = /INPUT|ACQUISITIONS|REVERSECHARGES|GSTONIMPORTS|^CAPEX|DRCHARGESUPPLY/;
// Codes only ever used on sales (the purchases fallback when Xero leaves the flags out).
const SALES_ONLY_RE = /OUTPUT|^DRCHARGE\d/;
// Sales codes for special regimes (reverse charge, EU): never picked by percentage alone.
const SPECIAL_SALES_RE = /^DRCHARGE|^EC|MOSS/;
const TAX_TYPE_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Xero's example sends these flags as strings, its spec as booleans; missing means unknown.
const flag = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : null);
const isActive = (r) => String(r?.Status || 'ACTIVE').toUpperCase() === 'ACTIVE';
// Xero's automated US sales tax and Avalara rates do not work through the API.
const apiUsable = (r) => !/^(USSALESTAX|AVALARA)$/i.test(String(r?.ReportTaxType || '')) && String(r?.TaxType || '').toUpperCase() !== 'AVALARA';
const view = (r) => ({ taxType: String(r.TaxType), name: String(r.Name || r.TaxType), rate: Number(r.EffectiveRate) || 0 });
const byType = (a, b) => a.taxType.localeCompare(b.taxType);
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.0005;

/** True when Xero allows this rate on a revenue account (its flag, else by code). */
export function canApplyToRevenue(r) {
  const f = flag(r?.CanApplyToRevenue);
  return f ?? !EXPENSE_TAX_RE.test(String(r?.TaxType || ''));
}

/** True when Xero allows this rate on an expense account (its flag, else by code). */
export function canApplyToExpenses(r) {
  const f = flag(r?.CanApplyToExpenses);
  return f ?? !SALES_ONLY_RE.test(String(r?.TaxType || ''));
}

const usable = (r) => r && r.TaxType && isActive(r) && apiUsable(r);

/** Xero's /TaxRates list narrowed to ACTIVE rates allowed on sales: [{ taxType, name, rate }] by code. */
export function revenueTaxRates(list) {
  return (Array.isArray(list) ? list : []).filter((r) => usable(r) && canApplyToRevenue(r)).map(view).sort(byType);
}

/** The same for purchases (the VAT on purchases dropdown). */
export function expenseTaxRates(list) {
  return (Array.isArray(list) ? list : []).filter((r) => usable(r) && canApplyToExpenses(r)).map(view).sort(byType);
}

// Xero's own UK sales codes, preferred when the org has them.
const PREFERRED = { 20: 'OUTPUT2', 5: 'RROUTPUT' };
const KNOWN_RATE = { OUTPUT2: 20, RROUTPUT: 5, ZERORATEDOUTPUT: 0, EXEMPTOUTPUT: 0, NONE: 0 };
// rev null means a dry run with no cached list: a UK org is assumed.
const has = (rev, tt) => tt === 'NONE' || (rev ? rev.some((r) => r.taxType === tt) : true);

/** The percentage of a Xero TaxType: the org's list first, else Xero's own UK codes. Null when unknown. */
export function rateOf(taxType, rev = null) {
  if (!taxType) return null;
  const r = Array.isArray(rev) ? rev.find((x) => x.taxType === taxType) : null;
  if (r) return Number(r.rate) || 0;
  return KNOWN_RATE[taxType] ?? null;
}

/** True when `tt` may go on a sales line: NONE, else a revenue rate the org has (by code when the list is unknown). */
export function isSalesType(tt, rev = null) {
  if (!tt || typeof tt !== 'string') return false;
  if (tt === 'NONE') return true;
  return Array.isArray(rev) ? rev.some((r) => r.taxType === tt) : !EXPENSE_TAX_RE.test(tt);
}

/**
 * The Xero sales rate for a percentage, or null when the org has none (never an expense
 * rate). 0%: 'outside' the scope of VAT is NONE, exempt is EXEMPTOUTPUT, anything else zero
 * rated (NONE in a US or global org, where NONE is "Tax Exempt").
 */
export function pickSalesTaxType(rev, { pct, zeroKind } = {}) {
  if (pct == null || !Number.isFinite(Number(pct))) return null;
  if (pct > 0) {
    const p = PREFERRED[pct];
    if (p && has(rev, p)) return p;
    return (Array.isArray(rev) ? rev : []).find((r) => r.taxType !== 'NONE' && !SPECIAL_SALES_RE.test(r.taxType) && near(r.rate, pct))?.taxType || null;
  }
  if (zeroKind === 'outside') return 'NONE';
  if (zeroKind === 'exempt' && has(rev, 'EXEMPTOUTPUT')) return 'EXEMPTOUTPUT';
  return has(rev, 'ZERORATEDOUTPUT') ? 'ZERORATEDOUTPUT' : 'NONE';
}

/**
 * The Xero TaxType one bucket posts at. ctx = { mapping, revenueRates, detail }.
 * Returns { taxType, source, invalid } where source is
 *   'no_vat'    not VAT registered (salesNoVat, or the older taxDefault 'NONE'): everything NONE
 *   'mapped'    the operator chose it for this ServOS rate (taxRateMap)
 *   'legacy'    the older single taxDefault, used only at its own percentage
 *   'auto'      matched by percentage in the org's list ('assumed' with no list: a dry run)
 *   'unmapped'  no match: taxType null, and the day must not post
 * `invalid` names a chosen code that is not a sales rate (ignored, and warned about).
 * Added-on sales tax ('excl') keeps today's single line at the default rate: a separate Sales
 * Tax Payable line is a later slice.
 */
export function resolveSalesTaxType(bucket, { mapping = {}, revenueRates: rev = null, detail = {} } = {}) {
  const m = mapping || {};
  const b = bucket?.key === 'excl' ? { key: 'default', pct: null } : (bucket || { key: 'default', pct: null });
  const ok = (tt) => isSalesType(tt, rev);
  if (m.salesNoVat === true || m.taxDefault === 'NONE') return { taxType: 'NONE', source: 'no_vat', invalid: null };
  const own = m.taxRateMap && typeof m.taxRateMap === 'object' ? m.taxRateMap[b.rateId || b.key] : null;
  if (own && ok(own)) return { taxType: own, source: 'mapped', invalid: null };
  const invalid = own && !ok(own) ? own : (m.taxDefault && !ok(m.taxDefault) ? m.taxDefault : null);
  const legacy = ok(m.taxDefault) ? m.taxDefault : null;
  if (legacy && (b.key === 'default' || (b.pct > 0 && near(rateOf(legacy, rev), b.pct)))) return { taxType: legacy, source: 'legacy', invalid };
  if (b.key === 'default') {
    return { taxType: ok(detail?.taxType) ? detail.taxType : (pickSalesTaxType(rev, { pct: 20 }) || 'NONE'), source: 'auto', invalid };
  }
  const auto = pickSalesTaxType(rev, b.key === 'none' ? { pct: 0 } : b);
  return auto ? { taxType: auto, source: rev ? 'auto' : 'assumed', invalid } : { taxType: null, source: 'unmapped', invalid };
}

/**
 * The TaxType for the service charge line. ServOS books no VAT on service charge (an optional
 * one is outside the scope of VAT), so NONE unless the operator chose a rate (serviceTax) or
 * said it is taxable (serviceTaxable, then the venue's default rate). Null when that default
 * rate has no Xero match (the day must not post). A venue that adds tax on top (US, default
 * bucket 'excl') keeps today's rule, the sales line's rate, so US postings do not change.
 */
export function serviceTaxType(ctx = {}, defaultBucket = null) {
  const m = ctx.mapping || {};
  if (m.salesNoVat === true || m.taxDefault === 'NONE' || m.serviceTaxable === false) return 'NONE';
  if (m.serviceTax && isSalesType(m.serviceTax, ctx.revenueRates ?? null)) return m.serviceTax;
  if (m.serviceTaxable === true || defaultBucket?.key === 'excl') return resolveSalesTaxType(defaultBucket || { key: 'default', pct: null }, ctx).taxType;
  return 'NONE';
}

/** The default sales TaxType kept in xero_config.detail: kept when it is a sales rate, else picked again. */
export function healedTaxType(detail, rev) {
  return isSalesType(detail?.taxType, rev) ? detail.taxType : (pickSalesTaxType(rev, { pct: 20 }) || 'NONE');
}

/** The VAT Xero works out on a tax inclusive line (per line, net rounded half up): 123309 at 20 is 20551. */
export const inclusiveTaxMinor = (L, pct) => (Number(pct) > 0 ? L - Math.round((L * 100) / (100 + Number(pct))) : 0);

/**
 * The words after a sales line's description. Empty for today's single line (the default
 * rate, added-on tax, or not VAT registered), so those payloads read exactly as before.
 */
export function lineLabel(b, tt) {
  if (!b || b.key === 'default' || b.key === 'excl') return '';
  if (b.key === 'none') return 'no tax rate';
  if (b.pct > 0) return `${b.pct}%`;
  if (tt === 'ZERORATEDOUTPUT') return 'zero rated';
  if (tt === 'EXEMPTOUTPUT') return 'exempt';
  if (tt === 'NONE') return 'no VAT';
  return '0%';
}

/** Null when a mapping's sales tax choices are acceptable, else a message for the person saving it. */
export function validateTaxMapping(m) {
  if (m == null) return null;
  if (typeof m !== 'object' || Array.isArray(m)) return 'The account mapping must be a set of choices.';
  const bad = (v) => v != null && v !== '' && (typeof v !== 'string' || !TAX_TYPE_RE.test(v) || EXPENSE_TAX_RE.test(v));
  const why = (v, what) => `${String(v)} cannot be used for ${what}. Choose a Xero rate for income (VAT on Income), not one for expenses.`;
  const map = m.taxRateMap;
  if (map != null) {
    if (typeof map !== 'object' || Array.isArray(map)) return 'The VAT on sales choices must pair each ServOS rate with a Xero rate.';
    for (const [k, v] of Object.entries(map)) {
      if (k.length > 80) return 'A VAT on sales choice names an unknown ServOS rate.';
      if (bad(v)) return why(v, 'sales');
    }
  }
  if (bad(m.serviceTax)) return why(m.serviceTax, 'service charge');
  if (bad(m.taxDefault)) return why(m.taxDefault, 'sales');
  for (const k of ['salesNoVat', 'serviceTaxable']) {
    if (m[k] != null && typeof m[k] !== 'boolean') return `${k} must be true or false.`;
  }
  return null;
}

/**
 * The Back Office's one time move from the older single taxDefault to per rate choices, on
 * load (the next save stores the result). 'NONE' ticks "Not VAT registered". A sales rate
 * becomes the choice of every ServOS rate at its percentage with none yet, exactly where the
 * server applied it (resolveSalesTaxType). An expense code is dropped (it never worked on
 * sales). taxDefault stays, shown on the screen, where the server still uses it for whole
 * sales: a venue with added-on (US) tax, or with no active inclusive default rate (checks
 * with no breakdown post at it). Nothing moves while either list is missing.
 */
export function migrateTaxMapping(mapping, { servosTaxRates = [], salesTaxRates = [] } = {}) {
  const m = { ...(mapping || {}) };
  const td = m.taxDefault;
  if (td == null || td === '') return m;
  if (td === 'NONE') { m.salesNoVat = true; delete m.taxDefault; return m; }
  if (typeof td !== 'string' || !TAX_TYPE_RE.test(td) || EXPENSE_TAX_RE.test(td)) { delete m.taxDefault; return m; }
  const servos = Array.isArray(servosTaxRates) ? servosTaxRates : [];
  const sales = Array.isArray(salesTaxRates) ? salesTaxRates : [];
  if (!servos.length || !sales.length || servos.some((r) => r.mode === 'exclusive')) return m;
  const x = sales.find((r) => r.taxType === td);
  if (x) {
    for (const r of servos) {
      if (r.mode !== 'inclusive' || !(r.pct > 0) || !near(x.rate, r.pct) || m.taxRateMap?.[r.id]) continue;
      m.taxRateMap = { ...(m.taxRateMap || {}), [r.id]: td };
    }
  }
  // 28 Sep 2026: with no active inclusive default, checks with no breakdown still post at it.
  if (!servos.some((r) => r.isDefault && r.active !== false && r.mode === 'inclusive')) return m;
  delete m.taxDefault;
  return m;
}
