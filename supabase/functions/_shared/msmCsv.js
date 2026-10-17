// supabase/functions/_shared/msmCsv.js
//
// MULTI SITE MENU (17 Oct 2026, v5.11.75): the grid as a spreadsheet, both ways. Pure, tested
// (src/lib/msm/msmCsv.test.js).
//
// EXPORT: central id, product, category, size of, default price, then per site "<Site> price" and
// "<Site> active". Excel safe: UTF-8 with a byte order mark, prices as plain numbers (2.95, no
// pound sign), and a cell that starts with = + - @ is quoted with a leading apostrophe so Excel
// never runs it as a formula.
// IMPORT: matches each row by central id, then by name and category. It stages PRICES and ACTIVE
// flags only; it never creates or deletes a product. Unmatched rows are listed as ignored, and the
// same publish preview shows before anything goes anywhere.

import { toPence, fromPence, normName, money2, samePrice } from './msmModel.js';

const listOf = (v) => (Array.isArray(v) ? v : []);
const BOM = String.fromCharCode(0xFEFF);

const cell = (v) => {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * The grid as CSV text.
 *   central   { products, productSites, categories }
 *   sites     [{ location_id, name }] in the order shown
 *   opts      { productIds: limit to these (the rows shown), bom: true }
 */
export function exportCsv(central, sites, opts = {}) {
  const cats = new Map(listOf(central?.categories).map((c) => [c.id, c.label]));
  const prods = listOf(central?.products).filter((p) => !p.archived && (!opts.productIds || opts.productIds.includes(p.id)));
  const byId = new Map(listOf(central?.products).map((p) => [p.id, p]));
  const ps = new Map(listOf(central?.productSites).map((r) => [`${r.product_id}|${r.location_id}`, r]));
  const head = ['Central id', 'Product', 'Category', 'Size of', 'Default price'];
  for (const s of listOf(sites)) head.push(`${s.name} price`, `${s.name} active`);
  const lines = [head.map(cell).join(',')];
  for (const p of prods) {
    const row = [p.id, p.menu_name || p.name, cats.get(p.category_id) || '', p.parent_product_id ? (byId.get(p.parent_product_id)?.name || '') : '', money2(p.default_price)];
    for (const s of listOf(sites)) {
      const r = ps.get(`${p.id}|${s.location_id}`);
      if (!r) { row.push('', ''); continue; }
      row.push(r.price == null ? '' : money2(r.price), r.active === false ? 'No' : 'Yes');
    }
    lines.push(row.map(cell).join(','));
  }
  return (opts.bom === false ? '' : BOM) + lines.join('\r\n') + '\r\n';
}

/** RFC 4180 text into rows of cells. Handles quotes, doubled quotes, CRLF and a byte order mark. */
export function parseCsv(text) {
  const s = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
      continue;
    }
    if (ch === '"') { q = true; continue; }
    if (ch === ',') { row.push(cur); cur = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; continue; }
    cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

const yesNo = (v) => {
  const t = String(v ?? '').trim().toLowerCase();
  if (['yes', 'y', 'true', '1', 'on'].includes(t)) return true;
  if (['no', 'n', 'false', '0', 'off'].includes(t)) return false;
  return null;
};
const priceCell = (v) => {
  const t = String(v ?? '').trim().replace(/^'/, '').replace(/^£/, '').replace(/,/g, '');
  if (t === '') return { blank: true };
  const p = toPence(t);
  if (p === null || Number.isNaN(p)) return { bad: true };
  return { pence: p };
};

/**
 * Check an imported CSV against the central menu and turn it into staged changes.
 *   text      the file's text
 *   central   { products, productSites, categories, sites }
 *   sites     [{ location_id, name }]
 * Returns { changes, ignored: [{ line, words }], errors: [{ line, words }], matched, summary }.
 * A blank site price means "follows the default". Nothing is created or deleted.
 */
export function readCsvChanges(text, central, sites) {
  const rows = parseCsv(text);
  const errors = [];
  const ignored = [];
  const changes = [];
  if (!rows.length) return { changes, ignored, errors: [{ line: 0, words: 'The file is empty.' }], matched: 0, summary: 'Nothing to change' };
  const head = rows[0].map((h) => String(h).trim());
  const col = (name) => head.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const iId = col('Central id'), iName = col('Product'), iCat = col('Category'), iDef = col('Default price');
  if (iName < 0 && iId < 0) return { changes, ignored, errors: [{ line: 1, words: 'The first row must have the column names (at least Central id or Product).' }], matched: 0, summary: 'Nothing to change' };
  const siteCols = listOf(sites).map((s) => ({ s, price: col(`${s.name} price`), active: col(`${s.name} active`) }));
  const cats = new Map(listOf(central?.categories).map((c) => [c.id, c.label]));
  const products = listOf(central?.products).filter((p) => !p.archived);
  const byId = new Map(products.map((p) => [p.id, p]));
  const byNameCat = new Map();
  for (const p of products) {
    const k = `${normName(p.menu_name || p.name)}|${normName(cats.get(p.category_id) || '')}`;
    byNameCat.set(k, byNameCat.has(k) ? null : p);     // null = two products share it
  }
  const ps = new Map(listOf(central?.productSites).map((r) => [`${r.product_id}|${r.location_id}`, r]));
  const seen = new Set();
  let matched = 0;
  for (let n = 1; n < rows.length; n++) {
    const r = rows[n];
    const line = n + 1;
    let p = iId >= 0 ? byId.get(String(r[iId] || '').trim()) : null;
    if (!p && iName >= 0) {
      const k = `${normName(r[iName])}|${normName(iCat >= 0 ? r[iCat] : '')}`;
      p = byNameCat.get(k) || null;
      if (byNameCat.get(k) === null) { ignored.push({ line, words: `"${r[iName]}" matches more than one product; add the Central id column.` }); continue; }
    }
    if (!p) { ignored.push({ line, words: `"${(iName >= 0 ? r[iName] : r[iId]) || 'This row'}" is not in the group menu (the file never adds products).` }); continue; }
    if (seen.has(p.id)) { ignored.push({ line, words: `"${p.name}" is in the file twice; only the first row counts.` }); continue; }
    seen.add(p.id);
    matched++;
    let newDefault = toPence(p.default_price);
    if (iDef >= 0) {
      const d = priceCell(r[iDef]);
      if (d.bad) { errors.push({ line, words: `Default price for "${p.name}" is not a price.` }); continue; }
      if (!d.blank && d.pence < 0) { errors.push({ line, words: `Default price for "${p.name}" is below zero.` }); continue; }
      if (!d.blank && !samePrice(fromPence(d.pence), p.default_price)) {
        changes.push({ target: 'product', entity_id: p.id, location_id: null, op: 'update', after: { default_price: fromPence(d.pence) }, before: { default_price: p.default_price } });
        newDefault = d.pence;
      }
    }
    for (const sc of siteCols) {
      const row = ps.get(`${p.id}|${sc.s.location_id}`);
      if (!row) continue;
      const after = {}, before = {};
      if (sc.price >= 0) {
        const c = priceCell(r[sc.price]);
        if (c.bad) { errors.push({ line, words: `${sc.s.name} price for "${p.name}" is not a price.` }); continue; }
        if (!c.blank && c.pence < 0) { errors.push({ line, words: `${sc.s.name} price for "${p.name}" is below zero.` }); continue; }
        const want = c.blank || c.pence === newDefault ? null : fromPence(c.pence);
        if (!samePrice(want, row.price) || (want === null) !== (row.price === null)) { after.price = want; before.price = row.price; }
      }
      if (sc.active >= 0 && String(r[sc.active] ?? '').trim() !== '') {
        const a = yesNo(r[sc.active]);
        if (a === null) { errors.push({ line, words: `${sc.s.name} active for "${p.name}" must be Yes or No.` }); continue; }
        if (a !== (row.active !== false)) { after.active = a; before.active = row.active !== false; }
      }
      if (Object.keys(after).length) changes.push({ target: 'product_site', entity_id: p.id, location_id: sc.s.location_id, op: 'update', after, before });
    }
  }
  const summary = `${changes.length} change${changes.length === 1 ? '' : 's'} from ${matched} matched row${matched === 1 ? '' : 's'}${ignored.length ? `, ${ignored.length} ignored` : ''}${errors.length ? `, ${errors.length} with errors` : ''}`;
  return { changes, ignored, errors, matched, summary };
}
