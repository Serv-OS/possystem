// src/lib/msm/msmWords.js
//
// MULTI SITE MENU (v5.11.75): a staged change in plain words, for the Changes panel. Pure, tested
// (msmWords.test.js). The publish preview has its own per site words (msmPlan.lineWords); these
// describe the draft itself: what the person changed in the group menu.
//
// ROUND 2 (17 Oct 2026, the clarity pass, design section 2): this file is also THE word list. Every
// screen takes its words for codes from here (column names, order types, VAT keys, the names of
// things), so the screens agree and no raw code reaches a person who is not technical (Peter:
// "these people using this will not be techy people"). msmWords.test.js pins it.

import { money2, toPence, pctText, CHANNELS } from '../../../supabase/functions/_shared/msmModel.js';
import { CHANNEL_LABELS } from './msmGrid.js';

const listOf = (v) => (Array.isArray(v) ? v : []);
// A price that moves from or to "follows" in words (17 Oct verification: never "price the group
// price to 3.10"). blank is what a blank price uses.
const priceMove = (label, from, to, blank = 'the group price') => (from == null && to == null ? `${label}: ${blank}`
  : from == null ? `${label} set to ${money2(to)} (was ${blank})`
    : to == null ? `${label} back to ${blank} (was ${money2(from)})`
      : `${label} ${money2(from)} to ${money2(to)}`);
// What a blank order type price at a site uses (the till's chain, PRICE_TYPE_HELP).
const ORDER_TYPE_BLANK = { driveThru: 'the Takeaway price' };

// ── The word list (design section 2) ────────────────────────────────────────
// One word for each thing, everywhere. Never: central, head office, venue, set, staged, change set,
// site only extra, In store.
export const WORDS = Object.freeze({
  groupMenu: 'Group menu',
  productsTab: 'Products',
  site: 'Site',
  draft: 'Draft',
  scheduled: 'Scheduled push',
  published: 'Published version',
  turnedOff: 'Turned off',
  removed: 'Removed',
  standardPrice: 'Standard price',
  addToDraft: 'Add to draft',
  publish: 'Publish',
  schedule: 'Schedule',
  takeOut: 'Take out of draft',
  reviewAndPublish: 'Review and publish',
  optionGroup: 'Option group',
  option: 'Option',
  subItem: 'Sub item',
  soldAlone: 'Also sold on its own',
  servosId: 'ServOS ID (do not change)',
});

// One line helpers for the option group words (design 1.1).
export const HELP = Object.freeze({
  optionGroup: 'A question the till asks, for example Milk or Choose 3 donuts.',
  option: 'One answer, with its own price.',
  subItem: 'A product that is picked as an option, for example a donut in a box of 3. It has its own kitchen name and stock.',
  soldAlone: 'On: it is also a normal product on the till. Off: only ever an option.',
  mustChoose: 'On: the till will not move on until they pick.',
  quantity: 'Same choice more than once: for boxes, for example 3 donuts of any flavour.',
  thenAsk: 'After this option, ask another group, for example Syrup then Which syrup.',
  optionVat: "An option is taxed at its product's VAT, because it is part of the same sale.",
  groupName: 'What the till shows as the question.',
});

// The price keys a site's pricing holds, in words (design 5.2). null = the Standard price.
export const PRICE_TYPE_WORDS = Object.freeze({
  base: 'Standard price', dineIn: 'Eat in', takeaway: 'Takeaway', collection: 'Collection', delivery: 'Delivery', driveThru: 'Drive thru', bar: 'Bar tab',
});
/** "Standard price" for null, "Eat in" for dineIn, never the code itself. */
export const priceTypeWord = (ch) => (ch ? PRICE_TYPE_WORDS[ch] || 'Another order type' : PRICE_TYPE_WORDS.base);

// Where each order type price is used, and what a blank falls back to (the till's own chain,
// lib/menuPricing.js resolveItemPrice and msmModel.channelFallback; design 5.2).
export const PRICE_TYPE_HELP = Object.freeze({
  base: 'Used when nothing else is set.',
  dineIn: 'Till eat in, QR and kiosk eat in. Blank uses the Standard price.',
  takeaway: 'Till and kiosk takeaway. Blank uses the Standard price.',
  collection: 'Till Collect, online collection and ezCater takeout. Blank uses the Standard price, not Takeaway. Its VAT follows Takeaway.',
  delivery: 'Online delivery and the HubRise catalogue. Blank uses the Standard price.',
  driveThru: 'Drive thru. Blank uses the Takeaway price.',
});

// VAT by order type keys (menu_items.tax_overrides) in words.
export const TAX_TYPE_WORDS = Object.freeze({ 'dine-in': 'Eat in', takeaway: 'Takeaway', delivery: 'Delivery', bar: 'Bar tab' });
export const TAX_TYPE_HELP = Object.freeze({
  'dine-in': 'Till eat in, QR, kiosk eat in.',
  takeaway: 'Also used for Collection and Drive thru.',
  delivery: 'Online delivery and delivery partners.',
  bar: 'Bar tabs.',
});

// A site's own column names in words (one map for the product sheet, the preview and the grid).
export const COL_WORDS = Object.freeze({
  cat: 'category', cats: 'extra categories', image: 'photo', name: 'name', menu_name: 'menu name', receipt_name: 'receipt name',
  kitchen_name: 'kitchen name', description: 'description', tax_rate_id: 'VAT rate', allergens: 'allergens', tags: 'tags',
  visibility: 'where it shows', sold_alone: 'sold on its own', item_code: 'item code', assigned_modifier_groups: 'option groups',
  type: 'type', parent_id: 'size of', tax_overrides: 'VAT by order type', label: 'name', sort_order: 'order',
  min: 'choose at least', max: 'choose up to', selection_type: 'kind of choice', item_link: 'sub item link', sub_group: 'Then ask',
  // 17 Oct recheck: a site whose row has no Standard price keeps none (said as "No price at <site>").
  no_price: 'no price',
});
/** A column in words, never the column itself ("its own setting" when the map has none). */
export const colWord = (k) => COL_WORDS[k] || 'its own setting';

const KIND_WORDS = { simple: 'a simple product', modifiable: 'a product with options', variants: 'a product with sizes', subitem: 'a sub item' };
/**
 * A value a site keeps as its own, in words (17 Oct verification: never a VAT rate id, true or
 * false, a type code or a web address).
 *   col     the venue column
 *   v       the kept value
 *   opts    { rates: that site's tax_rates rows, names: { venue id: name } }
 */
export function keptValueWords(col, v, opts = {}) {
  if (col === 'tax_rate_id') {
    if (v == null || v === '') return 'no VAT rate';
    const r = listOf(opts.rates).find((x) => x && String(x.id) === String(v));
    return r ? `${r.name || 'VAT'} ${pctText(r.rate)}` : 'a VAT rate of its own';
  }
  if (col === 'image') return v ? 'its own photo' : 'no photo';
  if (col === 'type') return KIND_WORDS[v] || 'its own kind of product';
  if (col === 'parent_id') return v ? (opts.names?.[v] ? `a size of ${opts.names[v]}` : 'its own') : 'not a size';
  if (col === 'cat') return v ? (opts.names?.[v] || 'its own category') : 'no category';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (v == null || v === '') return 'blank';
  if (Array.isArray(v)) return v.length ? `${v.length} set` : 'none';
  if (typeof v === 'object') return Object.keys(v).length ? 'its own' : 'none';
  if (typeof v === 'number') return String(v);
  const t = String(v);
  if (/^https?:\/\//.test(t)) return 'its own';
  return t.length > 40 ? `${t.slice(0, 40)}...` : t;
}

// The kinds of choice an option group asks (modifier_groups.selection_type).
export const CHOICE_WORDS = Object.freeze({ single: 'One choice', multiple: 'Several choices', quantity: 'Same choice more than once' });

const FIELD = {
  name: 'name', menu_name: 'menu name', receipt_name: 'receipt name', kitchen_name: 'kitchen name', description: 'description',
  category_id: 'category', extra_category_ids: 'extra categories', parent_product_id: 'size of', type: 'type',
  default_price: 'group price', default_channels: 'order type prices', tax_rate_name: 'VAT', tax_rate_percent: 'VAT',
  allergens: 'allergens', tags: 'tags', image: 'photo', modifier_groups: 'option groups', visibility: 'where it shows',
  sold_alone: 'sold on its own', item_code: 'item code', archived: 'removed', sort_order: 'order', label: 'name',
  parent_id: 'under', route_like_id: 'prints like', icon: 'icon', color: 'colour', use_name_everywhere: 'name at every site',
  tax_by_type: 'VAT by order type', min: 'rule', max: 'rule', selection_type: 'kind of choice', group_id: 'option group',
  price: 'price', product_id: 'sub item', sub_group_id: 'Then ask',
};
export const fieldWord = (k) => FIELD[k] || 'a setting';

/** "Choose exactly 1", "Choose up to 3", "Choose between 1 and 3", "Choose as many as they like". */
export function ruleSentence(min, max) {
  const a = Math.max(0, Number(min) || 0);
  const b = Math.max(0, Number(max) || 0);
  if (b >= 99 && a === 0) return 'Choose as many as they like';
  if (b >= 99) return `Choose at least ${a}`;
  if (a === b) return `Choose exactly ${a}`;
  if (a === 0) return `Choose up to ${b}`;
  return `Choose between ${a} and ${b}`;
}

/**
 * The words for one staged row.
 *   names   { products: Map(id -> name), categories: Map(id -> label), sites: Map(id -> name),
 *             groups: Map(id -> name), options: Map(id -> name), optionGroup: Map(optionId -> groupId) }
 * Returns { subject, words }  ("Latte", "Station: price 3.40 to 3.60").
 */
export function changeWords(row, names = {}) {
  const pn = (id) => names.products?.get(id) || 'A product';
  const cn = (id) => names.categories?.get(id) || 'a category';
  const sn = (id) => names.sites?.get(id) || 'a site';
  const gn = (id) => names.groups?.get(id) || 'An option group';
  const on = (id) => names.options?.get(id) || 'An option';
  const a = row?.after || {};
  const b = row?.before || {};
  if (row.target === 'product') {
    const subject = a.name || pn(row.entity_id);
    if (row.op === 'create' && a.type === 'subitem' && a.sold_alone !== true) return { subject, words: 'New sub item, only used as an option' };
    if (row.op === 'create') return { subject, words: `New ${a.type === 'subitem' ? 'sub item, also sold on its own' : 'product'}, group price ${money2(a.default_price)}${a.category_id ? `, in ${cn(a.category_id)}` : ''}${a.image ? ', with a photo' : ''}` };
    if (row.op === 'remove' || (a.archived === true && Object.keys(a).length === 1)) return { subject, words: 'Removed from every site' };
    if (a.archived === false && Object.keys(a).length === 1) return { subject, words: 'Brought back' };
    const parts = [];
    for (const k of Object.keys(a)) {
      if (k === 'site_only_location_id') { parts.push('now sold at more than one site'); continue; }
      if (k === 'default_price') parts.push(`group price ${money2(b.default_price)} to ${money2(a.default_price)}`);
      else if (k === 'category_id') parts.push(`moved to ${cn(a.category_id)}`);
      else if (k === 'name' || k === 'menu_name') { if (!parts.some((x) => x.startsWith('renamed'))) parts.push(`renamed to ${a[k]}`); }
      else if (k === 'default_channels') {
        // Only the order types the till charges, compared as money (a blank and a missing key are
        // the same: 17 Oct verification, "Delivery group price to the group price").
        const ac = a.default_channels || {}, bc = b.default_channels || {};
        const ch = CHANNELS.filter((c) => toPence(ac[c]) !== toPence(bc[c]));
        if (ch.length) parts.push(ch.map((c) => (ac[c] == null ? `${CHANNEL_LABELS[c] || 'Order type'} goes back to the Standard price` : `${CHANNEL_LABELS[c] || 'Order type'} group price to ${money2(ac[c])}`)).join(', '));
      } else if (k === 'tax_rate_percent' || k === 'tax_rate_name') { if (!parts.includes('VAT changed')) parts.push('VAT changed'); }
      else if (k === 'tax_by_type') {
        const bt = b.tax_by_type || {}, at = a.tax_by_type || {};
        const keys = Object.keys(TAX_TYPE_WORDS).filter((t) => JSON.stringify(bt[t] ?? null) !== JSON.stringify(at[t] ?? null));
        parts.push(keys.length ? keys.map((t) => `${TAX_TYPE_WORDS[t]} VAT ${at[t] ? `to ${at[t].name || pctText(at[t].percent)}` : "back to the product's VAT"}`).join(', ') : 'VAT by order type changed');
      } else if (k === 'sold_alone') parts.push(a.sold_alone ? 'now also sold on its own' : 'now only used as an option');
      else if (k === 'type') parts.push(a.type === 'subitem' ? 'now a sub item' : 'now a product');
      else if (k === 'modifier_groups') {
        const was = new Set(listOf(b.modifier_groups).map((x) => (typeof x === 'string' ? x : x?.groupId)));
        const now = new Set(listOf(a.modifier_groups).map((x) => (typeof x === 'string' ? x : x?.groupId)));
        const add = [...now].filter((x) => x && !was.has(x)).map(gn);
        const off = [...was].filter((x) => x && !now.has(x)).map(gn);
        if (add.length) parts.push(`${add.join(', ')} added`);
        if (off.length) parts.push(`${off.join(', ')} taken off`);
        if (!add.length && !off.length) parts.push('option groups in a new order');
      } else parts.push(`${fieldWord(k)} changed`);
    }
    return { subject, words: parts.join(', ') || 'No change' };
  }
  if (row.target === 'product_site') {
    const subject = pn(row.entity_id);
    const site = sn(row.location_id);
    if (row.op === 'create') return { subject, words: `${site}: added${a.active === false ? ' (off)' : ''}${a.price != null ? ` at ${money2(a.price)}` : ''}` };
    const parts = [];
    if ('active' in a) parts.push(a.active ? 'turned on' : 'turned off');
    if ('price' in a) parts.push(priceMove('price', b.price ?? null, a.price ?? null));
    if ('channel_prices' in a) {
      const before = b.channel_prices || {};
      const after = a.channel_prices || {};
      const keys = CHANNELS.filter((k) => toPence(before[k]) !== toPence(after[k]));
      if (keys.length) parts.push(keys.map((k) => priceMove(`${CHANNEL_LABELS[k] || 'Order type'} price`, before[k] ?? null, after[k] ?? null, ORDER_TYPE_BLANK[k] || 'the Standard price')).join(', '));
    }
    if ('kept' in a) {
      const gone = Object.keys(b.kept || {}).filter((k) => !Object.prototype.hasOwnProperty.call(a.kept || {}, k));
      parts.push(gone.length ? `uses the group's ${gone.map(colWord).join(', ')}` : 'keeps its own values');
    }
    return { subject, words: `${site}: ${parts.join(', ') || 'no change'}` };
  }
  if (row.target === 'category') {
    const subject = a.label || cn(row.entity_id);
    if (row.op === 'create') return { subject, words: `New category${a.parent_id ? ` under ${cn(a.parent_id)}` : ''}${a.route_like_id ? `, prints like ${cn(a.route_like_id)}` : ''}` };
    return { subject, words: Object.keys(a).map((k) => `${fieldWord(k)} changed`).join(', ') };
  }
  if (row.target === 'menu') return { subject: 'Menu details', words: Object.keys(a).map((k) => `${fieldWord(k)} changed`).join(', ') };
  if (row.target === 'menu_site') return { subject: sn(row.location_id), words: 'Joins the group menu' };
  // Round 2: option groups and options.
  if (row.target === 'modifier_group') {
    const subject = a.name || gn(row.entity_id);
    if (row.op === 'create') return { subject, words: `New option group: ${ruleSentence(a.min, a.max)}` };
    if (row.op === 'remove' || (a.archived === true && Object.keys(a).length === 1)) return { subject, words: 'Removed: taken off every product (nothing is deleted)' };
    const parts = [];
    if ('name' in a) parts.push(`renamed to ${a.name}`);
    if ('min' in a || 'max' in a) parts.push(`now: ${ruleSentence(a.min ?? b.min, a.max ?? b.max)}`);
    if ('selection_type' in a) parts.push(`now ${String(CHOICE_WORDS[a.selection_type] || 'another kind of choice').toLowerCase()}`);
    if ('archived' in a && a.archived === false) parts.push('brought back');
    if ('sort_order' in a) parts.push('moved in the list');
    return { subject, words: parts.join(', ') || 'changed' };
  }
  if (row.target === 'modifier_group_site') {
    const subject = gn(row.entity_id);
    if (row.op === 'create') return { subject, words: `${sn(row.location_id)}: added there` };
    const gone = Object.keys(b.kept || {}).filter((k) => !Object.prototype.hasOwnProperty.call(a.kept || {}, k));
    return { subject, words: `${sn(row.location_id)}: ${gone.length ? `uses the group's ${gone.map(colWord).join(', ')}` : 'keeps its own rule'}` };
  }
  if (row.target === 'modifier_option') {
    const subject = a.name || on(row.entity_id);
    if (row.op === 'create') return { subject, words: `New option in ${gn(a.group_id)}, ${money2(a.price)}${a.product_id ? ' (a sub item)' : ''}` };
    if (row.op === 'remove' || (a.archived === true && Object.keys(a).length === 1)) return { subject, words: 'Taken out of its group at every site' };
    const parts = [];
    if ('price' in a) parts.push(`price ${money2(b.price)} to ${money2(a.price)} at every site that follows it`);
    if ('name' in a) parts.push(`renamed to ${a.name}`);
    if ('product_id' in a) parts.push(a.product_id ? 'linked to a sub item' : 'no longer a sub item');
    if ('sub_group_id' in a) parts.push(a.sub_group_id ? `then asks ${gn(a.sub_group_id)}` : 'no longer asks another group');
    if ('sort_order' in a) parts.push('moved in the list');
    if ('archived' in a && a.archived === false) parts.push('brought back');
    return { subject, words: parts.join(', ') || 'changed' };
  }
  if (row.target === 'modifier_option_site') {
    const subject = on(row.entity_id);
    const site = sn(row.location_id);
    if (row.op === 'create') return { subject, words: `${site}: ${a.active === false ? 'off' : 'on'}${a.price != null ? ` at ${money2(a.price)}` : ''}` };
    const parts = [];
    if ('active' in a) parts.push(a.active ? 'turned on' : 'turned off');
    if ('price' in a) parts.push(priceMove('price', b.price ?? null, a.price ?? null));
    if ('kept' in a) {
      const gone = Object.keys(b.kept || {}).filter((k) => !Object.prototype.hasOwnProperty.call(a.kept || {}, k));
      parts.push(gone.length ? `uses the group's ${gone.map(colWord).join(', ')}` : 'keeps its own');
    }
    return { subject, words: `${site}: ${parts.join(', ') || 'no change'}` };
  }
  return { subject: 'Change', words: '' };
}

/** Staged rows grouped for the panel: [{ key, subject, lines: [{ row, words }] }], newest group first. */
export function groupChanges(rows, names = {}) {
  const by = new Map();
  for (const r of listOf(rows)) {
    const gid = r.target === 'modifier_option' ? (r.after?.group_id || names.optionGroup?.get(r.entity_id))
      : r.target === 'modifier_option_site' ? names.optionGroup?.get(r.entity_id) : null;
    const key = r.target === 'product' || r.target === 'product_site' ? `p:${r.entity_id}`
      : r.target === 'modifier_group' || r.target === 'modifier_group_site' ? `g:${r.entity_id}`
        : gid ? `g:${gid}` : `${r.target}:${r.entity_id}:${r.location_id || ''}`;
    const w = changeWords(r, names);
    const groupSubject = key.startsWith('g:') ? (names.groups?.get(key.slice(2)) || (r.target === 'modifier_group' ? w.subject : 'An option group')) : w.subject;
    if (!by.has(key)) by.set(key, { key, subject: groupSubject, kind: key.startsWith('g:') ? 'group' : 'product', lines: [] });
    const g = by.get(key);
    if (r.target === 'product' || r.target === 'modifier_group') g.subject = w.subject;
    // Inside a group, an option's line says which option.
    if (r.target === 'modifier_option' || r.target === 'modifier_option_site') { g.lines.push({ row: r, words: `${w.subject}: ${w.words}` }); continue; }
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
    const users = all.filter((r) => r.target === 'modifier_option' && r.after?.product_id === row.entity_id);
    if (users.length) return { rows: [], words: `${row.after?.name || 'This sub item'} is an option in this draft (${users.map((u) => u.after?.name || 'an option').slice(0, 2).join(', ')}). Take that option out first.` };
    const sites = all.filter((r) => r.target === 'product_site' && r.entity_id === row.entity_id);
    return { rows: [...sites, row] };
  }
  if (row.target === 'modifier_option' && row.op === 'create') {
    const sites = all.filter((r) => r.target === 'modifier_option_site' && r.entity_id === row.entity_id);
    return { rows: [...sites, row] };
  }
  if (row.target === 'modifier_group' && row.op === 'create') {
    const gid = row.entity_id;
    const usedBy = all.filter((r) => r.target === 'product' && listOf(r.after?.modifier_groups).some((x) => (typeof x === 'string' ? x : x?.groupId) === gid));
    const asks = all.filter((r) => r.target === 'modifier_option' && r.after?.sub_group_id === gid);
    if (usedBy.length || asks.length) {
      return { rows: [], words: `${row.after?.name || 'This option group'} is ${usedBy.length ? `on ${usedBy.length} product${usedBy.length === 1 ? '' : 's'}` : 'asked by another option'} in this draft. Take ${usedBy.length === 1 || (!usedBy.length && asks.length === 1) ? 'that' : 'those'} out first.` };
    }
    const opts = all.filter((r) => r.target === 'modifier_option' && r.op === 'create' && r.after?.group_id === gid);
    const optIds = new Set(opts.map((o) => o.entity_id));
    const optSites = all.filter((r) => r.target === 'modifier_option_site' && optIds.has(r.entity_id));
    const groupSites = all.filter((r) => r.target === 'modifier_group_site' && r.entity_id === gid);
    return { rows: [...optSites, ...opts, ...groupSites, row] };
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
