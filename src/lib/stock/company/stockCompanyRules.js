// src/lib/stock/company/stockCompanyRules.js
//
// MULTI SITE STOCK, Phase 1 (v5.11.80): the pure rules the screens use. No data, no React.
// The database decides everything (20261019c); these only turn its answers into plain words, read a
// CSV file, and lay the open draft over a page of company rows. Unit tested in
// stockCompanyRules.test.js.

/** "Not installed": the database update has not run (the function or table is missing). */
export function isNotInstalledError(error) {
  const m = `${error?.code || ''} ${error?.message || error || ''}`;
  return /PGRST202|PGRST205|42883|42P01|could not find the function|does not exist/i.test(m);
}

/** Plain words for a refusal from the database. */
export function refusalWords(error) {
  const m = String(error?.message || error || '');
  if (!m) return 'It did not save. Try again.';
  if (/jwt|expired|401/i.test(m)) return 'Your sign in has expired. Sign in again; nothing was saved.';
  if (/row-level security|permission denied/i.test(m)) return 'This login cannot change company stock (only stock Editors ServOS added can).';
  if (/statement timeout|57014/i.test(m)) return 'That took too long and was stopped. Nothing was changed. Try a smaller step.';
  return m.replace(/^ERROR:\s*/, '').slice(0, 400);
}

/**
 * May this login open Shared stock, and edit it? Fail closed: anything missing is no.
 * stock_my_access answers { installed, companies: [{ org_id, org_name, role, enabled, menu_enabled }] }.
 */
export function accessFromRpc(res, orgId = null) {
  const none = { installed: false, canOpen: false, canEdit: false, orgId: null, orgName: '', role: null, enabled: false, menuEnabled: false };
  if (!res) return none;
  if (res.error) return { ...none, installed: !isNotInstalledError(res.error) };
  const list = Array.isArray(res.data?.companies) ? res.data.companies : [];
  const open = list.filter((c) => c && c.enabled && c.menu_enabled && (c.role === 'editor' || c.role === 'viewer'));
  const pick = (orgId && open.find((c) => c.org_id === orgId)) || open[0] || null;
  if (!pick) return { ...none, installed: true };
  return { installed: true, canOpen: true, canEdit: pick.role === 'editor', orgId: pick.org_id, orgName: pick.org_name || '',
    role: pick.role, enabled: true, menuEnabled: true };
}

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const plural = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

/** VAT as a percent for people: 0.2 -> "20%", 0.125 -> "12.5%", null -> "". */
export function ratePercent(rate) {
  if (rate == null || rate === '' || !Number.isFinite(Number(rate))) return '';
  return `${Number((Number(rate) * 100).toFixed(3))}%`;
}

/** A typed percent to a rate: "20" -> 0.2, "" -> null, junk -> NaN. */
export function parseRatePercent(text) {
  const t = String(text ?? '').replace('%', '').trim();
  if (t === '') return null;
  const v = Number(t);
  if (!Number.isFinite(v) || v < 0 || v >= 100) return Number.NaN;
  return Math.round(v * 10000) / 1000000;
}

/**
 * One site's plan in words (5.2 "Changes, preview and publish"):
 * "Location 2: 3 new stock items, 1 supplier, 2 prices; 2 changed. No stock quantities change."
 */
export function planWords(siteName, plan) {
  const p = plan || {};
  const added = [];
  if (n(p.items_new)) added.push(plural(n(p.items_new), 'new stock item'));
  if (n(p.packs_new) + n(p.bridges_new)) added.push(plural(n(p.packs_new) + n(p.bridges_new), 'pack or unit', 'packs and units'));
  if (n(p.suppliers_new)) added.push(plural(n(p.suppliers_new), 'supplier'));
  if (n(p.prices_new)) added.push(plural(n(p.prices_new), 'price'));
  const changed = n(p.items_changed) + n(p.packs_changed) + n(p.bridges_changed) + n(p.suppliers_changed) + n(p.prices_changed);
  const name = siteName || 'This site';
  if (!added.length && !changed) return `${name}: nothing to change.`;
  const parts = [];
  if (added.length) parts.push(added.join(', '));
  if (changed) parts.push(`${changed} changed`);
  let out = `${name}: ${parts.join('; ')}.`;
  if (n(p.items_off)) out += ` ${plural(n(p.items_off), 'item')} switched off here.`;
  if (n(p.items_held)) out += ` ${plural(n(p.items_held), 'item')} still held here stay${n(p.items_held) === 1 ? 's' : ''} live (with their packs and prices) and are archived by the next publish after they are counted to zero.`;
  out += ' No stock quantities change.';
  if (n(p.costs_changed)) {
    out += ` Cost here moves for ${plural(n(p.costs_changed), 'item')} (${p.cost_rule === 'deliveries' ? 'deliveries rule: only items never received' : 'this site follows its price list'}).`;
  }
  return out;
}

/** Discard all stays offered whenever the draft has rows OR cannot be read (too big, a failed read). */
export const showDiscardAll = ({ canEdit = false, total = 0, readError = '' } = {}) => !!canEdit && (Number(total) > 0 || !!readError);

/** The preview's cost here before and after, one line each: "Cups: 0.05 to 0.055". */
export function costLines(plan, fmt = (v) => String(Number(Number(v).toFixed(5)))) {
  const list = Array.isArray(plan?.costs) ? plan.costs : [];
  return list.map((c) => (c.new || c.before == null ? `${c.name}: new here, cost ${fmt(c.after)}` : `${c.name}: ${fmt(c.before)} to ${fmt(c.after)}`));
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const AREA_WORDS = { cellar: 'Cellar', walk_in: 'Walk in fridge', fridge: 'Fridge', freezer: 'Freezer', dry_store: 'Dry store', bar: 'Bar', kitchen: 'Kitchen', other: 'Other' };
export const FIELD_WORDS = Object.freeze({
  name: 'name', category: 'category', accounting_group: 'accounting group', base_unit: 'base unit', allergens: 'allergens', sku: 'SKU',
  barcode: 'barcode', shelf_life_days: 'shelf life (days)', purchase_tax_rate: 'VAT', vat: 'VAT', default_area_kind: 'usual area',
  returns_to_shelf: 'can go back on the shelf', notes: 'notes', all_sites: 'every site', archived: 'archived', archived_at: 'archived',
  qty_in_base: 'holds', is_count_default: 'count pack', is_purchase_default: 'buying pack', contact_name: 'contact', contact_email: 'email',
  phone: 'phone', payment_terms_days: 'payment terms (days)', supplier_sku: 'supplier SKU', pack_description: 'pack', pack_qty: 'packs',
  inner_qty: 'each holds', inner_unit: 'unit', pack_price: 'price', price_includes_tax: 'price includes VAT', first_choice: 'first choice',
  account_number: 'account number', order_email: 'order email', delivery_days: 'delivery days', cutoff_time: 'cut off',
  min_order_value: 'minimum order', made_here: 'made here', off: 'off here', current_cost: 'cost here', on_hand: 'on hand',
});
const HIDDEN = new Set(['_new', 'item_id', 'supplier_id', 'parent_pack_id', 'link', 'company_ref', 'updated_at', 'open_history', 'history_id', 'item', 'area_id']);
const hiddenKey = (k) => HIDDEN.has(k) || /_id$/.test(k);

/** One value in words: yes or no, a VAT percent, an area name, a list; never an id. */
export function valueWords(key, v, fmtWhen = (iso) => iso) {
  if (v == null || v === '') return 'cleared';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (key === 'purchase_tax_rate') return ratePercent(v) || 'none';
  if (key === 'default_area_kind') return AREA_WORDS[v] || String(v);
  if (key === 'archived_at') return fmtWhen(v) || 'yes';
  if (Array.isArray(v)) return v.length ? v.join(', ') : 'none';
  if (typeof v === 'object') return '';
  const t = String(v);
  return UUID.test(t) ? '' : t;
}

/** The fields of a change or a version row in words, ids and bookkeeping left out. */
export function fieldWords(data, fmtWhen) {
  return Object.entries(data || {}).filter(([k]) => !hiddenKey(k))
    .map(([k, v]) => [FIELD_WORDS[k] || k.replace(/_/g, ' '), valueWords(k, v, fmtWhen)])
    .filter(([, w]) => w !== '')
    .map(([k, w]) => `${k} ${w}`).join(', ');
}

const KIND_WORDS = { item: 'Stock item', item_site: 'Stock item', pack: 'Pack', pack_site: 'Pack', bridge: 'Unit bridge', bridge_site: 'Unit bridge',
  supplier: 'Supplier', supplier_site: 'Supplier', sp: 'Supplier price', sp_site: 'Price' };

/**
 * A staged change in words, from msm_stock_draft_rows (each row carries item_name, supplier_name,
 * pack_name, parent_pack_name, site_name): "Price: Cups from Dairy Co at Provo: price 4.8". Never an id.
 */
export function changeWords(c) {
  const d = (c && c.data) || {};
  const item = c?.item_name || 'an item';
  const sup = c?.supplier_name || 'a supplier';
  const subject = {
    item: item, item_site: item, pack: `${item}, pack ${c?.pack_name || d.name || ''}`.trim(), pack_site: `${item}, pack ${c?.pack_name || ''}`.trim(),
    bridge: `${item}`, bridge_site: `${item}`, supplier: c?.supplier_name || d.name || 'a supplier', supplier_site: c?.supplier_name || 'a supplier',
    sp: `${item} from ${sup}`, sp_site: `${item} from ${sup}`,
  }[c?.target] || item;
  const bits = [];
  if (d.link) bits.push('joins the site\'s own row');
  if ('active' in d) bits.push(d.active == null ? 'follows every site' : (d.active ? 'on here' : 'off here'));
  if (c?.target === 'bridge' && d.from_qty != null) bits.push(`${d.from_qty} ${d.from_unit} = ${d.to_qty} ${d.to_unit}`);
  if (d.parent_pack_id) bits.push(`inside ${c?.parent_pack_name || 'another pack'}`);
  const rest = { ...d };
  for (const k of ['active', 'from_qty', 'from_unit', 'to_qty', 'to_unit']) delete rest[k];
  const f = fieldWords(rest);
  if (f) bits.push(f);
  return `${d._new ? 'New ' : ''}${KIND_WORDS[c?.target] || 'Change'}: ${subject}${c?.site_name ? ` at ${c.site_name}` : ''}${bits.length ? `: ${bits.join(', ')}` : ''}`;
}

const TABLE_WORDS = { inventory_items: 'Stock item', item_packaging_formats: 'Pack', inventory_item_conversions: 'Unit bridge', suppliers: 'Supplier',
  supplier_products: 'Supplier price', inventory_item_areas: 'Area', item_cost: 'Cost here' };
const OP_WORDS = { insert: 'Added', update: 'Changed', link: 'Joined the company row', unlink: 'Became the site\'s own', restore: 'Put back',
  delete: 'Removed', archive: 'Archived, kept by the site' };

/** One History row in words: { what, how, before, after }, from msm_stock_version_rows_page. */
export function versionRowWords(r, fmtWhen = (iso) => iso) {
  const x = r || {};
  return {
    what: `${TABLE_WORDS[x.tbl] || 'Row'}${x.name ? `: ${x.name}` : ''}`,
    how: OP_WORDS[x.op] || 'Changed',
    before: fieldWords(x.before, fmtWhen),
    after: fieldWords(x.after, fmtWhen),
  };
}

/** The health check's answer as two lists of words. */
export function healthLines(health) {
  const h = health || {};
  const words = (list) => (Array.isArray(list) ? list.map((x) => (x && x.words) || String(x || '')).filter(Boolean) : []);
  return { blocks: words(h.block), warns: words(h.warn) };
}

/**
 * A site card: "Stock in step" or what waits (5.2 site cards). Returns { tone, words }. A wait time is
 * on the SITE's clock (card.timezone), never the viewer's: fmtTime(iso, timeZone).
 */
export function siteCardWords(card, fmtTime = (iso) => iso) {
  const c = card || {};
  if (c.waiting) {
    const w = c.waiting;
    if (w.status === 'failed') return { tone: 'bad', words: `Version ${w.version_no} failed here: ${w.last_error || 'see History'}` };
    if (w.status === 'running') return { tone: 'blue', words: `Version ${w.version_no} is being written now` };
    if (w.last_error) return { tone: 'warn', words: `Version ${w.version_no} waits: ${w.last_error}` };
    return { tone: 'warn', words: `Version ${w.version_no} waits until ${fmtTime(w.due_at, c.timezone || undefined)}${c.name ? ` on ${c.name}'s clock` : ''}` };
  }
  if (c.last) return { tone: 'good', words: `Stock in step (version ${c.last.version_no})` };
  return { tone: 'neutral', words: 'Nothing published here yet' };
}

/** A version's status in words for History. */
export function versionWords(v) {
  const x = v || {};
  const kind = { publish: 'Publish', start: 'Start from a site', undo: 'Undo', keep: 'Keep the site\'s' }[x.kind] || 'Change';
  const st = { waiting: 'waiting', done: 'done', failed: 'failed at a site', undone: 'undone' }[x.status] || x.status || '';
  const s = x.summary || {};
  const writes = n(s.writes);
  return `${kind}, ${st}${writes ? `, ${plural(writes, 'row')} written` : ''}`;
}

/** "Head office added 12 items and changed 3 on Tuesday" (5.3 Overview card). */
export function newsWords(news, fmtDay = (iso) => iso) {
  if (!news) return null;
  const added = n(news.items_added); const changed = n(news.items_changed);
  const sup = n(news.suppliers_added); const prices = n(news.prices_changed);
  if (!added && !changed && !sup && !prices) return null;
  const bits = [];
  if (added) bits.push(`added ${plural(added, 'item')}`);
  if (changed) bits.push(`changed ${plural(changed, 'item')}`);
  if (sup) bits.push(`added ${plural(sup, 'supplier')}`);
  if (prices) bits.push(`changed ${plural(prices, 'price')}`);
  const last = bits.pop();
  const list = bits.length ? `${bits.join(', ')} and ${last}` : last;
  return `Head office ${list}${news.last_at ? ` (last on ${fmtDay(news.last_at)})` : ''}.`;
}

/**
 * Lay the open draft over a page of company items: each row gets `staged` (its own changes) and its
 * fields and site ticks as they will be after publish. `changes` are msm_stock_changes rows.
 */
export function mergeDraft(rows, changes) {
  const byItem = new Map();
  const bySite = new Map();
  for (const c of changes || []) {
    if (!c) continue;
    if (c.target === 'item') byItem.set(c.entity_id, c);
    if (c.target === 'item_site') {
      if (!bySite.has(c.entity_id)) bySite.set(c.entity_id, []);
      bySite.get(c.entity_id).push(c);
    }
  }
  return (rows || []).map((r) => {
    const own = byItem.get(r.id);
    const ticks = bySite.get(r.id) || [];
    if (!own && !ticks.length) return r;
    const sites = { ...(r.sites || {}) };
    const allSites = own && own.data && Object.prototype.hasOwnProperty.call(own.data, 'all_sites') ? !!own.data.all_sites : !!r.all_sites;
    for (const t of ticks) {
      const prev = sites[t.location_id] || {};
      const tick = t.data && Object.prototype.hasOwnProperty.call(t.data, 'active') ? t.data.active : prev.own_tick;
      sites[t.location_id] = { ...prev, own_tick: tick, active: tick == null ? allSites : !!tick, staged: true };
    }
    const data = own ? { ...own.data } : {};
    delete data._new;
    return { ...r, ...data, all_sites: allSites, sites, staged: true };
  });
}

/** Is an item on at a site (its own tick, else its every site switch)? */
export function onAtSite(row, siteId) {
  const s = row?.sites?.[siteId];
  if (s && s.own_tick != null) return !!s.own_tick;
  return !!row?.all_sites;
}

// ── CSV ────────────────────────────────────────────────────────────────────

/** Read CSV text (commas, quotes, doubled quotes, CR LF) into rows of strings. */
export function parseCsv(text) {
  const out = [];
  let row = [];
  let cell = '';
  let q = false;
  const s = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { q = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
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

export const CSV_COLUMNS = Object.freeze({
  items: { required: ['name'], fields: ['name', 'sku', 'base_unit', 'barcode', 'category', 'accounting_group', 'shelf_life_days', 'purchase_vat', 'allergens', 'area_kind'] },
  packs: { required: ['item', 'name', 'qty_in_base'], fields: ['item', 'name', 'qty_in_base', 'count_default', 'buy_default'] },
  prices: { required: ['supplier', 'item', 'pack_price'], fields: ['supplier', 'item', 'supplier_sku', 'pack_description', 'pack_qty', 'inner_qty', 'inner_unit', 'pack_price', 'includes_vat'] },
});
const ALIASES = {
  name: ['name', 'item name', 'stock item', 'pack name', 'pack'], sku: ['sku', 'code', 'our sku', 'item code'], base_unit: ['base unit', 'unit', 'base_unit'],
  barcode: ['barcode', 'ean', 'gtin'], category: ['category'], accounting_group: ['accounting group', 'accounting_group', 'group'],
  shelf_life_days: ['shelf life', 'shelf life days', 'shelf_life_days'], purchase_vat: ['purchase vat', 'vat', 'vat %', 'purchase_vat'],
  allergens: ['allergens'], area_kind: ['area', 'area kind', 'area_kind', 'usual area'],
  item: ['item', 'item sku', 'stock item', 'item name'], qty_in_base: ['qty in base', 'size', 'qty_in_base', 'quantity in base unit'],
  count_default: ['count default', 'count_default', 'count in this'], buy_default: ['buy default', 'buy_default', 'buy in this'],
  supplier: ['supplier', 'supplier name'], supplier_sku: ['supplier sku', 'supplier_sku', 'supplier code'],
  pack_description: ['pack', 'pack description', 'pack_description'], pack_qty: ['pack qty', 'pack_qty', 'packs'],
  inner_qty: ['inner qty', 'inner_qty', 'each pack holds'], inner_unit: ['inner unit', 'inner_unit', 'unit of the pack'],
  pack_price: ['price', 'pack price', 'pack_price'], includes_vat: ['includes vat', 'inc vat', 'includes_vat', 'price includes vat'],
};

/**
 * CSV rows (first row = headings) to the import's fields. Returns { rows, missing, unknown }:
 * rows are objects keyed by field; missing names required headings that are not there.
 */
export function csvRowsFor(kind, table) {
  const spec = CSV_COLUMNS[kind];
  if (!spec || !Array.isArray(table) || !table.length) return { rows: [], missing: spec ? spec.required : [], unknown: [] };
  const head = table[0].map((h) => String(h || '').trim().toLowerCase().replace(/\s+/g, ' '));
  const at = {};
  const unknown = [];
  head.forEach((h, i) => {
    const f = spec.fields.find((x) => x === h || (ALIASES[x] || []).includes(h));
    // "name" in a packs file is the pack's name; "item" is the item. First heading that fits wins.
    if (f && at[f] === undefined) at[f] = i; else if (h) unknown.push(table[0][i]);
  });
  const missing = spec.required.filter((f) => at[f] === undefined);
  const rows = table.slice(1).map((r) => {
    const o = {};
    for (const [f, i] of Object.entries(at)) { const v = String(r[i] ?? '').trim(); if (v !== '') o[f] = v; }
    return o;
  }).filter((o) => Object.keys(o).length > 0);
  return { rows, missing, unknown };
}

export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < (list || []).length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** A new id for a staged row (the database checks it is unused). */
export const newId = () => (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
  ? globalThis.crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)));

/**
 * The fields of a company item that a site cannot change (greyed on the site's screens; the database
 * refuses them too). Kept in step with 20261019c's lock trigger.
 */
export const COMPANY_ITEM_FIELDS = Object.freeze(['name', 'category', 'accountingGroup', 'baseUnit', 'allergens', 'sku', 'barcode',
  'shelfLifeDays', 'returnsToShelf', 'purchaseTaxRateId', 'archivedAt']);
export const COMPANY_SUPPLIER_FIELDS = Object.freeze(['name', 'contactName', 'phone', 'paymentTermsDays', 'archivedAt']);
export const COMPANY_PRICE_FIELDS = Object.freeze(['supplierId', 'inventoryItemId', 'supplierSku', 'packDescription', 'packQty', 'innerQty',
  'innerUnit', 'packPrice', 'priceIncludesTax', 'purchaseTaxRateId', 'archivedAt']);
