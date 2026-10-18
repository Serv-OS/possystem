// src/lib/msm/msmSummary.js
//
// MULTI SITE MENU, ROUND 2 (17 Oct 2026, v5.11.75): a list of staged changes as SENTENCES, shown
// before "Add to draft" and before "Publish" (design 6.4, "these people will not be techy"). Pure,
// tested (msmSummary.test.js). Grouped by what and where:
//   "12 prices go up at Leeds and Huddersfield from Mon 20 Oct 06:00."
//   "Oat milk goes from 0.50 to 0.60 in Milk options at every site."
//   "Latte is turned off at Barnsley."
//   "Galaxy donut: takeaway VAT becomes Zero Rate at every site."

import { money2, toPence, has, PUBLISHED_CHANNELS } from '../../../supabase/functions/_shared/msmModel.js';
import { isOptionOnlyItem } from '../menuRules.js';
import { fieldWord, colWord, PRICE_TYPE_WORDS, CHOICE_WORDS } from './msmWords.js';

const listOf = (v) => (Array.isArray(v) ? v : []);
const TAX_WORDS = { 'dine-in': 'eat in', takeaway: 'takeaway', delivery: 'delivery', bar: 'bar tab' };
// Fields a sentence above already covers, per target (the rest get one plain line each change, so
// every change has a sentence before Add to draft and Publish: design 6.4, round 2 review).
const COVERED = {
  product: ['default_price', 'tax_by_type', 'tax_rate_name', 'tax_rate_percent', 'modifier_groups', 'default_channels', 'archived', 'sort_order', 'family_base', 'site_only_location_id'],
  product_site: ['price', 'active', 'channel_prices', 'kept', 'venue_item_id'],
  modifier_group: ['min', 'max', 'archived', 'name', 'selection_type', 'sort_order', 'family_base'],
  modifier_option: ['price', 'archived', 'name', 'sort_order', 'group_id'],
  modifier_option_site: ['price', 'active', 'kept', 'venue_option_id'],
  modifier_group_site: ['kept', 'venue_group_id'],
};
const andList = (xs) => (xs.length <= 1 ? (xs[0] || '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** "Leeds", "Leeds and Huddersfield", "Leeds, Huddersfield and 2 more". */
export function siteList(names) {
  const n = [...new Set(listOf(names).filter(Boolean))];
  if (!n.length) return 'no site';
  if (n.length === 1) return n[0];
  if (n.length <= 3) return `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
  return `${n.slice(0, 2).join(', ')} and ${n.length - 2} more`;
}
const nameList = (xs) => (xs.length <= 3 ? siteList(xs) : `${xs.slice(0, 2).join(', ')} and ${xs.length - 2} more`);

/**
 * The sentences for a set of changes.
 *   changes  msm_changes rows (with before)
 *   central  the live central menu (names, defaults)
 *   opts     { siteNames: Map|object loc -> name, when: 'Mon 20 Oct 06:00' (a schedule) or null }
 * Returns [sentence].
 */
export function summarise(changes, central, opts = {}) {
  const C = central || {};
  const siteName = (loc) => (opts.siteNames instanceof Map ? opts.siteNames.get(loc) : opts.siteNames?.[loc]) || 'a site';
  const allSites = listOf(C.sites).length;
  const product = new Map(listOf(C.products).map((p) => [p.id, p]));
  const option = new Map(listOf(C.options).map((o) => [o.id, o]));
  const group = new Map(listOf(C.groups).map((g) => [g.id, g]));
  for (const ch of listOf(changes)) {
    if (ch.op === 'create' && ch.target === 'product') product.set(ch.entity_id, { id: ch.entity_id, ...(ch.after || {}) });
    if (ch.op === 'create' && ch.target === 'modifier_option') option.set(ch.entity_id, { id: ch.entity_id, ...(ch.after || {}) });
    if (ch.op === 'create' && ch.target === 'modifier_group') group.set(ch.entity_id, { id: ch.entity_id, ...(ch.after || {}) });
  }
  const pName = (id) => product.get(id)?.menu_name || product.get(id)?.name || 'A product';
  const when = opts.when ? ` from ${opts.when}` : '';
  const out = [];

  // Prices: up and down, every site (the group price) or the sites named.
  const ups = new Map(), downs = new Map();          // where -> count
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const newProducts = [], newSubs = [], removed = [], back = [], groupOffs = [];
  const offAt = new Map(), onAt = new Map();          // loc -> [names]
  const reordered = new Set();
  const siteRows = new Map();                          // "Oat milk is turned on in Milk" -> [site names]
  const createdOptions = new Set(listOf(changes).filter((c) => c.target === 'modifier_option' && c.op === 'create').map((c) => c.entity_id));
  const cats = new Map(listOf(C.categories).map((c) => [c.id, c]));
  for (const ch of listOf(changes)) {
    const a = ch.after || {}, b = ch.before || {};
    if (ch.target === 'product' && ch.op === 'create') { (isOptionOnlyItem(a) ? newSubs : newProducts).push(a.name || 'A product'); continue; }
    if (ch.target === 'product' && (ch.op === 'remove' || (a.archived === true && Object.keys(a).length === 1))) { removed.push(pName(ch.entity_id)); continue; }
    if (ch.target === 'product' && a.archived === false && Object.keys(a).length === 1) { back.push(pName(ch.entity_id)); continue; }
    if (ch.target === 'product' && 'default_price' in a && b.default_price != null) {
      const d = toPence(a.default_price) - toPence(b.default_price);
      if (d > 0) bump(ups, '*'); else if (d < 0) bump(downs, '*');
    }
    if (ch.target === 'product_site' && 'price' in a) {
      const p = product.get(ch.entity_id);
      const was = b.price ?? p?.default_price, now = a.price ?? p?.default_price;
      const d = toPence(now) - toPence(was);
      if (d > 0) bump(ups, ch.location_id); else if (d < 0) bump(downs, ch.location_id);
    }
    if (ch.target === 'product_site' && 'active' in a) {
      const m = a.active ? onAt : offAt;
      if (!m.has(ch.location_id)) m.set(ch.location_id, []);
      m.get(ch.location_id).push(pName(ch.entity_id));
    }
    if (ch.target === 'product' && 'tax_by_type' in a) {
      const before = b.tax_by_type || {}, after = a.tax_by_type || {};
      for (const k of Object.keys(TAX_WORDS)) {
        const x = before[k], y = after[k];
        if (JSON.stringify(x ?? null) === JSON.stringify(y ?? null)) continue;
        out.push(`${pName(ch.entity_id)}: ${TAX_WORDS[k]} VAT ${y ? `becomes ${y.name}` : "goes back to the product's own VAT"} at every site.`);
      }
    }
    if (ch.target === 'product' && ('tax_rate_name' in a || 'tax_rate_percent' in a)) {
      out.push(`${pName(ch.entity_id)}: VAT becomes ${a.tax_rate_name ?? 'another rate'}${a.tax_rate_percent != null ? ` (${Number(a.tax_rate_percent)}%)` : ''} at every site.`);
    }
    // Options.
    if (ch.target === 'modifier_option' && 'price' in a && ch.op !== 'create') {
      const o = option.get(ch.entity_id);
      out.push(`${o?.name || 'An option'} goes from ${money2(b.price ?? o?.price)} to ${money2(a.price)} in ${group.get(o?.group_id)?.name || 'its option group'} at every site${when}.`);
    }
    if (ch.target === 'modifier_option_site' && 'price' in a && ch.op !== 'create') {
      const o = option.get(ch.entity_id);
      out.push(`${o?.name || 'An option'} goes from ${money2(b.price ?? o?.price)} to ${money2(a.price ?? o?.price)} in ${group.get(o?.group_id)?.name || 'its option group'} at ${siteName(ch.location_id)}${when}.`);
    }
    if (ch.target === 'modifier_option_site' && 'active' in a && ch.op !== 'create') {
      const o = option.get(ch.entity_id);
      out.push(`${o?.name || 'An option'} is turned ${a.active ? 'on' : 'off'} in ${group.get(o?.group_id)?.name || 'its option group'} at ${siteName(ch.location_id)}.`);
    }
    if (ch.target === 'modifier_option' && ch.op === 'create') {
      out.push(`${a.name || 'An option'} (${money2(a.price)}) is added to ${group.get(a.group_id)?.name || 'an option group'}.`);
    }
    if (ch.target === 'modifier_option' && (ch.op === 'remove' || a.archived === true)) {
      const o = option.get(ch.entity_id);
      out.push(`${o?.name || 'An option'} is taken out of ${group.get(o?.group_id)?.name || 'its option group'} at every site.`);
    }
    if (ch.target === 'modifier_group' && ch.op === 'create') out.push(`New option group: ${a.name || 'Options'}.`);
    if (ch.target === 'modifier_group' && (ch.op === 'remove' || a.archived === true)) out.push(`${group.get(ch.entity_id)?.name || 'An option group'} is taken off every product.`);
    if (ch.target === 'modifier_group' && ch.op === 'update' && ('min' in a || 'max' in a)) {
      const g = group.get(ch.entity_id) || {};
      const min = a.min ?? g.min ?? 0, max = a.max ?? g.max ?? 1;
      out.push(`${g.name || 'An option group'}: customers ${Number(min) > 0 ? 'must' : 'can'} choose ${min === max ? `exactly ${max}` : Number(max) >= 99 ? 'as many as they like' : `up to ${max}`}.`);
    }
    if (ch.target === 'product' && 'modifier_groups' in a && ch.op === 'update') {
      const gid = (x) => (typeof x === 'string' ? x : x?.groupId);
      const was = new Set(listOf(b.modifier_groups).map(gid));
      const now = new Set(listOf(a.modifier_groups).map(gid));
      for (const id of now) if (id && !was.has(id)) bump(ups, `group:${id}`);
      for (const id of was) if (id && !now.has(id)) groupOffs.push(`${group.get(id)?.name || 'An option group'} is taken off ${pName(ch.entity_id)} at every site.`);
    }
    // Order type prices: the group's, and a site's own.
    if (ch.target === 'product' && 'default_channels' in a && ch.op !== 'create') {
      const was = b.default_channels || {}, now = a.default_channels || {};
      for (const k of PUBLISHED_CHANNELS) {
        if (toPence(was[k]) === toPence(now[k])) continue;
        out.push(now[k] == null
          ? `${pName(ch.entity_id)}: ${PRICE_TYPE_WORDS[k]} price goes back to the Standard price at every site that follows it${when}.`
          : `${pName(ch.entity_id)}: ${PRICE_TYPE_WORDS[k]} price becomes ${money2(now[k])} at every site that follows it${when}.`);
      }
    }
    if (ch.target === 'product_site' && 'channel_prices' in a) {
      const was = b.channel_prices || {}, now = a.channel_prices || {};
      for (const k of PUBLISHED_CHANNELS) {
        if (toPence(was[k]) === toPence(now[k])) continue;
        out.push(now[k] == null
          ? `${pName(ch.entity_id)}: ${PRICE_TYPE_WORDS[k]} price at ${siteName(ch.location_id)} follows the group again${when}.`
          : `${pName(ch.entity_id)}: ${PRICE_TYPE_WORDS[k]} price becomes ${money2(now[k])} at ${siteName(ch.location_id)}${when}.`);
      }
    }
    if (ch.target === 'product' && 'default_price' in a && ch.op !== 'create' && b.default_price == null) {
      out.push(`${pName(ch.entity_id)}: group price becomes ${money2(a.default_price)}${when}.`);
    }
    // A site's own settings given back or kept.
    if ((ch.target === 'product_site' || ch.target === 'modifier_group_site' || ch.target === 'modifier_option_site') && 'kept' in a && ch.op !== 'create') {
      const kb = b.kept || {}, ka = a.kept || {};
      const gone = Object.keys(kb).filter((k) => !has(ka, k));
      const added = Object.keys(ka).filter((k) => !has(kb, k) || JSON.stringify(ka[k]) !== JSON.stringify(kb[k]));
      if (kb.tax_overrides && ka.tax_overrides && JSON.stringify(kb.tax_overrides) !== JSON.stringify(ka.tax_overrides) && !added.includes('tax_overrides')) added.push('tax_overrides');
      const o = ch.target === 'modifier_option_site' ? option.get(ch.entity_id) : null;
      const what = ch.target === 'product_site' ? pName(ch.entity_id)
        : ch.target === 'modifier_group_site' ? (group.get(ch.entity_id)?.name || 'an option group')
          : `${o?.name || 'an option'} in ${group.get(o?.group_id)?.name || 'its option group'}`;
      if (gone.length) out.push(`${siteName(ch.location_id)} uses the group's ${andList(gone.map(colWord))} for ${what}.`);
      if (added.length) out.push(`${siteName(ch.location_id)} keeps its own ${andList(added.map(colWord))} for ${what}.`);
    }
    // Option groups: a rename, the kind of choice, options renamed or moved, sub item and Then ask.
    if (ch.target === 'modifier_group' && ch.op === 'update' && 'name' in a) out.push(`${b.name || group.get(ch.entity_id)?.name || 'An option group'} is renamed ${a.name}.`);
    if (ch.target === 'modifier_group' && ch.op === 'update' && 'selection_type' in a) out.push(`${a.name || group.get(ch.entity_id)?.name || 'An option group'}: ${CHOICE_WORDS[a.selection_type] || 'the kind of choice changes'}.`);
    if (ch.target === 'modifier_option' && ch.op === 'update' && 'name' in a) {
      const o = option.get(ch.entity_id);
      out.push(`${b.name || o?.name || 'An option'} is renamed ${a.name} in ${group.get(o?.group_id)?.name || 'its option group'}.`);
    }
    if (ch.target === 'modifier_option' && ch.op === 'update' && 'sort_order' in a) {
      const o = option.get(ch.entity_id);
      reordered.add(group.get(o?.group_id)?.name || 'An option group');
    }
    if (ch.target === 'modifier_option_site' && ch.op === 'create' && !createdOptions.has(ch.entity_id)) {
      const o = option.get(ch.entity_id);
      const k = `${o?.name || 'An option'} is turned ${a.active === false ? 'off' : 'on'} in ${group.get(o?.group_id)?.name || 'its option group'}`;
      if (!siteRows.has(k)) siteRows.set(k, []);
      siteRows.get(k).push(siteName(ch.location_id));
    }
    // Everything else: one plain line, so no change goes without a sentence.
    if (COVERED[ch.target] && !(ch.op === 'create' && ['product', 'modifier_group', 'modifier_option', 'product_site', 'modifier_option_site'].includes(ch.target))) {
      const rest = Object.keys(a).filter((k) => !COVERED[ch.target].includes(k));
      if (rest.length) {
        const words = [...new Set(rest.map(fieldWord))];
        const who = ch.target.startsWith('modifier_group') ? (group.get(ch.entity_id)?.name || 'An option group')
          : ch.target.startsWith('modifier_option') ? (option.get(ch.entity_id)?.name || 'An option') : pName(ch.entity_id);
        const where = ch.location_id ? `at ${siteName(ch.location_id)}` : 'at every site';
        out.push(`${who}: ${andList(words)} ${words.length === 1 && !/s$/.test(words[0]) ? 'changes' : 'change'} ${where}${when}.`);
      }
    }
    if (ch.target === 'category') {
      const label = a.label || cats.get(ch.entity_id)?.label || 'A category';
      if (ch.op === 'create') out.push(`New category: ${label}.`);
      else if (a.archived === true) out.push(`${label} comes off the menu at every site (nothing is deleted).`);
      else if (a.archived === false) out.push(`${label} comes back on the menu.`);
      else { const words = [...new Set(Object.keys(a).map(fieldWord))]; out.push(`Category ${label}: ${andList(words)} change${words.length === 1 && !/s$/.test(words[0]) ? 's' : ''} at every site.`); }
    }
    if (ch.target === 'menu') out.push(`The menu's ${andList([...new Set(Object.keys(a).map(fieldWord))])} change${Object.keys(a).length === 1 ? 's' : ''}.`);
    if (ch.target === 'menu_site' && ch.op === 'create') out.push(`${siteName(ch.location_id)} is added to the group menu.`);
  }
  const where = (k) => (k === '*' ? (allSites > 1 ? 'every site' : 'the site') : siteName(k));
  const priceLine = (m, word) => {
    const bySites = new Map();
    for (const [k, n] of m) { if (String(k).startsWith('group:')) continue; bySites.set(k, n); }
    if (!bySites.size) return;
    const every = bySites.get('*') || 0;
    const sites = [...bySites.keys()].filter((k) => k !== '*');
    const siteN = sites.reduce((s, k) => s + bySites.get(k), 0);
    if (every) out.unshift(`${every} group price${every === 1 ? '' : 's'} go${every === 1 ? 'es' : ''} ${word} at every site that follows it${when}.`);
    if (siteN) out.unshift(`${siteN} price${siteN === 1 ? '' : 's'} go${siteN === 1 ? 'es' : ''} ${word} at ${siteList(sites.map(where))}${when}.`);
  };
  priceLine(downs, 'down');
  priceLine(ups, 'up');
  // Groups put on products.
  const groupAdds = new Map();
  for (const [k, n] of ups) if (String(k).startsWith('group:')) groupAdds.set(k.slice(6), n);
  for (const [gid, n] of groupAdds) out.push(`${group.get(gid)?.name || 'An option group'} added to ${n} product${n === 1 ? '' : 's'} at every site.`);
  if (newProducts.length) out.push(`${newProducts.length} new product${newProducts.length === 1 ? '' : 's'}: ${nameList(newProducts)}.`);
  if (newSubs.length) out.push(`${newSubs.length} new sub item${newSubs.length === 1 ? '' : 's'} (only used as options): ${nameList(newSubs)}.`);
  for (const [loc, names] of offAt) out.push(names.length === 1 ? `${names[0]} is turned off at ${siteName(loc)}.` : `${names.length} products are turned off at ${siteName(loc)}: ${nameList(names)}.`);
  for (const [loc, names] of onAt) out.push(names.length === 1 ? `${names[0]} is turned on at ${siteName(loc)}.` : `${names.length} products are turned on at ${siteName(loc)}: ${nameList(names)}.`);
  if (removed.length) out.push(`${nameList(removed)} ${removed.length === 1 ? 'is' : 'are'} taken off every site (nothing is deleted).`);
  if (back.length) out.push(`${nameList(back)} ${back.length === 1 ? 'comes' : 'come'} back.`);
  out.push(...groupOffs);
  for (const g of reordered) out.push(`${g}: its options are put in a new order.`);
  for (const [k, sites] of siteRows) out.push(`${k} at ${siteList(sites)}.`);
  return [...new Set(out)];
}

/** The publish button repeats it: "Publish to 6 sites now" or "Schedule for Mon 20 Oct 06:00". */
export function publishButtonWords({ sites = 0, when = null } = {}) {
  if (when) return `Schedule for ${when}`;
  return `Publish to ${sites} site${sites === 1 ? '' : 's'} now`;
}
