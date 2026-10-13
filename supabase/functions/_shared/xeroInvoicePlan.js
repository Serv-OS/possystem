// supabase/functions/_shared/xeroInvoicePlan.js
//
// THE DAILY SALES INVOICE (30 Sep 2026). One site, one business day, posted to Xero the way
// Lightspeed ("invoices by accounting groups"), Xero's own POS guide and the market do it:
//   - a sales invoice (ACCREC, AUTHORISED, never emailed) numbered SOS-<SITE>-<YYYYMMDD>
//     (Xero keeps sales invoice numbers unique, so the number is the duplicate guard), to the
//     site's own contact "<Venue> (ServOS takings)", with the Site tracking option on every line;
//   - lines by sales group and VAT rate ("Hot drinks 20%"), minus lines per discount group,
//     tips and service to their liabilities, gift cards sold to the gift card liability (No VAT);
//   - TaxAmount set on EVERY line from the till's own VAT, so each rate ties to the penny
//     (Huddersfield 28 Sep: Xero worked out 1.33 where the till booked 1.34);
//   - one payment per clearing account, so the invoice shows Paid and each clearing account
//     holds exactly the money waiting for its payout or banking;
//   - refunds made that day as MINUS lines on the same invoice (13 Oct 2026, asked for by the
//     venue's accountant: "much easier for us if the refunds were included in the original
//     invoice", as Lightspeed did), each starting "Refund: ", with the till's own refunded VAT,
//     and each clearing account paid its takings less its refunds. A day whose refunds cannot go
//     on its invoice (see planXeroInvoiceDay) sends them the older way, as a credit note
//     SOS-<SITE>-<YYYYMMDD>-R with its refund payments. A day is never mixed: what an earlier
//     attempt sent decides (refundWayStarted).
// Pure JS, no network: xero-sales sends what this plans (_shared/xeroInvoicePost.ts). The
// card fee bill and the cash variance are hooks here, OFF in this slice.
//
// VAT per rate r (minor units): T money VAT, CT loyalty or promo credit VAT, S money goods,
// C credit goods, D_d discount group d. A discount line carries DT_d = round(D_d x (T + CT) /
// (S + C)); the group lines share T + CT + sum(DT) by their amounts; the credit share of CT
// sits on the discount lines. So the invoice's VAT at r is exactly T, the VAT the till booked.
// Added-on tax (US, Exclusive): the till works tax out AFTER discounts and credits, so all of
// T + CT is tax on the money. The goods lines carry all of it and the discount and credit lines
// carry none (a $10 item, a $2 reward, $0.80 tax posts goods 10.00 + 0.80 and the reward -2.00).

import { resolveSalesTaxType, serviceTaxType, inclusiveTaxMinor, rateOf, validateTaxMapping } from './xeroTax.js';
import { allocate, MONEY_KINDS } from './accountingDay.js';
import { accountRef, shortHash, idempotencyKey, adoptable } from './xeroPostingPlan.js';
import { DISCOUNT_GROUPS, DISCOUNT_GROUP_NAMES, OTHER_GROUP } from './accountingGroups.js';
import { LOYALTY_VAT_XERO_LINE } from './saleVat.js';

export { adoptable };

export const SITE_CODE_RE = /^[A-Z0-9]{2,12}$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const ACCOUNT_RE = /^[A-Za-z0-9 ._\-/]{1,64}$/;
const GROUP_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const major = (m) => (Math.round(m) / 100) || 0;   // never -0 in a payload
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

/** The Back Office tab that holds this setup: "VAT and accounts", or "Tax and accounts" where tax is added on top (US). */
export const setupTabName = (addedOn) => (addedOn ? 'Tax and accounts' : 'VAT and accounts');
/** The section of that tab with the Xero rate per ServOS rate. */
export const taxRatesSection = (addedOn) => (addedOn ? 'Sales tax rates' : 'VAT rates');

// ── naming ───────────────────────────────────────────────────────────────────

/** The site's name as Xero shows it: spaces collapsed, " - " dashes dropped ("Coffee Boy  - Headingly" is "Coffee Boy Headingly"). */
export function siteNameFrom(platformName) {
  return String(platformName ?? '').replace(/\s+[-–—]+\s+/g, ' ').replace(/\s+/g, ' ').trim();
}

const tokens = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * A short, stable site code suggested from the venue's online slug: the brand words every
 * sibling site shares are dropped (coffee-boy-leeds is LEEDS; coffeeboystation, with no dashes,
 * is STATION), upper case A-Z and 0-9, 2 to 12 characters, a digit added when the code is taken.
 * Only a suggestion: the code is saved in mapping.site.code and never worked out again.
 */
/**
 * @param {string} slug
 * @param {string[]} [siblingSlugs]
 * @param {string[]} [taken]
 * @returns {string}
 */
export function siteCodeFromSlug(slug, siblingSlugs = [], taken = []) {
  const own = tokens(slug);
  const sibs = (Array.isArray(siblingSlugs) ? siblingSlugs : []).map(tokens).filter((t) => t.length);
  let rest = own;
  const dashed = sibs.filter((t) => t.length > 1);
  if (dashed.length && own.length > 1) {
    const brand = own.filter((t) => dashed.every((s) => s.includes(t)));
    const left = own.filter((t) => !brand.includes(t));
    if (left.length) rest = left;
  } else if (own.length === 1 && dashed.length) {
    // An undashed slug: strip the shared brand when it is a prefix ("coffeeboy" + "station").
    const brand = dashed[0].filter((t) => dashed.every((s) => s.includes(t)));
    const b = brand.join('');
    if (b && own[0].startsWith(b) && own[0].length > b.length) rest = [own[0].slice(b.length)];
  } else if (!sibs.length && own.length > 1) {
    const last = own[own.length - 1];
    if (last.length >= 3) rest = [last];
  }
  let code = rest.join('').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  if (code.length < 2) code = (code + 'SITE').slice(0, 4);
  const used = new Set((Array.isArray(taken) ? taken : []).map((c) => String(c || '').toUpperCase()));
  if (!used.has(code)) return code;
  for (let n = 2; n < 100; n++) {
    const suffix = String(n);
    const c = code.slice(0, 12 - suffix.length) + suffix;
    if (!used.has(c)) return c;
  }
  return code;
}

const compact = (ymd) => String(ymd || '').replace(/-/g, '');
/** SOS-LEEDS-20260929 */
export const invoiceNumber = (code, ymd) => `SOS-${code}-${compact(ymd)}`;
/** SOS-LEEDS-20260929-R */
export const creditNoteNumber = (code, ymd) => `${invoiceNumber(code, ymd)}-R`;

/** "Tue 29 Sep 2026" for a business day. */
export function dayLabel(ymd) {
  if (!YMD_RE.test(String(ymd || ''))) return String(ymd || '');
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${DAYS[dt.getUTCDay()]} ${d} ${MONTHS[m - 1]} ${y}`;
}
/** "Coffee Boy Leeds takings Tue 29 Sep 2026" */
export const takingsReference = (name, ymd) => `${name} takings ${dayLabel(ymd)}`;
/** "Coffee Boy Leeds (ServOS takings)" */
export const contactName = (name) => `${name} (ServOS takings)`;

/** Open in Xero. With the org's short code the link opens the right organisation first. */
/**
 * @param {string} type 'invoice' | 'credit_note' | 'bank'
 * @param {string | null | undefined} id
 * @param {string | null | undefined} [shortCode]
 * @returns {string | null}
 */
export function xeroDocLink(type, id, shortCode = null) {
  if (!id) return null;
  const path = type === 'credit_note' ? `/AccountsReceivable/ViewCreditNote.aspx?creditNoteID=${id}`
    : type === 'bank' ? `/Bank/ViewTransaction.aspx?bankTransactionID=${id}`
      : `/AccountsReceivable/View.aspx?InvoiceID=${id}`;
  return shortCode ? `https://go.xero.com/organisationlogin/default.aspx?shortcode=${encodeURIComponent(shortCode)}&redirecturl=${path}` : `https://go.xero.com${path}`;
}

// ── money kinds to clearing accounts ─────────────────────────────────────────

/** A payment's Account: Xero's Payments take { AccountID } or { Code } (not AccountCode, as line items do). */
export function paymentAccount(value) {
  const r = accountRef(value);
  if (!r) return null;
  return r.AccountID ? { AccountID: r.AccountID } : { Code: r.AccountCode };
}

/** The clearing keys a money row may be mapped under, most specific first. */
export function clearingKeys(row) {
  const kind = row?.kind;
  if (kind === 'card') return [`card:${row.processor || 'none'}`, 'card'];
  if (kind === 'other') return [`other:${row.method}`, 'other'];
  return [kind];
}

/** Plain words for a clearing key. */
export function clearingLabel(key) {
  const [k, sub] = String(key).split(':');
  const nice = (s) => String(s || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  if (k === 'card') return sub && sub !== 'none' ? `Card (${nice(sub)})` : sub === 'none' ? 'Card (other machine)' : 'Card';
  if (k === 'cash') return 'Cash';
  if (k === 'gift_card') return 'Gift cards';
  if (k === 'deposit') return 'Deposits';
  if (k === 'unallocated') return 'Unallocated';
  return sub ? nice(sub) : 'Other';
}

function clearingFor(row, clearing) {
  const keys = clearingKeys(row);
  for (const k of keys) {
    const v = clearing?.[k];
    if (typeof v === 'string' && v.trim()) return { key: k, account: v.trim() };
  }
  return { key: keys[0], account: null };
}

// ── model and dates ──────────────────────────────────────────────────────────

/**
 * Which model posts this day: 'bank_tx' (the older Receive and Spend Money) or 'sales_invoice'.
 * A day is never mixed: what an earlier attempt sent decides; with nothing sent, the venue's
 * post_mode and start day decide.
 */
export function dayModel(prior, postMode, startDate, date) {
  const postings = prior?.detail?.postings && typeof prior.detail.postings === 'object' ? prior.detail.postings : {};
  const keys = Object.keys(postings);
  if (keys.some((k) => /^(RECEIVE|SPEND):/.test(k))) return 'bank_tx';
  if (keys.some((k) => k === 'INVOICE' || k === 'CREDIT' || /^(PAY|REFUND):/.test(k))) return 'sales_invoice';
  if (prior?.status === 'ok') return 'bank_tx';
  if (postMode === 'sales_invoice' && YMD_RE.test(String(startDate || '')) && String(date) >= String(startDate)) return 'sales_invoice';
  return 'bank_tx';
}

// ── mapping ──────────────────────────────────────────────────────────────────

const HASH_KEYS = ['site', 'tracking', 'groups', 'categoryGroups', 'itemGroups', 'otherSalesAccount', 'discounts', 'tipsAccount',
  'serviceAccount', 'giftLiabilityAccount', 'clearing', 'taxRateMap', 'salesNoVat', 'serviceTax', 'serviceTaxable', 'taxDefault'];

const stable = (v) => {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
};

/** A hash of the choices the figures depend on, so "I have checked a day's figures" lapses when they change. */
export function mappingHash(mapping) {
  const m = mapping && typeof mapping === 'object' ? mapping : {};
  const pick = {};
  for (const k of HASH_KEYS) if (m[k] !== undefined && m[k] !== null && m[k] !== '') pick[k] = m[k];
  return shortHash(stable(pick));
}

const isRef = (v) => v == null || v === '' || (typeof v === 'string' && ACCOUNT_RE.test(v.trim()));

/** Null when the invoice choices in a mapping are acceptable, else a message for the person saving it. */
export function validateInvoiceMapping(m) {
  if (m == null) return null;
  if (typeof m !== 'object' || Array.isArray(m)) return 'The account mapping must be a set of choices.';
  const tax = validateTaxMapping(m);
  if (tax) return tax;
  if (m.site != null) {
    if (typeof m.site !== 'object') return 'The site details are not valid.';
    if (m.site.name != null && (typeof m.site.name !== 'string' || m.site.name.length > 100)) return 'The site name must be text of 100 characters or fewer.';
    if (m.site.code != null && m.site.code !== '' && !SITE_CODE_RE.test(String(m.site.code))) return 'The site code must be 2 to 12 capital letters or digits.';
  }
  if (m.tracking != null) {
    if (typeof m.tracking !== 'object') return 'The tracking choice is not valid.';
    if (!m.tracking.none) {
      for (const k of ['categoryId', 'categoryName', 'optionId', 'optionName']) {
        const v = m.tracking[k];
        if (v != null && (typeof v !== 'string' || v.length > 120)) return 'The tracking choice is not valid.';
      }
    }
  }
  if (m.groups != null) {
    if (typeof m.groups !== 'object' || Array.isArray(m.groups)) return 'The sales groups are not valid.';
    const keys = Object.keys(m.groups);
    if (keys.length > 200) return 'There are too many sales groups (200 at most).';
    for (const k of keys) {
      if (!GROUP_KEY_RE.test(k)) return `The sales group key "${k.slice(0, 50)}" must be 1 to 40 lower case letters, digits or dashes.`;
      const g = m.groups[k];
      if (!g || typeof g !== 'object') return `The sales group "${k}" is not valid.`;
      if (g.name != null && (typeof g.name !== 'string' || g.name.length > 80)) return `The name of the sales group "${k}" must be 80 characters or fewer.`;
      if (!isRef(g.account)) return `The account for the sales group "${k}" is not valid.`;
    }
  }
  for (const key of ['categoryGroups', 'itemGroups']) {
    const v = m[key];
    if (v == null) continue;
    if (typeof v !== 'object' || Array.isArray(v)) return 'The category choices are not valid.';
    if (Object.keys(v).length > 5000) return 'There are too many category choices.';
    for (const [id, g] of Object.entries(v)) {
      if (id.length > 120 || typeof g !== 'string' || !GROUP_KEY_RE.test(g)) return 'A category is assigned to a sales group that is not valid.';
    }
  }
  for (const key of ['otherSalesAccount', 'tipsAccount', 'serviceAccount', 'giftLiabilityAccount']) {
    if (!isRef(m[key])) return `The account chosen for ${key.replace(/Account$/, '').replace(/([A-Z])/g, ' $1').toLowerCase()} is not valid.`;
  }
  if (m.discounts != null) {
    if (typeof m.discounts !== 'object') return 'The discount choices are not valid.';
    const acc = m.discounts.accounts || {};
    for (const [k, v] of Object.entries(acc)) {
      if (!DISCOUNT_GROUPS.includes(k) || !isRef(v)) return 'A discount account choice is not valid.';
    }
    for (const [label, g] of Object.entries(m.discounts.labels || {})) {
      if (label.length > 120 || !DISCOUNT_GROUPS.includes(g)) return 'A discount label is assigned to a group that is not valid.';
    }
  }
  if (m.clearing != null) {
    if (typeof m.clearing !== 'object' || Array.isArray(m.clearing)) return 'The payment account choices are not valid.';
    for (const [k, v] of Object.entries(m.clearing)) {
      if (k.length > 80 || !isRef(v)) return 'A payment account choice is not valid.';
    }
  }
  if (m.feeBill?.enabled === true) return 'The card fee bill is not available yet. It will follow once a payout has been checked.';
  if (m.cashVariance?.enabled === true) return 'Posting cash over and short is not available yet.';
  if (m.invoiceStartDate != null && m.invoiceStartDate !== '' && !YMD_RE.test(String(m.invoiceStartDate))) return 'The start day must be a date.';
  return null;
}

// ── readiness ────────────────────────────────────────────────────────────────

const REVENUE_CLASS = 'REVENUE';
const findAccount = (accounts, ref) => {
  const v = String(ref || '').trim();
  if (!v) return null;
  return (accounts || []).find((a) => a.id === v || (a.code && String(a.code).toUpperCase() === v.toUpperCase())) || null;
};
const canTakePayments = (a) => !!a && (String(a.type || '').toUpperCase() === 'BANK' || a.pay === true);

/**
 * The Ready checklist. ctx (all optional; a check whose facts are missing is skipped, so the
 * post time run with only the mapping checks what the mapping alone can):
 *   accounts [{ id, code, name, type, cls, pay, status }], tracking [{ id, name, status, options:[{id,name,status}] }],
 *   orgCurrency, venueCurrency, siblings [{ locationId, name, code, clearing }],
 *   seen { groups[], discountGroups[], moneyKeys[], tips, service, gift, deposits, unresolvedShare, onlineGift },
 *   taxBlocked [], lightspeedLastDate, startDate (the one about to be set)
 * Returns { ready, items: [{ key, ok, label, detail }], warnings: [{ code, message }] }.
 */
/**
 * @param {any} mapping
 * @param {any} [ctx]
 * @returns {{ ready: boolean, items: { key: string, ok: boolean, label: string, detail: string }[], warnings: { code: string, message: string }[] }}
 */
export function invoiceReadiness(mapping, ctx = {}) {
  const m = mapping && typeof mapping === 'object' ? mapping : {};
  const items = [];
  const warnings = [];
  const item = (key, ok, label, detail = '') => items.push({ key, ok: !!ok, label, detail: ok ? '' : detail });
  const accounts = Array.isArray(ctx.accounts) ? ctx.accounts : null;
  const seen = ctx.seen || {};
  const siblings = Array.isArray(ctx.siblings) ? ctx.siblings : [];
  const tab = setupTabName(!!ctx.addedOn);

  const code = String(m.site?.code || '');
  const name = String(m.site?.name || '').trim();
  const taken = siblings.map((s) => String(s.code || '').toUpperCase()).filter(Boolean);
  item('site', name && SITE_CODE_RE.test(code) && !taken.includes(code), 'Site name and code',
    !name ? 'Give the site the name Xero will show.' : !SITE_CODE_RE.test(code) ? 'Choose a site code of 2 to 12 capital letters or digits.' : 'Another site on this Xero already uses this code.');

  if (ctx.orgCurrency && ctx.venueCurrency) {
    item('currency', String(ctx.orgCurrency).toUpperCase() === String(ctx.venueCurrency).toUpperCase(), 'Xero currency matches the venue',
      `Xero's base currency is ${ctx.orgCurrency} but this venue trades in ${ctx.venueCurrency}.`);
  }

  const tr = m.tracking || {};
  if (tr.none) {
    item('tracking', siblings.length === 0, 'Site tracking', 'Other sites post to this Xero, so each line needs a tracking option naming this site.');
  } else {
    let ok = !!(tr.categoryName && tr.optionName);
    let detail = 'Choose the tracking category and the option for this site.';
    if (ok && Array.isArray(ctx.tracking)) {
      const cat = ctx.tracking.find((c) => (tr.categoryId && c.id === tr.categoryId) || c.name === tr.categoryName);
      const opt = cat?.options?.find((o) => (tr.optionId && o.id === tr.optionId) || o.name === tr.optionName);
      if (!cat || String(cat.status || 'ACTIVE').toUpperCase() !== 'ACTIVE') { ok = false; detail = `The tracking category "${tr.categoryName}" is not active in Xero.`; }
      else if (!opt || String(opt.status || 'ACTIVE').toUpperCase() !== 'ACTIVE') { ok = false; detail = `The option "${tr.optionName}" is not active in Xero.`; }
    }
    item('tracking', ok, 'Site tracking', detail);
  }

  const groupKeys = (Array.isArray(seen.groups) ? seen.groups : []).filter((g) => g !== OTHER_GROUP);
  const missingGroups = groupKeys.filter((g) => !m.groups?.[g]?.account);
  const badClass = accounts ? [...groupKeys.map((g) => m.groups?.[g]?.account), m.otherSalesAccount].filter(Boolean)
    .filter((ref) => { const a = findAccount(accounts, ref); return !a || String(a.cls || '').toUpperCase() !== REVENUE_CLASS; }) : [];
  item('groups', !!m.otherSalesAccount && !missingGroups.length && !badClass.length, 'Sales groups have income accounts',
    !m.otherSalesAccount ? 'Choose the Other sales account (sales with no group post there).'
      : missingGroups.length ? `Choose an income account for: ${missingGroups.map((g) => m.groups?.[g]?.name || seen.names?.[g] || g).join(', ')}.`
        : `These are not income accounts in Xero: ${badClass.join(', ')}.`);

  const dg = (Array.isArray(seen.discountGroups) ? seen.discountGroups : []).filter((d) => !m.discounts?.accounts?.[d]);
  item('discounts', !dg.length, 'Discount accounts', `Choose an account for: ${dg.map((d) => DISCOUNT_GROUP_NAMES[d] || d).join(', ')}.`);

  item('tips', !!m.tipsAccount && (!seen.service || !!m.serviceAccount), 'Tips and service charge accounts',
    !m.tipsAccount ? 'Choose the tips account (money owed to staff).' : 'Service charge was taken: choose its account.');

  if (seen.gift) {
    const a = accounts ? findAccount(accounts, m.giftLiabilityAccount) : null;
    item('gift', !!m.giftLiabilityAccount && (!accounts || canTakePayments(a)), 'Gift card liability',
      !m.giftLiabilityAccount ? 'Choose the gift card liability account.' : 'Turn on "Enable payments to this account" for the gift card liability in Xero, so gift card spends can be recorded.');
  }

  const clearing = m.clearing || {};
  const moneyKeys = Array.isArray(seen.moneyKeys) ? seen.moneyKeys : [];
  const unmapped = [];
  const cannot = [];
  for (const k of moneyKeys) {
    const fallback = k.startsWith('card:') ? 'card' : k.startsWith('other:') ? 'other' : null;
    const ref = clearing[k] || (fallback ? clearing[fallback] : null);
    if (!ref) { unmapped.push(clearingLabel(k)); continue; }
    if (accounts && !canTakePayments(findAccount(accounts, ref))) cannot.push(clearingLabel(k));
  }
  item('clearing', !unmapped.length && !cannot.length, 'Every kind of payment has a clearing account (where it waits for its payout or banking)',
    unmapped.length ? `Choose where these payments go: ${unmapped.join(', ')}.` : `These accounts cannot take payments in Xero (a bank account, or "Enable payments to this account"): ${cannot.join(', ')}.`);

  if (Array.isArray(ctx.taxBlocked)) {
    item('vat', !ctx.taxBlocked.length, `Every ServOS ${ctx.addedOn ? 'tax' : 'VAT'} rate has a Xero rate`,
      `Choose a Xero rate under ${tab}, ${taxRatesSection(!!ctx.addedOn)}, for: ${ctx.taxBlocked.map((b) => (b.pct != null ? `${b.name || b.key} (${b.pct}%)` : b.name || b.key)).join(', ')}.`);
  }

  const hash = mappingHash(m);
  item('figures', m.figuresChecked?.hash === hash, 'A day of figures checked',
    m.figuresChecked?.hash ? `The choices changed after the figures were checked. Check a day again under ${tab}, Check figures.`
      : `Use Check figures under ${tab} on a real day, then tick "I have checked these figures".`);

  const start = ctx.startDate !== undefined ? ctx.startDate : m.invoiceStartDate;
  item('start', YMD_RE.test(String(start || '')), 'A start day', 'Choose the first business day to post as a sales invoice.');

  // Warnings only.
  for (const s of siblings) {
    const shared = Object.entries(clearing).filter(([, v]) => v && Object.values(s.clearing || {}).includes(v));
    if (shared.length) warnings.push({ code: 'clearing_shared', message: `${s.name || 'Another site'} uses the same clearing account for ${shared.map(([k]) => clearingLabel(k)).join(', ')}. Each site's payouts are easier to match with its own.` });
  }
  if (seen.deposits) warnings.push({ code: 'deposits_seen', message: 'Booking deposits were used as payment. They post as a payment from the deposits account; VAT on deposits when they are taken comes in the next update.' });
  if (Number(seen.unresolvedShare) > 0.02) warnings.push({ code: 'unresolved_categories', message: `${Math.round(Number(seen.unresolvedShare) * 100)}% of sales are in categories with no sales group, so they post to Other sales.` });
  if (seen.onlineGift) warnings.push({ code: 'online_gift_not_posted', message: 'Gift cards sold online are not posted yet. Record them in Xero by hand for now.' });
  if (ctx.lightspeedLastDate && YMD_RE.test(String(start || '')) && String(start) <= String(ctx.lightspeedLastDate)) {
    warnings.push({ code: 'lightspeed_overlap', message: `Lightspeed posted this site's sales up to ${ctx.lightspeedLastDate}. Pick a later start day, or the same sales will be in Xero twice.` });
  }
  return { ready: items.every((i) => i.ok), items, warnings };
}

// ── the plan ─────────────────────────────────────────────────────────────────

const DEFAULT_BUCKET = { key: 'default', pct: null, mode: 'default', rateId: null, name: 'Default rate' };
const ZERO_TYPES = new Set(['NONE', 'ZERORATEDOUTPUT', 'EXEMPTOUTPUT']);
const totalsByRate = (t) => (t?.byRate && Object.keys(t.byRate).length ? t.byRate : ((t?.sales || t?.tax) ? { default: { sales: t.sales || 0, tax: t.tax || 0 } } : {}));
const rateText = (b) => (b.key === 'none' ? 'no tax rate' : b.mode === 'inclusive' && b.pct != null ? `${b.pct}%` : '');

/**
 * Plan one site day.
 *   grouped   buildGroupedDay() output { summary, groups }
 *   mapping   xero_config.mapping (site, tracking, groups, discounts, clearing, ...)
 *   detail    xero_config.detail (salesTaxRates, site.contactId, site.tracking)
 *   site      { name, code }
 *   started   how an earlier attempt sent, or started to send, this day's refunds, from the log
 *             row the run holds (refundWayStarted): null (nothing sent, free to decide),
 *             'lines', 'credit_note', or 'refused' (Xero refused the invoice with refund lines)
 * Returns { invoice, payments, creditNote, refundPayments, refundWay, refundWayReason, vatTie,
 * warnings, blocked, blockedRates, notReady, hooks, totals }. invoice and creditNote carry
 * { number, reference, contactName, total, lineAmountTypes, lines, payload }; payments { key,
 * kinds, account, amount, reference, payload }. Money in the plan is minor units, payloads are
 * Xero's (major).
 *
 * The day's refunds go ONE way (13 Oct 2026), refundWay:
 *   'lines'        minus lines on the invoice (each marked refund: true, described "Refund: ..."),
 *                  the invoice total is sales less refunds, each clearing account is paid its
 *                  takings less its refunds (a payment of zero is left out), no credit note.
 *   'credit_note'  the older way, exactly as before: the invoice for the sales, a credit note
 *                  for the refunds and its refund payments. Used when the refunds cannot go on
 *                  the invoice (Xero takes minus lines, but not an invoice of zero or less, and
 *                  not a minus payment): no sales that day, refunds as large as the sales, more
 *                  refunded from a clearing account than it took, or more VAT refunded than
 *                  charged; and for a day an earlier attempt started that way. The plan then
 *                  carries the warning 'refunds_as_credit_note' with the reason.
 *   null           the day has no refunds.
 * totals and vatTie keep both sides as positive figures whichever way is used.
 */
/**
 * @param {any} grouped
 * @param {{ mapping?: any, detail?: any, site?: { name?: string, code?: string }, date?: string, currency?: string | null, fees?: any, cash?: any, started?: null | 'lines' | 'credit_note' | 'refused' }} [opts]
 * @returns {any}
 */
export function planXeroInvoiceDay(grouped, { mapping = {}, detail = {}, site = {}, date, currency = null, fees = null, cash = null, started = null } = {}) {
  const m = mapping || {};
  const summary = grouped?.summary || {};
  const groups = grouped?.groups || {};
  const warnings = [];
  const blocked = [];
  const blockOnce = (b) => { if (!blocked.some((x) => x.code === b.code && x.message === b.message)) blocked.push(b); };
  const notReady = [];
  const need = (code, message) => { if (!notReady.some((n) => n.code === code)) notReady.push({ code, message }); };
  const day = date || summary.date;
  const siteName = String(site.name || '').trim();
  const code = String(site.code || '');
  if (!siteName) need('site_name', 'The site has no name for Xero.');
  if (!SITE_CODE_RE.test(code)) need('site_code', 'The site has no code for its invoice numbers.');
  const number = invoiceNumber(code || 'SITE', day);
  const cnNumber = creditNoteNumber(code || 'SITE', day);
  const reference = takingsReference(siteName || 'Site', day);
  const cName = contactName(siteName || 'Site');

  // Tracking on every line, by name (Xero takes Name and Option); the names read at post time win.
  const tr = m.tracking || {};
  const liveTr = detail?.site?.tracking;
  let tracking = null;
  if (!tr.none) {
    const catName = (liveTr && liveTr.categoryId === tr.categoryId && liveTr.categoryName) || tr.categoryName;
    const optName = (liveTr && liveTr.optionId === tr.optionId && liveTr.optionName) || tr.optionName;
    if (catName && optName) tracking = [{ Name: catName, Option: optName }];
    else need('tracking', 'Choose the site tracking option.');
  }

  // Tax: one Xero rate per ServOS bucket (as the older posting), never guessed.
  const rev = Array.isArray(detail?.salesTaxRates) ? detail.salesTaxRates : null;
  const rctx = { mapping: m, revenueRates: rev, detail };
  const bucketList = Array.isArray(summary.taxBuckets) ? summary.taxBuckets : [];
  const buckets = new Map(bucketList.map((b) => [b.key, b]));
  const rank = new Map(bucketList.map((b, i) => [b.key, i]));
  const bucketOf = (k) => buckets.get(k) || (k === 'default' ? DEFAULT_BUCKET : { key: k, pct: null, mode: 'inclusive', rateId: null, name: k });
  const blockedRates = new Map();
  const fellBack = [];
  const resolveBucket = (b) => {
    const r = resolveSalesTaxType(b, rctx);
    if (r.taxType || !b.estimated) return r;
    fellBack.push(b);
    return resolveSalesTaxType(DEFAULT_BUCKET, rctx);
  };
  const exclusive = summary.defaultTaxBucket?.key === 'excl';
  const lineAmountTypes = exclusive ? 'Exclusive' : 'Inclusive';
  // Plain words for this venue: VAT in the UK, sales tax where it is added on top (US).
  const taxWord = exclusive ? 'sales tax' : 'VAT';
  const where = (section) => `${setupTabName(exclusive)}, ${section}`;

  const acct = (ref) => (typeof ref === 'string' && ref.trim() ? ref.trim() : null);
  const unmappedGroups = new Set();
  const groupAccount = (g) => {
    const a = acct(m.groups?.[g]?.account);
    if (a) return a;
    if (g !== OTHER_GROUP) unmappedGroups.add(groups.names?.[g] || g);
    const other = acct(m.otherSalesAccount);
    if (!other) need('other_sales', 'Choose the Other sales account.');
    return other;
  };
  const discountAccount = (d) => {
    const a = acct(m.discounts?.accounts?.[d]);
    if (!a) need(`discount_${d}`, `Choose the account for ${DISCOUNT_GROUP_NAMES[d] || d}.`);
    return a;
  };
  const vatLarge = [];
  const refundVatLarge = [];
  const zeroWithVat = new Set();

  // Lines for one side (sales or refunds): goods per group and rate, then discount lines.
  // `large` takes this side's "VAT differs from what Xero would work out" notes.
  const sideLines = (side, totals, credits, withDiscounts, vatTie, large) => {
    const lines = [];
    const rates = new Set([...Object.keys(totalsByRate(totals)), ...Object.keys(totalsByRate(credits)), ...Object.keys(side || {})]);
    const keys = [...rates].sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9) || a.localeCompare(b));
    const money = totalsByRate(totals);
    const cred = totalsByRate(credits);
    for (const r of keys) {
      const b = bucketOf(r);
      const g = side?.[r] || { goods: {}, discounts: {}, credits: {}, gift: 0 };
      const T = money[r]?.tax || 0, S = money[r]?.sales || 0;
      const CT = cred[r]?.tax || 0, C = cred[r]?.sales || 0;
      // The tax the till took on this rate's money: T, and with added-on tax T + CT (see the top).
      const tillTax = exclusive ? T + CT : T;
      const disc = {};
      if (withDiscounts) for (const [d, v] of Object.entries(g.discounts || {})) if (v) disc[d] = (disc[d] || 0) + v;
      const credBy = {};
      for (const [d, v] of Object.entries(g.credits || {})) if (v) credBy[d] = (credBy[d] || 0) + v;
      const goodsEntries = Object.entries(g.goods || {}).filter(([, v]) => v)
        .sort(([a], [bk]) => (a === OTHER_GROUP) - (bk === OTHER_GROUP) || String(groups.names?.[a] || a).localeCompare(String(groups.names?.[bk] || bk)) || a.localeCompare(bk));
      if (!goodsEntries.length && !Object.keys(disc).length && !Object.keys(credBy).length) continue;
      const res = resolveBucket(b);
      const taxType = res.taxType;
      if (!taxType) blockedRates.set(b.key, { key: b.key, name: b.name || b.key, pct: b.pct ?? null });
      const noVat = res.source === 'no_vat';
      if (noVat && tillTax) warnings.push({ code: 'vat_not_registered', message: `The till booked ${taxWord} at ${b.name || r}, but this venue is set as not VAT registered, so the invoice carries none.` });
      const pct = rateOf(taxType, rev) ?? b.pct ?? 0;
      const gift = g.gift || 0;
      const base = S + C - gift;
      // VAT on each discount group (its credit share of CT added), then the goods share the rest.
      const discKeys = [...new Set([...Object.keys(disc), ...Object.keys(credBy)])]
        .sort((a, bk) => DISCOUNT_GROUPS.indexOf(a) - DISCOUNT_GROUPS.indexOf(bk) || a.localeCompare(bk));
      const credKeys = discKeys.filter((d) => credBy[d]);
      const credTax = allocate(CT, credKeys.map((d) => credBy[d]));
      const DT = {};
      discKeys.forEach((d) => {
        if (exclusive) { DT[d] = 0; return; }   // added-on tax: discounts and credits carry none
        const dt = disc[d] && base > 0 ? Math.round((disc[d] * (T + CT)) / base) : 0;
        const ct = credKeys.includes(d) ? credTax[credKeys.indexOf(d)] : 0;
        DT[d] = dt + ct;
      });
      const sumDT = discKeys.reduce((s, d) => s + DT[d], 0);
      const goodsTax = allocate(tillTax + sumDT, goodsEntries.map(([, v]) => v));
      if (!goodsEntries.length && tillTax + sumDT && !noVat) blockOnce({ code: 'vat_unplaced', message: `${cap(taxWord)} was booked at ${b.name || r} with no goods to carry it (only gift cards or discounts). Check the day's checks.` });
      const label = rateText(b);
      let invoiceVat = 0, xeroCalc = 0;
      const far = (t, calc) => Math.abs(t - calc) > Math.max(2, Math.round(Math.abs(calc) * 0.01));
      const push = (kind, group, description, account, amount, tax) => {
        const t = noVat ? 0 : (tax || 0);
        const calc = exclusive ? Math.round(((amount - t) * pct) / 100) : inclusiveTaxMinor(amount, pct);
        if (!noVat && t && ZERO_TYPES.has(taxType)) zeroWithVat.add(b.name || r);
        // Added-on tax sits wholly on the goods lines, so it is compared per rate below, not per line.
        if (!noVat && !exclusive && far(t, calc)) large.push(`${description}: ServOS ${major(t).toFixed(2)}, Xero would work out ${major(calc).toFixed(2)}`);
        invoiceVat += t; xeroCalc += calc;
        lines.push({ kind, group, rateKey: r, description, account, taxType, amount, tax: t, xeroCalc: calc });
      };
      goodsEntries.forEach(([grp, v], i) => push('sales', grp, `${groups.names?.[grp] || (grp === OTHER_GROUP ? 'Other sales' : grp)} ${label}`.trim(), groupAccount(grp), v, goodsTax[i]));
      discKeys.forEach((d) => {
        const amt = (disc[d] || 0) + (credBy[d] || 0);
        if (!amt) return;
        push('discount', d, `${DISCOUNT_GROUP_NAMES[d] || d} ${label}`.trim(), discountAccount(d), -amt, -DT[d]);
      });
      if (!noVat && exclusive && far(invoiceVat, xeroCalc)) large.push(`${b.name || r}: ServOS ${major(invoiceVat).toFixed(2)}, Xero would work out ${major(xeroCalc).toFixed(2)}`);
      if (gift && b.pct > 0) warnings.push({ code: 'gift_card_vat_charged', message: `Gift cards were sold at ${b.name || r}, so the till charged VAT on them. They post with No VAT; give gift card items a No VAT rate in ServOS.` });
      vatTie.push({ key: r, label: b.name || r, pct: b.pct ?? null, taxType, tillVat: tillTax, invoiceVat, xeroCalc });
    }
    return lines;
  };

  const giftLine = (amount, desc) => {
    const a = acct(m.giftLiabilityAccount);
    if (!a) need('gift', 'Choose the gift card liability account.');
    return { kind: 'gift', group: null, rateKey: null, description: desc, account: a, taxType: 'NONE', amount, tax: 0, xeroCalc: 0 };
  };
  const serviceTax = serviceTaxType(rctx, summary.defaultTaxBucket || DEFAULT_BUCKET);
  const extras = (t, refund) => {
    const out = [];
    if (t.tip > 0) {
      const a = acct(m.tipsAccount);
      if (!a) need('tips', 'Choose the tips account.');
      out.push({ kind: 'tip', group: null, rateKey: null, description: refund ? 'Tips refunded' : 'Tips and gratuities', account: a, taxType: 'NONE', amount: t.tip, tax: 0, xeroCalc: 0 });
    }
    if (t.service > 0) {
      const a = acct(m.serviceAccount);
      if (!a) need('service', 'Choose the service charge account.');
      const tt = exclusive ? 'NONE' : serviceTax;
      if (!tt) blockOnce({ code: 'service_rate', message: 'Service charge is set as taxable, but the venue default rate has no Xero sales rate.' });
      const tax = tt && !exclusive ? inclusiveTaxMinor(t.service, rateOf(tt, rev) ?? 0) : 0;
      out.push({ kind: 'service', group: null, rateKey: null, description: refund ? 'Service charge refunded' : 'Service charge', account: a, taxType: tt, amount: t.service, tax, xeroCalc: tax });
    }
    return out;
  };

  const payloadLine = (l) => ({
    Description: l.description,
    Quantity: 1,
    UnitAmount: major(exclusive ? l.amount - l.tax : l.amount),
    ...(accountRef(l.account) || {}),
    TaxType: l.taxType || undefined,
    TaxAmount: major(l.tax),
    ...(tracking ? { Tracking: tracking } : {}),
  });
  const contact = detail?.site?.contactId ? { ContactID: detail.site.contactId } : { Name: cName };

  // The day's money per clearing account, from its money rows: Map(account -> { account, kinds, amount }).
  const moneyByAccount = (rows, refund) => {
    const byAcct = new Map();
    for (const row of rows || []) {
      if (!MONEY_KINDS.has(row.kind) || !row.gross) continue;
      const c = clearingFor(row, m.clearing);
      if (!c.account) {
        blockOnce({ code: 'clearing_unmapped', key: c.key, message: `No clearing account is chosen for ${clearingLabel(c.key)} (${major(row.gross).toFixed(2)}${refund ? ' refunded' : ''}). Choose one under ${where('Payments')}.` });
        continue;
      }
      const p = byAcct.get(c.account) || { account: c.account, kinds: [], amount: 0 };
      const lbl = clearingLabel(c.key);
      if (!p.kinds.includes(lbl)) p.kinds.push(lbl);
      p.amount += row.gross;
      byAcct.set(c.account, p);
    }
    return byAcct;
  };
  // One payment per clearing account in the list, on the invoice (or the refund of the credit note).
  const paymentsOf = (list, docNumber, refund) => {
    const out = [];
    const usedRefs = new Set();
    for (const p of list) {
      let ref = `${docNumber} ${p.kinds.join(' and ')}`;
      if (usedRefs.has(ref)) ref = `${ref} ${shortHash(p.account).slice(0, 4)}`;
      usedRefs.add(ref);
      const target = refund ? { CreditNote: { CreditNoteNumber: docNumber } } : { Invoice: { InvoiceNumber: docNumber } };
      out.push({
        key: `${refund ? 'REFUND' : 'PAY'}:${p.account}`, kinds: p.kinds, account: p.account, amount: p.amount, reference: ref,
        payload: { ...target, Account: paymentAccount(p.account), Date: day, Amount: major(p.amount), Reference: ref },
      });
    }
    return out;
  };

  const vatTie = [];
  const refundTie = [];
  const sum = (list, f) => list.reduce((s, x) => s + f(x), 0);
  // ── both sides of the day, as lines (refunds as positive figures, as the credit note carries them)
  const st = summary.sales?.totals || { gross: 0, tip: 0, service: 0 };
  const salesLines = [
    ...sideLines(groups.sales, st, summary.sales?.credits, true, vatTie, vatLarge),
  ];
  const giftSold = Object.values(groups.sales || {}).reduce((s, b) => s + (b.gift || 0), 0);
  if (giftSold) salesLines.push(giftLine(giftSold, 'Gift cards sold'));
  salesLines.push(...extras(st, false));
  const rt = summary.refunds?.totals || { gross: 0, tip: 0, service: 0 };
  const refundLines = [...sideLines(groups.refunds, rt, summary.refunds?.credits, false, refundTie, refundVatLarge)];
  const giftBack = Object.values(groups.refunds || {}).reduce((s, b) => s + (b.gift || 0), 0);
  if (giftBack) refundLines.push(giftLine(giftBack, 'Gift cards refunded'));
  refundLines.push(...extras(rt, true));
  const hasSales = salesLines.some((l) => l.amount);
  const hasRefunds = refundLines.some((l) => l.amount);
  const salesTotal = sum(salesLines, (l) => l.amount);
  const refundTotal = sum(refundLines, (l) => l.amount);
  const salesMoney = hasSales ? moneyByAccount(summary.sales?.byMethod, false) : new Map();
  const refundMoney = hasRefunds ? moneyByAccount(summary.refunds?.byMethod, true) : new Map();

  // ── which way the day's refunds go: minus lines on the invoice, or the credit note
  // Xero takes minus line items, but not an invoice of zero or less, and a payment must be above
  // zero. So the refunds go on the invoice only when what is left is a real invoice: above zero,
  // every clearing account took at least what it refunded (an account with refunds and no takings
  // is short too), and the VAT left is not below zero. Otherwise the whole day goes the older way.
  const short = [...refundMoney.values()].filter((r) => r.amount > (salesMoney.get(r.account)?.amount || 0));
  let why = null;
  if (hasRefunds) {
    if (!hasSales) why = 'no_sales';
    else if (salesTotal - refundTotal <= 0) why = 'total_not_positive';
    else if (short.length) why = 'account_short';
    else if (sum(salesLines, (l) => l.tax) - sum(refundLines, (l) => l.tax) < 0) why = 'vat_negative';
  }
  // A day is never mixed: what an earlier attempt started stands, whatever the day looks like now.
  const forced = started === 'lines' ? 'lines' : (started === 'credit_note' || started === 'refused') ? 'credit_note' : null;
  const refundWay = !hasRefunds ? null : forced || (why ? 'credit_note' : 'lines');
  // The reason is the real one for as long as it holds: a day that fell back because its refunds
  // do not fit keeps saying that on every later attempt. 'started_credit_note' is only for a day
  // whose refunds WOULD fit today (a day sent before 13 Oct 2026, or one that has changed since).
  const refundWayReason = !hasRefunds ? null : started === 'refused' ? 'xero_refused'
    : forced === 'credit_note' ? (why || 'started_credit_note') : forced === 'lines' ? 'started_lines' : why;
  const asLines = refundWay === 'lines';
  // A refund line on the invoice: the credit note's line with the sign turned (`|| 0`: never -0).
  // A loyalty or promo credit put back is a minus line on the credit note, so a plus line here.
  const REFUND_NAME = { gift: 'Gift cards', tip: 'Tips', service: 'Service charge' };
  const minus = (l) => ({ ...l, refund: true, description: `Refund: ${REFUND_NAME[l.kind] || l.description}`,
    amount: -l.amount || 0, tax: -l.tax || 0, xeroCalc: -l.xeroCalc || 0 });
  // Started with its refunds on the invoice, and they no longer fit: never switched to a credit
  // note (part of the day may be in Xero at the net figure), so the day stops with plain words.
  if (asLines && why) blockOnce({ code: 'refund_lines_changed', message: 'This day was started in Xero with its refunds on the invoice, and the day has changed since, so the refunds no longer fit on it. Finish the day in Xero by hand.' });

  // ── the invoice
  let invoice = null, payments = [];
  if (hasSales) {
    if (salesTotal !== (st.gross || 0)) blockOnce({ code: 'totals_mismatch', message: `The invoice lines come to ${major(salesTotal).toFixed(2)} but the day's takings are ${major(st.gross || 0).toFixed(2)}. Nothing was posted.` });
    if (salesTotal < 0) blockOnce({ code: 'negative_invoice', message: 'The day comes to less than nothing after discounts, so it cannot be an invoice.' });
    if (asLines && refundTotal !== (rt.gross || 0)) blockOnce({ code: 'refund_totals_mismatch', message: `The refund lines come to ${major(refundTotal).toFixed(2)} but the day's refunds are ${major(rt.gross || 0).toFixed(2)}. Nothing was posted.` });
    const lines = asLines ? [...salesLines, ...refundLines.map(minus)] : salesLines;
    const total = asLines ? salesTotal - refundTotal : salesTotal;
    // One payment per clearing account: its takings, less its refunds when they are on the
    // invoice. Every reference is worked out over the full list first (so it is the one the
    // older way gives), then a payment that nets to nothing is left out.
    const money = [...salesMoney.values()].map((p) => (asLines ? { ...p, amount: p.amount - (refundMoney.get(p.account)?.amount || 0) } : p));
    payments = paymentsOf(money, number, false).filter((p) => !asLines || p.amount > 0);
    const paid = payments.reduce((s, p) => s + p.amount, 0);
    if (!blocked.some((b) => b.code === 'clearing_unmapped' || b.code === 'refund_lines_changed') && paid !== total) blockOnce({ code: 'payments_mismatch', message: `The payments come to ${major(paid).toFixed(2)} but the invoice to ${major(total).toFixed(2)}.` });
    invoice = {
      number, reference, contactName: cName, total, lineAmountTypes, lines,
      payload: {
        Type: 'ACCREC', Contact: contact, InvoiceNumber: number, Reference: reference, Date: day, DueDate: day,
        Status: 'AUTHORISED', LineAmountTypes: lineAmountTypes, ...(currency ? { CurrencyCode: currency } : {}),
        LineItems: lines.map(payloadLine),
      },
    };
  }

  // ── the credit note for the day's refunds, when they do not go on the invoice
  let creditNote = null, refundPayments = [];
  if (hasRefunds && !asLines) {
    if (refundTotal !== (rt.gross || 0)) blockOnce({ code: 'refund_totals_mismatch', message: `The credit note lines come to ${major(refundTotal).toFixed(2)} but the day's refunds are ${major(rt.gross || 0).toFixed(2)}. Nothing was posted.` });
    refundPayments = paymentsOf([...refundMoney.values()], cnNumber, true);
    creditNote = {
      number: cnNumber, reference: `${reference} refunds`, contactName: cName, total: refundTotal, lineAmountTypes, lines: refundLines,
      payload: {
        Type: 'ACCRECCREDIT', Contact: contact, CreditNoteNumber: cnNumber, Reference: `${reference} refunds`, Date: day,
        Status: 'AUTHORISED', LineAmountTypes: lineAmountTypes, ...(currency ? { CurrencyCode: currency } : {}),
        LineItems: refundLines.map(payloadLine),
      },
    };
    // Said plainly on the day: its refunds went as a credit note, and why.
    const names = short.map((r) => r.kinds.join(' and ')).join(' and ');
    const WHY = {
      no_sales: 'This day has refunds and no sales, so there is no invoice to put them on. The refunds go to Xero as a credit note.',
      total_not_positive: 'The refunds on this day come to as much as its sales or more, and Xero does not take an invoice of zero or less. The refunds go to Xero as a credit note.',
      account_short: `More was refunded by ${names} on this day than was taken by ${names}, and Xero does not take a minus payment. The refunds go to Xero as a credit note.`,
      vat_negative: `The ${taxWord} on the refunds of this day is more than the ${taxWord} on its sales. The refunds go to Xero as a credit note.`,
      started_credit_note: 'This day was started in Xero with its refunds as a credit note, so it stays that way.',
      xero_refused: 'Xero did not take this day with its refunds on the invoice, so the refunds go to Xero as a credit note.',
    };
    warnings.push({ code: 'refunds_as_credit_note', reason: refundWayReason, message: WHY[refundWayReason] });
  }
  // The "VAT differs" notes of the refund side, named as the lines they are on.
  if (asLines) vatLarge.push(...refundVatLarge.map((x) => `Refund: ${x}`)); else vatLarge.push(...refundVatLarge);

  // ── warnings and blocks
  // 8 Oct 2026 (the VAT audit): a day holding a sale with no VAT recorded is never posted (it
  // would post inside the 20% line at VAT 0.00). The accounting day names the sales; nothing is
  // guessed, the sale is fixed first.
  for (const h of Array.isArray(summary.holds) ? summary.holds : []) blockOnce({ code: h.code, message: h.message, checkIds: h.checkIds || [] });
  const blockedList = [...blockedRates.values()];
  if (blockedList.length) {
    const names = blockedList.map((b) => (b.pct != null && !String(b.name).includes('%') ? `${b.name} (${b.pct}%)` : b.name)).join(', ');
    blockOnce({ code: 'tax_rate_unmapped', message: `No Xero sales tax rate for ServOS rate(s) ${names}. Choose one under ${where(taxRatesSection(exclusive))}. Nothing was posted.`, buckets: blockedList });
  }
  if (zeroWithVat.size) blockOnce({ code: 'zero_rate_with_vat', message: `${cap(taxWord)} was booked at ${[...zeroWithVat].join(', ')}, but the Xero rate chosen for it is 0% or No VAT. Choose the right rate under ${where(taxRatesSection(exclusive))}.` });
  if (unmappedGroups.size) warnings.push({ code: 'group_unmapped', message: `These sales groups have no account, so they post to Other sales: ${[...unmappedGroups].join(', ')}.`, groups: [...unmappedGroups] });
  if (fellBack.length) warnings.push({ code: 'tax_rate_estimated_default', message: `Checks with no VAT breakdown were taken to be at ${fellBack.map((b) => b.name).join(', ')}, which has no Xero sales rate, so they post at the default rate.` });
  if (vatLarge.length) warnings.push({ code: 'vat_override_large', message: `ServOS's ${taxWord} differs from what Xero would work out ${exclusive ? 'at these rates' : 'on these lines (discounts spread over a rate, or estimated splits)'}. ServOS's figure is sent: ${vatLarge.slice(0, 8).join('; ')}${vatLarge.length > 8 ? '; and more' : ''}.` });
  const flag = (code) => (groups.flags || []).find((f) => f.code === code);
  const est = flag('group_rate_estimated');
  if (est) warnings.push({ code: 'group_rate_estimated', message: `Items on ${est.count} check(s) could not be matched to a VAT rate, so their split between sales groups is estimated. The VAT per rate is still exact.`, checkIds: est.checkIds });
  if (groups.unresolved?.goods > 0 && groups.goodsTotal > 0) {
    const share = groups.unresolved.goods / groups.goodsTotal;
    if (share > 0.02) warnings.push({ code: 'unresolved_categories', message: `${Math.round(share * 100)}% of the day's sales are in categories with no sales group, so they post to Other sales.` });
  }
  if ((summary.sales?.byMethod || []).some((r) => r.kind === 'deposit' && r.gross)) {
    warnings.push({ code: 'deposits_seen', message: 'Booking deposits were used as payment. They post as a payment from the deposits account.' });
  }
  // 8 Oct 2026 (D1, the owner decides with his accountant): the till books VAT on a drink given
  // for stamps; this invoice takes it off on the Loyalty rewards line. Said plainly on every
  // preview that has one, so the Tax summary and the invoice can be read side by side.
  if (!exclusive && (summary.sales?.credits?.gross || 0) > 0) {
    warnings.push({ code: 'loyalty_vat_rule', message: LOYALTY_VAT_XERO_LINE });
  }

  // Hooks for phase 1b and 2: the card fee bill and cash over and short. OFF in this slice.
  const hooks = {
    feeBill: m.feeBill?.enabled === true && fees ? { planned: false, reason: 'not_available' } : null,
    cashVariance: m.cashVariance?.enabled === true && cash ? { planned: false, reason: 'not_available' } : null,
  };

  return {
    model: 'sales_invoice',
    number, creditNoteNumber: cnNumber, reference, contactName: cName,
    refundWay, refundWayReason,
    invoice, payments, creditNote, refundPayments,
    vatTie: [...vatTie.map((v) => ({ side: 'sales', ...v })), ...refundTie.map((v) => ({ side: 'refunds', ...v }))],
    warnings, blocked, blockedRates: blockedList, notReady, hooks,
    totals: { sales: st.gross || 0, refunds: rt.gross || 0, vat: vatTie.reduce((s, v) => s + v.invoiceVat, 0), refundVat: refundTie.reduce((s, v) => s + v.invoiceVat, 0) },
  };
}

/**
 * What a day (or a run of days) holds that the setup must cover: the sales and discount groups
 * seen, the money kinds (as clearing keys), and whether tips, service, gift cards or deposits
 * were taken. Feeds the Ready checklist.
 */
export function seenFromGrouped(grouped) {
  const summary = grouped?.summary || {};
  const groups = grouped?.groups || {};
  const g = new Set(), d = new Set();
  let gift = false, deposits = false;
  for (const side of [groups.sales, groups.refunds]) {
    for (const b of Object.values(side || {})) {
      for (const [k, v] of Object.entries(b.goods || {})) if (v) g.add(k);
      for (const [k, v] of Object.entries(b.discounts || {})) if (v) d.add(k);
      for (const [k, v] of Object.entries(b.credits || {})) if (v) d.add(k);
      if (b.gift) gift = true;
    }
  }
  const money = new Set();
  for (const r of [...(summary.sales?.byMethod || []), ...(summary.refunds?.byMethod || [])]) {
    if (!MONEY_KINDS.has(r.kind) || !r.gross) continue;
    money.add(clearingKeys(r)[0]);
    if (r.kind === 'gift_card') gift = true;
    if (r.kind === 'deposit') deposits = true;
  }
  const st = summary.sales?.totals || {}, rt = summary.refunds?.totals || {};
  return {
    groups: [...g].sort(), discountGroups: [...d].sort((a, b) => DISCOUNT_GROUPS.indexOf(a) - DISCOUNT_GROUPS.indexOf(b)), moneyKeys: [...money].sort(),
    tips: (st.tip || 0) + (rt.tip || 0) > 0, service: (st.service || 0) + (rt.service || 0) > 0, gift, deposits,
    unresolvedShare: groups.goodsTotal > 0 ? (groups.unresolved?.goods || 0) / groups.goodsTotal : 0,
    names: { ...(groups.names || {}) },
  };
}

/**
 * The ordered postings of a plan: [{ key, type, doc }] with type 'invoice' | 'payment' | 'credit_note' | 'refund'.
 * A day whose refunds are minus lines on the invoice has no credit note, so its steps are the
 * invoice and its payments only (INVOICE, PAY:<account>).
 */
export function planSteps(plan) {
  const out = [];
  if (plan?.invoice) out.push({ key: 'INVOICE', type: 'invoice', doc: plan.invoice });
  if (plan?.invoice) for (const p of plan.payments || []) out.push({ key: p.key, type: 'payment', doc: p });
  if (plan?.creditNote) out.push({ key: 'CREDIT', type: 'credit_note', doc: plan.creditNote });
  if (plan?.creditNote) for (const p of plan.refundPayments || []) out.push({ key: p.key, type: 'refund', doc: p });
  return out;
}

/**
 * Before a retry sends anything: what an earlier attempt already put in Xero must still be part
 * of the day exactly as it is planned now. A late check, a refund or a remapped clearing account
 * after the invoice was sent would otherwise pay money against an invoice Xero holds at the old
 * total (refused, or left owing), or book one kind of money into two clearing accounts. A changed
 * site code would miss the invoice already sent under the old number and send a second one.
 * Returns [{ code, key, message }]; empty when the retry may go on.
 */
/**
 * @param {any} plan
 * @param {Record<string, any> | null | undefined} postings
 * @returns {{ code: string, key: string, message: string }[]}
 */
export function retryConflicts(plan, postings) {
  const out = [];
  const recorded = postings && typeof postings === 'object' ? postings : {};
  const steps = new Map(planSteps(plan).map((s) => [s.key, s]));
  const planned = (s) => major(s.type === 'invoice' || s.type === 'credit_note' ? s.doc.total : s.doc.amount);
  const docNumber = (key) => (key === 'INVOICE' ? plan?.number : plan?.creditNoteNumber);
  for (const [key, rec] of Object.entries(recorded)) {
    if (!rec || typeof rec !== 'object') continue;
    const isDoc = key === 'INVOICE' || key === 'CREDIT';
    if (!isDoc && !/^(PAY|REFUND):/.test(key)) continue;
    const step = steps.get(key);
    const name = rec.number || rec.reference || key;
    // Sent under another number (the site code changed since): never looked up under the new one.
    if (isDoc && rec.number && docNumber(key) && rec.number !== docNumber(key)) {
      const code = String(rec.number).replace(/^SOS-/, '').replace(/-\d{8}(-R)?$/, '');
      out.push({ code: 'number_changed', key, message: `This day was sent to Xero as ${rec.number}, but the site code has changed since, so it would now be ${docNumber(key)}. Put the site code back to ${code} and press again.` });
      continue;
    }
    if (rec.status !== 'posted') continue;
    const was = Number(rec.total);
    if (!step) {
      out.push({ code: 'posted_not_in_plan', key, message: `${name} is in Xero${Number.isFinite(was) ? ` for ${was.toFixed(2)}` : ''} but is no longer part of this day's figures.` });
    } else if (Number.isFinite(was) && Math.abs(was - planned(step)) >= 0.005) {
      out.push({ code: 'posted_amount_changed', key, message: `${name} is in Xero for ${was.toFixed(2)}; the day now comes to ${planned(step).toFixed(2)}.` });
    }
  }
  return out;
}

/** The Idempotency-Key for one step (the payload as planned, before Xero ids are filled in). */
export function stepIdempotencyKey(locationId, date, step) {
  return idempotencyKey(locationId, date, { key: step.key, payload: step.doc.payload });
}

/** The plan in major units, for the Back Office (Check figures and the result of a post). */
export function planView(plan) {
  if (!plan) return null;
  const line = (l) => ({ kind: l.kind, refund: !!l.refund, description: l.description, account: l.account, taxType: l.taxType, amount: major(l.amount), vat: major(l.tax), xeroVat: major(l.xeroCalc) });
  const doc = (d) => (d ? { number: d.number, reference: d.reference, contactName: d.contactName, total: major(d.total), lineAmountTypes: d.lineAmountTypes, lines: d.lines.map(line), payload: d.payload } : null);
  const pay = (p) => ({ key: p.key, kinds: p.kinds, account: p.account, amount: major(p.amount), reference: p.reference, payload: p.payload });
  const tracking = plan.invoice?.payload?.LineItems?.[0]?.Tracking || plan.creditNote?.payload?.LineItems?.[0]?.Tracking || null;
  return {
    model: 'sales_invoice', number: plan.number, creditNoteNumber: plan.creditNoteNumber, reference: plan.reference, contactName: plan.contactName,
    refundWay: plan.refundWay || null, refundWayReason: plan.refundWayReason || null,
    tracking: tracking ? tracking.map((t) => `${t.Name}: ${t.Option}`).join(', ') : null,
    invoice: doc(plan.invoice), payments: (plan.payments || []).map(pay),
    creditNote: doc(plan.creditNote), refundPayments: (plan.refundPayments || []).map(pay),
    vatTie: (plan.vatTie || []).map((v) => ({ ...v, tillVat: major(v.tillVat), invoiceVat: major(v.invoiceVat), xeroCalc: major(v.xeroCalc) })),
    totals: { sales: major(plan.totals?.sales || 0), refunds: major(plan.totals?.refunds || 0), vat: major(plan.totals?.vat || 0) },
  };
}

// ── how a day's refunds were sent (13 Oct 2026) ──────────────────────────────
//
// A day is never mixed. The planner is pure and never sees the log row, so the caller reads the
// way from the row its run HOLDS (xero_sync_log.detail) and passes it in as `started`:
//   detail.postings            INVOICE, PAY:<account>, CREDIT, REFUND:<account>, each 'sending' or 'posted'
//   detail.refundWay           'lines' | 'credit_note' | null, saved BEFORE anything is sent
//                              (refundWayToRecord). Rows written before 13 Oct 2026 have none.
//   detail.refundLinesRefused  { at, message }, only after Xero refused an invoice BECAUSE of its
//                              refund lines, as far as can be told (invoiceRefusal 'lines')
//   postings.INVOICE.refusedNotLines  { at, words }, on an invoice still 'sending' that Xero refused
//                              for a cause that is not the refund lines (invoiceRefusal 'other').
//                              Nothing of the day is in Xero. The record is written again the
//                              moment a later attempt sends the invoice, so the mark goes with it.
// Every day sent before 13 Oct 2026 has an invoice for the gross figure and no marker, so it
// reads as the credit note way and finishes exactly as it was started.

const INV_KEY = (k) => k === 'INVOICE' || /^PAY:/.test(k);
const CN_KEY = (k) => k === 'CREDIT' || /^REFUND:/.test(k);
const dayKeys = (postings) => Object.keys(postings).filter((k) => postings[k] && typeof postings[k] === 'object' && (INV_KEY(k) || CN_KEY(k)));
// Nothing of the day on the row but its invoice, still 'sending'.
const invoiceAlone = (postings, keys) => keys.length === 1 && keys[0] === 'INVOICE' && postings.INVOICE.status === 'sending';

/**
 * How an earlier attempt sent, or started to send, the day's refunds: null | 'lines' | 'credit_note' | 'refused'.
 *   null           nothing of the sales invoice was sent (no row, a blocked or failed attempt that
 *                  sent nothing, older bank transaction keys only, a replace day after its old
 *                  entries were removed), or all that was sent is an invoice Xero refused for a
 *                  cause that is not the refund lines: the day is free to decide. A left over
 *                  marker is ignored.
 *   'credit_note'  a CREDIT or REFUND: record exists, or an INVOICE or PAY: record with no 'lines'
 *                  marker (the invoice went for the gross figure).
 *   'lines'        an INVOICE or PAY: record with the 'lines' marker.
 *   'refused'      Xero refused the refund lines (the refusal is on the row): the day goes the
 *                  credit note way, and keeps saying that Xero's refusal is why. Either nothing
 *                  but the refused invoice is on the row yet ('lines' marker), or the day has
 *                  already been switched ('credit_note' marker), however far it has got since.
 */
/**
 * @param {any} detail
 * @returns {null | 'lines' | 'credit_note' | 'refused'}
 */
export function refundWayStarted(detail) {
  const postings = detail?.postings && typeof detail.postings === 'object' ? detail.postings : {};
  const keys = dayKeys(postings);
  if (!keys.length) return null;
  const alone = invoiceAlone(postings, keys);
  if (alone && postings.INVOICE.refusedNotLines) return null;
  if (detail.refundLinesRefused && (detail.refundWay === 'credit_note' || (detail.refundWay === 'lines' && alone))) return 'refused';
  if (keys.some(CN_KEY)) return 'credit_note';
  if (detail.refundWay !== 'lines') return 'credit_note';
  return 'lines';
}

/** The value for detail.refundWay, saved before anything is sent. What an earlier attempt started always stands. */
export const refundWayToRecord = (started, plan) => (started === 'refused' ? 'credit_note' : started || plan?.refundWay || null);

/** Xero's answer that an invoice or credit note number is already in use (the document may be in Xero). */
export const isNumberTaken = (message) => /must be unique|already (been )?(used|assigned|exists)/i.test(String(message || ''));

// Xero's answer to the invoice THIS run sent (_shared/xero.ts words an error "Xero API <path>
// failed: <status> <body>"). A lookup of the number has "?InvoiceNumbers=" in its path: not this.
const OWN_INVOICE_400 = /^Xero API \/Invoices failed: 400(\s|$)/;
// Causes Xero names itself that have nothing to do with refund lines: a locked period.
const NOT_THE_REFUNDS = /lock date/i;

/**
 * What a failed attempt says about the day's refund lines (13 Oct 2026 review). Only Xero's own
 * "no" (HTTP 400) to the invoice this run sent counts, and only while nothing else of the day is
 * on the row: then nothing of the day is in Xero. A lookup that failed, a number Xero says is
 * taken (the invoice may be there) or a payment that failed says nothing, and the day goes on
 * the way it was started.
 *   null     says nothing.
 *   'lines'  the invoice had refund lines and nothing shows another cause: the next attempt
 *            sends the day the credit note way.
 *   'other'  the refund lines were NOT the cause: Xero refused the invoice without them too (the
 *            attempt after a refusal), or in the same words as the last such refusal, or
 *            refused an invoice with refund lines for a cause it names itself (a lock date).
 *            The day is free again, so it goes with its refunds on the invoice once the real
 *            cause is put right.
 * `started` is refundWayStarted of the row as claimed; `before` is postings.INVOICE.refusedNotLines
 * of the row as claimed; `error` is { status, message, words } (words: Xero's own, xeroErrorWords).
 */
/**
 * @param {any} plan
 * @param {{ started?: any, postings?: any, before?: any, error?: { status?: any, message?: any, words?: any } | null }} [o]
 * @returns {null | 'lines' | 'other'}
 */
export function invoiceRefusal(plan, { started = null, postings = null, before = null, error = null } = {}) {
  if (!plan?.invoice || Number(error?.status) !== 400) return null;
  const message = String(error?.message || '');
  if (!OWN_INVOICE_400.test(message) || isNumberTaken(message)) return null;
  const p = postings && typeof postings === 'object' ? postings : {};
  if (!invoiceAlone(p, dayKeys(p))) return null;
  const words = String(error?.words || '').trim();
  // Refused without its refund lines too, or in the words that refused it so before.
  if (started === 'refused' || (words && before?.words === words)) return 'other';
  // A day with no refund lines on its invoice has none to refuse: it goes on as it always did.
  if (plan.refundWay !== 'lines') return null;
  return NOT_THE_REFUNDS.test(words) ? 'other' : 'lines';
}

/** What a refusal writes on the day's row, in the detail of the attempt that failed. */
export function refusalPatch(kind, postings, { at, message, words }) {
  if (kind === 'lines') return { refundLinesRefused: { at, message: String(message || '').slice(0, 500) } };
  if (kind === 'other') return { refundLinesRefused: null, refundWay: null, postings: { ...postings, INVOICE: { ...postings.INVOICE, refusedNotLines: { at, words } } } };
  return {};
}

/** What the person is told after a refusal. `words` are Xero's own. */
export function refusalWords(kind, words) {
  const why = `${words}${/[.!?]$/.test(words) ? '' : '.'}`;
  if (kind === 'lines') return `Xero did not take this day with its refunds on the invoice: ${why} Nothing was posted. The next push sends the refunds as a credit note.`;
  if (kind === 'other') return `Xero did not take this day: ${why} Nothing was posted. Put that right, then push again.`;
  return '';
}

/**
 * The numbers a day would use in Xero. The credit note number is still checked on any day with
 * refunds: a day whose refund lines Xero refuses falls back to the credit note.
 */
export const dayNumbers = (plan) => ({
  invoice: plan?.invoice ? plan.number : null,
  creditNote: plan?.creditNote || plan?.refundWay === 'lines' ? plan.creditNoteNumber : null,
});

/**
 * A posted day against the day as it comes to now: one sentence per document whose total
 * differs. `plan` must be made the way the day was posted (started from its own row), or every
 * older day with refunds would read as changed.
 */
/**
 * @param {any} plan
 * @param {any[] | null | undefined} documents
 * @returns {string[]}
 */
export function postedDayChanges(plan, documents) {
  const docs = Array.isArray(documents) ? documents : [];
  const changed = [];
  const was = (t) => docs.find((d) => d?.type === t);
  for (const [t, doc] of [['invoice', plan?.invoice], ['credit_note', plan?.creditNote]]) {
    const posted = was(t);
    const now = doc ? doc.total / 100 : 0;
    const then = posted ? Number(posted.total) : 0;
    if (Math.abs(now - then) > 0.005) changed.push(`${posted?.number || doc?.number}: posted ${then.toFixed(2)}, now ${now.toFixed(2)}`);
  }
  return changed;
}

/**
 * The documents of a history row for the Postings tab, with Open in Xero links: the documents
 * recorded when the day finished, else the lines of an older bank transactions day, else what
 * the postings say is in Xero. A day posted with a credit note keeps showing it.
 */
/**
 * @param {any} row
 * @param {string | null} shortCode
 * @returns {any[]}
 */
export function historyDocs(row, shortCode) {
  if (Array.isArray(row.documents) && row.documents.length) {
    return row.documents.map((d) => ({ type: d.type, number: d.number, reference: d.reference, total: d.total, xeroId: d.xeroId, link: d.link || (d.type === 'invoice' || d.type === 'credit_note' ? xeroDocLink(d.type, d.xeroId, shortCode) : null) }));
  }
  if (Array.isArray(row.lines) && row.lines.length) {
    return row.lines.filter((l) => l.bankTransactionID).map((l) => ({ type: 'bank', number: l.reference, reference: l.reference, total: l.total, xeroId: l.bankTransactionID, direction: l.direction, link: l.link || xeroDocLink('bank', l.bankTransactionID, shortCode) }));
  }
  const postings = row.postings && typeof row.postings === 'object' ? row.postings : {};
  return Object.entries(postings).filter(([, p]) => p?.status === 'posted' && p.id).map(([k, p]) => {
    const type = p.type || (k.startsWith('RECEIVE') || k.startsWith('SPEND') ? 'bank' : k === 'INVOICE' ? 'invoice' : k === 'CREDIT' ? 'credit_note' : 'payment');
    return { type, number: p.number || p.reference, reference: p.reference, total: p.total, xeroId: p.id, direction: k.startsWith('SPEND') ? 'refunds' : 'takings', link: type === 'invoice' || type === 'credit_note' || type === 'bank' ? xeroDocLink(type, p.id, shortCode) : null };
  });
}
