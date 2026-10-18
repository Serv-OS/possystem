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
//   ROUND 2, BLOCKING: a required option group with no options on at a site (customers could never
//     finish); a group whose "choose up to" is below its "must choose"; a "Then ask" loop or a
//     "Then ask" group missing; no matching VAT rate for an order type; a real tax profile on a
//     product that gets VAT by order type. An option only sub item never needs a category.
//   ROUND 2, WARNINGS: an option whose sub item is turned off at a site (with the fix); a group
//     also used by a site's own products; a site's own Drive thru or Collection VAT that the group
//     Takeaway VAT will not reach. Every line says the fix.
//   17 OCT VERIFICATION, WARNINGS: a product this publish adds where the site already sells its own
//     product with the same name (in any category); a product written into a category that is not
//     on the site's menu (no till would show it).
//   17 OCT VERIFICATION, BLOCKING (central): a product brought back into a category that was taken
//     off the group menu.

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
  const optionOnly = (i) => !!i && i.type === 'subitem' && i.sold_alone !== true;
  const siteName = opts.siteName || 'this site';

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
    if (active(i) && !i.cat && !optionOnly(i)) {
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
        push(warnings, { code: 'tier_price_wins', words: `${label}: ${siteName} has a timed menu price that will be charged instead. Change it in ${siteName}'s Menu Manager, or ignore this.`, productId });
      }
    }
    if (active(i)) {
      for (const g of listOf(i.assigned_modifier_groups)) {
        const def = listOf(A.groups).find((x) => x.id === (g && g.groupId));
        if (!def) continue;
        const offOpts = listOf(def.options).filter((o) => o && o.itemId && !active(byId.get(o.itemId)));
        const off = offOpts.map((o) => o.name);
        if (off.length) push(warnings, { code: 'option_inactive', words: `"${def.name}" offers ${off.slice(0, 3).join(', ')}${off.length > 3 ? ' and more' : ''}, whose sub item is turned off at ${siteName}. Turn the option off there too, or turn the sub item back on.`, productId, venueGroupId: def.id, venueOptionIds: offOpts.map((o) => o.id) });
      }
    }
  }

  // 17 Oct verification. A product this publish ADDS where the site already sells its own product
  // (not in the group menu) with the same name, in any category: two buttons for one thing.
  const managed = new Set(listOf(plan.managedItemIds));
  for (const id of listOf(plan.insertedItemIds)) {
    const i = byId.get(id);
    if (!active(i) || optionOnly(i)) continue;
    const n = normName(nameOf(i));
    const own = items.find((o) => o !== i && active(o) && !optionOnly(o) && !managed.has(o.id) && o.id !== i.parent_id && o.parent_id !== i.id
      && normName(nameOf(o)) === n && !(o.cat && o.cat === i.cat));
    if (own) push(warnings, { code: 'own_same_name', words: `${siteName} already sells its own "${nameOf(own)}" (not in the group menu), so it would have two. To use that one instead, take this out of the draft and bring it in on the Sites tab.`, productId: productOf.get(id) });
  }
  // A product written on sale into a category that is not on the site's menu: no till shows it.
  if (plan.venueMenuId && Array.isArray(A.links)) {
    const cats = new Map(listOf(A.categories).map((c) => [c.id, c]));
    const linked = new Set(listOf(A.links).filter((l) => l.menu_id === plan.venueMenuId).map((l) => l.category_id));
    const onMenu = (cid, n = 0) => { const c = cats.get(cid); if (!c || n > 20) return false; return c.menu_id === plan.venueMenuId || linked.has(cid) || (c.parent_id ? onMenu(c.parent_id, n + 1) : false); };
    for (const id of touched) {
      const i = byId.get(id);
      if (!active(i) || optionOnly(i) || i.parent_id) continue;
      const mine = [i.cat, ...listOf(i.cats)].filter(Boolean);
      if (!mine.length || mine.some((c) => onMenu(c))) continue;
      const c = cats.get(i.cat);
      push(warnings, { code: 'category_off_menu', words: `"${nameOf(i)}" is in ${c ? `"${c.label}"` : 'a category'}, which is not on ${siteName}'s menu, so no till shows it there. Put that category back on the menu in ${siteName}'s Menu Manager.`, productId: productOf.get(id) });
    }
  }

  // Option groups this plan wrote: one customers could never finish, rules that cannot be met.
  const groupIds = new Set([...listOf(plan.writtenGroupIds)]);
  for (const i of items) if (active(i) && touched.has(i.id)) for (const a of listOf(i.assigned_modifier_groups)) { const id = a && (typeof a === 'string' ? a : a.groupId); if (id) groupIds.add(id); }
  for (const gid of groupIds) {
    const def = listOf(A.groups).find((x) => x.id === gid);
    if (!def) continue;
    const users = items.filter((i) => active(i) && listOf(i.assigned_modifier_groups).some((a) => (typeof a === 'string' ? a : a?.groupId) === gid));
    if (!users.length && !listOf(plan.writtenGroupIds).includes(gid)) continue;
    const min = Number(def.min ?? 0), max = Number(def.max ?? 1);
    if (min > 0 && !listOf(def.options).length && users.length) {
      push(blocking, { code: 'required_group_empty', words: `${siteName} customers could never finish ordering ${nameOf(users[0])}${users.length > 1 ? ` (and ${users.length - 1} more)` : ''}: "${def.name}" must be chosen but has no options on at ${siteName}. Turn an option on there, or make it optional.`, venueGroupId: gid });
    } else if (!listOf(def.options).length && users.length) {
      // An optional group with nothing to pick shows as an empty heading on the till, kiosk and
      // HubRise (round 2 review backstop).
      push(warnings, { code: 'group_empty', words: `"${def.name}" has no options on at ${siteName}, so ${nameOf(users[0])}${users.length > 1 ? ` (and ${users.length - 1} more)` : ''} would show an empty question there. Turn its options on at ${siteName} on the Option groups tab.`, venueGroupId: gid });
    }
    if (max > 0 && max < min) {
      push(blocking, { code: 'group_max_below_min', words: `"${def.name}": customers must choose ${min} but can only choose up to ${max}. Make "up to" ${min} or more.`, venueGroupId: gid });
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
  const catOf = new Map(listOf(central?.categories).map((c) => [c.id, c]));
  for (const [pid, t] of touched?.products || new Map()) {
    const p = listOf(central?.products).find((x) => x.id === pid);
    if (!p || p.archived || t.op === 'remove') continue;
    if (!ps.some((r) => r.product_id === pid && r.active !== false)) warnings.push({ code: 'active_nowhere', words: `"${p.name}" is not on sale at any site.`, productId: pid });
    // Brought back (or moved) into a category that was taken off the group menu: it would go on
    // sale where no till shows it (17 Oct verification).
    const gone = [p.category_id, ...listOf(p.extra_category_ids)].map((cid) => catOf.get(cid)).filter((c) => c && c.archived);
    if (gone.length && !(t.op === 'update' && !t.fields.has('archived') && !t.fields.has('category_id') && !t.fields.has('extra_category_ids'))) {
      blocking.push({ code: 'category_removed', words: `"${p.name}" is in "${gone[0].label}", which was taken off the group menu. Move it to another category first.`, productId: pid });
    }
  }
  // Option groups (round 2): rules that cannot be met, and "Then ask" loops.
  const groups = listOf(central?.groups);
  const opts = listOf(central?.options).filter((o) => o && !o.archived);
  const touchedGroups = new Set([...(touched?.groups?.keys?.() || [])]);
  for (const oid of touched?.options?.keys?.() || []) { const o = listOf(central?.options).find((x) => x.id === oid); if (o) touchedGroups.add(o.group_id); }
  for (const gid of touchedGroups) {
    const g = groups.find((x) => x.id === gid);
    if (!g || g.archived) continue;
    const min = Number(g.min ?? 0), max = Number(g.max ?? 1);
    if (max > 0 && max < min) blocking.push({ code: 'group_max_below_min', words: `"${g.name}": customers must choose ${min} but can only choose up to ${max}. Make "up to" ${min} or more.`, groupId: gid });
    // A loop through "Then ask": A asks B asks ... asks A.
    const seen = new Set();
    const walk = (id, depth) => {
      if (depth > 20) return false;
      for (const o of opts.filter((x) => x.group_id === id && x.sub_group_id)) {
        if (o.sub_group_id === gid) return true;
        if (seen.has(o.sub_group_id)) continue;
        seen.add(o.sub_group_id);
        if (walk(o.sub_group_id, depth + 1)) return true;
      }
      return false;
    };
    if (walk(gid, 0)) blocking.push({ code: 'then_ask_loop', words: `"${g.name}" comes back to itself through "Then ask", so customers could never finish. Change one of the "Then ask" groups.`, groupId: gid });
    for (const o of opts.filter((x) => x.group_id === gid && x.sub_group_id)) {
      const sg = groups.find((x) => x.id === o.sub_group_id);
      if (!sg || sg.archived) blocking.push({ code: 'then_ask_missing', words: `The option "${o.name}" in "${g.name}" asks a group that is not in the group menu any more. Pick another "Then ask".`, groupId: gid });
    }
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
