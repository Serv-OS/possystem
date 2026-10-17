// src/lib/msm/msmGroupEdit.js
//
// MULTI SITE MENU, ROUND 2 (17 Oct 2026, v5.11.75): the changes an edit on the Option groups screen
// and the product sheet stages, so the screens only render. Pure, tested (msmGroupEdit.test.js).
// Every function takes ctx = { eff } (the central menu with the draft applied: msmDiff.applyChanges)
// and returns msm_changes rows with `before` filled, ready for msmData.stageMany.
//
// THE RULES (design 1.1 to 1.8 and the design review)
//   * No option site row means OFF at that site, so a new option writes an explicit row for EVERY
//     site where its group is (on by default, or as the person picked).
//   * An option's price at a site equal to the option's default is "follows the default" (null).
//   * "Same choice more than once" (quantity) sets must choose = up to, as Menu Manager does.
//   * A group removed from the group menu is taken off every product's option groups in the same
//     draft, and is never deleted at a venue.
//   * Putting a group on products follows the size rule: ticking a product with sizes means all of
//     its sizes (options belong on sizes; lib/menu/modifierAttach.js expandPicks).
//   * A new sub item: type 'subitem', not sold on its own unless asked, hidden everywhere unless
//     sold on its own (the store's own rule, store addMenuItem). Sold on its own, it is a product
//     at every site; only an option, publish adds it at each site where an option needs it.

import { samePrice, sameValue, newItemId, SELECTION_TYPES } from '../../../supabase/functions/_shared/msmModel.js';
import { expandPicks } from '../menu/modifierAttach.js';

const listOf = (v) => (Array.isArray(v) ? v : []);
const gidOf = (a) => (typeof a === 'string' ? a : a && typeof a === 'object' ? (a.groupId ?? null) : null);
const pick = (row, keys) => Object.fromEntries(keys.map((k) => [k, row ? (row[k] ?? null) : null]));
const groupOf = (ctx, id) => listOf(ctx?.eff?.groups).find((g) => g.id === id) || null;
const optionOf = (ctx, id) => listOf(ctx?.eff?.options).find((o) => o.id === id) || null;
const sitesOfGroup = (ctx, gid) => listOf(ctx?.eff?.groupSites).filter((r) => r.group_id === gid).map((r) => r.location_id);

/** "Choose exactly 1", "Choose up to 3", "Choose between 1 and 3", "Choose as many as they like". */
export function ruleWords(min, max) {
  const a = Math.max(0, Number(min) || 0);
  const b = Math.max(0, Number(max) || 0);
  if (b >= 99 && a === 0) return 'Choose as many as they like';
  if (b >= 99) return `Choose at least ${a}`;
  if (a === b) return `Choose exactly ${a}`;
  if (a === 0) return `Choose up to ${b}`;
  return `Choose between ${a} and ${b}`;
}

/** The group's fields after an edit, with the quantity rule applied. */
function withRules(current, fields) {
  const out = { ...fields };
  const type = out.selection_type ?? current?.selection_type ?? 'single';
  if (out.selection_type && !SELECTION_TYPES.includes(out.selection_type)) delete out.selection_type;
  if (type === 'quantity' && (out.selection_type === 'quantity' || 'max' in out)) {
    const max = Number(out.max ?? current?.max ?? 1);
    out.min = max;
    out.max = max;
  }
  return out;
}

/** A new option group. */
export function newGroupChanges(ctx, { id, name, min = 0, max = 1, selection_type = 'single', sort_order = null }) {
  const after = withRules(null, {
    name: String(name || '').trim() || 'Options', min: Number(min) || 0, max: Number(max) || 0, selection_type,
    sort_order: sort_order ?? listOf(ctx?.eff?.groups).length,
  });
  return [{ target: 'modifier_group', entity_id: id, location_id: null, op: 'create', after, before: {} }];
}

/** An edit of a group's name or rules (only what really changed). */
export function groupUpdate(ctx, groupId, fields) {
  const g = groupOf(ctx, groupId);
  if (!g) return [];
  const after = withRules(g, fields);
  for (const k of Object.keys(after)) if (sameValue(after[k], g[k])) delete after[k];
  if (!Object.keys(after).length) return [];
  return [{ target: 'modifier_group', entity_id: groupId, location_id: null, op: 'update', after, before: pick(g, Object.keys(after)) }];
}

/** A site keeps its own rule (or gives it back with value undefined: "Use the group's"). */
export function groupSiteKeep(ctx, groupId, locationId, column, value) {
  const gs = listOf(ctx?.eff?.groupSites).find((r) => r.group_id === groupId && r.location_id === locationId);
  if (!gs) return [];
  const kept = { ...(gs.kept || {}) };
  if (value === undefined) delete kept[column]; else kept[column] = value;
  if (sameValue(kept, gs.kept || {})) return [];
  return [{ target: 'modifier_group_site', entity_id: groupId, location_id: locationId, op: 'update', after: { kept }, before: { kept: gs.kept || {} } }];
}

/** Remove a group from the group menu: off every product's option groups too. Never a delete. */
export function removeGroupChanges(ctx, groupId) {
  const g = groupOf(ctx, groupId);
  if (!g) return [];
  const out = [{ target: 'modifier_group', entity_id: groupId, location_id: null, op: 'remove', after: { archived: true }, before: { archived: !!g.archived } }];
  for (const p of listOf(ctx?.eff?.products)) {
    const list = listOf(p.modifier_groups);
    if (!list.some((a) => gidOf(a) === groupId)) continue;
    out.push({ target: 'product', entity_id: p.id, location_id: null, op: 'update', after: { modifier_groups: list.filter((a) => gidOf(a) !== groupId) }, before: { modifier_groups: list } });
  }
  return out;
}

/**
 * A new option, with a row for every site where the group is (on, unless `sites` says otherwise).
 *   sites   { [locationId]: { active, price } } (price null = the default)
 */
export function newOptionChanges(ctx, { id, groupId, name, price = 0, productId = null, subGroupId = null, sites = {} }) {
  const rows = listOf(ctx?.eff?.options).filter((o) => o.group_id === groupId);
  const out = [{
    target: 'modifier_option', entity_id: id, location_id: null, op: 'create', before: {},
    after: { group_id: groupId, name: String(name || '').trim() || 'Option', price: Math.max(0, Number(price) || 0), product_id: productId, sub_group_id: subGroupId, sort_order: rows.length },
  }];
  for (const loc of sitesOfGroup(ctx, groupId)) {
    const s = sites[loc] || {};
    const own = s.price == null || samePrice(s.price, price) ? null : Number(s.price);
    out.push({ target: 'modifier_option_site', entity_id: id, location_id: loc, op: 'create', after: { active: s.active !== false, price: own }, before: {} });
  }
  return out;
}

/** An edit of an option (name, default price, sub item, Then ask, order). */
export function optionUpdate(ctx, optionId, fields) {
  const o = optionOf(ctx, optionId);
  if (!o) return [];
  const after = { ...fields };
  delete after.group_id;
  if ('price' in after) after.price = Number(after.price) || 0;
  for (const k of Object.keys(after)) if (k === 'price' ? samePrice(after[k], o[k]) : sameValue(after[k], o[k])) delete after[k];
  if (!Object.keys(after).length) return [];
  return [{ target: 'modifier_option', entity_id: optionId, location_id: null, op: 'update', after, before: pick(o, Object.keys(after)) }];
}

/**
 * An option at one site: on or off, and its own price (equal to the default = follows it).
 * A site the group is at but with no row yet gets one (create).
 */
export function optionSiteChange(ctx, optionId, locationId, { active, price } = {}) {
  const o = optionOf(ctx, optionId);
  if (!o) return [];
  const os = listOf(ctx?.eff?.optionSites).find((r) => r.option_id === optionId && r.location_id === locationId);
  const after = {};
  if (active !== undefined) after.active = !!active;
  if (price !== undefined) after.price = price == null || samePrice(price, o.price) ? null : Number(price);
  if (!os) return [{ target: 'modifier_option_site', entity_id: optionId, location_id: locationId, op: 'create', after: { active: after.active ?? true, price: after.price ?? null }, before: {} }];
  for (const k of Object.keys(after)) if (k === 'price' ? (after.price == null ? os.price == null : samePrice(after.price, os.price)) : after[k] === os[k]) delete after[k];
  if (!Object.keys(after).length) return [];
  return [{ target: 'modifier_option_site', entity_id: optionId, location_id: locationId, op: 'update', after, before: pick(os, Object.keys(after)) }];
}

/** A site gives back (value undefined) or keeps its own option name, sub item link or Then ask. */
export function optionSiteKeep(ctx, optionId, locationId, key, value) {
  const os = listOf(ctx?.eff?.optionSites).find((r) => r.option_id === optionId && r.location_id === locationId);
  if (!os) return [];
  const kept = { ...(os.kept || {}) };
  if (value === undefined) delete kept[key]; else kept[key] = value;
  if (sameValue(kept, os.kept || {})) return [];
  return [{ target: 'modifier_option_site', entity_id: optionId, location_id: locationId, op: 'update', after: { kept }, before: { kept: os.kept || {} } }];
}

/** Remove an option from its group: off at every site when published (its venue ids stay for ever). */
export function removeOptionChanges(ctx, optionId) {
  const o = optionOf(ctx, optionId);
  if (!o) return [];
  return [{ target: 'modifier_option', entity_id: optionId, location_id: null, op: 'remove', after: { archived: true }, before: { archived: !!o.archived } }];
}

/** New order of a group's options: one change per option whose place moved. */
export function reorderOptions(ctx, groupId, optionIds) {
  const out = [];
  listOf(optionIds).forEach((id, i) => {
    const o = optionOf(ctx, id);
    if (!o || o.group_id !== groupId || Number(o.sort_order ?? 0) === i) return;
    out.push({ target: 'modifier_option', entity_id: id, location_id: null, op: 'update', after: { sort_order: i }, before: { sort_order: o.sort_order ?? 0 } });
  });
  return out;
}

/** "Set every price in this group": the default, and every site back to following it. */
export function setEveryPrice(ctx, groupId, price) {
  const out = [];
  for (const o of listOf(ctx?.eff?.options).filter((x) => x.group_id === groupId && !x.archived)) {
    out.push(...optionUpdate(ctx, o.id, { price }));
    for (const os of listOf(ctx?.eff?.optionSites).filter((r) => r.option_id === o.id && r.price != null)) {
      out.push({ target: 'modifier_option_site', entity_id: o.id, location_id: os.location_id, op: 'update', after: { price: null }, before: { price: os.price } });
    }
  }
  return out;
}

/**
 * "Add option > New sub item": the sub item product and its option in one step.
 *   soldAlone  also a normal product on the till (then it goes on sale at every site, at its own
 *              price, in `categoryId`); otherwise only ever an option (publish adds it where needed)
 */
export function newSubItemOption(ctx, { productId, optionId, groupId, name, price = 0, productPrice = null, soldAlone = false, categoryId = null, tax = null }) {
  const nm = String(name || '').trim() || 'Sub item';
  const product = {
    target: 'product', entity_id: productId, location_id: null, op: 'create', before: {},
    after: {
      name: nm, menu_name: nm, type: 'subitem', sold_alone: !!soldAlone, default_price: Math.max(0, Number(productPrice ?? price) || 0),
      category_id: soldAlone ? categoryId : null, tax_rate_name: tax?.name ?? null, tax_rate_percent: tax?.percent ?? null,
      visibility: soldAlone ? { pos: true, kiosk: true, online: true, onlineDelivery: true } : { pos: false, kiosk: false, online: false, onlineDelivery: false },
      modifier_groups: [], allergens: [], tags: [],
    },
  };
  const out = [product];
  if (soldAlone) {
    for (const s of listOf(ctx?.eff?.sites)) {
      out.push({ target: 'product_site', entity_id: productId, location_id: s.location_id, op: 'create', before: {}, after: { venue_item_id: newItemId({ id: productId }, s.location_id), active: true, price: null, channel_prices: null } });
    }
  }
  out.push(...newOptionChanges(ctx, { id: optionId, groupId, name: nm, price, productId }));
  return out;
}

/** The central products to put a group on, from ticks (a product with sizes means its sizes). */
export function expandProductPicks(ctx, productIds) {
  const items = listOf(ctx?.eff?.products).filter((p) => !p.archived).map((p) => ({ id: p.id, parentId: p.parent_product_id || null, archived: false, name: p.name }));
  return expandPicks(items, productIds);
}

/** Put a group on products ("Milk options added to 14 products at every site"). */
export function addGroupToProducts(ctx, groupId, productIds) {
  const out = [];
  for (const id of expandProductPicks(ctx, productIds)) {
    const p = listOf(ctx?.eff?.products).find((x) => x.id === id);
    if (!p) continue;
    const list = listOf(p.modifier_groups);
    if (list.some((a) => gidOf(a) === groupId)) continue;
    out.push({ target: 'product', entity_id: id, location_id: null, op: 'update', after: { modifier_groups: [...list, { groupId }] }, before: { modifier_groups: list } });
  }
  return out;
}

/** Take a group off products. */
export function removeGroupFromProducts(ctx, groupId, productIds) {
  const out = [];
  for (const id of productIds || []) {
    const p = listOf(ctx?.eff?.products).find((x) => x.id === id);
    const list = listOf(p?.modifier_groups);
    if (!p || !list.some((a) => gidOf(a) === groupId)) continue;
    out.push({ target: 'product', entity_id: id, location_id: null, op: 'update', after: { modifier_groups: list.filter((a) => gidOf(a) !== groupId) }, before: { modifier_groups: list } });
  }
  return out;
}

/**
 * "Copy this group": a new group with the same rules and options ("Milk options (copy)"), on at the
 * same sites with the same site prices once it is on a product there.
 *   ids   { groupId, optionId: (oldOptionId) => newId }
 */
export function copyGroupChanges(ctx, groupId, ids) {
  const g = groupOf(ctx, groupId);
  if (!g) return [];
  const out = newGroupChanges(ctx, { id: ids.groupId, name: `${g.name} (copy)`, min: g.min, max: g.max, selection_type: g.selection_type });
  const rows = listOf(ctx?.eff?.options).filter((o) => o.group_id === groupId && !o.archived).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  rows.forEach((o, i) => {
    out.push({ target: 'modifier_option', entity_id: ids.optionId(o.id), location_id: null, op: 'create', before: {}, after: { group_id: ids.groupId, name: o.name, price: Number(o.price) || 0, product_id: o.product_id ?? null, sub_group_id: o.sub_group_id ?? null, sort_order: i } });
  });
  return out;
}

/** Where a group is used: "Used by 14 products in 3 categories". */
export function whereUsed(ctx, groupId) {
  const products = listOf(ctx?.eff?.products).filter((p) => !p.archived && listOf(p.modifier_groups).some((a) => gidOf(a) === groupId));
  const cats = new Set(products.map((p) => p.category_id).filter(Boolean));
  const n = products.length;
  const words = n ? `Used by ${n} product${n === 1 ? '' : 's'}${cats.size ? ` in ${cats.size} categor${cats.size === 1 ? 'y' : 'ies'}` : ''}` : 'Not on any product yet';
  return { products, categories: cats.size, words };
}

/** The options a sub item is in, for "Donut is also an option in Choose 3 Donuts (0.00) and Extras (0.50)". */
export function optionsUsingProduct(ctx, productId) {
  return listOf(ctx?.eff?.options).filter((o) => !o.archived && o.product_id === productId).map((o) => ({ option: o, group: groupOf(ctx, o.group_id) }));
}
