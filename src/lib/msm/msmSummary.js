// src/lib/msm/msmSummary.js
//
// MULTI SITE MENU, ROUND 2 (17 Oct 2026, v5.11.75): a list of staged changes as SENTENCES, shown
// before "Add to draft" and before "Publish" (design 6.4, "these people will not be techy"). Pure,
// tested (msmSummary.test.js). Grouped by what and where:
//   "12 prices go up at Leeds and Huddersfield from Mon 20 Oct 06:00."
//   "Oat milk goes from 0.50 to 0.60 in Milk options at every site."
//   "Latte is turned off at Barnsley."
//   "Galaxy donut: takeaway VAT becomes Zero Rate at every site."

import { money2, toPence } from '../../../supabase/functions/_shared/msmModel.js';
import { isOptionOnlyItem } from '../menuRules.js';

const listOf = (v) => (Array.isArray(v) ? v : []);
const TAX_WORDS = { 'dine-in': 'eat in', takeaway: 'takeaway', delivery: 'delivery', bar: 'bar tab' };

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
  const newProducts = [], newSubs = [], removed = [], back = [];
  const offAt = new Map(), onAt = new Map();          // loc -> [names]
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
      const was = new Set(listOf(b.modifier_groups).map((x) => (typeof x === 'string' ? x : x?.groupId)));
      for (const x of listOf(a.modifier_groups)) { const id = typeof x === 'string' ? x : x?.groupId; if (id && !was.has(id)) bump(ups, `group:${id}`); }
    }
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
  return out;
}

/** The publish button repeats it: "Publish to 6 sites now" or "Schedule for Mon 20 Oct 06:00". */
export function publishButtonWords({ sites = 0, when = null } = {}) {
  if (when) return `Schedule for ${when}`;
  return `Publish to ${sites} site${sites === 1 ? '' : 's'} now`;
}
