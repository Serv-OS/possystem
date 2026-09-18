// src/lib/ezcaterMenuExport.js
//
// "COPY OUR MENU FOR EZCATER": the other direction.
//
// Pasting their menu in (ezcaterMenuPaste.js) matches the names they already
// have. This is for the day their menu is set up, or changed: ezCater's menu
// team builds a caterer's menu by hand from what the caterer sends them
// (menus@ezcater.com, or the Menus tab in ezManage asks for "serving sizes and
// prices" and a menu). Send them OUR names and every item matches from its
// first order, with nothing left to match by hand.
//
// One tab separated block a spreadsheet takes as columns, and a person can
// paste into an email as it is:
//
//   Category  Item  Size  Price  Item code
//   ...
//
//   Option group  Option name  Price
//   ...
//
// Our sizes are separate products under their main product (parent_id), so a
// sized product is one row per size, with the main product's name in Item and
// the size's own name in Size. That is exactly the shape ezCater keeps (an item
// with selections), and exactly the pair the webhook joins back together
// (ezLineName) when their order comes in.
//
// The item code column is the existing item code (src/lib/itemCode.js): the
// short id ezCater may be able to put on their side as the POS id. Blank when
// the product has none, or before its migration has been run.
//
// PURE. Takes the table rows, returns rows and text.

import { itemPriceOf } from './ezcaterItemRows.js';
import { codeOf, itemNameOf } from './itemCode.js';
import { isOptionOnlyItem } from './menuRules.js';

export const MENU_EXPORT_HEADER = ['Category', 'Item', 'Size', 'Price', 'Item code'];
export const OPTION_EXPORT_HEADER = ['Option group', 'Option name', 'Price'];

const one = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const money = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(2) : '');
const sortOf = (it) => {
  const n = Number(it && (it.sort_order != null ? it.sort_order : it.sortOrder));
  return Number.isFinite(n) ? n : 0;
};
const parentIdOf = (it) => {
  const p = it && (it.parent_id != null ? it.parent_id : it.parentId);
  return p != null && p !== '' ? String(p) : null;
};
const catIdOf = (it) => {
  if (!it) return null;
  if (it.cat != null && it.cat !== '') return String(it.cat);
  if (Array.isArray(it.cats) && it.cats.length) return String(it.cats[0]);
  return null;
};

/**
 * Our live menu as rows: { category, item, size, price, code }.
 *
 *   items       menu_items rows (snake_case or store shape)
 *   categories  menu_categories rows, for the Category column. Optional.
 *
 * Archived products, and option only products (a sub item that is not sold on
 * its own), are left out: ezCater cannot sell either.
 */
export function ourMenuRows(items, categories) {
  const list = (Array.isArray(items) ? items : []).filter((it) => it && it.id != null && !it.archived && !isOptionOnlyItem(it));
  const catName = new Map();
  for (const c of Array.isArray(categories) ? categories : []) {
    if (c && c.id != null) catName.set(String(c.id), one(c.label != null ? c.label : c.name));
  }
  const byId = new Map(list.map((it) => [String(it.id), it]));
  const sizesOf = new Map();
  for (const it of list) {
    const pid = parentIdOf(it);
    if (pid && byId.has(pid)) {
      if (!sizesOf.has(pid)) sizesOf.set(pid, []);
      sizesOf.get(pid).push(it);
    }
  }

  const rows = [];
  for (const it of list) {
    const pid = parentIdOf(it);
    if (pid && byId.has(pid)) continue;              // listed under its product
    const name = itemNameOf(it);
    if (!name) continue;
    const category = catName.get(catIdOf(it) || '') || '';
    const sizes = (sizesOf.get(String(it.id)) || []).slice().sort((a, b) => sortOf(a) - sortOf(b));
    if (!sizes.length) {
      rows.push({ category, item: name, size: '', price: itemPriceOf(it), code: one(codeOf(it)) });
      continue;
    }
    for (const s of sizes) {
      rows.push({ category, item: name, size: itemNameOf(s), price: itemPriceOf(s), code: one(codeOf(s)) });
    }
  }
  rows.sort((a, b) => {
    if (a.category !== b.category) {
      if (!a.category) return 1;
      if (!b.category) return -1;
      return a.category < b.category ? -1 : 1;
    }
    if (a.item !== b.item) return a.item < b.item ? -1 : 1;
    return 0;                                         // sizes keep their own order
  });
  return rows;
}

/** Our modifier options as rows: { group, option, price }. */
export function ourOptionRows(groups) {
  const rows = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    const gName = one(g && g.name);
    if (!gName) continue;
    for (const o of (Array.isArray(g.options) ? g.options : [])) {
      const oName = one(o && (o.name != null ? o.name : o.label));
      if (!oName) continue;
      const n = Number(o.price);
      rows.push({ group: gName, option: oName, price: Number.isFinite(n) && n > 0 ? n : null });
    }
  }
  return rows;
}

/**
 * The text the button copies. Items first, then a blank line and the options.
 * Returns '' when there is nothing to send.
 */
export function ourMenuText(items, categories, groups) {
  const rows = ourMenuRows(items, categories);
  const opts = ourOptionRows(groups);
  if (!rows.length && !opts.length) return '';
  const cell = (s) => one(s).replace(/\t/g, ' ');
  const out = [];
  if (rows.length) {
    out.push(MENU_EXPORT_HEADER.join('\t'));
    for (const r of rows) out.push([r.category, r.item, r.size, money(r.price), r.code].map(cell).join('\t'));
  }
  if (opts.length) {
    if (out.length) out.push('');
    out.push(OPTION_EXPORT_HEADER.join('\t'));
    for (const r of opts) out.push([r.group, r.option, money(r.price)].map(cell).join('\t'));
  }
  return out.join('\n');
}
