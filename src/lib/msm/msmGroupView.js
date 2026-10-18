// src/lib/msm/msmGroupView.js
//
// MULTI SITE MENU, ROUND 2 (17 Oct 2026, v5.11.75): what the Option groups screen shows. Pure,
// tested (msmGroupView.test.js). The screen (src/backoffice/sections/msm/MsmGroups.jsx) only draws
// these; the changes an edit stages come from msmGroupEdit.js (builder 1).
//
// Peter, 17 Oct 2026: "build modifier groups here and push them across the company, and set things
// like sub items, and sub items that can be sold separately, and manage the groups globally".
//
// THE RULES
//   * An option at a site: no option site row means OFF there (design review). A site the group
//     is not at shows "Not at this site" (the group lands there once a product there uses it).
//   * An option's price at a site: its own (bold) or the default (grey, "follows").
//   * A group "differs between sites" when a site keeps its own rule, or an option is off at a site
//     where the group is, or a site has its own option price.
//   * A group still held as one list of options (imported before round 2) needs the one time
//     refresh before its options can be edited here (msmPlan.groupOptionRows legacy).
//   * The rule form: Customers must choose, the kind of choice, and the two numbers, always a valid
//     rule (Menu Manager's own: one choice is up to 1; the same choice more than once is exactly N).

import { groupOptionRows } from '../../../supabase/functions/_shared/msmPlan.js';
import { normName, money2 } from '../../../supabase/functions/_shared/msmModel.js';
import { isOptionOnlyItem } from '../menuRules.js';
import { ruleSentence } from './msmWords.js';

const listOf = (v) => (Array.isArray(v) ? v : []);
const gidOf = (a) => (typeof a === 'string' ? a : a && typeof a === 'object' ? (a.groupId ?? a.id ?? null) : null);

/** A group's options in order (rows, or the old list for a group that still needs the refresh). */
export function optionsOf(central, groupId) {
  const g = listOf(central?.groups).find((x) => x.id === groupId);
  if (!g) return { rows: [], legacy: false };
  const r = groupOptionRows(g, central?.options);
  return { rows: r.rows.filter((o) => !o.archived), legacy: r.legacy, archived: r.rows.filter((o) => o.archived) };
}

/** Groups that still need the one time refresh (their options are one list, not rows yet). */
export function legacyGroupIds(central) {
  return listOf(central?.groups).filter((g) => g && !g.archived && groupOptionRows(g, central?.options).legacy).map((g) => g.id);
}

/** The sites a group is at: Set(locationId). */
export const groupSiteIds = (central, groupId) => new Set(listOf(central?.groupSites).filter((r) => r.group_id === groupId).map((r) => r.location_id));

/**
 * One option at one site.
 * Returns { here, active, own, price, follows } (here false: the group is not at that site).
 */
export function optionCell(central, option, locationId, siteIds = null) {
  const at = siteIds || groupSiteIds(central, option?.group_id);
  const def = Number(option?.price ?? 0);
  if (!at.has(locationId)) return { here: false, active: false, own: null, price: def, follows: true };
  const os = listOf(central?.optionSites).find((r) => r.option_id === option.id && r.location_id === locationId);
  if (!os) return { here: true, active: false, own: null, price: def, follows: true, noRow: true };
  const own = os.price == null ? null : Number(os.price);
  return { here: true, active: os.active === true, own, price: own ?? def, follows: own == null, kept: os.kept && typeof os.kept === 'object' ? os.kept : {} };
}

/** Does this group differ between sites? */
export function groupDiffers(central, groupId) {
  const at = groupSiteIds(central, groupId);
  for (const gs of listOf(central?.groupSites)) if (gs.group_id === groupId && gs.kept && Object.keys(gs.kept).length) return true;
  for (const o of optionsOf(central, groupId).rows) {
    for (const loc of at) {
      const c = optionCell(central, o, loc, at);
      if (!c.active || !c.follows) return true;
    }
  }
  return false;
}

/**
 * The left hand list: [{ group, options, products, categories, sites, differs, legacy, words }].
 *   opts { search, filter: 'all' | 'differ' | 'unused' | 'removed' }
 */
export function groupList(central, opts = {}) {
  const q = normName(opts.search || '');
  const filter = opts.filter || 'all';
  const legacy = new Set(legacyGroupIds(central));
  const usedBy = new Map();
  for (const p of listOf(central?.products)) {
    if (!p || p.archived) continue;
    for (const a of listOf(p.modifier_groups)) {
      const id = gidOf(a);
      if (!id) continue;
      if (!usedBy.has(id)) usedBy.set(id, []);
      usedBy.get(id).push(p);
    }
  }
  const out = [];
  for (const g of listOf(central?.groups)) {
    if (!g) continue;
    if (filter === 'removed' ? !g.archived : g.archived) continue;
    const opt = optionsOf(central, g.id);
    if (q && !normName(g.name).includes(q) && !opt.rows.some((o) => normName(o.name).includes(q))) continue;
    const products = usedBy.get(g.id) || [];
    const categories = new Set(products.map((p) => p.category_id).filter(Boolean)).size;
    const differs = !legacy.has(g.id) && groupDiffers(central, g.id);
    if (filter === 'differ' && !differs) continue;
    if (filter === 'unused' && products.length) continue;
    const n = products.length;
    out.push({
      group: g, options: opt.rows, legacy: legacy.has(g.id), products, categories, sites: groupSiteIds(central, g.id).size, differs,
      words: n ? `Used by ${n} product${n === 1 ? '' : 's'}${categories ? ` in ${categories} categor${categories === 1 ? 'y' : 'ies'}` : ''}` : 'Not on any product yet',
      rule: ruleSentence(g.min, g.max),
    });
  }
  out.sort((a, b) => (Number(a.group.sort_order ?? 0) - Number(b.group.sort_order ?? 0)) || String(a.group.name).localeCompare(String(b.group.name)) || String(a.group.id).localeCompare(String(b.group.id)));
  return out;
}

/** "Barnsley keeps its own rule: choose up to 2." for each site that keeps one, [{ locationId, words }]. */
export function keptRuleLines(central, groupId, siteName = (l) => l) {
  const out = [];
  const g = listOf(central?.groups).find((x) => x.id === groupId);
  for (const gs of listOf(central?.groupSites)) {
    if (gs.group_id !== groupId || !gs.kept || !Object.keys(gs.kept).length) continue;
    const k = gs.kept;
    const parts = [];
    if ('name' in k) parts.push(`its own name "${k.name}"`);
    if ('min' in k || 'max' in k) parts.push(`its own rule: ${ruleSentence(k.min ?? g?.min, k.max ?? g?.max).toLowerCase()}`);
    if ('selection_type' in k) parts.push('its own kind of choice');
    out.push({ locationId: gs.location_id, columns: Object.keys(k), words: `${siteName(gs.location_id)} keeps ${parts.join(', ') || 'its own settings'}.` });
  }
  return out;
}

// ── The rule form ───────────────────────────────────────────────────────────

/** The form from a group row. */
export function formFromGroup(g) {
  const min = Math.max(0, Number(g?.min) || 0);
  const max = Math.max(0, Number(g?.max ?? 1) || 0);
  return { mustChoose: min > 0, choice: ['single', 'multiple', 'quantity'].includes(g?.selection_type) ? g.selection_type : (max > 1 ? 'multiple' : 'single'), min, max: max || 1 };
}

/**
 * The form back to a valid rule { min, max, selection_type }:
 *   One choice              up to 1 (exactly 1 when they must choose)
 *   Several choices         up to max (99 = as many as they like); must choose = at least 1 (or min)
 *   Same choice more than once   exactly N (Menu Manager's quantity rule)
 */
export function ruleFromForm(f) {
  const choice = f?.choice || 'single';
  if (choice === 'single') return { min: f?.mustChoose ? 1 : 0, max: 1, selection_type: 'single' };
  const max = Math.max(1, Math.min(99, Math.round(Number(f?.max) || 1)));
  if (choice === 'quantity') return { min: max, max, selection_type: 'quantity' };
  const min = f?.mustChoose ? Math.max(1, Math.min(max, Math.round(Number(f?.min) || 1))) : 0;
  return { min, max, selection_type: 'multiple' };
}

/** Plain words for a rule from the form, for the sentence under the boxes. */
export function formSentence(f) {
  const r = ruleFromForm(f);
  const s = ruleSentence(r.min, r.max);
  return r.min > 0 ? `${s}. Customers must choose before the till moves on.` : `${s}. Customers can skip it.`;
}

// ── Putting a group on products ─────────────────────────────────────────────

/**
 * The tree for "Add to products": categories in order with their products (sizes under their
 * product), each ticked when it already has the group. Option only sub items are left out.
 *   ix   indexCentral(central)   tree   categoryTree(ix)
 * Returns [{ category, depth, products: [{ product, has, sizes: [{ product, has }] }] }].
 */
export function productPickTree(ix, tree, groupId, search = '') {
  const q = normName(search);
  const hasGroup = (p) => listOf(p.modifier_groups).some((a) => gidOf(a) === groupId);
  const byCat = new Map();
  for (const p of ix.products.values()) {
    if (p.archived || isOptionOnlyItem(p) || p.parent_product_id) continue;
    const sizes = (ix.sizes.get(p.id) || []).filter((s) => !s.archived);
    const hit = !q || normName(p.menu_name || p.name).includes(q) || sizes.some((s) => normName(s.menu_name || s.name).includes(q));
    if (!hit) continue;
    const cid = p.category_id || '__none__';
    if (!byCat.has(cid)) byCat.set(cid, []);
    byCat.get(cid).push({ product: p, has: hasGroup(p) || (sizes.length > 0 && sizes.every(hasGroup)), sizes: sizes.map((s) => ({ product: s, has: hasGroup(s) })) });
  }
  for (const list of byCat.values()) list.sort((a, b) => ix.byOrder(a.product, b.product));
  const out = [];
  for (const t of tree) if (byCat.has(t.id)) out.push({ category: t.category, depth: t.depth, products: byCat.get(t.id) });
  if (byCat.has('__none__')) out.push({ category: { id: '__none__', label: 'No category' }, depth: 0, products: byCat.get('__none__') });
  return out;
}

/** "Takes 0.50 off" for a minus price imported from a site; otherwise the money. */
export const optionPriceWords = (v) => (Number(v) < 0 ? `takes ${money2(Math.abs(Number(v)))} off` : money2(v));

// ── Saving the group form ───────────────────────────────────────────────────

const listSites = (central) => listOf(central?.sites).map((s) => s.location_id);
const priceOrNull = (v) => (v === '' || v == null ? null : Number(v));

/**
 * The form the group editor holds for one group.
 *   { id, isNew, name, rule: { min, max, selection_type }, options: [OptionForm], removed: [optionId] }
 *   OptionForm { id, isNew, name, price, product_id, sub_group_id,
 *                sites: { [loc]: { active: bool, own: '' | '0.60', absent?: bool } },
 *                newSub?: { productId, soldAlone, productPrice, categoryId, tax } }
 * Built from central state with the draft applied (eff); a site the group is not at yet is
 * `absent` (its options go on there when a product there gets the group: addGroupWithSites).
 */
export function groupForm(central, groupId) {
  const g = listOf(central?.groups).find((x) => x.id === groupId);
  if (!g) return null;
  const at = groupSiteIds(central, groupId);
  const f = formFromGroup(g);
  const options = optionsOf(central, groupId).rows.map((o) => ({
    id: o.id, isNew: false, name: o.name || '', price: Number(o.price ?? 0).toFixed(2), product_id: o.product_id || null, sub_group_id: o.sub_group_id || null,
    sites: Object.fromEntries(listSites(central).map((loc) => {
      const c = optionCell(central, o, loc, at);
      const os = listOf(central?.optionSites).find((r) => r.option_id === o.id && r.location_id === loc);
      if (!c.here && !os) return [loc, { active: false, own: '', absent: true }];
      return [loc, { active: os ? os.active === true : false, own: os && os.price != null ? Number(os.price).toFixed(2) : '' }];
    })),
  }));
  return { id: g.id, isNew: false, name: g.name || '', form: f, options, removed: [] };
}

/** A blank form for a new group (its options will be on at every site). */
export function newGroupForm(id) {
  return { id, isNew: true, name: '', form: { mustChoose: false, choice: 'single', min: 0, max: 1 }, options: [], removed: [] };
}

/** A new option line for the form: on at every site of the group menu, following the default price. */
export function newOptionForm(central, { id, name = '', price = '0.00', product_id = null, newSub = null }) {
  return { id, isNew: true, name, price, product_id, sub_group_id: null, newSub, sites: Object.fromEntries(listSites(central).map((loc) => [loc, { active: true, own: '' }])) };
}

/**
 * The changes the form stages, in an order the database accepts (a group before its options, a
 * sub item before the option that points at it, an option before its site rows).
 *   ctx      { eff } (and live, unused here)
 *   edit     msmGroupEdit functions (passed in, so this file stays free of a second copy of the rules)
 * Returns { changes, words } (words: what stops the save, in plain words, or '').
 */
export function groupSaveChanges(ctx, draft, edit) {
  const out = [];
  const name = String(draft?.name || '').trim();
  if (!name) return { changes: [], words: 'Give the option group a name, like Milk.' };
  const rule = ruleFromForm(draft.form);
  for (const o of listOf(draft.options)) {
    if (!String(o.name || '').trim()) return { changes: [], words: 'Every option needs a name.' };
    const p = Number(o.price);
    if (o.price === '' || !Number.isFinite(p) || p < 0) return { changes: [], words: `"${o.name}" needs a price of 0.00 or more.` };
    for (const [, s] of Object.entries(o.sites || {})) {
      if (s.own !== '' && s.own != null && !(Number.isFinite(Number(s.own)) && Number(s.own) >= 0)) return { changes: [], words: `A site price for "${o.name}" is not a price.` };
    }
  }
  const activeCount = listOf(draft.options).length;
  if (rule.min > 0 && !activeCount) return { changes: [], words: 'Customers must choose, so the group needs at least one option.' };
  if (rule.selection_type !== 'quantity' && rule.min > activeCount && activeCount > 0) return { changes: [], words: `Customers must choose ${rule.min}, but there are only ${activeCount} options.` };

  if (draft.isNew) out.push(...edit.newGroupChanges(ctx, { id: draft.id, name, ...rule }));
  else out.push(...edit.groupUpdate(ctx, draft.id, { name, ...rule }));
  for (const id of listOf(draft.removed)) out.push(...edit.removeOptionChanges(ctx, id));
  const sites = listSites(ctx?.eff);
  listOf(draft.options).forEach((o, i) => {
    const price = Number(o.price);
    if (o.isNew) {
      const made = o.newSub
        ? edit.newSubItemOption(ctx, { productId: o.newSub.productId, optionId: o.id, groupId: draft.id, name: o.name, price, productPrice: o.newSub.productPrice, soldAlone: !!o.newSub.soldAlone, categoryId: o.newSub.categoryId || null, tax: o.newSub.tax || null })
        : edit.newOptionChanges(ctx, { id: o.id, groupId: draft.id, name: o.name, price, productId: o.product_id || null, subGroupId: o.sub_group_id || null });
      // The option's place, and a site row for EVERY site (no row means off there).
      const rows = made.filter((c) => !(c.target === 'modifier_option_site' && c.entity_id === o.id));
      const create = rows.find((c) => c.target === 'modifier_option' && c.entity_id === o.id);
      if (create) { create.after.sort_order = i; if (o.sub_group_id) create.after.sub_group_id = o.sub_group_id; }
      out.push(...rows);
      for (const loc of sites) {
        const s = o.sites?.[loc] || { active: true, own: '' };
        const own = priceOrNull(s.own);
        out.push({ target: 'modifier_option_site', entity_id: o.id, location_id: loc, op: 'create', before: {}, after: { active: s.active !== false, price: own == null || Math.round(own * 100) === Math.round(price * 100) ? null : own } });
      }
      return;
    }
    out.push(...edit.optionUpdate(ctx, o.id, { name: String(o.name).trim(), price, product_id: o.product_id || null, sub_group_id: o.sub_group_id || null, sort_order: i }));
    // Site rows are worked out against the option as it will be after this save.
    const opt = listOf(ctx?.eff?.options).find((x) => x.id === o.id);
    const ctxO = opt ? { ...ctx, eff: { ...ctx.eff, options: ctx.eff.options.map((x) => (x.id === o.id ? { ...x, price } : x)) } } : ctx;
    for (const loc of sites) {
      const st = o.sites?.[loc];
      if (!st || (st.absent && !st.touched)) continue;
      const hasRow = listOf(ctx?.eff?.optionSites).some((r) => r.option_id === o.id && r.location_id === loc);
      if (!hasRow && !st.active) continue;           // no row is already off there
      out.push(...edit.optionSiteChange(ctxO, o.id, loc, { active: !!st.active, price: priceOrNull(st.own) }));
    }
  });
  return { changes: out, words: '' };
}

/**
 * Put a group on products, and switch its options on at the sites where those products are and
 * the options have no row yet (no row means off: without this the group would land with nothing
 * to pick at a new site).
 */
export function addGroupWithSites(ctx, groupId, productIds, edit) {
  const out = edit.addGroupToProducts(ctx, groupId, productIds);
  if (!out.length) return out;
  const touched = new Set(out.map((c) => c.entity_id));
  const locs = new Set(listOf(ctx?.eff?.productSites).filter((ps) => touched.has(ps.product_id) && ps.active !== false).map((ps) => ps.location_id));
  for (const o of optionsOf(ctx?.eff, groupId).rows) {
    if (String(o.id).startsWith('legacy:')) continue;
    for (const loc of locs) {
      if (listOf(ctx?.eff?.optionSites).some((r) => r.option_id === o.id && r.location_id === loc)) continue;
      out.push(...edit.optionSiteChange(ctx, o.id, loc, { active: true }));
    }
  }
  return out;
}

/**
 * "Copy this group": builder 1's copy (same rules, same options, "Milk options (copy)") plus a site
 * row for each copied option at every site where the original has one, with the same on or off and
 * the same own price (no row would mean off everywhere).
 *   newId   () => a new uuid
 */
export function copyGroupWithSites(ctx, groupId, newId, edit) {
  const ids = new Map();
  const groupNew = newId();
  const changes = edit.copyGroupChanges(ctx, groupId, { groupId: groupNew, optionId: (old) => { if (!ids.has(old)) ids.set(old, newId()); return ids.get(old); } });
  for (const [oldId, nid] of ids) {
    for (const os of listOf(ctx?.eff?.optionSites).filter((r) => r.option_id === oldId)) {
      changes.push({ target: 'modifier_option_site', entity_id: nid, location_id: os.location_id, op: 'create', before: {}, after: { active: os.active === true, price: os.price == null ? null : Number(os.price) } });
    }
  }
  return { groupId: groupNew, changes };
}
