// supabase/functions/_shared/msmHealth.js
//
// MULTI SITE MENU (17 Oct 2026, v5.11.75): the menu health check. Pure, shared by the screen
// (live, in the changes panel and the publish preview) and the server (at publish, an hour
// before a scheduled run, and again at run time). Tested in src/lib/msm/msmHealth.test.js.
//
// It reads a plan from msmPlan.js planSite (the venue as it will look) and says, in plain words:
//   BLOCKING (the site is not published, the others still are):
//     an active product with no category; no matching VAT rate; a price missing or below zero;
//     a category removed while it still holds active products; an item code that already exists
//     at that site; a size whose parent is not active there; a site with no menu; a new
//     category that no printer or kitchen screen takes; a category photo the venue table would
//     refuse.
//   WARNINGS (it goes through):
//     a price of 0.00; two products with one name in one category; a modifier option pointing at
//     a product not on sale there; a product on sale nowhere; a menu tier price that wins over the
//     price set; changed at the venue since it was staged; new categories are not in any
//     automatic discount.

import { CATEGORY_IMAGE_RE, normName, toPence, money2 } from './msmModel.js';

const listOf = (v) => (Array.isArray(v) ? v : []);
const codeKey = (c) => (c == null ? null : String(c).trim().toUpperCase() || null);

/**
 * The health of one site's plan.
 *   plan     planSite(...) result
 *   opts     { names: { venueItemId|productId: name }, drift: [lines], siteName }
 * Returns { location, blocking: [{code, words, productId?, categoryId?}], warnings: [...], ok }
 */
export function checkSite(plan, opts = {}) {
  const blocking = [];
  const warnings = [];
  const seen = new Set();
  const push = (list, p) => {
    const key = `${p.code}|${p.productId || ''}|${p.categoryId || ''}|${p.words}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push(p);
  };
  for (const p of listOf(plan?.problems)) push(p.level === 'block' ? blocking : warnings, { code: p.code, words: p.words, productId: p.productId, categoryId: p.categoryId });
  if (!plan || plan.notAtSite) return { location: plan?.locationId || null, blocking, warnings, ok: blocking.length === 0 };

  const A = plan.applied || {};
  const items = listOf(A.items);
  const byId = new Map(items.map((i) => [i.id, i]));
  const touched = new Set([...(plan.writtenItemIds || []), ...(plan.insertedItemIds || [])]);
  const catWritten = new Set(listOf(plan.lines).filter((l) => l.table === 'items' && (l.column === 'cat' || l.column === '(new)')).map((l) => l.id));
  const priceWritten = new Set(listOf(plan.lines).filter((l) => l.table === 'items' && (l.column === 'pricing.base' || l.column === '(new)')).map((l) => l.id));
  const productOf = new Map(listOf(plan.lines).filter((l) => l.productId).map((l) => [l.id, l.productId]));
  const nameOf = (i) => i?.menu_name || i?.name || i?.id;
  const active = (i) => i && i.archived === false;

  // Item codes in use at the venue (the unique index counts every row, archived too).
  const codes = new Map();
  for (const i of items) {
    const k = codeKey(i.item_code);
    if (!k) continue;
    codes.set(k, (codes.get(k) || 0) + 1);
  }

  for (const id of touched) {
    const i = byId.get(id);
    if (!i) continue;
    const productId = productOf.get(id);
    const label = `"${nameOf(i)}"`;
    if (active(i) && !i.cat) {
      if (catWritten.has(id)) push(blocking, { code: 'no_category', words: `${label} has no category at this site.`, productId });
      else push(warnings, { code: 'no_category_kept', words: `${label} has no category at this site (kept from the venue).`, productId });
    }
    const base = i.pricing?.base;
    const p = toPence(base);
    if (active(i) && priceWritten.has(id)) {
      if (p === null || Number.isNaN(p)) push(blocking, { code: 'no_price', words: `${label} has no price at this site.`, productId });
      else if (p < 0) push(blocking, { code: 'price_below_zero', words: `${label} would cost below zero (${money2(base)}).`, productId });
      else if (p === 0 && i.type !== 'variants') push(warnings, { code: 'price_zero', words: `${label} is free (0.00) at this site.`, productId });
    }
    const k = codeKey(i.item_code);
    if (k && (codes.get(k) || 0) > 1) push(blocking, { code: 'item_code_clash', words: `Item code ${i.item_code} for ${label} is already used by another product at this site.`, productId });
    if (active(i) && i.parent_id) {
      const parent = byId.get(i.parent_id);
      if (!active(parent)) push(blocking, { code: 'size_parent_inactive', words: `${label} is a size of a product that is not on sale at this site.`, productId });
    }
    if (active(i) && i.cat) {
      const n = normName(nameOf(i));
      const dup = items.find((o) => o !== i && active(o) && o.cat === i.cat && normName(nameOf(o)) === n && !(o.parent_id && o.parent_id !== i.parent_id));
      if (dup) push(warnings, { code: 'duplicate_name', words: `Two products called ${label} in the same category at this site.`, productId });
    }
    if (priceWritten.has(id) && plan.venueMenuId) {
      const tier = i.pricing?.menus && i.pricing.menus[plan.venueMenuId];
      if (tier && typeof tier === 'object' && Object.values(tier).some((v) => v != null && v !== '')) {
        push(warnings, { code: 'tier_price_wins', words: `${label} has a menu price at this site that wins over the price you set.`, productId });
      }
    }
    if (active(i)) {
      for (const g of listOf(i.assigned_modifier_groups)) {
        const def = listOf(A.groups).find((x) => x.id === (g && g.groupId));
        if (!def) continue;
        const off = listOf(def.options).filter((o) => o && o.itemId && !active(byId.get(o.itemId))).map((o) => o.name);
        if (off.length) push(warnings, { code: 'option_inactive', words: `"${def.name}" offers ${off.slice(0, 3).join(', ')}${off.length > 3 ? ' and more' : ''}, not on sale at this site.`, productId });
      }
    }
  }

  // Categories taken off the menu while they still hold products on sale.
  for (const l of listOf(plan.lines).filter((x) => x.table === 'links' && x.column === '(off menu)')) {
    const held = items.filter((i) => active(i) && (i.cat === l.id || listOf(i.cats).includes(l.id)));
    if (held.length) push(blocking, { code: 'category_removed_with_products', words: `A category taken off the menu still holds ${held.length} product${held.length === 1 ? '' : 's'} on sale (${held.slice(0, 3).map(nameOf).join(', ')}). Move them first.`, categoryId: l.categoryId });
  }
  // Category photos the venue table would refuse.
  for (const c of [...listOf(plan.writes?.categories?.insert), ...listOf(plan.writes?.categories?.update).map((u) => ({ id: u.id, ...u.set }))]) {
    if (c.image != null && c.image !== '' && !CATEGORY_IMAGE_RE.test(String(c.image))) {
      push(blocking, { code: 'category_image', words: `The photo for category "${c.label || c.id}" is not one uploaded in Back Office, so the venue would refuse it.` });
    }
  }
  if ((plan.newCategories || []).length) {
    push(warnings, { code: 'new_category_discounts', words: `${plan.newCategories.length} new categor${plan.newCategories.length === 1 ? 'y is' : 'ies are'} not in any automatic discount at this site. Check Discounts if they should be.` });
  }
  for (const d of listOf(opts.drift)) {
    push(warnings, { code: 'changed_at_venue', words: d.words || 'Changed at the venue since it was staged; publishing puts the group value in.', productId: d.productId });
  }
  return { location: plan.locationId, blocking, warnings, ok: blocking.length === 0 };
}

/**
 * Checks across the whole central menu for what a set touched.
 *   central   central state with the set applied
 *   touched   touchedFromChanges(...)
 * Returns { blocking, warnings }.
 */
export function checkCentral(central, touched) {
  const blocking = [];
  const warnings = [];
  const ps = listOf(central?.productSites);
  for (const [pid, t] of touched?.products || new Map()) {
    const p = listOf(central?.products).find((x) => x.id === pid);
    if (!p || p.archived || t.op === 'remove') continue;
    if (!ps.some((r) => r.product_id === pid && r.active !== false)) warnings.push({ code: 'active_nowhere', words: `"${p.name}" is not on sale at any site.`, productId: pid });
  }
  for (const [cid, t] of touched?.categories || new Map()) {
    const c = listOf(central?.categories).find((x) => x.id === cid);
    if (!c) continue;
    if ((t.op === 'remove' || c.archived) && listOf(central?.products).some((p) => !p.archived && p.category_id === cid)) {
      blocking.push({ code: 'category_removed_with_products', words: `"${c.label}" still holds products. Move them to another category first.`, categoryId: cid });
    }
  }
  return { blocking, warnings };
}

/** One sentence for a failed site: "Site B will not get Monday's price rise: no 20% VAT rate." */
export function failWords(siteName, title, blocking) {
  const first = listOf(blocking)[0];
  const rest = listOf(blocking).length - 1;
  const why = first ? first.words.replace(/\.$/, '') : 'a problem with the menu';
  return `${siteName || 'This site'} will not get ${title ? `"${title}"` : 'this update'}: ${why}${rest > 0 ? ` (and ${rest} more)` : ''}.`;
}
