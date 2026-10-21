// src/lib/stock/importMappers.js
//
// MULTI SITE STOCK, Drop 1 (migration 20261024a): reading an import file into the rows the database
// stages (stock_import_stage). Map 4.3 and 8.2 step 11, design 2.4 and A18, contract 3.5.
//
//   A ServOS CSV, or an export from Nory or MarketMan, becomes rows of four kinds: items, suppliers,
//   supplier items (a supplier's pack and price of an item) and pars. A recipe file is recognised
//   only to be skipped ("Recipes come in with the recipe update.", Drop 2).
//   Nothing here writes or decides: the database checks every staged row (new, change, same, skip
//   or problem) and the check screen shows its answer. These rules only read the file, match its
//   headings to our fields, turn text into values ('1.38', '6 x 1L', 'Mon-Fri', '2pm') and say in
//   plain words which values could not be read.
//
// Headings are matched case blind, ignoring spaces and punctuation ('UOMName', 'UOM name' and
// 'uom_name' are one heading). Each source has its own heading list (ALIASES): the first heading a
// field's list finds wins, so a 'Supplier' column is the supplier even when there is a 'Name'
// column too. Any heading no field uses is listed on the check screen ('These columns were not
// used'). The Nory and MarketMan lists start from their help pages and API names (decision 13):
// real export files from a group switching over should be tried before its go live.
//
// Pure: no I/O. Parts lifted from Phase 1 (origin/feat/stock-company src/lib/stock/company/
// stockCompanyRules.js: parseCsv, CSV_COLUMNS, the aliases, csvRowsFor, chunk, ratePercent,
// parseRatePercent). Unit tested in importMappers.test.js with small made up files.

import { normDay } from './purchasingRules.js';
import { normaliseAllergenId, isUkAllergen } from '../kioskAllergens.js';
import { globalFactor, isKnownUnit, normUnit } from './units.js';

// -- reading the file --------------------------------------------------------------------------

// The separator a file uses: the one seen most often in its first line, outside quotes.
function sniffDelimiter(s) {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') q = !q;
    else if (!q && (ch === '\n' || ch === '\r')) break;
    else if (!q && ch in counts) counts[ch]++;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ',';
}

/**
 * Read CSV text into rows of strings: quotes, doubled quotes, line breaks inside quotes, CR LF, a
 * leading byte order mark, and files saved with ';' or tabs between the values. Empty lines are
 * left out. Lifted from Phase 1 (commas only there).
 */
export function parseCsv(text, { delimiter = null } = {}) {
  const out = [];
  let row = [];
  let cell = '';
  let q = false;
  const s = String(text || '').replace(/^\uFEFF/, '');
  const sep = delimiter || sniffDelimiter(s);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { q = true; continue; }
    if (ch === sep) { row.push(cell); cell = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) out.push(row);
      row = [];
      continue;
    }
    cell += ch;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) out.push(row);
  return out;
}

/** A list in pieces of `size` (the stage call takes 2,000 rows at most). */
export function chunk(list, size = 2000) {
  const out = [];
  const n = Math.max(1, Math.trunc(Number(size)) || 2000);
  for (let i = 0; i < (list || []).length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/** VAT as a percent for people: 0.2 -> "20%", 0.125 -> "12.5%", null -> "". (Phase 1) */
export function ratePercent(rate) {
  if (rate == null || rate === '' || !Number.isFinite(Number(rate))) return '';
  return `${Number((Number(rate) * 100).toFixed(3))}%`;
}

/** A typed percent to a rate: "20" -> 0.2, "" -> null, junk -> NaN. (Phase 1) */
export function parseRatePercent(text) {
  const t = String(text ?? '').replace('%', '').trim();
  if (t === '') return null;
  const v = Number(t);
  if (!Number.isFinite(v) || v < 0 || v >= 100) return Number.NaN;
  return Math.round(v * 10000) / 1000000;
}

// -- the fields of each kind ----------------------------------------------------------------------

/**
 * What each kind of file can carry (our field names). `required`: the file is refused for that kind
 * without them. `oneOf`: at least one of these too. `skip`: recognised only to be skipped.
 * 'site' on items and suppliers is a location column (rows per site): the sites it names are where
 * the item is stocked, or where the supplier can deliver.
 */
export const CSV_COLUMNS = Object.freeze({
  items: Object.freeze({ required: ['name'], fields: ['name', 'category', 'base_unit', 'type', 'sku', 'barcode', 'purchase_vat', 'allergens', 'shelf_life_days', 'count_pack', 'count_pack_size', 'sites', 'site'] }),
  suppliers: Object.freeze({ required: ['name'], fields: ['name', 'email', 'phone', 'contact_name', 'payment_terms_days', 'account_number', 'min_order_value', 'delivery_days', 'cutoff_time', 'sites', 'site'] }),
  supplier_items: Object.freeze({ required: ['supplier', 'item'], oneOf: ['pack_price', 'price_with_vat'], fields: ['supplier', 'item', 'item_sku', 'supplier_sku', 'supplier_product_name', 'pack_description', 'pack_size', 'pack_qty', 'inner_qty', 'inner_unit', 'base_unit', 'pack_price', 'price_with_vat', 'currency', 'purchase_vat', 'includes_vat', 'site', 'sites'] }),
  pars: Object.freeze({ required: ['item', 'site'], oneOf: ['par_level', 'reorder_point', 'min_level'], fields: ['item', 'item_sku', 'site', 'par_level', 'reorder_point', 'min_level'] }),
  recipes: Object.freeze({ required: ['name'], fields: ['name'], skip: true }),
});

export const IMPORT_KINDS = Object.freeze(['items', 'suppliers', 'supplier_items', 'pars', 'recipes']);

/** The staged row kind of each file kind (stock_co_import_rows.kind). */
export const STAGE_KIND = Object.freeze({ items: 'item', suppliers: 'supplier', supplier_items: 'supplier_item', pars: 'par', recipes: 'recipe' });
const FILE_KIND = Object.freeze({ item: 'items', supplier: 'suppliers', supplier_item: 'supplier_items', par: 'pars', recipe: 'recipes' });
const fileKind = (k) => (CSV_COLUMNS[k] ? k : FILE_KIND[k] || null);

/** Our field names in plain words, for 'These columns are missing: Name, Price.' */
export const FIELD_WORDS = Object.freeze({
  name: 'Name', category: 'Category', base_unit: 'Base unit', type: 'Type', sku: 'SKU', barcode: 'Barcode',
  purchase_vat: 'Purchase VAT', allergens: 'Allergens', shelf_life_days: 'Shelf life', count_pack: 'Pack people count in',
  count_pack_size: 'Pack size', sites: 'Sites', site: 'Site', email: 'Order email', phone: 'Phone', contact_name: 'Contact',
  payment_terms_days: 'Payment terms (days)', account_number: 'Account number', min_order_value: 'Minimum order',
  delivery_days: 'Delivery days', cutoff_time: 'Order by time', supplier: 'Supplier', item: 'Item', item_sku: 'Item SKU',
  supplier_sku: 'Supplier SKU', supplier_product_name: 'Their name', pack_description: 'Pack', pack_size: 'Pack size',
  pack_qty: 'Packs per case', inner_qty: 'Each pack holds', inner_unit: 'Unit of the pack', pack_price: 'Price',
  price_with_vat: 'Price with VAT', currency: 'Currency', includes_vat: 'Price includes VAT', par_level: 'Par',
  reorder_point: 'Reorder at', min_level: 'Min',
});

/** 'These columns are missing: Supplier, Price.' ('' when none). oneOf groups read 'Par or Reorder at or Min'. */
export function missingWords(missing) {
  const list = (missing || []).map((m) => (Array.isArray(m) ? m.map((x) => FIELD_WORDS[x] || x).join(' or ') : FIELD_WORDS[m] || m));
  return list.length ? `These columns are missing: ${list.join(', ')}.` : '';
}

/** 'These columns were not used: Storage area, BOM price.' ('' when none). */
export function unusedWords(unknown) {
  const list = (unknown || []).filter(Boolean);
  return list.length ? `These columns were not used: ${list.join(', ')}.` : '';
}

// -- headings each source uses (first match wins) ---------------------------------------------

const CSV_ALIASES = {
  items: {
    name: ['name', 'item name', 'stock item', 'item', 'product name', 'product'],
    category: ['category', 'category name', 'group'],
    base_unit: ['base unit', 'unit', 'unit of measure', 'uom'],
    type: ['type', 'item type'],
    sku: ['sku', 'our sku', 'item sku', 'item code', 'code'],
    barcode: ['barcode', 'ean', 'gtin', 'upc'],
    purchase_vat: ['purchase vat', 'vat', 'vat %', 'vat rate', 'tax rate'],
    allergens: ['allergens', 'allergen'],
    shelf_life_days: ['shelf life days', 'shelf life (days)', 'shelf life'],
    count_pack: ['count pack', 'pack people count in', 'pack people use', 'count in'],
    count_pack_size: ['count pack size', 'count pack holds', 'qty in base'],
    sites: ['sites', 'at sites'],
    site: ['site', 'location'],
  },
  suppliers: {
    name: ['supplier name', 'supplier', 'name'],
    email: ['order email', 'email', 'email address', 'e-mail'],
    phone: ['phone', 'telephone', 'phone number', 'tel'],
    contact_name: ['contact name', 'contact'],
    payment_terms_days: ['payment terms (days)', 'payment terms days', 'payment terms', 'terms'],
    account_number: ['account number', 'account no', 'account #', 'account'],
    min_order_value: ['minimum order', 'min order', 'minimum order value', 'min order value'],
    delivery_days: ['delivery days', 'delivers on', 'deliveries'],
    cutoff_time: ['order by time', 'order by', 'cut off time', 'cut off', 'cutoff'],
    sites: ['sites', 'can order', 'can order at'],
    site: ['site', 'location'],
  },
  supplier_items: {
    supplier: ['supplier', 'supplier name', 'vendor'],
    item: ['item', 'item name', 'stock item'],
    item_sku: ['item sku', 'our sku', 'item code'],
    supplier_sku: ['supplier sku', 'sku', 'supplier code', 'product code', 'their code'],
    supplier_product_name: ['their name', 'supplier product name', 'supplier item name', 'product name'],
    pack_description: ['pack description', 'pack'],
    pack_size: ['pack size', 'size'],
    pack_qty: ['packs per case', 'pack qty', 'packs'],
    inner_qty: ['each pack holds', 'inner qty', 'qty per pack'],
    inner_unit: ['unit of the pack', 'inner unit', 'pack unit'],
    base_unit: ['base unit', 'unit'],
    pack_price: ['price', 'pack price', 'case price', 'cost'],
    price_with_vat: ['price with vat', 'price inc vat'],
    currency: ['currency'],
    purchase_vat: ['purchase vat', 'vat', 'vat %', 'vat rate'],
    includes_vat: ['price includes vat', 'includes vat', 'inc vat'],
    site: ['site', 'location', 'at site'],
    sites: ['sites'],
  },
  pars: {
    item: ['item', 'item name', 'stock item', 'name'],
    item_sku: ['item sku', 'sku', 'item code'],
    site: ['site', 'location', 'site name'],
    par_level: ['par', 'par level'],
    reorder_point: ['reorder at', 'reorder point', 'reorder level', 'reorder'],
    min_level: ['min', 'minimum', 'min level', 'min on hand'],
  },
  recipes: { name: ['recipe name', 'recipe', 'name', 'dish'] },
};

// Nory: no self serve stock export (its help page "What can I export from Nory and where?"); its
// Support sends a file with the item screen's words: Name, Category, Type, Supplier, Supplier code,
// Pack size, Price, Storage area, Unit, Location.
const NORY_ALIASES = {
  items: {
    name: ['item name', 'name', 'item', 'inventory item'],
    category: ['category'],
    base_unit: ['unit', 'unit of measure', 'base unit', 'count unit', 'uom'],
    type: ['type', 'item type'],
    sku: ['sku', 'item code'],
    barcode: ['barcode'],
    purchase_vat: ['vat', 'vat rate', 'tax rate', 'tax'],
    allergens: ['allergens'],
    shelf_life_days: ['shelf life', 'shelf life days'],
    sites: ['locations', 'sites'],
    site: ['location', 'site'],
  },
  suppliers: {
    name: ['supplier', 'supplier name'],
    email: ['supplier email', 'order email', 'email'],
    phone: ['supplier phone', 'phone'],
    contact_name: ['supplier contact', 'contact'],
    payment_terms_days: ['payment terms'],
    account_number: ['account number', 'customer number', 'account'],
    min_order_value: ['minimum order value', 'minimum order', 'min order value'],
    delivery_days: ['delivery days'],
    cutoff_time: ['cut-off time', 'cut off time', 'cut off', 'order cut off'],
    site: ['location', 'site'],
  },
  supplier_items: {
    supplier: ['supplier', 'supplier name'],
    item: ['item name', 'name', 'item'],
    item_sku: ['sku', 'item code'],
    supplier_sku: ['supplier code', 'code'],
    supplier_product_name: ['supplier item name', 'invoice name'],
    pack_size: ['pack size', 'pack'],
    base_unit: ['unit', 'unit of measure', 'count unit'],
    pack_price: ['price', 'pack price', 'price per pack', 'cost'],
    purchase_vat: ['vat', 'vat rate', 'tax'],
    site: ['location', 'site'],
  },
  pars: {
    item: ['item name', 'name', 'item'],
    item_sku: ['sku', 'item code'],
    site: ['location', 'site'],
    par_level: ['par level', 'par'],
    reorder_point: ['reorder level', 'reorder point'],
    min_level: ['minimum stock', 'min'],
  },
  recipes: { name: ['recipe name', 'recipe', 'name'] },
};

// MarketMan: the names of its inventory item export and API (GetInventoryItems: Name, CategoryName,
// UOMName, ParLevel, MinOnHand, StorageNames; PurchaseItems: VendorName, ProductCode, PackQty,
// PacksPerCase, UOMName, Price, PriceWithVat, TaxValue, ScanBarcode). A chain export carries the
// buyer (site) on each row. PackQty is what one pack holds, PacksPerCase the packs in a case.
const MARKETMAN_ALIASES = {
  items: {
    name: ['item name', 'inventory item name', 'inventory item', 'name'],
    category: ['category name', 'category'],
    base_unit: ['count uom', 'inventory uom', 'bom uom', 'uom name', 'uom', 'unit of measure', 'unit'],
    sku: ['item code', 'sku'],
    barcode: ['scan barcode', 'barcode'],
    purchase_vat: ['tax value', 'tax rate', 'vat', 'tax'],
    allergens: ['allergens'],
    sites: ['buyers', 'locations'],
    site: ['buyer name', 'buyer', 'location name', 'location'],
  },
  suppliers: {
    name: ['vendor name', 'vendor', 'supplier name', 'supplier'],
    email: ['vendor email', 'email'],
    phone: ['vendor phone', 'phone'],
    contact_name: ['contact name', 'contact'],
    account_number: ['account number', 'customer number'],
    min_order_value: ['min order value', 'minimum order', 'min order'],
    delivery_days: ['delivery days', 'order days'],
    cutoff_time: ['cutoff time', 'cut off time', 'order cutoff'],
    site: ['buyer name', 'buyer', 'location name', 'location'],
  },
  supplier_items: {
    supplier: ['vendor name', 'vendor', 'supplier name', 'supplier'],
    item: ['item name', 'inventory item name', 'inventory item', 'name'],
    item_sku: ['item code'],
    supplier_sku: ['product code', 'vendor item code', 'vendor code', 'catalog item code'],
    supplier_product_name: ['purchase item name', 'purchase item', 'vendor item name', 'catalog item name'],
    pack_size: ['pack size'],
    inner_qty: ['pack qty', 'pack quantity'],
    pack_qty: ['packs per case'],
    inner_unit: ['purchase uom', 'pack uom'],
    base_unit: ['uom name', 'uom', 'unit'],
    pack_price: ['price', 'pack price', 'case price'],
    price_with_vat: ['price with vat'],
    purchase_vat: ['tax value', 'tax rate', 'vat', 'tax'],
    site: ['buyer name', 'buyer', 'location name', 'location'],
  },
  pars: {
    item: ['item name', 'inventory item name', 'inventory item', 'name'],
    item_sku: ['item code'],
    site: ['buyer name', 'buyer', 'location name', 'location'],
    par_level: ['par level', 'par'],
    reorder_point: ['reorder point', 'reorder level'],
    min_level: ['min on hand', 'minimum on hand'],
  },
  recipes: { name: ['recipe name', 'recipe', 'menu item', 'prep name'] },
};

/** The heading lists by source ('csv', 'nory', 'marketman'), then kind, then field. */
export const ALIASES = Object.freeze({ csv: CSV_ALIASES, nory: NORY_ALIASES, marketman: MARKETMAN_ALIASES });

/** One heading as a key: case blind, no spaces or punctuation ('UOM Name' -> 'uomname', 'VAT %' -> 'vat%'). */
export const headKey = (h) => String(h ?? '').replace(/^\uFEFF/, '').trim().toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9%#]+/g, '');

// -- which source, which kinds -------------------------------------------------------------------

const MARKETMAN_MARKS = ['vendor', 'vendorname', 'uom', 'uomname', 'productcode', 'bomprice', 'minonhand', 'packspercase', 'scanbarcode',
  'pricewithvat', 'catalogitemcode', 'buyer', 'buyername', 'ismainpurchaseoption', 'storagenames', 'categoryname', 'vendoritemcode', 'packqty', 'taxvalue'];
const NORY_MARKS = ['suppliercode', 'packsize', 'storagearea', 'storageareas', 'countunit', 'countunits', 'itemtype', 'priceperpack', 'invoicename'];
const SERVOS_MARKS = ['baseunit', 'suppliersku', 'innerqty', 'innerunit', 'includesvat', 'priceincludesvat', 'theirname', 'countpack', 'countpacksize',
  'reorderat', 'sites', 'shelflifedays', 'purchasevat', 'eachpackholds', 'unitofthepack', 'orderemail'];

/** Where a file came from, from its heading row: 'marketman', 'nory' or 'csv' (ours, or anything else). */
export function detectSource(headerRow) {
  const keys = new Set((headerRow || []).map(headKey));
  const score = (marks) => marks.filter((m) => keys.has(m)).length;
  const mm = score(MARKETMAN_MARKS), nory = score(NORY_MARKS), ours = score(SERVOS_MARKS);
  if (mm >= 2 && mm > ours && mm >= nory) return 'marketman';
  if (nory >= 2 && nory > ours) return 'nory';
  return 'csv';
}

const aliasesOf = (source) => ALIASES[source] || CSV_ALIASES;

// Field -> column index for one kind: each field takes the first heading its list finds, each
// heading is used once.
function columnsFor(kind, head, aliases) {
  const spec = CSV_COLUMNS[kind];
  const at = {};
  const taken = new Set();
  for (const f of spec.fields) {
    const list = [...(aliases[kind]?.[f] || []), f];
    for (const a of list) {
      const i = head.indexOf(headKey(a));
      if (i >= 0 && !taken.has(i)) { at[f] = i; taken.add(i); break; }
    }
  }
  return at;
}

function missingOf(kind, at) {
  const spec = CSV_COLUMNS[kind];
  const missing = spec.required.filter((f) => at[f] === undefined);
  if (spec.oneOf && !spec.oneOf.some((f) => at[f] !== undefined)) missing.push([...spec.oneOf]);
  return missing;
}

const RECIPE_MARKS = ['recipe', 'recipename', 'ingredient', 'ingredients', 'ingredientname', 'yield', 'portions', 'method', 'menuitem', 'prepname'];
const SUPPLIER_DETAIL_MARKS = ['email', 'orderemail', 'vendoremail', 'supplieremail', 'phone', 'vendorphone', 'contact', 'contactname', 'accountnumber',
  'deliverydays', 'cutoff', 'cutofftime', 'paymentterms', 'minimumorder', 'minorder', 'minordervalue', 'minimumordervalue', 'orderbytime'];
const ITEM_MARKS = ['unit', 'baseunit', 'uom', 'uomname', 'unitofmeasure', 'category', 'categoryname', 'sku', 'barcode', 'price', 'packprice', 'packsize',
  'pack', 'par', 'parlevel', 'item', 'itemname', 'type', 'vat', 'allergens', 'shelflife', 'productcode', 'suppliercode'];
const ITEM_DESCRIBED = ['base_unit', 'category', 'type', 'sku', 'barcode', 'allergens', 'shelf_life_days', 'count_pack'];

/**
 * The kinds a file can feed, in the order they stage (items before the supplier items and pars that
 * name them). A recipe file: recipes only. A supplier list (contact columns, no item columns):
 * suppliers only. Otherwise: items when the file describes items (a unit, category, type, SKU,
 * barcode, allergens or shelf life), suppliers when it names a supplier, supplier items when it has
 * a supplier, an item and a price, pars when it has an item, a site and a par.
 */
export function fileKinds(source, headerRow) {
  const head = (headerRow || []).map(headKey);
  const keys = new Set(head);
  if (RECIPE_MARKS.some((m) => keys.has(m))) return ['recipes'];
  const aliases = aliasesOf(source);
  if (SUPPLIER_DETAIL_MARKS.some((m) => keys.has(m)) && !ITEM_MARKS.some((m) => keys.has(m))) return ['suppliers'];
  const out = [];
  const items = columnsFor('items', head, aliases);
  const si = columnsFor('supplier_items', head, aliases);
  // in a supplier's price list the SKU is the supplier's, so it alone does not make an item list
  const describes = ITEM_DESCRIBED.filter((f) => !(f === 'sku' && si.supplier !== undefined));
  if (items.name !== undefined && describes.some((f) => items[f] !== undefined)) out.push('items');
  if (si.supplier !== undefined) out.push('suppliers');
  if (!missingOf('supplier_items', si).length) out.push('supplier_items');
  if (!missingOf('pars', columnsFor('pars', head, aliases)).length) out.push('pars');
  if (!out.length && items.name !== undefined) out.push('items');
  return out;
}

// -- rows ----------------------------------------------------------------------------------------

const low = (v) => String(v ?? '').trim().toLowerCase();

// Is this row really one of this kind? An item list that names no supplier on a row makes no
// supplier item there; a row with no par, reorder or min makes no par.
function hasContent(kind, r) {
  if (kind === 'supplier_items') return !!(r.supplier && r.item);
  if (kind === 'pars') return !!(r.item && r.site && (r.par_level || r.reorder_point || r.min_level));
  return !!r.name;
}

const priceKey = (r) => { const m = moneyOf(r.pack_price ?? r.price_with_vat); return Number.isFinite(m.amount) ? m.amount : String(r.pack_price ?? r.price_with_vat ?? ''); };

// Rows with the same key are one row: later rows fill what the first left empty, and site names
// add up (an export with one row per site and supplier lists an item once per row).
// perSite (Nory, MarketMan exports, one row per location): a supplier item's first row is the
// company price; another site's row is kept as that site's own price only when its price differs.
// In a ServOS file a Site on a price row always means the price at that site.
function dedupe(kind, rows, { perSite = false } = {}) {
  const siteOf = (r) => (perSite && kind === 'supplier_items' ? '' : low(r.site));
  const keyOf = {
    items: (r) => `${low(r.name)}|${unitOf(r.base_unit) || low(r.base_unit)}|${low(r.sku)}`,
    suppliers: (r) => low(r.name),
    supplier_items: (r) => (r.supplier_sku
      ? `${low(r.supplier)}|sku|${low(r.supplier_sku)}|${siteOf(r)}`
      : `${low(r.supplier)}|${low(r.item)}|${low(r.item_sku)}|${low(r.pack_size)}|${low(r.pack_qty)}|${low(r.inner_qty)}|${low(r.inner_unit)}|${siteOf(r)}`),
    pars: (r) => `${low(r.item)}|${low(r.item_sku)}|${low(r.site)}`,
    recipes: (r) => low(r.name),
  }[kind];
  const collects = kind === 'items' || kind === 'suppliers';
  const byKey = new Map();
  const ownPrices = new Map();
  let merged = 0;
  for (const r of rows) {
    const k = keyOf(r);
    const first = byKey.get(k);
    if (!first) {
      const row = { ...r, _sites: r.site && collects ? [r.site] : [] };
      if (perSite && kind === 'supplier_items') delete row.site;
      byKey.set(k, row);
      continue;
    }
    if (perSite && kind === 'supplier_items' && r.site && priceKey(r) !== priceKey(first)) {
      const own = `${k}|${low(r.site)}`;
      if (!ownPrices.has(own)) { ownPrices.set(own, { ...r, _sites: [] }); continue; }
    }
    merged++;
    for (const [f, v] of Object.entries(r)) {
      if (f === '_row' || (perSite && kind === 'supplier_items' && f === 'site')) continue;
      if (first[f] === undefined || first[f] === '') first[f] = v;
    }
    if (r.site && collects && !first._sites.some((x) => low(x) === low(r.site))) first._sites.push(r.site);
  }
  return { rows: [...byKey.values(), ...ownPrices.values()].sort((a, b) => a._row - b._row), merged };
}

/**
 * The rows of one kind from a parsed table (first row = headings), by one source's heading list.
 * Answer { rows, missing, unknown, merged }: rows are objects of our fields (text as typed, plus
 * `_row`, the line in the file); missing: required fields with no column (a list inside means "one
 * of these"); unknown: headings this kind did not use; merged: repeated rows folded into the first.
 */
export function rowsFor(source, kind, table) {
  const k = fileKind(kind);
  const spec = k ? CSV_COLUMNS[k] : null;
  if (!spec) return { rows: [], missing: [], unknown: [], merged: 0 };
  if (!Array.isArray(table) || !table.length) return { rows: [], missing: missingOf(k, {}), unknown: [], merged: 0 };
  const head = table[0].map(headKey);
  const at = columnsFor(k, head, aliasesOf(source));
  const used = new Set(Object.values(at));
  const unknown = table[0].map((h, i) => (used.has(i) || !String(h ?? '').trim() ? null : String(h).trim())).filter(Boolean);
  const missing = missingOf(k, at);
  const raw = [];
  table.slice(1).forEach((r, idx) => {
    const o = { _row: idx + 2 };
    for (const [f, i] of Object.entries(at)) { const v = String(r?.[i] ?? '').trim(); if (v !== '') o[f] = v; }
    if (hasContent(k, o)) raw.push(o);
  });
  const { rows, merged } = dedupe(k, raw, { perSite: source === 'nory' || source === 'marketman' });
  return { rows, missing, unknown, merged };
}

/** A ServOS CSV of one kind ('items', 'suppliers', 'supplier_items', 'pars', 'recipes'). */
export function csvRowsFor(kind, table) { return rowsFor('csv', kind, table); }
/** A Nory export of one kind. */
export function mapNory(kind, table) { return rowsFor('nory', kind, table); }
/** A MarketMan export of one kind. */
export function mapMarketMan(kind, table) { return rowsFor('marketman', kind, table); }

/**
 * A whole file: every kind it can feed (fileKinds), or the kinds asked for.
 * Answer { source, kinds: { [kind]: { rows, missing, merged } }, order: [kind], unknown: [heading] },
 * unknown being the headings no kind used.
 */
export function mapFile(table, { source = null, kinds = null } = {}) {
  const header = Array.isArray(table) && table.length ? table[0] : [];
  const src = source || detectSource(header);
  const order = (kinds && kinds.length ? kinds.map(fileKind).filter(Boolean) : fileKinds(src, header));
  const out = {};
  const usedBy = new Set();
  for (const k of order) {
    const r = rowsFor(src, k, table);
    out[k] = { rows: r.rows, missing: r.missing, merged: r.merged };
    const head = header.map(headKey);
    for (const i of Object.values(columnsFor(k, head, aliasesOf(src)))) usedBy.add(i);
  }
  const unknown = header.map((h, i) => (usedBy.has(i) || !String(h ?? '').trim() ? null : String(h).trim())).filter(Boolean);
  return { source: src, kinds: out, order, unknown };
}

// -- values ----------------------------------------------------------------------------------------

const UNIT_WORDS = {
  each: ['each', 'ea', 'unit', 'units', 'pc', 'pcs', 'piece', 'pieces', 'item', 'items', 'btl', 'bottle', 'bottles', 'can', 'cans', 'tin', 'tins', 'jar', 'jars', 'portion', 'portions'],
  dozen: ['dozen', 'dz', 'doz'],
  g: ['g', 'gr', 'gm', 'gms', 'gram', 'grams', 'gramme', 'grammes'],
  kg: ['kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms'],
  mg: ['mg', 'milligram', 'milligrams'],
  oz: ['oz', 'ounce', 'ounces'],
  lb: ['lb', 'lbs', 'pound', 'pounds'],
  ml: ['ml', 'mls', 'millilitre', 'millilitres', 'milliliter', 'milliliters'],
  cl: ['cl', 'centilitre', 'centilitres', 'centiliter'],
  l: ['l', 'lt', 'ltr', 'ltrs', 'litre', 'litres', 'liter', 'liters'],
  floz: ['floz', 'fl oz', 'fluid ounce', 'fluid ounces'],
  pt: ['pt', 'pint', 'pints'],
  gal: ['gal', 'gallon', 'gallons'],
};
const UNIT_BY_WORD = new Map(Object.entries(UNIT_WORDS).flatMap(([code, words]) => words.map((w) => [w.replace(/\s+/g, ''), code])));

/** A unit as typed ('KG', 'Litre', 'EA', 'btl') to our code ('kg', 'l', 'each'); null for none; undefined when not a unit. */
export function unitOf(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/\.$/, '').replace(/\s+/g, '');
  if (!t) return null;
  const code = UNIT_BY_WORD.get(t) || (isKnownUnit(t) ? normUnit(t) : null);
  return code || undefined;
}

/** A number as typed ('12', '1,250.5', ' 3 '); null for empty, NaN for junk. */
export function numberOf(text) {
  const t = String(text ?? '').trim().replace(/,(?=\d{3}(\D|$))/g, '');
  if (t === '') return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : Number.NaN;
}

const SYMBOL_CURRENCY = { '\u00a3': 'GBP', $: 'USD', '\u20ac': 'EUR' };
const CURRENCY_CODE = /\b(GBP|USD|EUR|CAD|AUD|NZD|CHF|SEK|NOK|DKK|PLN|AED|SGD|HKD|JPY|ZAR)\b/i;

/** A price as typed ('\u00a31.38', '1,234.50', 'USD 3.35', '2.50 EUR'): { amount, currency }; amount null for empty, NaN for junk or below 0. */
export function moneyOf(text) {
  let t = String(text ?? '').trim();
  if (!t) return { amount: null, currency: null };
  let currency = null;
  const sym = t.match(/[\u00a3$\u20ac]/);
  if (sym) currency = SYMBOL_CURRENCY[sym[0]];
  const code = t.match(CURRENCY_CODE);
  if (code) currency = code[1].toUpperCase();
  t = t.replace(/[\u00a3$\u20ac]/g, '').replace(CURRENCY_CODE, '').trim();
  const v = numberOf(t);
  if (v === null) return { amount: currency ? Number.NaN : null, currency };
  return { amount: Number.isFinite(v) && v >= 0 ? v : Number.NaN, currency };
}

/** VAT as typed ('20%', '20', '0.2', 'Standard 20%', 'zero', 'exempt') to a rate (0.2); null for empty; NaN for junk. */
export function vatRateOf(text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t) return null;
  if (/^(zero|exempt|none|nil|no vat|0%?)$/.test(t)) return 0;
  const m = t.match(/(\d+(?:\.\d+)?)/);
  if (!m) return Number.NaN;
  const v = Number(m[1]);
  if (!Number.isFinite(v) || v < 0 || v >= 100) return Number.NaN;
  // 0.2 is a rate, 20 is a percent: no VAT rate anywhere is below 1%
  return v > 0 && v < 1 && !t.includes('%') ? v : Math.round(v * 10000) / 1000000;
}

/** Yes or no as typed ('Yes', 'inc', 'true', '1' / 'No', 'ex', 'false', '0'); null for empty; undefined for junk. */
export function yesNoOf(text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t) return null;
  if (/^(y|yes|true|1|inc|inc vat|incl|included|including vat)$/.test(t)) return true;
  if (/^(n|no|false|0|ex|ex vat|excl|excluded|excluding vat)$/.test(t)) return false;
  return undefined;
}

/** A time as typed ('14:00', '14.00', '1400', '2pm', '2:30 pm', '14:00:00') to 'HH:MM'; null for empty; undefined for junk. */
export function timeOf(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!t) return null;
  let m = t.match(/^(\d{1,2})(?:[:.](\d{2}))?(am|pm)$/);
  let h, mi;
  if (m) {
    h = Number(m[1]); mi = Number(m[2] || 0);
    if (h < 1 || h > 12) return undefined;
    if (m[3] === 'am') h = h === 12 ? 0 : h; else h = h === 12 ? 12 : h + 12;
  } else if ((m = t.match(/^(\d{1,2})[:.](\d{2})(?::\d{2})?$/))) {
    h = Number(m[1]); mi = Number(m[2]);
  } else if ((m = t.match(/^(\d{2})(\d{2})$/))) {
    h = Number(m[1]); mi = Number(m[2]);
  } else return undefined;
  if (h > 23 || mi > 59) return undefined;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

const WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/**
 * Delivery days as typed ('Mon;Wed;Fri', 'Monday, Thursday', 'Mon-Fri', 'Mon to Sat', 'Daily',
 * 'Weekdays') to day codes in week order; [] for empty; { days, bad } with the words not read.
 */
export function daysOf(text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t) return { days: [], bad: [] };
  if (/^(daily|every ?day|all|7 days)$/.test(t)) return { days: [...WEEK], bad: [] };
  if (/^(weekdays|mon ?- ?fri)$/.test(t)) return { days: WEEK.slice(0, 5), bad: [] };
  const set = new Set();
  const bad = [];
  for (const part of t.split(/[;,/|&]+|\s+and\s+/).map((x) => x.trim()).filter(Boolean)) {
    const range = part.match(/^([a-z0-9]+)\s*(?:-|to)\s*([a-z0-9]+)$/);
    if (range) {
      const a = normDay(range[1]), b = normDay(range[2]);
      if (!a || !b) { bad.push(part); continue; }
      let i = WEEK.indexOf(a);
      for (let n = 0; n < 7; n++) { set.add(WEEK[i]); if (WEEK[i] === b) break; i = (i + 1) % 7; }
      continue;
    }
    const words = part.split(/\s+/);
    for (const w of words) { const d = normDay(w); if (d) set.add(d); else bad.push(w); }
  }
  return { days: WEEK.filter((d) => set.has(d)), bad };
}

/**
 * A pack as typed ('6 x 1L', '12x330 ml', '2 x 2.5kg', '5kg', 'Case of 12', '24') to
 * { pack_qty, inner_qty, inner_unit } (inner_unit null when not written); null for empty;
 * undefined when it cannot be read.
 */
export function packOf(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/\u00d7/g, 'x');
  if (!t) return null;
  const n = '(\\d+(?:\\.\\d+)?)';
  let m = t.match(new RegExp(`^${n}\\s*[x*]\\s*${n}\\s*([a-z][a-z .]*)?$`));
  if (m) {
    const u = m[3] ? unitOf(m[3]) : null;
    return u === undefined ? undefined : { pack_qty: Number(m[1]), inner_qty: Number(m[2]), inner_unit: u };
  }
  m = t.match(new RegExp(`^(?:case|pack|box|tray|crate) of ${n}(?:\\s*([a-z][a-z .]*))?$`));
  if (m) {
    const u = m[2] ? unitOf(m[2]) : null;
    return u === undefined ? undefined : { pack_qty: Number(m[1]), inner_qty: 1, inner_unit: u };
  }
  m = t.match(new RegExp(`^${n}\\s*([a-z][a-z .]*)?$`));
  if (m) {
    const u = m[2] ? unitOf(m[2]) : null;
    return u === undefined ? undefined : { pack_qty: 1, inner_qty: Number(m[1]), inner_unit: u };
  }
  return undefined;
}

const ITEM_TYPES = {
  food: ['food', 'foods', 'kitchen', 'food cost'],
  drink: ['drink', 'drinks', 'beverage', 'beverages', 'bev', 'wet', 'liquor', 'alcohol', 'beer', 'wine', 'spirits', 'soft drinks', 'coffee', 'tea', 'bar'],
  other: ['other', 'packaging', 'non food', 'non-food', 'nonfood', 'cleaning', 'consumables', 'disposables', 'sundries', 'chemicals'],
};
const TYPE_BY_WORD = new Map(Object.entries(ITEM_TYPES).flatMap(([t, words]) => words.map((w) => [w, t])));

/** A type as typed ('Food', 'Beverage', 'Packaging') to 'food', 'drink' or 'other'; null for empty; undefined when not one. */
export function typeOf(text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t) return null;
  return TYPE_BY_WORD.get(t) || undefined;
}

/** Allergens as typed ('Milk; Gluten, soya') to the 14 ids; { ids, bad } (bad: words that are not one of the 14). */
export function allergensOf(text) {
  const t = String(text ?? '').trim();
  if (!t || /^(none|n\/a|na|-|no)$/i.test(t)) return { ids: [], bad: [] };
  const ids = [];
  const bad = [];
  for (const part of t.split(/[;,/|]+|\s+and\s+/i).map((x) => x.trim()).filter(Boolean)) {
    const id = normaliseAllergenId(part);
    if (isUkAllergen(id)) { if (!ids.includes(id)) ids.push(id); } else bad.push(part);
  }
  return { ids, bad };
}

/** The site names to ids map, from a Map, an object, or a list of { id, name }. Keys are lower case. */
export function siteLookup(siteIdByName) {
  const out = new Map();
  if (!siteIdByName) return out;
  const add = (name, id) => { if (name && id) out.set(String(name).trim().toLowerCase(), String(id)); };
  if (siteIdByName instanceof Map) for (const [n, id] of siteIdByName) add(n, id);
  else if (Array.isArray(siteIdByName)) for (const s of siteIdByName) add(s?.name, s?.id);
  else for (const [n, id] of Object.entries(siteIdByName)) add(n, id);
  return out;
}

/** A sites cell ('All', 'North; South', a list) to { ids, unknown }; ids null when the cell is empty (the job's sites). */
export function sitesOf(cell, lookup) {
  const names = Array.isArray(cell) ? cell : String(cell ?? '').split(/[;|]+/);
  const list = names.map((x) => String(x ?? '').trim()).filter(Boolean);
  if (!list.length) return { ids: null, unknown: [] };
  const map = lookup instanceof Map ? lookup : siteLookup(lookup);
  if (list.some((n) => /^all( sites)?$/i.test(n))) return { ids: [...new Set(map.values())], unknown: [] };
  const ids = [];
  const unknown = [];
  const known = new Set(map.values());
  for (const n of list) {
    const id = map.get(n.toLowerCase()) || (known.has(n) ? n : null);
    if (id) { if (!ids.includes(id)) ids.push(id); } else unknown.push(n);
  }
  return { ids, unknown };
}

// -- staged rows ---------------------------------------------------------------------------------

/**
 * Row numbers of a file of more than one kind: each kind in its own block, so the database (which
 * imports in row number order) makes every item before the supplier items and pars that name it.
 * fileRowOf gives the line in the file back.
 */
export const KIND_BLOCK = Object.freeze({ item: 1000000, supplier: 2000000, supplier_item: 3000000, par: 4000000, recipe: 5000000 });
export const fileRowOf = (rowNo) => (Number.isFinite(Number(rowNo)) ? Number(rowNo) % 1000000 : null);

const str = (v) => { const t = String(v ?? '').trim(); return t === '' ? null : t; };
const say = (problems, row, kind, words) => { if (Array.isArray(problems)) problems.push({ row, kind, words: `Row ${row}: ${words}` }); };

// One number field: null when empty, the words when it is not a number or below 0.
function amount(r, f, problems, kind, label) {
  const v = numberOf(r[f]);
  if (v === null) return null;
  if (!Number.isFinite(v) || v < 0) { say(problems, r._row, kind, `"${r[f]}" is not a ${label}. Left empty.`); return null; }
  return v;
}

function itemData(r, problems) {
  const unit = unitOf(r.base_unit);
  if (unit === undefined) say(problems, r._row, 'item', `"${r.base_unit}" is not a unit we know (each, g, kg, ml, l and so on). Left empty.`);
  const type = typeOf(r.type);
  if (type === undefined) say(problems, r._row, 'item', `type "${r.type}" is not Food, Drink or Other. Left empty.`);
  const vat = vatRateOf(r.purchase_vat);
  if (Number.isNaN(vat)) say(problems, r._row, 'item', `"${r.purchase_vat}" is not a VAT rate. Left empty.`);
  const al = allergensOf(r.allergens);
  if (al.bad.length) say(problems, r._row, 'item', `${al.bad.map((b) => `"${b}"`).join(', ')} ${al.bad.length === 1 ? 'is' : 'are'} not one of the 14 allergens. Left out.`);
  const shelf = amount(r, 'shelf_life_days', problems, 'item', 'number of days');
  let countPack = null;
  if (r.count_pack || r.count_pack_size) {
    const p = packOf(r.count_pack_size);
    let qty = null;
    if (p) {
      const factor = p.inner_unit && unit ? globalFactor(p.inner_unit, unit) : 1;
      if (factor != null && (!p.inner_unit || unit)) qty = Math.round(p.pack_qty * p.inner_qty * factor * 1e6) / 1e6;
    }
    if (qty > 0) countPack = { name: str(r.count_pack) || str(r.count_pack_size), qty_in_base: qty };
    else say(problems, r._row, 'item', `the pack people count in needs a size in ${unit || 'the base unit'}. Left out.`);
  }
  return {
    name: str(r.name), category: str(r.category), base_unit: unit || null, type: type || null, sku: str(r.sku), barcode: str(r.barcode),
    purchase_vat_rate: Number.isNaN(vat) ? null : vat, allergens: al.ids,
    shelf_life_days: shelf == null ? null : Math.round(shelf), count_pack: countPack,
  };
}

function supplierData(r, problems) {
  const terms = String(r.payment_terms_days ?? '').match(/\d+/);
  if (str(r.payment_terms_days) && !terms) say(problems, r._row, 'supplier', `"${r.payment_terms_days}" is not a number of days. Left empty.`);
  const min = moneyOf(r.min_order_value);
  if (Number.isNaN(min.amount)) say(problems, r._row, 'supplier', `"${r.min_order_value}" is not an amount. Left empty.`);
  const days = daysOf(r.delivery_days);
  if (days.bad.length) say(problems, r._row, 'supplier', `${days.bad.map((b) => `"${b}"`).join(', ')} ${days.bad.length === 1 ? 'is' : 'are'} not a day. Left out.`);
  const cut = timeOf(r.cutoff_time);
  if (cut === undefined) say(problems, r._row, 'supplier', `"${r.cutoff_time}" is not a time such as 14:00. Left empty.`);
  return {
    name: str(r.name), email: str(r.email), phone: str(r.phone), contact_name: str(r.contact_name),
    payment_terms_days: terms ? Number(terms[0]) : null, account_number: str(r.account_number),
    min_order_value: Number.isFinite(min.amount) ? min.amount : null, delivery_days: days.days, cutoff_time: cut || null,
  };
}

function supplierItemData(r, problems) {
  const kind = 'supplier_item';
  // the pack: its own columns win, then a pack size ('6 x 1L'), then the item's unit
  const pack = packOf(r.pack_size);
  if (pack === undefined) say(problems, r._row, kind, `could not read the pack size "${r.pack_size}".`);
  const packQty = amount(r, 'pack_qty', problems, kind, 'number') ?? pack?.pack_qty ?? 1;
  const innerQty = amount(r, 'inner_qty', problems, kind, 'number') ?? pack?.inner_qty ?? 1;
  let unit = r.inner_unit ? unitOf(r.inner_unit) : null;
  if (unit === undefined) { say(problems, r._row, kind, `"${r.inner_unit}" is not a unit we know. Left empty.`); unit = null; }
  if (!unit) unit = pack?.inner_unit || null;
  if (!unit) { const b = unitOf(r.base_unit); unit = b || null; }
  // the price: ex VAT when written so, else the price with VAT
  let price = moneyOf(r.pack_price);
  let inc = yesNoOf(r.includes_vat);
  if (inc === undefined) { say(problems, r._row, kind, `"${r.includes_vat}" is not yes or no. Read as no.`); inc = null; }
  if (price.amount === null && str(r.price_with_vat)) { price = moneyOf(r.price_with_vat); inc = true; }
  if (Number.isNaN(price.amount)) say(problems, r._row, kind, `"${r.pack_price ?? r.price_with_vat}" is not a price.`);
  const vat = vatRateOf(r.purchase_vat);
  if (Number.isNaN(vat)) say(problems, r._row, kind, `"${r.purchase_vat}" is not a VAT rate. Left empty.`);
  const cur = str(r.currency);
  const currency = cur && /^[A-Za-z]{3}$/.test(cur) ? cur.toUpperCase() : price.currency;
  if (cur && !/^[A-Za-z]{3}$/.test(cur)) say(problems, r._row, kind, `"${cur}" is not a currency such as GBP. Left empty.`);
  const described = str(r.pack_description) || str(r.pack_size) || `${packQty} x ${innerQty}${unit ? ` ${unit}` : ''}`;
  return {
    supplier: str(r.supplier), item: str(r.item), item_sku: str(r.item_sku), supplier_sku: str(r.supplier_sku),
    supplier_product_name: str(r.supplier_product_name), pack_description: described,
    pack_qty: packQty, inner_qty: innerQty, inner_unit: unit,
    pack_price: Number.isFinite(price.amount) ? price.amount : null, currency: currency || null,
    purchase_vat_rate: Number.isNaN(vat) ? null : vat, price_includes_tax: inc === true, site: str(r.site),
  };
}

function parData(r, problems) {
  return {
    item: str(r.item), item_sku: str(r.item_sku), site: str(r.site),
    par_level: amount(r, 'par_level', problems, 'par', 'number'),
    reorder_point: amount(r, 'reorder_point', problems, 'par', 'number'),
    min_level: amount(r, 'min_level', problems, 'par', 'number'),
  };
}

/**
 * The rows of one kind as stock_import_stage takes them: [{ row_no, kind, data, sites }].
 *   kind: 'items' (or 'item'), 'suppliers', 'supplier_items', 'pars', 'recipes'
 *   rows: the rows of csvRowsFor, mapNory, mapMarketMan or mapFile
 *   siteIdByName: the company's sites (a Map, an object, or a list of { id, name }) for the sites
 *     column ('All', or names split by ';') and the site column of items and suppliers
 *   problems: an optional list the plain words of every value that could not be read are added to
 *     ({ row, kind, words }); the row still stages, with that value left empty, and the database
 *     says whether it can be imported
 *   rowBase: added to each file line (KIND_BLOCK when one file stages several kinds)
 * data has the contract shapes (item, supplier, supplier_item, par, recipe). sites is null when the
 * row names none (the job's ticked sites apply), or the ids it names.
 */
export function toStageRows(kind, rows, { siteIdByName = null, problems = null, rowBase = 0 } = {}) {
  const k = fileKind(kind);
  const stageKind = STAGE_KIND[k];
  if (!stageKind) return [];
  const lookup = siteLookup(siteIdByName);
  const out = [];
  (rows || []).forEach((r, i) => {
    const row = { ...r, _row: Number.isFinite(Number(r?._row)) ? Number(r._row) : i + 2 };
    let data;
    if (k === 'items') data = itemData(row, problems);
    else if (k === 'suppliers') data = supplierData(row, problems);
    else if (k === 'supplier_items') data = supplierItemData(row, problems);
    else if (k === 'pars') data = parData(row, problems);
    else data = { name: str(row.name) };
    // where it goes: the sites column, else (items, suppliers) the sites its rows named
    let cell = row.sites;
    if (!str(cell) && (k === 'items' || k === 'suppliers') && Array.isArray(row._sites) && row._sites.length) cell = row._sites;
    else if (!str(cell) && (k === 'items' || k === 'suppliers') && row.site) cell = [row.site];
    const s = k === 'recipes' ? { ids: null, unknown: [] } : sitesOf(cell, lookup);
    if (s.unknown.length) say(problems, row._row, stageKind, `no site called ${s.unknown.map((n) => `"${n}"`).join(', ')}.`);
    if ((k === 'pars' || k === 'supplier_items') && data.site && lookup.size && !lookup.has(data.site.toLowerCase()) && ![...lookup.values()].includes(data.site)) {
      say(problems, row._row, stageKind, `no site called "${data.site}".`);
    }
    out.push({ row_no: Math.trunc(Number(rowBase) || 0) + row._row, kind: stageKind, data, sites: s.ids });
  });
  return out;
}

/**
 * A whole file's staged rows (mapFile's answer), every kind in its block: items, then suppliers,
 * supplier items, pars, recipes. Answer { rows, problems, counts: { item: n, ... } }.
 */
export function stageFile(mapped, { siteIdByName = null } = {}) {
  const problems = [];
  const rows = [];
  const counts = {};
  for (const k of ['items', 'suppliers', 'supplier_items', 'pars', 'recipes']) {
    const part = mapped?.kinds?.[k];
    if (!part || !part.rows?.length) continue;
    const staged = toStageRows(k, part.rows, { siteIdByName, problems, rowBase: KIND_BLOCK[STAGE_KIND[k]] });
    counts[STAGE_KIND[k]] = staged.length;
    rows.push(...staged);
  }
  return { rows, problems, counts };
}
