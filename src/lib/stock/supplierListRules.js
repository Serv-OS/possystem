/**
 * stock/supplierListRules.js: the words and small rules of the company Suppliers screens (multi
 * site stock Drop 1: SupplierList, SupplierPage and its tabs). Pure: no imports, node --test drives
 * every function (supplierListRules.test.js). The words are the mockup's (scrSuppliers,
 * scrSupplier) and the Drop 1 contract 4.3.
 *
 * Nothing here decides who may save: the database does (stock_co__guard). These rules only grey
 * what the database would refuse, so no screen looks editable when the save would be refused.
 */

// ── money and days ──────────────────────────────────────────────────────────────────────────────
const SYMBOLS = Object.freeze({ GBP: '£', USD: '$', EUR: '€' });
const MONTHS = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const symbolOf = (currency) => {
  const c = String(currency || 'GBP').toUpperCase();
  return SYMBOLS[c] || `${c} `;
};

/** '£1.38' (2 places); '' for no amount. */
export function moneyText(amount, currency = 'GBP') {
  const n = num(amount);
  if (n === null) return '';
  return n < 0 ? `-${symbolOf(currency)}${(-n).toFixed(2)}` : `${symbolOf(currency)}${n.toFixed(2)}`;
}

/** Spend this month, whole pounds: '£4,210'; more than one currency: '£4,210 + €300'; none: '£0'. */
export function spendText(spend, fallbackCurrency = 'GBP') {
  const list = (Array.isArray(spend) ? spend : []).filter((s) => s && num(s.amount) !== null);
  if (!list.length) return `${symbolOf(fallbackCurrency)}0`;
  return list.map((s) => `${symbolOf(s.currency || fallbackCurrency)}${Math.round(num(s.amount)).toLocaleString('en-GB')}`).join(' + ');
}

/** A day as '3 Nov' (from 'YYYY-MM-DD', read as the calendar day it names, never shifted by a clock). */
export function dayMonth(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  const month = Number(m[2]);
  if (month < 1 || month > 12) return '';
  return `${Number(m[3])} ${MONTHS[month - 1]}`;
}

/** Next price: '£8.61 from 1 Nov'; none: 'None'. */
export function nextPriceText(next, currency = 'GBP') {
  if (!next || num(next.price) === null) return 'None';
  const day = dayMonth(next.from_day);
  return day ? `${moneyText(next.price, currency)} from ${day}` : moneyText(next.price, currency);
}

/** Price spread: '£8.28 to £8.70', one price when they are the same, '' when none is on. */
export function spreadText(spread, currency = 'GBP') {
  const lo = num(spread?.low);
  const hi = num(spread?.high);
  if (lo === null && hi === null) return '';
  if (lo === null || hi === null || lo === hi) return moneyText(lo ?? hi, currency);
  return `${moneyText(lo, currency)} to ${moneyText(hi, currency)}`;
}

/** Purchase VAT from its rate (a fraction, 0.2): '20%', '12.5%', '0%'; '' when none is set. */
export function vatText(rate) {
  const n = num(rate);
  if (n === null) return '';
  const pct = Math.round(n * 100 * 100) / 100;
  return `${pct}%`;
}

/**
 * The price of one count pack at another pack price: the row's unit price scales with the pack
 * price (both net of VAT), so "Price at Leeds" can say "£1.45 a bottle" too. null when unknown.
 */
export function unitPriceAt(row, price) {
  const unit = num(row?.unit_price);
  const company = num(row?.company_price);
  const p = num(price);
  if (unit === null || p === null) return null;
  if (company === null || company <= 0) return p === company ? unit : null;
  return (unit * p) / company;
}

// ── the list ────────────────────────────────────────────────────────────────────────────────────

/**
 * How many of the sites in view: 'All 7', '3 of 7', the one site's name, 'None here'. With one site
 * in view: its name when it is on, else 'None here'.
 */
export function countText(onIds, scopeIds, siteName = (id) => id) {
  const scope = Array.isArray(scopeIds) ? scopeIds : [];
  const on = new Set(Array.isArray(onIds) ? onIds : []);
  const inScope = scope.filter((id) => on.has(id));
  if (!scope.length || !inScope.length) return 'None here';
  if (inScope.length === scope.length) return scope.length === 1 ? siteName(scope[0]) : `All ${scope.length}`;
  if (inScope.length === 1) return siteName(inScope[0]);
  return `${inScope.length} of ${scope.length}`;
}

/** The Can order cell (mockup scrSuppliers): a local supplier says 'Local to <site>'. */
export function canOrderText(row, scopeIds, siteName = (id) => id) {
  if (row?.local_location_id) return `Local to ${siteName(row.local_location_id)}`;
  const on = (Array.isArray(row?.sites) ? row.sites : []).filter((s) => s && s.can_order).map((s) => s.location_id);
  return countText(on, scopeIds, siteName);
}

/** The Prices cell: `{ words, pill }`. A supplier with agreed prices shows the words as a pill. */
export function pricesText(row) {
  return row?.accepts_price_changes === false ? { words: 'Agreed prices', pill: true } : { words: 'Accepts price changes', pill: false };
}

/** The two ways orders reach a supplier: value, the list words and the Details words. */
export const ORDER_METHODS = Object.freeze([
  Object.freeze({ value: 'email', short: 'Email', label: 'Email, with a CSV attached' }),
  Object.freeze({ value: 'held', short: 'They hold a standing order', label: 'They hold a standing order (no email sent)' }),
]);

/** How orders reach them: 'Email' or 'They hold a standing order'. */
export function howOrdersText(row) {
  return (ORDER_METHODS.find((m) => m.value === row?.order_method) || ORDER_METHODS[0]).short;
}

/** The page sub line (decision 10: no promise of what Drop 3 builds). */
export function supplierSubText(supplier) {
  return supplier?.accepts_price_changes === false ? 'Agreed prices.' : 'Accepts price changes.';
}

/** The supplier page tabs, in order (mockup scrSupplier, multi site). */
export const SUPPLIER_TABS = Object.freeze([
  Object.freeze({ id: 'details', label: 'Details' }),
  Object.freeze({ id: 'sites', label: 'Sites' }),
  Object.freeze({ id: 'rules', label: 'Order rules' }),
  Object.freeze({ id: 'items', label: 'Items' }),
  Object.freeze({ id: 'changes', label: 'Changes' }),
]);

/** A start tab the page knows ('orderrules' and 'order rules' read as 'rules'), else 'sites'. */
export function tabOrDefault(tab) {
  const t = String(tab || '').toLowerCase().replace(/[\s_-]/g, '');
  const key = t === 'orderrules' ? 'rules' : t;
  return SUPPLIER_TABS.some((x) => x.id === key) ? key : 'sites';
}

/** The ids of the sites in view for stock_suppliers_page: null on All sites (the server's scope). */
export function listSites({ isAll, scopeSites }) {
  if (isAll) return null;
  const ids = (Array.isArray(scopeSites) ? scopeSites : []).map((s) => (typeof s === 'string' ? s : s?.id)).filter(Boolean);
  return ids.length ? ids : null;
}

// ── the Sites tab ───────────────────────────────────────────────────────────────────────────────

/** What each Sites tab value needs (contract 1.5, stock_save_supplier_site and p_sites). */
export const SITE_FIELD_NEED = Object.freeze({
  can_order: 'site_price', account_number: 'site_facts', email: 'site_facts', cc_emails: 'site_facts',
  min_order_value: 'site_price', delivery_fee: 'site_price', approval_limit: 'company',
});

/**
 * May this login change this value at this site? can = { company: bool (canEditCompany
 * 'purchasing'), site: (siteId, what) => bool (canEditSite) }.
 */
export function canEditSiteField(field, siteId, can) {
  const need = SITE_FIELD_NEED[field];
  if (!need || !can) return false;
  if (need === 'company') return !!can.company;
  return !!can.company || !!(typeof can.site === 'function' && can.site(siteId, need));
}

const andWords = (names) => {
  const list = (Array.isArray(names) ? names : []).map((n) => String(n ?? '').trim()).filter(Boolean);
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
};

/**
 * The line over the Sites tab for a login that is not a company editor: what they can change and
 * at which sites (the cells that are greyed say the rest). null for a company editor.
 */
export function sitesTabNote({ company, level, siteNames }) {
  if (company) return null;
  const where = andWords(siteNames);
  if (!where) return null;
  return level === 'sites_full'
    ? `You can change who can order, the account number, order email, CC emails, minimum order and delivery fee for ${where}. The approval limit comes from head office.`
    : `You can change the account number, order email and CC emails for ${where}. Who can order, the minimum order, the delivery fee and the approval limit come from head office.`;
}

/**
 * One row per site in the login's list (contract 3.4): the site, its link from
 * stock_supplier_detail (null when it has none) and whether it can order there. A site with no
 * link, or with can order off, reads "Cannot order from this supplier".
 */
export function siteRows(siteList, detailSites) {
  const links = new Map((Array.isArray(detailSites) ? detailSites : []).filter(Boolean).map((d) => [d.location_id, d]));
  return (Array.isArray(siteList) ? siteList : []).filter(Boolean).map((site) => {
    const link = links.get(site.id) || null;
    return { site, link, on: !!(link && link.can_order) };
  });
}

const sameValue = (a, b, kind) => {
  if (a === null || a === undefined || a === '') return b === null || b === undefined || b === '';
  if (b === null || b === undefined || b === '') return false;
  if (kind === 'money') return num(a) !== null && num(a) === num(b);
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
};

/**
 * A site value against the company's (order email, minimum order, delivery fee): the value the
 * site uses and whether it follows the company (grey, '(company)'). A site with its own value
 * that equals the company's still follows it: a company change carries to it (contract 1.5).
 */
export function followValue(siteValue, companyValue, kind = 'text') {
  const hasCompany = !(companyValue === null || companyValue === undefined || companyValue === '');
  const hasSite = !(siteValue === null || siteValue === undefined || siteValue === '');
  if (!hasCompany) return { value: hasSite ? siteValue : null, follow: false };
  if (!hasSite || sameValue(siteValue, companyValue, kind)) return { value: companyValue, follow: true };
  return { value: siteValue, follow: false };
}

/** The read only words of a Sites tab value: '(company)', '(none)' for no approval limit, or the value. */
export function siteValueText(field, siteValue, companyValue, currency = 'GBP') {
  if (field === 'approval_limit') return num(siteValue) === null ? '(none)' : moneyText(siteValue, currency);
  if (field === 'cc_emails') return ccText(siteValue);
  const kind = field === 'min_order_value' || field === 'delivery_fee' ? 'money' : 'text';
  const f = field === 'account_number' ? { value: siteValue, follow: false } : followValue(siteValue, companyValue, kind);
  if (f.follow) return '(company)';
  if (f.value === null || f.value === undefined || f.value === '') return '';
  return kind === 'money' ? moneyText(f.value, currency) : String(f.value);
}

/** CC emails as one line: 'a@example.com, b@example.com'. */
export function ccText(list) {
  if (Array.isArray(list)) return list.filter(Boolean).join(', ');
  return list ? String(list) : '';
}

/** CC emails typed in one box (commas, semicolons or spaces between): `{ ok, value: [..] | null } | { ok: false, error }`. */
export function parseCc(text) {
  const parts = String(text ?? '').split(/[\s,;]+/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return { ok: true, value: null };
  const bad = parts.find((p) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p));
  if (bad) return { ok: false, error: `"${bad}" is not an email. Write it like chef@example.com.` };
  return { ok: true, value: [...new Set(parts)] };
}

/** A money box: a number from 0, null when empty, or `{ error }` words. */
export function parseMoneyInput(v, label = 'This') {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return { ok: true, value: null };
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[£$€,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: `${label} must be an amount such as 150.` };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

/**
 * The value a Sites tab cell sends when it is left (stock_save_supplier_site patch). An emptied
 * order email, minimum or delivery fee goes back to the company's value, so a site is never left
 * with no order email while the company has one (orders read that one site row). Answers
 * `{ ok, value }` or `{ ok: false, error }`.
 */
export function siteCommitValue(field, input, companyValue) {
  const empty = input === null || input === undefined || (typeof input === 'string' && input.trim() === '');
  if (field === 'cc_emails') return parseCc(input);
  if (field === 'account_number') return { ok: true, value: empty ? null : String(input).trim() };
  if (field === 'email') {
    if (empty) return { ok: true, value: companyValue ? String(companyValue).trim() : null };
    const e = String(input).trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return { ok: false, error: 'The order email needs an @, for example orders@example.com.' };
    return { ok: true, value: e };
  }
  if (field === 'min_order_value' || field === 'delivery_fee' || field === 'approval_limit') {
    const labels = { min_order_value: 'Min order', delivery_fee: 'Delivery fee', approval_limit: 'Approval over' };
    const r = parseMoneyInput(input, labels[field]);
    if (!r.ok) return r;
    if (r.value === null && field !== 'approval_limit') return { ok: true, value: num(companyValue) };
    return r;
  }
  return { ok: false, error: 'This cannot be changed here.' };
}

// ── the Details tab ─────────────────────────────────────────────────────────────────────────────

/** The Details fields, in screen order, with their words (contract 4.3). */
export const DETAILS_FIELDS = Object.freeze([
  Object.freeze({ key: 'name', label: 'Name', kind: 'text' }),
  Object.freeze({ key: 'email', label: 'Order email', kind: 'text' }),
  Object.freeze({ key: 'phone', label: 'Phone', kind: 'text' }),
  Object.freeze({ key: 'contact_name', label: 'Contact', kind: 'text' }),
  Object.freeze({ key: 'payment_terms_days', label: 'Payment terms (days)', kind: 'int' }),
  Object.freeze({ key: 'notes', label: 'Comments', kind: 'text' }),
  Object.freeze({ key: 'min_order_value', label: 'Minimum order', kind: 'money' }),
  Object.freeze({ key: 'max_order_value', label: 'Maximum order', kind: 'money' }),
  Object.freeze({ key: 'delivery_fee', label: 'Delivery fee', kind: 'money' }),
  Object.freeze({ key: 'order_method', label: 'How orders reach them', kind: 'method' }),
  Object.freeze({ key: 'accepts_price_changes', label: 'Accept price changes', kind: 'bool' }),
]);

const str = (v) => (v === null || v === undefined ? '' : String(v));

/** The form values of a company supplier row (every box a string, the tick a bool). */
export function detailsDraft(s) {
  const r = s || {};
  return {
    name: str(r.name), email: str(r.email), phone: str(r.phone), contact_name: str(r.contact_name),
    payment_terms_days: str(r.payment_terms_days), notes: str(r.notes),
    min_order_value: str(r.min_order_value), max_order_value: str(r.max_order_value), delivery_fee: str(r.delivery_fee),
    order_method: r.order_method === 'held' ? 'held' : 'email',
    accepts_price_changes: r.accepts_price_changes !== false,
  };
}

/**
 * The company keys stock_save_supplier takes from the Details form (contract 1.5 and Drop 0 3.4),
 * checked: `{ ok: true, supplier }` or `{ ok: false, error }`. Never a site key (delivery days are
 * on the Order rules tab in a multi site company).
 */
export function detailsPayload(draft) {
  const d = draft || {};
  const name = str(d.name).trim();
  if (!name) return { ok: false, error: 'Give the supplier a name.' };
  const email = str(d.email).trim();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'The order email needs an @, for example orders@example.com.' };
  let terms = null;
  if (str(d.payment_terms_days).trim() !== '') {
    terms = Number(str(d.payment_terms_days).trim());
    if (!Number.isInteger(terms) || terms < 0) return { ok: false, error: 'Payment terms must be a whole number of days, such as 30.' };
  }
  const moneyOf = {};
  for (const f of DETAILS_FIELDS.filter((x) => x.kind === 'money')) {
    const r = parseMoneyInput(d[f.key], f.label);
    if (!r.ok) return r;
    moneyOf[f.key] = r.value;
  }
  if (moneyOf.min_order_value !== null && moneyOf.max_order_value !== null && moneyOf.max_order_value < moneyOf.min_order_value) {
    return { ok: false, error: 'The maximum order must be more than the minimum order.' };
  }
  return {
    ok: true,
    supplier: {
      name, email: email || null, phone: str(d.phone).trim() || null, contact_name: str(d.contact_name).trim() || null,
      payment_terms_days: terms, notes: str(d.notes).trim() || null,
      min_order_value: moneyOf.min_order_value, max_order_value: moneyOf.max_order_value, delivery_fee: moneyOf.delivery_fee,
      order_method: d.order_method === 'held' ? 'held' : 'email',
      accepts_price_changes: d.accepts_price_changes !== false,
    },
  };
}

/** A company supplier row as the values the form saves (no checks: a stored row is taken as it is). */
export function companyValues(s) {
  const r = s || {};
  const text = (v) => (str(v).trim() || null);
  return {
    name: str(r.name).trim(), email: text(r.email), phone: text(r.phone), contact_name: text(r.contact_name),
    payment_terms_days: num(r.payment_terms_days), notes: text(r.notes),
    min_order_value: num(r.min_order_value), max_order_value: num(r.max_order_value), delivery_fee: num(r.delivery_fee),
    order_method: r.order_method === 'held' ? 'held' : 'email',
    accepts_price_changes: r.accepts_price_changes !== false,
  };
}

/** Plain words of one Details value, for the Someone saved first table. */
export function detailsValueText(field, value, currency = 'GBP') {
  const f = DETAILS_FIELDS.find((x) => x.key === field);
  if (value === null || value === undefined || value === '') return f?.kind === 'bool' ? 'No' : '';
  if (f?.kind === 'bool') return value ? 'Yes' : 'No';
  if (f?.kind === 'money') return moneyText(value, currency);
  if (f?.kind === 'method') return (ORDER_METHODS.find((m) => m.value === value) || ORDER_METHODS[0]).label;
  return String(value);
}

/**
 * Someone saved first (mockup modal "conflict"): loaded = the company row the form opened with,
 * mine = the checked form values (detailsPayload().supplier), theirs = the fresh company row.
 *   rows:  each field THEY changed (theirs differs from loaded) that this screen says otherwise:
 *          { label, theirs, mine }. So "Tom changed Contact from Alex Kim to Sam Ray." is true, and
 *          a field only this login changed is never shown as theirs;
 *   patch: what "Save mine on top" sends: this screen, on the new version, so each row above goes
 *          back to "Yours" as the table says (both changes are in the log);
 *   theirsChanged: they changed a field this form shows.
 * No rows: nothing of theirs clashes with this screen (they changed nothing here, or the same as
 * typed here), so the screen saves again on the new version with no question.
 */
export function onTopPlan(loaded, mine, theirs, currency = 'GBP') {
  const L = companyValues(loaded);
  const T = companyValues(theirs);
  const M = { ...L, ...(mine || {}) };
  const rows = [];
  let theirsChanged = false;
  for (const f of DETAILS_FIELDS) {
    const kind = f.kind === 'money' || f.kind === 'int' ? 'money' : 'text';
    const same = (a, b) => (f.kind === 'bool' ? !!a === !!b : sameValue(a, b, kind));
    if (same(T[f.key], L[f.key])) continue;
    theirsChanged = true;
    if (!same(M[f.key], T[f.key])) rows.push({ label: f.label, theirs: detailsValueText(f.key, T[f.key], currency), mine: detailsValueText(f.key, M[f.key], currency) });
  }
  return { patch: M, rows, theirsChanged };
}

// ── the Changes tab ─────────────────────────────────────────────────────────────────────────────

/** The change log field names in plain words (stock_change_log.field of a supplier). */
export const SUPPLIER_FIELD_WORDS = Object.freeze({
  name: 'Name', contact_name: 'Contact', phone: 'Phone', email: 'Order email', payment_terms_days: 'Payment terms (days)',
  notes: 'Comments', accepts_price_changes: 'Accept price changes', min_order_value: 'Minimum order', max_order_value: 'Maximum order',
  delivery_fee: 'Delivery fee', order_method: 'How orders reach them', account_number: 'Account number', cc_emails: 'CC emails',
  approval_limit: 'Approval over', can_order: 'Can order', order_rules: 'Order rules', delivery_days: 'Delivery days',
  cutoff_time: 'Cut off', archived_at: 'Archived', local_location_id: 'Local site', pack_price: 'Company price',
  price_here: 'Price here', off_here: 'On', paused: 'Paused', agreed_until: 'Agreed until', allowed_diff_pct: 'Allowed difference %',
  suggestion: 'Suggested change',
});

const humanField = (field) => {
  const f = String(field || '');
  if (SUPPLIER_FIELD_WORDS[f]) return SUPPLIER_FIELD_WORDS[f];
  const words = f.replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'A change';
};

/** The What cell: 'Account number at Leeds', 'Name'. */
export function changeWhat(row, siteName = (id) => id) {
  const what = humanField(row?.field);
  return row?.location_id ? `${what} at ${siteName(row.location_id)}` : what;
}

const DAY_SHORT = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
const ruleText = (r) => {
  const d = Number(r?.delivery_dow);
  const day = Number.isInteger(d) && d >= 0 && d <= 6 ? DAY_SHORT[d] : '?';
  const od = Number(r?.order_by_dow);
  const t = String(r?.order_by_time || '').slice(0, 5);
  return r?.order_by_dow !== null && r?.order_by_dow !== undefined && Number.isInteger(od) && od >= 0 && od <= 6 && t
    ? `${day} (order by ${DAY_SHORT[od]} ${t})` : day;
};

/** An Old or New cell: plain words for any value the log holds. */
export function changeValueText(value, field) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'boolean') {
    if (field === 'off_here') return value ? 'No' : 'Yes';
    return value ? 'Yes' : 'No';
  }
  if (field === 'order_method') return (ORDER_METHODS.find((m) => m.value === value) || { short: String(value) }).short;
  if (Array.isArray(value)) {
    if (field === 'order_rules' || value.some((v) => v && typeof v === 'object' && 'delivery_dow' in v)) return value.map(ruleText).join(', ');
    return value.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : String(v))).join(', ');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// ── the Items tab export ────────────────────────────────────────────────────────────────────────

/**
 * The Items tab rows as a CSV table: `{ headers, rows }` for reports/_csv.js toCsv. priceFor is
 * 'company' or a site id (then a "Price at <site>" column, empty when off there).
 */
export function exportPriceRows(rows, { priceFor = 'company', siteName = (id) => id } = {}) {
  const site = priceFor && priceFor !== 'company' ? priceFor : null;
  const headers = [
    { label: 'Item', key: 'item' }, { label: 'Their name', key: 'their_name' }, { label: 'SKU', key: 'sku' },
    { label: 'Pack', key: 'pack' }, { label: 'Company price', key: 'company_price' },
    ...(site ? [{ label: `Price at ${siteName(site)}`, key: 'site_price' }] : []),
    { label: 'Currency', key: 'currency' }, { label: 'Next price', key: 'next_price' }, { label: 'Next price from', key: 'next_from' },
    { label: 'VAT', key: 'vat' }, { label: 'Sites on', key: 'sites_on' }, { label: 'Lowest price', key: 'low' }, { label: 'Highest price', key: 'high' },
    { label: 'Paused', key: 'paused' },
  ];
  const fix = (v) => (num(v) === null ? '' : num(v).toFixed(2));
  const out = (Array.isArray(rows) ? rows : []).map((r) => ({
    item: str(r.item_name), their_name: str(r.supplier_product_name), sku: str(r.sku), pack: str(r.pack_description),
    company_price: fix(r.company_price), site_price: site ? fix(r.site_price) : '', currency: str(r.currency),
    next_price: fix(r.next_price?.price), next_from: str(r.next_price?.from_day), vat: vatText(r.purchase_vat_rate),
    sites_on: num(r.sites_on) === null ? '' : String(num(r.sites_on)), low: fix(r.spread?.low), high: fix(r.spread?.high),
    paused: r.paused ? 'Yes' : 'No',
  }));
  return { headers, rows: out };
}

/** A file name from a supplier name: letters, numbers and spaces only. */
export function fileName(name, tail = 'prices') {
  const base = String(name || 'Supplier').replace(/[^A-Za-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Supplier';
  return `${base} ${tail}.csv`;
}

// ── saved words ─────────────────────────────────────────────────────────────────────────────────

/**
 * What a save says when the database queued some sites (contract 4.5): 'Saved.' alone, or
 * 'Saved. 1 site catches up within a minute.' / 'Saved. 3 sites catch up within a minute.'.
 * lead: the words before (default 'Saved.').
 */
export function savedWords(queued, lead = 'Saved.') {
  const n = new Set((Array.isArray(queued) ? queued : []).map((q) => q?.location_id ?? q?.job_id ?? q).filter(Boolean)).size;
  if (!n) return lead;
  return `${lead} ${n} site${n === 1 ? ' catches' : 's catch'} up within a minute.`;
}
