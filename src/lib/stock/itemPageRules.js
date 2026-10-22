/**
 * stock/itemPageRules.js: the rules behind the company item page (multi site stock Drop 1, mockup
 * scrItem and sitesTab). Pure: no browser, no database, so node --test drives every rule
 * (itemPageRules.test.js). The screens in src/backoffice/sections/stock/items/ only draw what these
 * answer and call the save functions.
 *
 *   itemTabs(multi)                        the tabs, in order ('Sites' only in a multi site company)
 *   FIELD_WORDS                            change log field names in plain words
 *   conflictRows(draft, fresh, fieldWords) the fields where two versions differ
 *   onTopRows(loaded, draft, fresh, fieldWords) "someone saved first": the fields THEY changed that
 *                                          this screen says otherwise
 *   untickState({ onHand, unit, recipeNames, siteName })  can Remove now run, and why not
 *   siteRowModel(site, detail, scope)      one row of the Sites tab
 *   changeWords(row, siteById, opts)       one change log row as When, Who, What, Old, New
 *
 * Nothing here decides who may save: the database does (stock_co__guard). These only grey what the
 * database would refuse, so nobody meets a refusal on a screen that looks editable.
 */

import { countPackOf, packAmount, packPrice, packQtyWords, moneyText } from './packPrice.js';
import { toBase } from './uom.js';
import { fmtVenueDateTime, fmtVenueDate, fmtYmd } from '../venueDate.js';
import { allergenWords, dietWords, factsOf, nutritionOf, NUTRITION_FIELDS } from './factsRules.js';

const num = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const round = (v, places = 3) => { const f = 10 ** places; return Math.round(Number(v) * f) / f; };
const trimNum = (v) => { const n = num(v); return n == null ? '' : String(round(n, 3)); };

// ── Tabs ─────────────────────────────────────────────────────────────────────

const TABS = Object.freeze([
  Object.freeze({ id: 'details', value: 'details', key: 'details', label: 'Details' }),
  Object.freeze({ id: 'packs', value: 'packs', key: 'packs', label: 'Packs' }),
  Object.freeze({ id: 'suppliers', value: 'suppliers', key: 'suppliers', label: 'Suppliers' }),
  Object.freeze({ id: 'sites', value: 'sites', key: 'sites', label: 'Sites' }),
  Object.freeze({ id: 'usedin', value: 'usedin', key: 'usedin', label: 'Used in' }),
  Object.freeze({ id: 'changes', value: 'changes', key: 'changes', label: 'Changes' }),
]);

/**
 * Details, Packs, Suppliers, Sites, Used in, Changes. No Sites tab for a one site company. Each tab is
 * { id, value, key, label }: stockUi TabBar reads id and label.
 */
export function itemTabs(multi) {
  return multi ? TABS.slice() : TABS.filter((t) => t.value !== 'sites');
}

/** The tab the page opens on: the asked one when it is there, else Details. */
export function startTabOf(tabs, wanted) {
  return (tabs || []).some((t) => t.value === wanted) ? wanted : 'details';
}

// ── Words for fields and values ──────────────────────────────────────────────

/** The change log's field names (company and site columns) in plain words. */
export const FIELD_WORDS = Object.freeze({
  name: 'Name',
  category: 'Category',
  category_id: 'Category',
  accounting_group: 'Accounting group',
  type: 'Type',
  base_unit: 'Base unit',
  sku: 'SKU',
  barcode: 'Barcode',
  shelf_life_days: 'Shelf life',
  purchase_vat_rate: 'Purchase VAT',
  allergens: 'Allergens',
  returns_to_shelf: 'Can go back on the shelf after a refund',
  exclude_from_gp: 'Leave out of GP',
  key_item: 'Key item (counted daily)',
  notes: 'Notes',
  paused_from: 'Paused from',
  paused_until: 'Paused until',
  main_supplier_item_id: 'Main supplier',
  local_location_id: 'Local to',
  archived_at: 'Archived',
  on_here: 'Stocked here',
  paused: 'Paused',
  supply_mode: 'Bought or made',
  counted_here: 'Counted here',
  stop_ordering_at: 'Stop ordering, run out',
  par_level: 'Par',
  reorder_point: 'Reorder at',
  min_level: 'Min',
  area_id: 'Area',
  why_on: 'Why it is here',
  price_here: 'Price here',
  pack_price: 'Company price',
  supplier_here: 'Supplier here',
  current_cost: 'Cost here',
  par_by_weekday: 'Par by day',
  cover_days: 'Days of cover',
  created: 'Made',
  suggestion: 'Suggested change',
  lines: 'Recipe lines',
  // Drop 2: what is in a supplier item (stock_co_supplier_items facts columns, change log field 'facts')
  may_contain: 'May contain',
  diets: 'Diets',
  ingredients_text: 'Ingredients (in weight order)',
  nutrition: 'Nutrition per 100 g',
  facts: 'What is in it',
  facts_checked_at: 'Checked',
  facts_checked_by_name: 'Checked by',
  facts_source: 'Allergens come from',
});

/** Where an item's allergens come from (stock_co_items.facts_source) in words. */
export const FACTS_SOURCE_WORDS = Object.freeze({ supplier_items: 'The supplier items', item: 'The item itself' });

/** Who did a change when no person did: the source in words. */
export const SOURCE_WORDS = Object.freeze({
  invoice: 'An invoice', INVOICE: 'An invoice',
  po_receipt: 'A delivery', PO_RECEIPT: 'A delivery',
  import: 'An import',
  dated_price: 'A dated price',
  copy_site: 'Copy a site',
  nightly: 'The nightly check',
  link: 'Linking the sites',
  writer: 'ServOS', system: 'ServOS',
});

const TYPE_WORDS = Object.freeze({ food: 'Food', drink: 'Drink', other: 'Other' });
export const ITEM_TYPES = Object.freeze([
  Object.freeze({ value: 'food', label: 'Food' }),
  Object.freeze({ value: 'drink', label: 'Drink' }),
  Object.freeze({ value: 'other', label: 'Other' }),
]);

/** A VAT rate (a fraction, 0.2) in words: '20%', '0% (zero rated)'. Null: 'None set'. */
export function vatWords(rate) {
  const r = num(rate);
  if (r == null) return 'None set';
  if (r === 0) return '0% (zero rated)';
  return `${String(round(r * 100, 3))}%`;
}

/**
 * The Purchase VAT choices: every distinct rate of the company's sites' tax rows (VAT is matched by
 * its rate, so "VAT 20%" at one site and "Standard Rate 20%" at another are one choice), plus the
 * item's own rate when no site has it. [{ value: number | null, label }], None first.
 */
export function vatChoices(taxRows, current = null) {
  const seen = new Map();
  for (const r of taxRows || []) {
    if (!r || r.active === false) continue;
    const v = num(r.rate);
    if (v == null || v < 0 || v >= 1) continue;
    const k = round(v, 6);
    if (!seen.has(k)) seen.set(k, k);
  }
  const cur = num(current);
  if (cur != null && !seen.has(round(cur, 6))) seen.set(round(cur, 6), round(cur, 6));
  const list = [...seen.values()].sort((a, b) => a - b).map((v) => ({ value: v, label: vatWords(v) }));
  return [{ value: null, label: 'None set' }, ...list];
}

const sameRate = (a, b) => (num(a) == null && num(b) == null) || (num(a) != null && num(b) != null && round(num(a), 6) === round(num(b), 6));
export { sameRate };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// a record id the screen has no name for is never shown raw
const ID_WORDS = Object.freeze({
  area_id: 'Another area', main_supplier_item_id: 'Another supplier', supplier_here: 'Another supplier',
  local_location_id: 'Another site', category_id: 'Another category',
});

/** One stored value in words, for the change log and the "saved first" table. */
export function valueWords(field, value, opts = {}) {
  if (value == null || value === '') return 'None';
  if (Array.isArray(value)) {
    const list = value.filter((v) => v != null && v !== '').map((v) => (typeof v === 'string' ? v[0].toUpperCase() + v.slice(1) : String(v)));
    return list.length ? list.join(', ') : 'None';
  }
  if (typeof value === 'boolean') {
    if (field === 'on_here') return value ? 'On' : 'Off';
    return value ? 'Yes' : 'No';
  }
  if (field === 'type') return TYPE_WORDS[value] || String(value);
  if (field === 'purchase_vat_rate') return vatWords(value);
  if (field === 'shelf_life_days') return `${trimNum(value)} days`;
  if (field === 'pack_price' || field === 'price_here') return moneyText(value, opts.currency) || 'None';
  if (field === 'current_cost') return (opts.countPack ? packPrice(value, opts.countPack, opts.currency) : moneyText(value, opts.currency)) || 'None';
  if (field === 'par_level' || field === 'reorder_point' || field === 'min_level') {
    if (opts.countPack) { const q = toPackQty(value, opts.countPack); return q == null ? 'None' : packQtyWords(q, opts.countPack, opts.baseUnit); }
    return trimNum(value);
  }
  if (field === 'paused_from' || field === 'paused_until') return fmtYmd(value, { year: false });
  if (field === 'stop_ordering_at' || field === 'archived_at') return fmtVenueDate(value, opts.tz, { year: false }) || String(value);
  if (opts.names && typeof value === 'string' && opts.names[value]) return opts.names[value];
  if (field === 'facts_source') return FACTS_SOURCE_WORDS[value] || String(value);
  if (field === 'facts' && typeof value === 'object') return factsChangeWords(value);
  if (field === 'nutrition' && typeof value === 'object') return nutritionWords(value);
  if (typeof value === 'string' && UUID.test(value)) return ID_WORDS[field] || 'Another one';
  if (typeof value === 'number') return trimNum(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Nutrition per 100 g in one line: '120 kcal, Fat 3 g, Salt 0.4 g' (empty numbers left out); 'None' for nothing. */
export function nutritionWords(value) {
  const n = nutritionOf(value);
  const parts = NUTRITION_FIELDS.filter((f) => n[f.key] != null).map((f) => (f.key === 'kcal' ? `${trimNum(n.kcal)} kcal` : `${f.label} ${trimNum(n[f.key])} ${f.unit}`));
  return parts.length ? parts.join(', ') : 'None';
}

/**
 * A change log 'facts' value (the before or after of What is in it) in one line:
 * 'Allergens: Milk; May contain: Tree nuts; Diets: Vegetarian; Ingredients: ...; Nutrition: 120 kcal'.
 */
export function factsChangeWords(value) {
  const f = factsOf(value);
  const parts = [`Allergens: ${allergenWords(f.allergens)}`];
  if (f.may_contain.length) parts.push(`May contain: ${allergenWords(f.may_contain)}`);
  if (f.diets.length) parts.push(`Diets: ${dietWords(f.diets)}`);
  if (f.ingredients_text) parts.push(`Ingredients: ${f.ingredients_text}`);
  const n = nutritionWords(f.nutrition);
  if (n !== 'None') parts.push(`Nutrition: ${n}`);
  return parts.join('; ');
}

// ── Someone saved first ──────────────────────────────────────────────────────

function norm(v) {
  if (v == null || v === '') return null;
  if (Array.isArray(v)) return JSON.stringify([...v].map(String).sort());
  if (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) && /^-?\d+(\.\d+)?$/.test(v.trim()))) return `n:${Number(v)}`;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** True when two stored values mean the same ('' and null, '7' and 7, the same list in any order). */
export function sameValue(a, b) {
  return norm(a) === norm(b);
}

/**
 * The rows of the "someone saved first" table: every field in fieldWords whose value in what the
 * other person saved (fresh) differs from the screen (draft). [{ key, label, theirs, mine }].
 * opts.names maps ids to words (a category id to its name).
 */
export function conflictRows(draft, fresh, fieldWords = FIELD_WORDS, opts = {}) {
  const words = fieldWords || FIELD_WORDS;
  const d = draft || {};
  const f = fresh || {};
  const out = [];
  const seenLabels = new Set();
  for (const key of Object.keys(words)) {
    if (!(key in d) && !(key in f)) continue;
    if (sameValue(d[key], f[key])) continue;
    const label = words[key];
    if (seenLabels.has(label)) continue;
    seenLabels.add(label);
    out.push({ key, label, theirs: valueWords(key, f[key], opts), mine: valueWords(key, d[key], opts) });
  }
  return out;
}

/**
 * Someone saved first (mockup modal "conflict") on the Details tab. loaded = the screen's fields as it
 * opened (detailsDraft of the item it read), draft = the screen now, fresh = what the other person
 * saved (detailsDraft of the item read again). The rows are only the fields THEY changed (fresh differs
 * from loaded) that this screen says otherwise: [{ key, label, from, theirs, mine }]. A field only this
 * login changed is never shown as theirs. "Save mine on top" sends this screen against the item read
 * again (detailsPatch(draft, freshItem)), so every row goes back to "Yours", as the table says, and
 * their other changes stay. No rows: nothing of theirs clashes with this screen, so it saves again on
 * the new version with no question (the supplier page does the same, supplierListRules.onTopPlan).
 */
export function onTopRows(loaded, draft, fresh, fieldWords = FIELD_WORDS, opts = {}) {
  const words = fieldWords || FIELD_WORDS;
  const L = loaded || {};
  const D = draft || {};
  const F = fresh || {};
  const out = [];
  const seenLabels = new Set();
  for (const key of Object.keys(words)) {
    if (!(key in L) && !(key in D) && !(key in F)) continue;
    if (sameValue(F[key], L[key])) continue;
    if (sameValue(D[key], F[key])) continue;
    const label = words[key];
    if (seenLabels.has(label)) continue;
    seenLabels.add(label);
    out.push({ key, label, from: valueWords(key, L[key], opts), theirs: valueWords(key, F[key], opts), mine: valueWords(key, D[key], opts) });
  }
  return out;
}

/** Purchased or made, the words of the one site screen (StockItemsSplit) on the company page too. */
export const KIND_CHOICES = Object.freeze([
  Object.freeze({ value: 'PURCHASED', label: 'Purchased' }),
  Object.freeze({ value: 'MADE', label: 'Made here' }),
]);

/**
 * Clone keeps how each ticked site gets the item: [{ location_id, kind, is_sellable }], PURCHASED
 * or MADE as the item is at that site (a batch or made to order counts as MADE). A ticked site the
 * item is not at yet takes what most of its sites do (MADE only when most of them make it).
 */
export function cloneSiteKinds(detail, siteIds) {
  const rows = (detail?.sites || []).filter((s) => s && s.location_id);
  const isMade = (s) => !!s.supply_mode && s.supply_mode !== 'bought';
  const usual = rows.length && rows.filter(isMade).length * 2 > rows.length ? 'MADE' : 'PURCHASED';
  return (siteIds || []).filter(Boolean).map((id) => {
    const s = rows.find((x) => x.location_id === id);
    return { location_id: id, kind: s ? (isMade(s) ? 'MADE' : 'PURCHASED') : usual, is_sellable: s ? s.is_sellable === true : false };
  });
}

// ── Taking an item off a site ────────────────────────────────────────────────

/** 'Latte'; 'Latte and Mocha'; 'Latte, Mocha and Flat white'; 'Latte, Mocha and 3 more'. */
export function recipesWords(names, count = null) {
  const list = (names || []).filter(Boolean).map(String);
  const total = Math.max(num(count) || 0, list.length);
  if (!list.length) return '';
  if (total === 1) return list[0];
  if (total > list.length) return `${list.slice(0, 2).join(', ')} and ${total - Math.min(list.length, 2)} more`;
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/**
 * The plain reason Remove now is blocked (contract 4.2, the server's own words for the parts that
 * apply): 'Leeds holds 3 kg and Latte uses it. Choose Stop ordering, run out, or write it off first.'
 * holds is the amount in words ('3 kg') or empty.
 */
export function untickWords({ siteName = '', holds = '', usedBy = [], recipeCount = null } = {}) {
  const h = String(holds || '').trim();
  const rec = recipesWords(usedBy, recipeCount);
  const many = Math.max(num(recipeCount) || 0, (usedBy || []).filter(Boolean).length) > 1;
  if (!h && !rec) return 'Nothing is held there and no recipe there uses it.';
  let first;
  if (h && rec) first = `${siteName} holds ${h} and ${rec} ${many ? 'use' : 'uses'} it.`;
  else if (h) first = `${siteName} holds ${h}.`;
  else first = `${rec} ${many ? 'use' : 'uses'} it at ${siteName}.`;
  return `${first} Choose Stop ordering, run out, or write it off first.`;
}

/**
 * Can Remove now run at this site? onHand in the unit people count in ({ onHand: 3, unit: 'kg' }),
 * recipeNames the live recipes there that use it. Stock below zero is not "held".
 * Answer { holds: '3 kg' | '', usedBy: [...], blocked, words }.
 */
export function untickState({ onHand = 0, unit = '', recipeNames = [], siteName = '', recipeCount = null } = {}) {
  const q = num(onHand);
  const holds = q != null && q > 1e-9 ? `${trimNum(q)} ${unit || ''}`.trim() : '';
  const usedBy = (recipeNames || []).filter(Boolean).map(String);
  const recipes = Math.max(num(recipeCount) || 0, usedBy.length);
  const blocked = !!holds || recipes > 0;
  return { holds, usedBy, blocked, words: untickWords({ siteName, holds, usedBy, recipeCount: recipes }) };
}

/** What the modal's holds prop may be (words, a number, true) as words. */
export function holdsText(holds) {
  if (holds == null || holds === false) return '';
  if (holds === true) return 'some stock';
  if (typeof holds === 'number') return holds > 1e-9 ? trimNum(holds) : '';
  return String(holds).trim();
}

// ── One row of the Sites tab ─────────────────────────────────────────────────

/** A base unit quantity (par, reorder, min, on hand) in the pack people count in, or null. */
export function toPackQty(base, countPack) {
  const b = num(base);
  const q = num(countPack?.qty_in_base);
  if (b == null || q == null || q <= 0) return null;
  return round(b / q, 3);
}

/** What was typed in the pack people count in, back in base units: '' is null (clears it). */
export function toBaseQty(typed, countPack) {
  if (typed == null || String(typed).trim() === '') return null;
  const t = Number(typed);
  const q = num(countPack?.qty_in_base);
  if (!Number.isFinite(t) || t < 0 || q == null || q <= 0) return undefined;
  return round(t * q, 6);
}

const liveSupplierItems = (detail) => (detail?.supplier_items || []).filter((s) => s && !s.archived_at);

/** The item in the shape the unit engine reads (base unit and the company bridges). */
export function uomItemOf(detail) {
  const item = detail?.item || {};
  return {
    baseUnit: item.base_unit || 'each',
    itemConversions: (detail?.bridges || []).filter((b) => b && !b.archived_at)
      .map((b) => ({ fromQty: Number(b.from_qty), fromUnit: b.from_unit, toQty: Number(b.to_qty), toUnit: b.to_unit })),
    formats: (detail?.packs || []).filter((p) => p && !p.archived_at).map((p) => ({
      id: p.id, name: p.name, qtyInBase: Number(p.qty_in_base), isCountDefault: p.is_count_default === true, isPurchaseDefault: p.is_purchase_default === true,
    })),
  };
}

/**
 * How many supplier packs' worth of money one count pack is: the number that turns the price shown
 * ("£1.45 a bottle") into the supplier pack price the database stores ("£8.70 for 6 x 2 L").
 * From the database's own two figures when both are there (so a price typed back exactly is the
 * price stored), else from the pack sizes (a supplier pack whose price includes VAT is grossed up).
 * Null when it cannot be worked out: the screen then does not offer the price box.
 */
export function priceFactor({ packNow = null, shown = null, si = null, detail = null, countPack = null } = {}) {
  const p = num(packNow);
  const s = num(shown);
  if (p != null && s != null && p > 0 && s > 0) return p / s;
  if (!si || !countPack) return null;
  const qty = (num(si.pack_qty) || 1) * (num(si.inner_qty) || 1);
  let base;
  try { base = toBase(qty, si.inner_unit, uomItemOf(detail)); } catch { base = null; }
  const cq = num(countPack.qty_in_base);
  if (!(base > 0) || !(cq > 0)) return null;
  const vat = si.price_includes_tax ? (num(si.purchase_vat_rate ?? detail?.item?.purchase_vat_rate) || 0) : 0;
  return (base / cq) * (1 + vat);
}

/**
 * The Price here box holds the price the site is charged for the supplier's pack (what the
 * invoice says), the same as the Sites grid. What a commit sends: { price_here } with null to
 * follow the company again (an empty box, or the company price typed back, as the grid does), or
 * { skip: true } when nothing changed, or { error } in words.
 */
export function pricePatchFor(typed, model) {
  const m = model || {};
  const empty = typed == null || String(typed).trim() === '';
  if (empty) return m.follows ? { skip: true } : { patch: { price_here: null }, reset: true };
  const n = Number(typed);
  if (!Number.isFinite(n)) return { error: 'Type a price, such as 8.70.' };
  if (n < 0) return { error: 'A price cannot be below 0.' };
  const v = round(n, 4);
  const near = (a, b) => num(a) != null && Math.abs(num(a) - b) < 0.00005;
  if (m.follows ? near(m.packNow, v) : near(m.priceHere, v)) return { skip: true };
  if (!m.follows && near(m.companyPack, v)) return { patch: { price_here: null }, reset: true };
  return { patch: { price_here: v }, reset: false };
}

/** A supplier pack price in the pack people count in, in words ('£1.45 a bottle'); '' when unknown. */
export function packPriceWords(packMoney, model) {
  const p = num(packMoney);
  const f = num(model?.factor);
  const cp = model?.countPack;
  if (p == null || f == null || f <= 0 || !cp || !(num(cp.qty_in_base) > 0)) return '';
  return packPrice(p / f / num(cp.qty_in_base), cp, model?.currency);
}

/** The supplier pack price to store for a price typed in the pack people count in. Null: not a price. */
export function priceHereFor(typed, model) {
  if (typed == null || String(typed).trim() === '') return null;
  const t = Number(typed);
  if (!Number.isFinite(t) || t < 0) return null;
  const f = num(model?.factor);
  if (f == null || f <= 0) return null;
  return round(t * f, 4);
}

const can = (scope, siteId, what) => {
  if (scope && typeof scope.canEditSite === 'function') return !!scope.canEditSite(siteId, what);
  return true;
};

/**
 * One row of the Sites tab, from one site of the login's list and the item detail read.
 * Every money figure is in the pack people count in; par, reorder and min too.
 */
export function siteRowModel(site, detail, scope) {
  const item = detail?.item || {};
  const id = site?.id ?? site?.location_id ?? null;
  const row = (detail?.sites || []).find((s) => s && s.location_id === id) || null;
  const countPack = countPackOf(detail);
  const sis = liveSupplierItems(detail);
  const choices = (row?.can_order_suppliers || []).filter((c) => c && c.supplier_item_id)
    .map((c) => ({ id: c.supplier_item_id, name: c.supplier_name || '' }));
  const mainId = item.main_supplier_item_id || null;
  const hereId = row?.supplier_here?.supplier_item_id || null;
  const usedId = hereId || mainId || (choices[0]?.id ?? null);
  const si = sis.find((x) => x.id === usedId) || null;
  if (usedId && !choices.some((c) => c.id === usedId)) {
    const name = row?.supplier_here?.supplier_name || si?.supplier_name || '';
    if (name) choices.unshift({ id: usedId, name, cannotOrder: true });
  }
  const siSite = si ? (si.sites || []).find((x) => x && x.location_id === id) || null : null;
  // the site row's own answer wins, null included (null = it follows the company price)
  const priceHere = num(row && Object.prototype.hasOwnProperty.call(row, 'price_here') ? row.price_here : siSite?.price_here);
  const follows = priceHere == null;
  const packNow = priceHere != null ? priceHere : (num(siSite?.price) ?? num(si?.pack_price));
  const unitPrice = num(row?.unit_price) ?? num(siSite?.unit_price) ?? (follows ? num(si?.unit_price) : null);
  const shown = packAmount(unitPrice, countPack);
  const factor = si ? priceFactor({ packNow, shown, si, detail, countPack }) : null;
  const lastPaid = row?.last_paid ? {
    amount: packAmount(row.last_paid.unit_cost, countPack),
    at: row.last_paid.at || null,
    label: row.last_paid.pack_label || null,
  } : null;
  return {
    siteId: id,
    name: site?.name || row?.name || '',
    currency: site?.currency || si?.currency || null,
    linked: !!row,
    on: !!row?.on_here,
    siteItemId: row?.site_item_id || null,
    rowVersion: row?.row_version ?? null,
    runningOut: !!row?.stop_ordering_at,
    paused: !!row?.paused,
    pausedFrom: row?.paused_from || null,
    pausedUntil: row?.paused_until || null,
    why: row?.why_on || '',
    supplierHereId: hereId,
    supplierUsedId: usedId,
    mainId,
    supplierChoices: choices,
    hasSupplier: !!si,
    follows,
    priceHere,
    packNow,
    companyPack: num(si?.pack_price),
    packDescription: si?.pack_description || '',
    unitPrice,
    shown,
    factor,
    costHere: packAmount(row?.current_cost, countPack),
    costUnit: num(row?.current_cost),
    lastPaid,
    par: toPackQty(row?.par_level, countPack),
    reorder: toPackQty(row?.reorder_point, countPack),
    min: toPackQty(row?.min_level, countPack),
    parBase: { par_level: num(row?.par_level), reorder_point: num(row?.reorder_point), min_level: num(row?.min_level) },
    onHand: num(row?.on_hand) ?? 0,
    areaId: row?.area_id || null,
    areaName: row?.area_name || '',
    countedHere: row ? row.counted_here !== false : true,
    // how the site gets it: bought from a supplier, or made there (a batch or made to order)
    made: !!row && !!row.supply_mode && row.supply_mode !== 'bought',
    sellable: row?.is_sellable === true,
    recipesHere: Math.max(num(row?.recipes_here) || 0, (row?.recipe_names_here || []).length),
    recipeNamesHere: (row?.recipe_names_here || []).filter(Boolean),
    countPack,
    canFacts: can(scope, id, 'site_facts'),
    canPrice: can(scope, id, 'site_price'),
  };
}

/**
 * The par patch the Sites tab sends: always all three (par, reorder, min) in base units, so a
 * figure the screen did not touch is kept, never wiped. `changed` is { par | reorder | min: typed }.
 * Undefined when a typed figure is not a number of packs (nothing is sent).
 */
export function parPatchFor(model, changed) {
  const cp = model?.countPack;
  const out = { ...(model?.parBase || { par_level: null, reorder_point: null, min_level: null }) };
  const map = { par: 'par_level', reorder: 'reorder_point', min: 'min_level' };
  for (const [k, col] of Object.entries(map)) {
    if (!changed || !(k in changed)) continue;
    const b = toBaseQty(changed[k], cp);
    if (b === undefined) return undefined;
    out[col] = b;
  }
  return out;
}

/** The first site in reach where the item is on (or its local site): where company saves name. */
export function homeSiteOf(detail, siteIds = [], fallback = null) {
  const ids = new Set(siteIds || []);
  const local = detail?.item?.local_location_id || null;
  if (local && (ids.size === 0 || ids.has(local))) return local;
  const rows = detail?.sites || [];
  const ordered = [...(siteIds || [])].map((sid) => rows.find((r) => r.location_id === sid)).filter(Boolean);
  const on = ordered.find((r) => r.on_here) || rows.find((r) => r.on_here && (ids.size === 0 || ids.has(r.location_id)));
  if (on) return on.location_id;
  const any = ordered[0] || rows[0];
  return any?.location_id || fallback || null;
}

/** May this login change the item's company fields? A company editor, or its own local item. */
export function canEditItem({ companyEditor = false, item = null, siteIds = [] } = {}) {
  if (companyEditor) return true;
  const local = item?.local_location_id || null;
  return !!local && (siteIds || []).includes(local);
}

/** The company packs of a detail read in today's Units tab shape (live ones only). */
export function packsOf(detail) {
  return (detail?.packs || []).filter((p) => p && !p.archived_at).map((p) => ({
    id: p.id, name: p.name, qtyInBase: Number(p.qty_in_base), parentFormatId: p.parent_pack_id || null,
    isCountDefault: p.is_count_default === true, isPurchaseDefault: p.is_purchase_default === true, rowVersion: p.row_version ?? null,
  }));
}

/** The company unit bridges of a detail read in today's Dimension tab shape (live ones only). */
export function bridgesOf(detail) {
  return (detail?.bridges || []).filter((b) => b && !b.archived_at).map((b) => ({
    id: b.id, fromQty: Number(b.from_qty), fromUnit: b.from_unit, toQty: Number(b.to_qty), toUnit: b.to_unit, rowVersion: b.row_version ?? null,
  }));
}

/**
 * One site's row of the item in today's item shape (id = that site's inventory_items row), for the
 * Stock tab side panel. The packs keep their company ids: the tab only uses them as unit tokens.
 */
export function siteDraftOf(detail, siteId) {
  const row = (detail?.sites || []).find((s) => s && s.location_id === siteId) || null;
  if (!row) return null;
  const item = detail?.item || {};
  return {
    id: row.site_item_id || null,
    name: item.name || '',
    baseUnit: item.base_unit || 'each',
    kind: row.supply_mode === 'batches' ? 'MADE' : 'PURCHASED',
    onHand: num(row.on_hand) ?? 0,
    currentCost: num(row.current_cost),
    areaId: row.area_id || null,
    packaging: packsOf(detail),
    conversions: bridgesOf(detail),
  };
}

/** The tail of a save toast when sites were queued: '3 sites catch up within a minute.'; '' for none. */
export function queuedNote(queued) {
  const list = Array.isArray(queued) ? queued : [];
  const n = new Set(list.map((q) => q?.location_id).filter(Boolean)).size || list.length;
  if (!n) return '';
  return n === 1 ? '1 site catches up within a minute.' : `${n} sites catch up within a minute.`;
}

// ── Details ──────────────────────────────────────────────────────────────────

const DETAIL_KEYS = Object.freeze(['name', 'category_id', 'type', 'base_unit', 'sku', 'barcode', 'purchase_vat_rate',
  'shelf_life_days', 'notes', 'exclude_from_gp', 'key_item', 'returns_to_shelf', 'allergens']);

/** The Details form from a company item row. */
export function detailsDraft(item) {
  const i = item || {};
  return {
    name: i.name || '',
    category_id: i.category_id || null,
    type: i.type || null,
    base_unit: i.base_unit || 'each',
    sku: i.sku || '',
    barcode: i.barcode || '',
    purchase_vat_rate: num(i.purchase_vat_rate),
    shelf_life_days: i.shelf_life_days == null ? '' : String(i.shelf_life_days),
    notes: i.notes || '',
    exclude_from_gp: i.exclude_from_gp === true,
    key_item: i.key_item === true,
    returns_to_shelf: i.returns_to_shelf === true,
    allergens: Array.isArray(i.allergens) ? i.allergens.slice() : [],
  };
}

/**
 * What the Details Save sends: only the fields that differ from the item as loaded, cleaned
 * (text trimmed, empty text null, shelf life a whole number). Answer { patch, error }: error is the
 * plain words when a field cannot be saved as typed.
 */
export function detailsPatch(draft, item) {
  const d = draft || {};
  const before = detailsDraft(item);
  const patch = {};
  const text = (v) => { const s = String(v ?? '').trim(); return s === '' ? null : s; };
  if (!text(d.name)) return { patch: null, error: 'Give the item a name.' };
  let shelf = null;
  if (String(d.shelf_life_days ?? '').trim() !== '') {
    const n = Number(d.shelf_life_days);
    if (!Number.isInteger(n) || n < 0) return { patch: null, error: 'Shelf life is a whole number of days.' };
    shelf = n;
  }
  const clean = {
    name: text(d.name), category_id: d.category_id || null, type: d.type || null, base_unit: d.base_unit || before.base_unit,
    sku: text(d.sku), barcode: text(d.barcode), purchase_vat_rate: num(d.purchase_vat_rate), shelf_life_days: shelf,
    notes: text(d.notes), exclude_from_gp: d.exclude_from_gp === true, key_item: d.key_item === true,
    returns_to_shelf: d.returns_to_shelf === true, allergens: Array.isArray(d.allergens) ? d.allergens.slice() : [],
  };
  const was = { ...before, sku: text(before.sku), barcode: text(before.barcode), notes: text(before.notes),
    shelf_life_days: before.shelf_life_days === '' ? null : Number(before.shelf_life_days) };
  for (const k of DETAIL_KEYS) {
    if (k === 'purchase_vat_rate' ? !sameRate(clean[k], was[k]) : !sameValue(clean[k], was[k])) patch[k] = clean[k];
  }
  return { patch, error: null };
}

// ── The change log ───────────────────────────────────────────────────────────

function siteNameOf(siteById, id) {
  if (!id || !siteById) return '';
  if (typeof siteById === 'function') return siteById(id) || '';
  if (siteById instanceof Map) { const s = siteById.get(id); return (typeof s === 'string' ? s : s?.name) || ''; }
  const s = siteById[id];
  return (typeof s === 'string' ? s : s?.name) || '';
}

const withSite = (what, site) => (site ? `${what}, ${site}` : what);
const human = (field) => { const s = String(field || '').replace(/_/g, ' ').trim(); return s ? s[0].toUpperCase() + s.slice(1) : 'A change'; };

/**
 * One change log row (stock_changes_page) as { who, what, old, new }. opts: { countPack, baseUnit,
 * currency, tz, names } so prices and pars read in the pack people use.
 */
export function changeWords(row, siteById, opts = {}) {
  const r = row || {};
  const site = siteNameOf(siteById, r.location_id);
  const field = r.field || '';
  const who = (r.who_name && String(r.who_name).trim()) || SOURCE_WORDS[r.source] || 'ServOS';
  if (r.kind === 'cost' || field === 'current_cost') {
    return { who, what: withSite('Cost here', site), old: r.before == null ? '' : valueWords('current_cost', r.before, opts), new: valueWords('current_cost', r.after, opts) };
  }
  if (field === 'on_here') {
    const on = r.after === true || r.after === 'true';
    return { who, what: on ? (site ? `Ticked at ${site}` : 'Ticked') : (site ? `Unticked at ${site}` : 'Unticked'), old: on ? 'Off' : 'On', new: on ? 'On' : 'Off' };
  }
  if (field === 'created') return { who, what: withSite('Made', site), old: '', new: '' };
  if (field === 'suggestion') return { who, what: 'Suggested a change', old: '', new: valueWords('suggestion', r.after, opts) };
  const label = FIELD_WORDS[field] || human(field);
  return { who, what: withSite(label, site), old: valueWords(field, r.before, opts), new: valueWords(field, r.after, opts) };
}

/** When a change happened, on the venue's clock: '18 Oct 09:12'. */
export function whenWords(at, tz) {
  return fmtVenueDateTime(at, tz, { year: false });
}

/** A short day on the venue's clock: '18 Oct'. */
export function dayWords(at, tz) {
  return fmtVenueDate(at, tz, { year: false });
}

// ── The Details allergen line (Drop 2, contract 3.4 and 4.4) ─────────────────

export const FACTS_LINE_LINK = 'Change them on the Suppliers tab';

const sitesCount = (n) => `${Number(n) || 0} ${Number(n) === 1 ? 'site' : 'sites'}`;

/**
 * In a multi site company the item's allergen chips become one read only line when they come from
 * the supplier items (stock_item_detail `facts.source` 'supplier_items'):
 *   { words: 'Allergens: Milk, Gluten · from Freshways (3 sites)', link: 'Change them on the Suppliers tab', needsCheck }
 * With more than one supplier item: 'from Freshways (3 sites), Brakes (1 site)', the main supplier
 * first. Null when the chips stay editable (no supplier item, source 'item') or the read has no facts.
 */
export function factsLine(detail) {
  const facts = detail?.facts;
  if (!facts || facts.source !== 'supplier_items') return null;
  const item = detail?.item || {};
  const from = (Array.isArray(facts.from) ? facts.from : []).filter(Boolean);
  const mainFirst = [...from].sort((a, b) => (a.supplier_item_id === item.main_supplier_item_id ? -1 : b.supplier_item_id === item.main_supplier_item_id ? 1 : 0));
  const who = mainFirst.map((x) => `${x.supplier_name || 'a supplier'} (${sitesCount(x.sites_on)})`).join(', ');
  const ids = Array.isArray(facts.allergens) && facts.allergens.length ? facts.allergens : (item.allergens || []);
  const words = `Allergens: ${allergenWords(ids)}${who ? ` · from ${who}` : ''}`;
  return { words, link: FACTS_LINE_LINK, needsCheck: facts.needs_check === true };
}

/** The Sites tab cell for Last paid: '£1.45, 18 Oct'; 'None' when nothing was paid here yet. */
export function lastPaidWords(lastPaid, currency, tz) {
  if (!lastPaid || lastPaid.amount == null) return 'None';
  const day = dayWords(lastPaid.at, tz);
  return day ? `${moneyText(lastPaid.amount, currency)}, ${day}` : moneyText(lastPaid.amount, currency);
}

/** The next company price of a supplier item: '£8.61 from 1 Nov'; 'None'. */
export function nextPriceWords(next, currency, countPack = null, factorToPack = null) {
  if (!next || num(next.price) == null) return 'None';
  const f = num(factorToPack);
  const amount = countPack && f && f > 0 ? num(next.price) / f : num(next.price);
  const day = next.from_day ? fmtYmd(next.from_day, { year: false }) : '';
  return `${moneyText(amount, currency)}${day ? ` from ${day}` : ''}`;
}
