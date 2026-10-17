// src/lib/msm/msmWords.js
//
// MULTI SITE MENU (v5.11.75): a staged change in plain words, for the Changes panel. Pure, tested
// (msmWords.test.js). The publish preview has its own per site words (msmPlan.lineWords); these
// describe the draft itself: what the person changed in the group menu.

import { money2 } from '../../../supabase/functions/_shared/msmModel.js';
import { CHANNEL_LABELS } from './msmGrid.js';

const listOf = (v) => (Array.isArray(v) ? v : []);
const price = (v) => (v == null ? 'the group price' : money2(v));

const FIELD = {
  name: 'name', menu_name: 'menu name', receipt_name: 'receipt name', kitchen_name: 'kitchen name', description: 'description',
  category_id: 'category', extra_category_ids: 'extra categories', parent_product_id: 'size of', type: 'type',
  default_price: 'group price', default_channels: 'group channel prices', tax_rate_name: 'VAT', tax_rate_percent: 'VAT',
  allergens: 'allergens', tags: 'tags', image: 'photo', modifier_groups: 'modifier groups', visibility: 'where it shows',
  sold_alone: 'sold on its own', item_code: 'item code', archived: 'removed', sort_order: 'order', label: 'name',
  parent_id: 'under', route_like_id: 'prints like', icon: 'icon', color: 'colour', use_name_everywhere: 'name at every site',
};

/**
 * The words for one staged row.
 *   names   { products: Map(id -> name), categories: Map(id -> label), sites: Map(id -> name) }
 * Returns { subject, words }  ("Latte", "Station: price 3.40 to 3.60").
 */
export function changeWords(row, names = {}) {
  const pn = (id) => names.products?.get(id) || 'A product';
  const cn = (id) => names.categories?.get(id) || 'a category';
  const sn = (id) => names.sites?.get(id) || 'a site';
  const a = row?.after || {};
  const b = row?.before || {};
  if (row.target === 'product') {
    const subject = a.name || pn(row.entity_id);
    if (row.op === 'create') return { subject, words: `New product, group price ${money2(a.default_price)}${a.category_id ? `, in ${cn(a.category_id)}` : ''}${a.site_only_location_id ? `, ${sn(a.site_only_location_id)} only` : ''}` };
    if (row.op === 'remove' || (a.archived === true && Object.keys(a).length === 1)) return { subject, words: 'Removed from every site' };
    if (a.archived === false && Object.keys(a).length === 1) return { subject, words: 'Brought back' };
    const parts = [];
    for (const k of Object.keys(a)) {
      if (k === 'default_price') parts.push(`group price ${money2(b.default_price)} to ${money2(a.default_price)}`);
      else if (k === 'category_id') parts.push(`moved to ${cn(a.category_id)}`);
      else if (k === 'name' || k === 'menu_name') { if (!parts.some((x) => x.startsWith('renamed'))) parts.push(`renamed to ${a[k]}`); }
      else if (k === 'default_channels') {
        const ch = Object.keys(a.default_channels || {}).filter((c) => (a.default_channels || {})[c] !== (b.default_channels || {})?.[c]);
        parts.push(ch.length ? ch.map((c) => `${CHANNEL_LABELS[c] || c} group price to ${price(a.default_channels[c])}`).join(', ') : 'group channel prices');
      } else if (k === 'tax_rate_percent' || k === 'tax_rate_name') { if (!parts.includes('VAT changed')) parts.push('VAT changed'); }
      else parts.push(`${FIELD[k] || k.replace(/_/g, ' ')} changed`);
    }
    return { subject, words: parts.join(', ') || 'No change' };
  }
  if (row.target === 'product_site') {
    const subject = pn(row.entity_id);
    const site = sn(row.location_id);
    if (row.op === 'create') return { subject, words: `${site}: added${a.active === false ? ' (off)' : ''}${a.price != null ? ` at ${money2(a.price)}` : ''}` };
    const parts = [];
    if ('active' in a) parts.push(a.active ? 'turned on' : 'turned off');
    if ('price' in a) parts.push(`price ${price(b.price)} to ${price(a.price)}`);
    if ('channel_prices' in a) {
      const before = b.channel_prices || {};
      const after = a.channel_prices || {};
      const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => (before[k] ?? null) !== (after[k] ?? null));
      parts.push(keys.length ? keys.map((k) => `${CHANNEL_LABELS[k] || k} price ${price(before[k] ?? null)} to ${price(after[k] ?? null)}`).join(', ') : 'channel prices');
    }
    if ('kept' in a) {
      const gone = Object.keys(b.kept || {}).filter((k) => !Object.prototype.hasOwnProperty.call(a.kept || {}, k));
      parts.push(gone.length ? `uses the group's ${gone.map((k) => k.replace(/_/g, ' ')).join(', ')}` : 'keeps its own values');
    }
    return { subject, words: `${site}: ${parts.join(', ') || 'no change'}` };
  }
  if (row.target === 'category') {
    const subject = a.label || cn(row.entity_id);
    if (row.op === 'create') return { subject, words: `New category${a.parent_id ? ` under ${cn(a.parent_id)}` : ''}${a.route_like_id ? `, prints like ${cn(a.route_like_id)}` : ''}` };
    return { subject, words: Object.keys(a).map((k) => `${FIELD[k] || k} changed`).join(', ') };
  }
  if (row.target === 'menu') return { subject: 'Menu details', words: Object.keys(a).map((k) => `${FIELD[k] || k} changed`).join(', ') };
  if (row.target === 'menu_site') return { subject: sn(row.location_id), words: 'Joins the group menu' };
  return { subject: 'Change', words: '' };
}

/** Staged rows grouped for the panel: [{ key, subject, lines: [{ row, words }] }], newest group first. */
export function groupChanges(rows, names = {}) {
  const by = new Map();
  for (const r of listOf(rows)) {
    const key = r.target === 'product' || r.target === 'product_site' ? `p:${r.entity_id}` : `${r.target}:${r.entity_id}:${r.location_id || ''}`;
    const w = changeWords(r, names);
    if (!by.has(key)) by.set(key, { key, subject: w.subject, lines: [] });
    const g = by.get(key);
    if (r.target === 'product') g.subject = w.subject;
    g.lines.push({ row: r, words: w.words });
  }
  return [...by.values()];
}

/**
 * What taking back one staged row takes with it, in the order to remove them.
 *   A new product: its new sites first, then the product (a site row cannot point at a product
 *   that is not there). A new category that a staged product still uses: refused, in words.
 * Returns { rows } or { rows: [], words }.
 */
export function unstageOrder(rows, row, names = {}) {
  const all = listOf(rows);
  if (row.target === 'product' && row.op === 'create') {
    const sites = all.filter((r) => r.target === 'product_site' && r.entity_id === row.entity_id);
    return { rows: [...sites, row] };
  }
  if (row.target === 'category' && row.op === 'create') {
    const users = all.filter((r) => r.target === 'product' && (r.after?.category_id === row.entity_id || listOf(r.after?.extra_category_ids).includes(row.entity_id)));
    if (users.length) {
      const n = users.map((u) => u.after?.name || names.products?.get(u.entity_id) || 'a product').slice(0, 3).join(', ');
      return { rows: [], words: `${row.after?.label || 'This category'} is still used by ${n}. Move or take back ${users.length === 1 ? 'that product' : 'those products'} first.` };
    }
    const children = all.filter((r) => r.target === 'category' && r.after?.parent_id === row.entity_id);
    if (children.length) return { rows: [], words: `${row.after?.label || 'This category'} has a new category under it. Take that back first.` };
  }
  return { rows: [row] };
}
