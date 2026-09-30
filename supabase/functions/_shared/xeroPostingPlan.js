// supabase/functions/_shared/xeroPostingPlan.js
//
// Turns one neutral accounting day (_shared/accountingDay.js buildAccountingDay) into the
// Xero bank transactions xero-sales posts. Pure JS, no network: xero-sales provisions any
// default accounts the plan needs, then sends the payloads. A QuickBooks integration writes
// its own planner over the SAME day summary; nothing in accountingDay.js is Xero shaped.
//
// The model (unchanged in spirit since v5.5.782, reconciliation first):
//   - every tender method lands in a Xero BANK "clearing" account (operator mapping, else a
//     default per tender KIND), so each processor payout or cash banking reconciles there;
//   - per clearing account, ONE "Receive Money" transaction for the day's takings and, when
//     there were refunds that day, ONE "Spend Money" transaction for the money that went back
//     (Xero will not take a negative bank transaction, and a separate refund line lets the
//     accountant see both sides of the payout);
//   - lines split the money into goods (revenue account, VAT via the tax rate, amounts are
//     tax INCLUSIVE), tips (never revenue, never VAT) and service charge.
//
// v5.9.11 defaults (19 Sep 2026): gift card redemptions, booking deposits and money we
// cannot place ('unallocated', old split bills) each get their own clearing account instead
// of falling into card clearing, which never matched the card payout. Unmapped tips and
// service charge post to their own liability accounts instead of revenue.
//
// VAT per rate (28 Sep 2026): inside each transaction the one goods line became one goods line
// per Xero TaxType (from the day's byRate split, _shared/accountingDay.js), chosen by
// _shared/xeroTax.js: never an expense rate, never 20% on zero rated food, and a ServOS rate
// with no Xero match blocks the day (plan.blocked) instead of being guessed (one estimated only
// from checks with no saved breakdown posts at the default rate, as before, and is warned
// about). Transaction keys and references are unchanged, so a half posted day still finishes
// without posting twice. Service charge posts No VAT unless the operator opts in (a venue that
// adds tax on top keeps today's rate, so US postings do not change); tips stay No VAT.

import { resolveSalesTaxType, serviceTaxType, lineLabel, inclusiveTaxMinor, rateOf, isSalesType } from './xeroTax.js';
import { taxContext } from './accountingDay.js';

export const DEFAULT_ACCOUNTS = {
  cardClearing: { name: 'ServOS Card Clearing', type: 'BANK', number: 'SERVOS-CARD-CLR', code: 'SOSCARDCLR', detailKey: 'cardClearingId' },
  cashClearing: { name: 'ServOS Cash Clearing', type: 'BANK', number: 'SERVOS-CASH-CLR', code: 'SOSCASHCLR', detailKey: 'cashClearingId' },
  giftClearing: { name: 'ServOS Gift Card Clearing', type: 'BANK', number: 'SERVOS-GIFT-CLR', code: 'SOSGIFTCLR', detailKey: 'giftClearingId' },
  depositClearing: { name: 'ServOS Deposits Clearing', type: 'BANK', number: 'SERVOS-DEP-CLR', code: 'SOSDEPCLR', detailKey: 'depositClearingId' },
  unallocatedClearing: { name: 'ServOS Unallocated Clearing', type: 'BANK', number: 'SERVOS-UNALLOC', code: 'SOSUNALLOC', detailKey: 'unallocatedClearingId' },
  tipsPayable: { name: 'ServOS Tips Payable', type: 'CURRLIAB', code: 'SOSTIPS', detailKey: 'tipsAccountCode' },
  servicePayable: { name: 'ServOS Service Charge Payable', type: 'CURRLIAB', code: 'SOSSVCCHG', detailKey: 'serviceAccountCode' },
};

/** Default clearing account per tender kind. 'other' (a method we do not recognise) keeps the old card default and is flagged. */
export const KIND_ACCOUNT = { card: 'cardClearing', cash: 'cashClearing', gift_card: 'giftClearing', deposit: 'depositClearing', unallocated: 'unallocatedClearing', other: 'cardClearing' };

// Loyalty rewards and promo codes lower the sale; they are not money and never post as takings.
const isMoney = (r) => r.kind !== 'discount';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A mapped account value: a Xero AccountID (the mapping screen stores the id when an account has no code) or a code. */
export function accountRef(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  return UUID.test(v) ? { AccountID: v } : { AccountCode: v };
}

/**
 * The mapped bank account for a tender row. An older row's method exactly as the till wrote
 * it comes first (that is the key the mapping screen showed before v5.9.11), then the method.
 */
function mappedBank(row, paymentMap) {
  const keys = [...(row.rawMethods || []), row.method];
  for (const k of keys) {
    const v = paymentMap?.[k];
    if (v) return v;
  }
  return null;
}

/**
 * Which default accounts the day needs (so xero-sales creates only those in Xero).
 * Returns an array of DEFAULT_ACCOUNTS keys.
 */
export function requiredDefaults(summary, mapping = {}) {
  const need = new Set();
  const rows = [...(summary?.sales?.byMethod || []), ...(summary?.refunds?.byMethod || [])];
  for (const r of rows) {
    if (!r.gross || !isMoney(r)) continue;
    if (!mappedBank(r, mapping.paymentMap)) need.add(KIND_ACCOUNT[r.kind] || 'cardClearing');
    if (r.tip > 0 && !mapping.tipsAccount) need.add('tipsPayable');
    if (r.service > 0 && !mapping.serviceAccount) need.add('servicePayable');
  }
  return [...need];
}

const minorToMajor = (m) => Math.round(m) / 100;

// The venue's rates unknown (a summary built without them): today's single line.
const DEFAULT_BUCKET = { key: 'default', pct: null, mode: 'default', rateId: null, name: 'Default rate' };

/** Short, stable, readable id for a reference: the first 8 characters of the bank account id. */
const shortId = (id) => String(id || '').replace(/-/g, '').slice(0, 8) || 'none';

/**
 * Plan the day. `detail` holds the resolved default account ids and codes (xero_config.detail,
 * with the org's sales tax rates in detail.salesTaxRates); `mapping` is xero_config.mapping.
 * Returns { transactions, warnings, blocked } where each transaction is { key, direction,
 * accountId, accountDefault, methods, totals:{gross,tip,service,sales,tax,byRate}, reference,
 * payload, vat } and payload is the Xero BankTransaction object (no wrapper). vat is
 * { lines:[{taxType, label, amount, taxBooked, taxXero, compare}], booked, xero } in minor
 * units: the VAT ServOS booked against what Xero will work out from the lines. `blocked` lists
 * the ServOS rates with no Xero sales rate: such a day must not be posted.
 */
/**
 * @param {any} summary
 * @param {{ mapping?: any, detail?: any, sample?: boolean, site?: { name?: string } | null }} [opts]
 * @returns {any}
 */
export function planXeroDay(summary, { mapping = {}, detail = {}, sample = false, site = null } = {}) {
  const warnings = [];
  const date = summary.date;
  // 30 Sep 2026: the site's name in every reference and line, so two sites posting to one Xero
  // org never share a reference. With no site (demo) the payloads read exactly as before.
  const siteName = String(site?.name || '').trim();
  const at = siteName ? `${siteName} ${date}` : date;
  const paymentMap = mapping.paymentMap || {};
  const revenueRef = accountRef(mapping.revenueAccount) || accountRef(detail.salesAccountCode) || { AccountCode: '200' };
  const tipsRef = accountRef(mapping.tipsAccount) || accountRef(detail.tipsAccountCode);
  const serviceRef = accountRef(mapping.serviceAccount) || accountRef(detail.serviceAccountCode);

  // The rate for each ServOS tax bucket, resolved once per day.
  const rev = Array.isArray(detail.salesTaxRates) ? detail.salesTaxRates : null;
  const rctx = { mapping, revenueRates: rev, detail };
  const bucketList = Array.isArray(summary.taxBuckets) ? summary.taxBuckets : [];
  const buckets = new Map(bucketList.map((b) => [b.key, b]));
  const rank = new Map(bucketList.map((b, i) => [b.key, i]));
  const bucketOf = (k) => buckets.get(k) || (k === 'default' ? DEFAULT_BUCKET : { key: k, pct: null, mode: 'inclusive', rateId: null, name: k });
  const resolved = new Map();
  const resolve = (b) => {
    if (!resolved.has(b.key)) resolved.set(b.key, resolveSalesTaxType(b, rctx));
    return resolved.get(b.key);
  };
  const blocked = new Map();
  const invalid = new Set();
  const fellBack = new Map();
  let unrated = 0;
  // A rate with no Xero match refuses the day, except one only checks with no saved VAT
  // breakdown fed (an estimate from the venue default rate): that posts at the default rate,
  // as it did before 28 Sep, and is warned about, instead of refusing the day on a guess.
  const resolveLine = (b) => {
    const r = resolve(b);
    if (r.taxType || !b.estimated) return { r, plain: false };
    if (r.invalid) invalid.add(r.invalid);
    fellBack.set(b.key, b);
    return { r: resolve(DEFAULT_BUCKET), plain: true };
  };
  const serviceTax = serviceTaxType(rctx, summary.defaultTaxBucket || DEFAULT_BUCKET);
  if (mapping.serviceTax && !isSalesType(mapping.serviceTax, rev)) invalid.add(mapping.serviceTax);

  const defaulted = new Set();
  const groups = new Map();   // key -> group
  const add = (direction, rows) => {
    for (const r of rows || []) {
      if (!r.gross || !isMoney(r)) continue;
      const mapped = mappedBank(r, paymentMap);
      const def = mapped ? null : (KIND_ACCOUNT[r.kind] || 'cardClearing');
      if (!mapped && r.kind === 'other') defaulted.add(r.method);
      const accountId = mapped || detail[DEFAULT_ACCOUNTS[def].detailKey] || null;
      const key = `${direction}:${accountId || def}`;
      const g = groups.get(key) || { key, direction, accountId, accountDefault: def, methods: [], totals: { gross: 0, tip: 0, service: 0, sales: 0, tax: 0, byRate: {} } };
      if (!g.methods.includes(r.method)) g.methods.push(r.method);
      g.totals.gross += r.gross; g.totals.tip += r.tip; g.totals.service += r.service; g.totals.sales += r.sales; g.totals.tax += r.tax || 0;
      for (const [k, v] of Object.entries(r.byRate || {})) {
        const e = g.totals.byRate[k] || (g.totals.byRate[k] = { sales: 0, tax: 0 });
        e.sales += v.sales; e.tax += v.tax;
      }
      groups.set(key, g);
    }
  };
  add('RECEIVE', summary.sales?.byMethod);
  add('SPEND', summary.refunds?.byMethod);

  if (defaulted.size) {
    warnings.push({ code: 'method_defaulted', message: `Payment methods with no bank account chosen went to Card Clearing: ${[...defaulted].join(', ')}. Choose an account for them under Account mapping.`, methods: [...defaulted] });
  }
  const anyTip = [...groups.values()].some((g) => g.totals.tip > 0);
  const anyService = [...groups.values()].some((g) => g.totals.service > 0);
  if (anyTip && !mapping.tipsAccount) warnings.push({ code: 'tips_unmapped', message: 'Tips have no account chosen, so they post to ServOS Tips Payable (money owed to staff, never sales).' });
  if (anyService && !mapping.serviceAccount) warnings.push({ code: 'service_unmapped', message: 'Service charge has no account chosen, so it posts to ServOS Service Charge Payable. Choose where it belongs under Account mapping.' });

  // One goods line per Xero TaxType (and label), in bucket order. Lines with a label (a ServOS
  // rate) are the ones whose VAT is checked; the unlabelled line is today's single line.
  const goodsLines = (g) => {
    const entries = { ...g.totals.byRate };
    let covered = 0, coveredTax = 0;
    for (const v of Object.values(entries)) { covered += v.sales; coveredTax += v.tax; }
    // Money the split does not cover (a summary built without the venue's rates) is the default rate, as before.
    if (g.totals.sales !== covered) {
      const d = entries.default || { sales: 0, tax: 0 };
      entries.default = { sales: d.sales + g.totals.sales - covered, tax: d.tax + g.totals.tax - coveredTax };
    }
    const keys = Object.keys(entries).sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9) || a.localeCompare(b));
    const lines = new Map();
    for (const k of keys) {
      const v = entries[k];
      if (!v.sales && !v.tax) continue;
      const b = bucketOf(k);
      const { r, plain: fallback } = resolveLine(b);
      if (r.invalid) invalid.add(r.invalid);
      if (!r.taxType && v.sales) blocked.set(b.key, { key: b.key, name: b.name || b.key, pct: b.pct ?? null });
      if (k === 'none' && v.sales > 0 && r.source !== 'mapped' && r.source !== 'no_vat') unrated += v.sales;
      const plain = fallback || r.source === 'no_vat' || k === 'default' || k === 'excl';
      const label = plain ? '' : lineLabel(b, r.taxType);
      const id = `${r.taxType}|${label}`;
      const line = lines.get(id) || { taxType: r.taxType, label, pct: b.pct ?? null, amount: 0, taxBooked: 0, taxXero: 0, compare: !plain && !!r.taxType };
      line.amount += v.sales; line.taxBooked += v.tax;
      lines.set(id, line);
    }
    const out = [...lines.values()].filter((l) => l.amount !== 0);
    for (const l of out) l.taxXero = inclusiveTaxMinor(l.amount, rateOf(l.taxType, rev) ?? l.pct ?? 0);
    return out;
  };

  const transactions = [];
  const differs = [];
  for (const g of groups.values()) {
    const refund = g.direction === 'SPEND';
    const label = refund ? 'Refunds' : 'Takings';
    const what = g.methods.join(', ');
    const li = [];
    let vatLines = [];
    let serviceVat = 0;
    if (g.totals.sales > 0) {
      vatLines = goodsLines(g);
      for (const l of vatLines) {
        li.push({ Description: `${refund ? 'Refunded sales' : 'Sales'} ${at} (${what})${l.label ? ` ${l.label}` : ''}`, Quantity: 1, UnitAmount: minorToMajor(l.amount), ...revenueRef, TaxType: l.taxType });
      }
      if (g.totals.tip > 0) li.push({ Description: `${refund ? 'Refunded tips' : 'Tips and gratuities'} ${at}`, Quantity: 1, UnitAmount: minorToMajor(g.totals.tip), ...(tipsRef || revenueRef), TaxType: 'NONE' });
      if (g.totals.service > 0) {
        if (!serviceTax) blocked.set('service', { key: 'service', name: 'Service charge', pct: null });
        serviceVat = inclusiveTaxMinor(g.totals.service, rateOf(serviceTax, rev) ?? 0);
        li.push({ Description: `${refund ? 'Refunded service charge' : 'Service charge'} ${at}`, Quantity: 1, UnitAmount: minorToMajor(g.totals.service), ...(serviceRef || revenueRef), TaxType: serviceTax });
      }
    } else {
      // Odd data (tips plus service at or above the money): one line for the whole amount, never at a VAT rate.
      li.push({ Description: `${label} ${at} (${what})`, Quantity: 1, UnitAmount: minorToMajor(g.totals.gross), ...revenueRef, TaxType: 'NONE' });
    }
    const reference = `ServOS ${label.toLowerCase()} ${at} (${shortId(g.accountId || g.accountDefault)})${sample ? ' TEST' : ''}`;
    const checked = vatLines.filter((l) => l.compare);
    const vat = {
      lines: vatLines.map(({ taxType, label: lb, amount, taxBooked, taxXero, compare }) => ({ taxType, label: lb, amount, taxBooked, taxXero, compare })),
      booked: checked.reduce((s, l) => s + l.taxBooked, 0),
      xero: checked.reduce((s, l) => s + l.taxXero, 0) + serviceVat,
    };
    if (checked.length && Math.abs(vat.xero - vat.booked) > Math.max(5, Math.round(vat.booked * 0.005))) {
      differs.push(`${reference}: Xero ${minorToMajor(vat.xero).toFixed(2)}, ServOS ${minorToMajor(vat.booked).toFixed(2)}`);
    }
    transactions.push({
      key: g.key,
      direction: g.direction,
      accountId: g.accountId,
      accountDefault: g.accountDefault,
      methods: g.methods,
      totals: g.totals,
      reference,
      vat,
      payload: {
        Type: g.direction,
        Contact: detail.contactId ? { ContactID: detail.contactId } : undefined,
        BankAccount: g.accountId ? { AccountID: g.accountId } : undefined,
        Date: date,
        Reference: reference,
        LineAmountTypes: 'Inclusive',
        LineItems: li,
      },
    });
  }
  // Takings before refunds, then by account, so the order is the same on every retry.
  transactions.sort((a, b) => (a.direction === b.direction ? a.key.localeCompare(b.key) : a.direction === 'RECEIVE' ? -1 : 1));

  if (invalid.size) {
    warnings.push({ code: 'tax_mapping_invalid', message: `These Xero rates chosen for sales are not rates for income, so they were ignored: ${[...invalid].join(', ')}. Choose again under Account mapping, VAT on sales.`, taxTypes: [...invalid] });
  }
  const blockedList = [...blocked.values()];
  if (blockedList.length) {
    warnings.push({ code: 'tax_rate_unmapped', message: blockedMessage(blockedList), blocked: blockedList });
  }
  if (fellBack.size) {
    const tt = resolve(DEFAULT_BUCKET).taxType;
    const names = [...fellBack.values()].map((b) => (b.pct != null ? `${b.name} (${b.pct}%)` : b.name)).join(', ');
    warnings.push({ code: 'tax_rate_estimated_default', message: `Checks with no VAT breakdown were taken to be at ${names}, which has no Xero sales rate, so they post at ${tt === 'NONE' ? 'No VAT' : tt}, as before. Choose a Xero rate for it under Account mapping, VAT on sales.` });
  }
  if (unrated > 0) {
    const tt = resolve(bucketOf('none')).taxType;
    warnings.push({ code: 'tax_unrated_goods', message: `${minorToMajor(unrated).toFixed(2)} of sales had no tax rate in ServOS and post as ${tt === 'ZERORATEDOUTPUT' ? 'zero rated' : tt === 'NONE' ? 'No VAT' : tt}. Give those items a tax rate, or choose a Xero rate for "Items with no tax rate" under Account mapping.` });
  }
  if (differs.length) {
    warnings.push({ code: 'vat_differs', message: `The VAT Xero works out from these lines differs from the VAT ServOS booked (rounding per line, discounts, or checks whose VAT was estimated): ${differs.join('; ')}.` });
  }
  return { transactions, warnings, blocked: blockedList };
}

/**
 * The message for a day refused because a ServOS rate has no Xero sales rate. A 'pct:' bucket
 * is a percentage the venue has no rate for (another venue's rate, or a deleted one): it gets
 * its own row under Account mapping once a push has been refused. `partial`: part of the day
 * reached Xero on an earlier attempt, so "nothing more" was posted this time.
 */
export function blockedMessage(blocked, { partial = false } = {}) {
  const names = (blocked || []).map((b) => {
    if (String(b.key || '').startsWith('pct:')) return `${b.pct != null ? `${b.pct}%` : b.name} (a rate this venue does not have)`;
    return b.pct != null && !String(b.name).includes('%') ? `${b.name} (${b.pct}%)` : b.name;
  }).join(', ');
  return `No Xero sales tax rate for ServOS rate(s) ${names}. Choose one under Account mapping, VAT on sales, then push again. Nothing ${partial ? 'more ' : ''}was posted.`;
}

/**
 * The two made up checks xero-sales posts as test figures (only on an empty day, when asked).
 * 28 Sep 2026: built from the venue's OWN tax rates, never a percentage the venue does not
 * have (that refused the test post with nothing to choose under Account mapping). Check 1
 * splits between the default rate and the 0% rate when the venue has both, so the test post
 * shows one sales line per rate; check 2 is at the 0% rate (else the default). With no
 * inclusive default (added-on US tax, or no rates) neither carries a breakdown, and each
 * posts the one sales line it always did.
 */
export function sampleSaleRows(at, taxRates) {
  const ctx = taxContext(Array.isArray(taxRates) ? taxRates : []);
  const def = ctx.addedOn ? null : ctx.defaultRate;
  const entry = (r, gross) => {
    const tax = r.pct > 0 ? Math.round(((gross * r.pct) / (100 + r.pct)) * 100) / 100 : 0;
    return { rate: { id: r.id, name: r.name, rate: r.pct / 100, type: 'inclusive' }, tax, net: Math.round((gross - tax) * 100) / 100, gross };
  };
  const record = (entries) => {
    const totalTax = Math.round(entries.reduce((a, e) => a + e.tax, 0) * 100) / 100;
    return { tax_amount: totalTax, tax_breakdown: { totalTax, total: entries.reduce((a, e) => a + e.gross, 0), hasExclusiveTax: false, breakdown: entries } };
  };
  let one = { tax_amount: 0 }, two = { tax_amount: 0 };
  if (def && def.mode === 'inclusive') {
    const zero = def.pct > 0 && ctx.zeroRate && ctx.zeroRate.id !== def.id ? ctx.zeroRate : null;
    one = record(zero ? [entry(def, 90), entry(zero, 12)] : [entry(def, 102)]);   // 102 = the 108 bill less 6 service
    two = record([entry(zero || def, 30)]);
  }
  return [
    { id: 'sample-1', closed_at: at, total: 120, tip: 12, service: 6, ...one, tenders: [{ method: 'card', amount: 108, tip: 12 }] },
    { id: 'sample-2', closed_at: at, total: 30, tip: 0, service: 0, ...two, tenders: [{ method: 'cash', amount: 30, tip: 0 }] },
  ];
}

/** Day notes on how checks' VAT was recorded: meaningless on the made up test figures. */
export const SAMPLE_TAX_NOTES = new Set(['tax_split_estimated', 'tax_not_recorded', 'tax_breakdown_mismatch', 'tax_no_rates']);

/** The VAT lines a posting records ({ 'TaxType|label': major amount }), to spot a later change. */
export function postingVat(tx) {
  return Object.fromEntries((tx?.vat?.lines || []).map((l) => [`${l.taxType}|${l.label}`, minorToMajor(l.amount)]));
}

/**
 * Whether a bank transaction found in Xero by its reference (a posting whose answer was lost)
 * is this site's own (30 Sep 2026: two Coffee Boy sites post to one org and, before the site
 * name was in references, their 28 Sep references were identical).
 *   'adopt'      the reference is the one expected and names this site (or no other site shares the org)
 *   'ambiguous'  an older reference with no site name, on an org other sites post to: never adopted
 *   'none'       not the posting expected
 */
/**
 * @param {any} found
 * @param {{ expectedRef?: string, siteName?: string, siblingCount?: number }} [opts]
 * @returns {'adopt' | 'ambiguous' | 'none'}
 */
export function adoptable(found, { expectedRef, siteName = '', siblingCount = 0 } = {}) {
  if (!found) return 'none';
  const ref = String(found.Reference ?? '');
  if (!expectedRef || ref !== expectedRef) return 'none';
  const name = String(siteName || '').trim();
  if (name && ref.includes(name)) return 'adopt';
  return Number(siblingCount) > 0 ? 'ambiguous' : 'adopt';
}

/**
 * What to do with one planned transaction given its earlier posting record: 'skip' (already
 * in Xero), 'lookup' (sent before and the answer was lost: look for it by reference first) or
 * 'send'.
 */
export function postingStep(prev) {
  if (prev?.status === 'posted') return 'skip';
  if (prev?.status === 'sending') return 'lookup';
  return 'send';
}

/** The Idempotency-Key for one send: a changed payload gets a new key, so an old answer is never replayed. */
export function idempotencyKey(locationId, date, tx) {
  return `servos-${locationId}-${date}-${tx.key}-${shortHash(JSON.stringify(tx.payload))}`;
}

/** A short deterministic hash of a string (FNV-1a, hex), for idempotency keys. */
export function shortHash(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
