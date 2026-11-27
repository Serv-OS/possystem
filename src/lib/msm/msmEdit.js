// src/lib/msm/msmEdit.js
//
// MULTI SITE MENU (17 Oct 2026, v5.11.75): what each edit on the screens stages. Pure, tested
// (msmEdit.test.js). Every function returns msm_changes rows ({ target, entity_id, location_id,
// op, after, before }) for msmData.stage / stageMany, or { words } when the edit cannot be made.
//
// TWO STATES (both passed in as ctx):
//   live   central state as last published: `before` always comes from here (the database keeps
//          the FIRST before when a cell is edited twice: msmDiff.mergeStaged)
//   eff    central state with the draft applied (what the grid shows): an edit is compared with
//          this, so typing the price a cell already shows stages nothing
//
// THE RULES
//   * A site price equal to the price that site would follow is stored as "follows" (null), so a
//     site never holds an override that says nothing.
//   * Turning a product on at a site where it is not in the group menu yet adds it there, with a
//     new venue id in the sharing engine's scheme (msmModel.newItemId). Round 2 (Peter, UI issues 6
//     and 8): there is no "site only extra" any more. A product imported at one site (the old
//     site_only_location_id) turned on at a second site becomes a normal product on at both: the
//     same edit clears that field. A switch never silently does nothing.
//   * Nothing is ever deleted: "remove" is archived, off is active false.
//   * 17 Oct recheck. A site with NO price (kept no_price: its row has no Standard price, a fact the
//     import keeps) stays with no price until someone sets one for it there: a price typed or
//     pasted at that site, a copy from another site that has one, or "Use the group price" sets it
//     on purpose and takes "no price" away in the same change; a blank leaves it as it is (said).
//     A copy from a site with no price copies nothing (said).
//   * A product turned on at a site where it never was and off again before publishing leaves
//     nothing: its row comes out of the draft, and so do the option rows its turn on staged there,
//     unless another product still on at that site needs them (droppedOptionRows).

import { STAGE_FIELDS, CHANNELS, has, sameValue, samePrice, newItemId, toPence, fromPence, channelFallback, hex12, pctText, keptWithoutNoPrice, noPriceAt, CATEGORY_RULE_OLD_WORDS, plural } from '../../../supabase/functions/_shared/msmModel.js';

export { noPriceAt };
import { optionRowsForNewSites } from './msmGroupEdit.js';
import { isOptionOnlyItem } from '../menuRules.js';
import { SHOWN_ON_KEYS, SHOWN_ON_WORDS, notShownOn, toggleShownOn } from '../soldAs.js';
import {
  MAIN_MENU, allExtraMenus, extraMenus, extraMenusValue, extraMenuNameProblem, newExtraMenu, matchSiteMenus, menuKeysOf, menuKeysValue,
  toggleMenuKey, menuKeysWords, rootCategory, extraMenuAt,
} from '../../../supabase/functions/_shared/msmMenus.js';

const listOf = (v) => (Array.isArray(v) ? v : []);
const findProduct = (c, id) => listOf(c?.products).find((p) => p.id === id) || null;
const findSite = (c, pid, loc) => listOf(c?.productSites).find((s) => s.product_id === pid && s.location_id === loc) || null;
const findCategory = (c, id) => listOf(c?.categories).find((x) => x.id === id) || null;
const okChannel = (ch) => (ch && CHANNELS.includes(ch) ? ch : null);
const gidOf = (a) => (typeof a === 'string' ? a : a && typeof a === 'object' ? (a.groupId ?? null) : null);
// A product with sizes: typed 'variants', or any product that has live sizes under it (a size made
// in the sheet never retypes its product; the demo's Latte). 17 Oct verification.
export const hasSizes = (eff, p) => !!p && (p.type === 'variants' || listOf(eff?.products).some((x) => x.parent_product_id === p.id && !x.archived));
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

// A variants parent's own price is never charged (Change prices leaves it out too).
const VARIANTS_WORDS = 'This product is priced by its sizes. Change the price on each size.';

/** The price a site falls back to when it has no price of its own (In store or a channel). */
export function followPrice(product, site, channel = null) {
  const ch = okChannel(channel);
  const base = Number(product?.default_price ?? 0);
  if (!ch) return base;
  // The till's chain (msmModel.channelFallback): drive thru reads takeaway before In store.
  return channelFallback(product, site, ch) ?? base;
}

/** The price a site charges now (In store or a channel); null when it has no price there. */
export function sitePrice(product, site, channel = null) {
  const ch = okChannel(channel);
  if (!site) return null;
  if (noPriceAt(product, site, ch)) return null;
  const own = ch ? site.channel_prices?.[ch] : site.price;
  return own != null ? Number(own) : followPrice(product, site, ch);
}

// ── One cell ────────────────────────────────────────────────────────────────

/**
 * Set a product's price at one site. value null = follow the group's price.
 * Returns { change } or { words }.
 */
export function sitePriceChange(ctx, productId, locationId, value, channel = null) {
  const ch = okChannel(channel);
  const p = findProduct(ctx.eff, productId);
  const s = findSite(ctx.eff, productId, locationId);
  if (!p || !s) return { words: 'This product is not at that site. Turn it on there first.' };
  // Priced by its sizes: a blank is nothing to stage (the product sheet saves one per site); a
  // price typed for it says where to type it instead.
  if (hasSizes(ctx.eff, p)) return value == null ? { change: null } : { words: VARIANTS_WORDS };
  if (value != null && (!Number.isFinite(Number(value)) || Number(value) < 0)) return { words: 'A price cannot be below zero.' };
  const follow = followPrice(p, s, ch);
  const next = value == null || samePrice(value, follow) ? null : fromPence(toPence(value));
  const liveS = findSite(ctx.live, productId, locationId);
  if (ch) {
    const cur = s.channel_prices && s.channel_prices[ch] != null ? Number(s.channel_prices[ch]) : null;
    if (samePrice(cur, next)) return { change: null };
    const after = { ...(s.channel_prices || {}) };
    if (next == null) delete after[ch]; else after[ch] = next;
    return { change: { target: 'product_site', entity_id: productId, location_id: locationId, op: 'update', after: { channel_prices: Object.keys(after).length ? after : null }, before: { channel_prices: clone(liveS?.channel_prices ?? null) } } };
  }
  // No price at this site: a price given here sets it on purpose (and "no price" goes in the same
  // change, so publish writes it); a blank leaves it with no price, and says so.
  if (noPriceAt(p, s)) {
    if (value == null) return { change: null, note: `${p.menu_name || p.name} has no price at this site. Type a price to sell it here at that price.` };
    return { change: { target: 'product_site', entity_id: productId, location_id: locationId, op: 'update', after: { price: next, kept: keptWithoutNoPrice(s.kept) }, before: { price: liveS ? liveS.price ?? null : null, kept: clone(liveS?.kept ?? {}) } } };
  }
  if (samePrice(s.price, next)) return { change: null };
  return { change: { target: 'product_site', entity_id: productId, location_id: locationId, op: 'update', after: { price: next }, before: { price: liveS ? liveS.price ?? null : null } } };
}

/**
 * Turn a product on or off at a site. On where it is not in the group menu yet adds it there.
 * Returns { change } or { words }.
 */
export function siteActiveChange(ctx, productId, locationId, active) {
  const r = siteActiveOne(ctx, productId, locationId, active);
  if (r.words) return r;
  const p = findProduct(ctx.eff, productId);
  // Sizes and their product go together (UI issue 11, the House Red case through one cell): a size
  // turned on where its product is not on brings the product too (publish would block with "a size
  // of a product that is not at this site"); a product with sizes turned on or off takes its sizes.
  const more = [];
  if (p && p.parent_product_id && active) {
    const parent = findProduct(ctx.eff, p.parent_product_id);
    const pps = findSite(ctx.eff, p.parent_product_id, locationId);
    if (parent && !parent.archived && (!pps || pps.active === false)) {
      const pr = siteActiveOne(ctx, parent.id, locationId, true);
      if (pr.words) return pr;
      if (pr.change) more.push(pr.change, ...(pr.extra || []));
    }
  }
  const dropped = r.change?.dropCreate ? [productId] : [];
  if (hasSizes(ctx.eff, p)) {
    for (const size of listOf(ctx.eff?.products).filter((x) => x.parent_product_id === p.id && !x.archived)) {
      const sr = siteActiveOne(ctx, size.id, locationId, active);
      if (sr.change) more.push(sr.change, ...(sr.extra || []));
      if (sr.change?.dropCreate) dropped.push(size.id);
    }
  }
  // Taken out of the draft again: the option rows its turn on staged go with it (Builder B recheck).
  if (dropped.length) more.push(...droppedOptionRows(ctx, locationId, dropped));
  if (!more.length) return r;
  if (!r.change) return { change: more[0], extra: more.slice(1), already: r.already };
  return { ...r, extra: [...(r.extra || []), ...more] };
}

function siteActiveOne(ctx, productId, locationId, active) {
  const p = findProduct(ctx.eff, productId);
  if (!p) return { words: 'That product is not in the group menu.' };
  const s = findSite(ctx.eff, productId, locationId);
  if (!s) {
    if (!active) return { change: null };
    if (!listOf(ctx.eff?.sites).some((x) => x.location_id === locationId)) return { words: 'That site is not in the group menu yet. Add it on the Sites tab first.' };
    const change = { target: 'product_site', entity_id: productId, location_id: locationId, op: 'create', after: { venue_item_id: newItemId(p, locationId), active: true, price: null, channel_prices: null }, before: {} };
    return { change, extra: [...clearSiteOnly(ctx, p, locationId), ...groupRowsFor(ctx, p, locationId)] };
  }
  if ((s.active !== false) === !!active) return { change: null, already: true };
  const liveS = findSite(ctx.live, productId, locationId);
  const liveP = findProduct(ctx.live, productId);
  // On, then off again before publishing, at a site where the product never was (its row is only
  // in this draft, with the id this module made for it): the draft's row comes out again, and the
  // old one site mark goes back, so nothing is left to publish or count (17 Oct verification). A
  // brought in row (the venue's own item) or a new product keeps its row: off there is real.
  if (!active && !liveS && liveP && s.venue_item_id === newItemId(p, locationId)) {
    const extra = [];
    if ((liveP.site_only_location_id ?? null) !== (p.site_only_location_id ?? null)) {
      extra.push({ target: 'product', entity_id: p.id, location_id: null, op: 'update', after: { site_only_location_id: liveP.site_only_location_id ?? null }, before: { site_only_location_id: liveP.site_only_location_id ?? null } });
    }
    return { change: { target: 'product_site', entity_id: productId, location_id: locationId, op: 'update', after: { active: false }, before: { active: null }, dropCreate: true }, extra };
  }
  return {
    change: { target: 'product_site', entity_id: productId, location_id: locationId, op: 'update', after: { active: !!active }, before: { active: liveS ? liveS.active !== false : null } },
    extra: active ? [...clearSiteOnly(ctx, p, locationId), ...groupRowsFor(ctx, p, locationId)] : [],
  };
}

// The option rows a product's option groups need at a site where the group is not yet (and the
// "Then ask" groups their options lead to). No row means off, so without these publish would make
// the group there with nothing to pick (an empty question, or a required one that blocks). Options
// that already have a row there keep it, so an option a site turned off stays off. 17 Oct
// verification; the same rule as Add to products and the product sheet's group tick.
function groupRowsFor(ctx, p, locationId) {
  const out = [];
  for (const gid of groupsOf(ctx, p)) {
    if (listOf(ctx.eff?.groupSites).some((r) => r.group_id === gid && r.location_id === locationId)) continue;
    out.push(...optionRowsForNewSites(ctx, gid, [locationId]));
  }
  return out;
}

// A product's option groups and the "Then ask" groups their options lead to (none for a sub item
// only used as an option).
function groupsOf(ctx, p) {
  if (!p || (p.type === 'subitem' && p.sold_alone !== true)) return new Set();
  const want = new Set(listOf(p.modifier_groups).map(gidOf).filter(Boolean));
  for (let round = 0; round < 10; round++) {
    const n = want.size;
    for (const o of listOf(ctx.eff?.options)) if (!o.archived && o.sub_group_id && want.has(o.group_id)) want.add(o.sub_group_id);
    if (want.size === n) break;
  }
  return want;
}

/**
 * The option rows to take out of the draft with products whose turn on at a site is taken out
 * again before publishing (Builder B recheck: turning Pie on and off at a site left its 4 option
 * rows, "3 changes" in the status bar and "an option is turned on" in the summary). Only the rows
 * that turn on staged: rows this draft made (none is live) for groups that are not at that site,
 * and that no other product still on there needs. An option row added any other way stays (a new
 * option in a group the site has, a group the site already shows).
 *   droppedIds   the products (and sizes) whose create at the site comes out
 */
export function droppedOptionRows(ctx, locationId, droppedIds) {
  const dropped = new Set(listOf(droppedIds));
  if (!dropped.size) return [];
  const needed = new Set();
  for (const ps of listOf(ctx.eff?.productSites)) {
    if (ps.location_id !== locationId || ps.active === false || dropped.has(ps.product_id)) continue;
    const other = findProduct(ctx.eff, ps.product_id);
    if (other && !other.archived) for (const g of groupsOf(ctx, other)) needed.add(g);
  }
  const groups = new Set();
  for (const id of dropped) for (const g of groupsOf(ctx, findProduct(ctx.eff, id))) if (!needed.has(g)) groups.add(g);
  const out = [];
  for (const o of listOf(ctx.eff?.options)) {
    if (!groups.has(o.group_id)) continue;
    if (listOf(ctx.eff?.groupSites).some((r) => r.group_id === o.group_id && r.location_id === locationId)) continue;
    if (!listOf(ctx.eff?.optionSites).some((r) => r.option_id === o.id && r.location_id === locationId)) continue;
    if (listOf(ctx.live?.optionSites).some((r) => r.option_id === o.id && r.location_id === locationId)) continue;
    out.push({ target: 'modifier_option_site', entity_id: o.id, location_id: locationId, op: 'update', after: { active: false }, before: { active: null }, dropCreate: true });
  }
  return out;
}

// The old "only at one site" mark, cleared when the product goes on at another site.
function clearSiteOnly(ctx, p, locationId) {
  if (!p.site_only_location_id || p.site_only_location_id === locationId) return [];
  const liveP = findProduct(ctx.live, p.id);
  return [{ target: 'product', entity_id: p.id, location_id: null, op: 'update', after: { site_only_location_id: null }, before: { site_only_location_id: liveP ? liveP.site_only_location_id ?? null : null } }];
}

/**
 * The group's (default) price: In store, or a channel (null clears a channel price).
 * Returns { change } or { words }.
 */
export function defaultPriceChange(ctx, productId, value, channel = null) {
  const ch = okChannel(channel);
  const p = findProduct(ctx.eff, productId);
  if (!p) return { words: 'That product is not in the group menu.' };
  if (hasSizes(ctx.eff, p)) return { words: VARIANTS_WORDS };
  if (value != null && (!Number.isFinite(Number(value)) || Number(value) < 0)) return { words: 'A price cannot be below zero.' };
  const liveP = findProduct(ctx.live, productId);
  if (!ch) {
    if (value == null) return { words: 'The group price cannot be blank. Type 0.00 for free.' };
    const next = fromPence(toPence(value));
    if (samePrice(p.default_price, next)) return { change: null };
    return { change: { target: 'product', entity_id: productId, location_id: null, op: 'update', after: { default_price: next }, before: { default_price: liveP ? Number(liveP.default_price) : null } } };
  }
  const next = value == null ? null : fromPence(toPence(value));
  const cur = p.default_channels?.[ch] ?? null;
  if (samePrice(cur, next)) return { change: null };
  const after = { ...(p.default_channels || {}) };
  after[ch] = next;
  return { change: { target: 'product', entity_id: productId, location_id: null, op: 'update', after: { default_channels: after }, before: { default_channels: clone(liveP?.default_channels ?? null) } } };
}

// ── Products ────────────────────────────────────────────────────────────────

const PRODUCT_EDITABLE = STAGE_FIELDS.product.filter((f) => !['family_base', 'site_only_location_id'].includes(f));
const TEXT_FIELDS = new Set(['name', 'menu_name', 'receipt_name', 'kitchen_name', 'description', 'item_code']);
const EMPTY_IS_NONE = new Set(['tags', 'allergens', 'extra_category_ids']);

/** Plain words for what is wrong with a product's fields ([] when nothing). */
export function productProblems(fields, ctx = {}) {
  const out = [];
  const f = fields || {};
  const name = String(f.name ?? '').trim();
  if (!name) out.push('Give the product a name.');
  if (name.length > 120) out.push('The name is too long (120 letters at most).');
  // Round 2: a sub item only ever used as an option is never on a menu, so it needs no category.
  const optionOnly = f.type === 'subitem' && f.sold_alone !== true;
  if (!f.category_id && !optionOnly) out.push('Pick a category.');
  const price = Number(f.default_price);
  if (f.default_price == null || f.default_price === '' || !Number.isFinite(price)) out.push('Give the product a price (0.00 for free).');
  else if (price < 0) out.push('A price cannot be below zero.');
  // 5.12.104: a rate is asked for only in a group that works on rates (some product has a percent).
  // A tax profile by name (a name, no percent) is a tax; and a group on tax profiles, where a
  // product with nothing set follows each site's own profile, is never asked (Mozz).
  const blank = (v) => v == null || v === '';
  const needsTax = listOf(ctx.eff?.products).some((p) => !blank(p.tax_rate_percent));
  if (needsTax && blank(f.tax_rate_percent) && !String(f.tax_rate_name ?? '').trim()) out.push('Pick the VAT rate.');
  if (f.parent_product_id && f.parent_product_id === f.id) out.push('A product cannot be a size of itself.');
  return out;
}

/**
 * Change a product's own fields (names, category, tax, allergens, image, groups, visibility ...).
 * Only fields that differ from what the grid shows are staged.
 * Returns { change } or { words }.
 */
export function productUpdate(ctx, productId, fields) {
  const p = findProduct(ctx.eff, productId);
  if (!p) return { words: 'That product is not in the group menu.' };
  const liveP = findProduct(ctx.live, productId);
  const after = {}, before = {};
  // A size uses its product's VAT by order type (msmTax.effectiveTaxByType): its own value would
  // be staged and shown, but never written (round 2 review). Never staged on a size.
  const isSize = has(fields, 'parent_product_id') ? !!fields.parent_product_id : !!p.parent_product_id;
  for (const k of PRODUCT_EDITABLE) {
    if (!has(fields, k)) continue;
    if (k === 'tax_by_type' && isSize) continue;
    if (sameValue(p[k], fields[k])) continue;
    // 5.12.101: no list and an empty list are the same thing (a product with no dietary tags, and
    // a sheet with none ticked). Without this every save staged "dietary tags change".
    if (EMPTY_IS_NONE.has(k) && listOf(p[k]).length === 0 && listOf(fields[k]).length === 0) continue;
    // Spaces at either end are no change (the sheet trims what it sends; 17 Oct rehearsal).
    if (TEXT_FIELDS.has(k) && String(p[k] ?? '').trim() === String(fields[k] ?? '').trim()) continue;
    after[k] = clone(fields[k]);
    before[k] = liveP ? clone(liveP[k] ?? null) : null;
  }
  if (!Object.keys(after).length) return { change: null };
  const merged = { ...p, ...after };
  const problems = productProblems(merged, ctx);
  if (problems.length) return { words: problems.join(' ') };
  return { change: { target: 'product', entity_id: productId, location_id: null, op: 'update', after, before } };
}

/**
 * A new product, sold at the sites ticked.
 *   id       a new uuid for it
 *   fields   the product's fields
 *   sites    [{ location_id, active, price }]   where it goes on sale (price null = the default)
 * Returns { changes } or { words }. The product create comes first, so the database sees it
 * before the sites that point at it.
 */
export function newProductChanges(ctx, { id, fields, sites }) {
  if (!id) return { words: 'No id for the new product.' };
  if (findProduct(ctx.eff, id)) return { words: 'That product already exists.' };
  const f = { ...(fields || {}), id };
  const problems = productProblems(f, ctx);
  if (problems.length) return { words: problems.join(' ') };
  const siteOnly = f.site_only_location_id || null;
  const known = new Set(listOf(ctx.eff?.sites).map((s) => s.location_id));
  const chosen = listOf(sites).filter((s) => s && known.has(s.location_id) && (!siteOnly || s.location_id === siteOnly));
  if (siteOnly && !chosen.length) chosen.push({ location_id: siteOnly, active: true, price: null });
  // Round 2: a sub item only used as an option goes to a site only where an option needs it
  // (publish adds it there), so it needs no site of its own.
  const optionOnly = f.type === 'subitem' && f.sold_alone !== true;
  if (optionOnly) chosen.length = 0;
  else if (!chosen.length) return { words: 'Pick at least one site to sell it at.' };
  const after = {
    name: String(f.name).trim(), menu_name: f.menu_name ? String(f.menu_name).trim() : String(f.name).trim(),
    receipt_name: f.receipt_name ? String(f.receipt_name).trim() : null, kitchen_name: f.kitchen_name ? String(f.kitchen_name).trim() : null,
    description: f.description || '', category_id: f.category_id, extra_category_ids: listOf(f.extra_category_ids),
    parent_product_id: f.parent_product_id || null, type: f.type || 'simple',
    default_price: fromPence(toPence(f.default_price)), default_channels: f.default_channels || null,
    tax_rate_name: f.tax_rate_name ?? null, tax_rate_percent: f.tax_rate_percent == null || f.tax_rate_percent === '' ? null : Number(f.tax_rate_percent),
    allergens: listOf(f.allergens), tags: listOf(f.tags), image: f.image || null, modifier_groups: listOf(f.modifier_groups),
    visibility: f.visibility || { pos: true, kiosk: true, online: true, onlineDelivery: true },
    sold_alone: f.type === 'subitem' ? f.sold_alone === true : f.sold_alone !== false, item_code: f.item_code ? String(f.item_code).trim() : null,
    site_only_location_id: siteOnly, archived: false, sort_order: newSortOrder(ctx, f),
  };
  const tbt = f.tax_by_type && typeof f.tax_by_type === 'object' && Object.keys(f.tax_by_type).length ? clone(f.tax_by_type) : null;
  if (tbt) after.tax_by_type = tbt;
  if (optionOnly) { after.category_id = f.category_id || null; after.visibility = { pos: false, kiosk: false, online: false, onlineDelivery: false }; }
  const product = { id, family_base: null };
  const changes = [{ target: 'product', entity_id: id, location_id: null, op: 'create', after, before: {} }];
  for (const s of chosen) {
    const price = s.price == null || s.price === '' || samePrice(s.price, after.default_price) ? null : fromPence(toPence(s.price));
    if (price != null && price < 0) return { words: 'A price cannot be below zero.' };
    changes.push({
      target: 'product_site', entity_id: id, location_id: s.location_id, op: 'create',
      after: { venue_item_id: newItemId(product, s.location_id), active: s.active !== false, price, channel_prices: null }, before: {},
    });
  }
  return { changes };
}

// A new product goes LAST in its category (a new size last among its product's sizes), as Menu
// Manager adds one, not first at every till (17 Oct verification). A number the form gives wins.
function newSortOrder(ctx, f) {
  if (f.sort_order !== undefined && f.sort_order !== null && f.sort_order !== '' && Number.isFinite(Number(f.sort_order))) return Number(f.sort_order);
  const parent = f.parent_product_id || null;
  const peers = listOf(ctx.eff?.products).filter((p) => !p.archived && (parent ? p.parent_product_id === parent : (!p.parent_product_id && p.category_id === f.category_id)));
  return peers.reduce((m, p) => Math.max(m, Number(p.sort_order) || 0), -1) + 1;
}

/**
 * The sheet's Name box (17 Oct verification): the menu, receipt and kitchen names that still say
 * the old name (or are blank) follow the new name, as Menu Manager's rename does, so the till
 * button, the receipt and the kitchen ticket change too. A name set on purpose is left alone.
 */
export function renameFields(form, name) {
  const out = { ...(form || {}), name };
  const old = String(form?.name ?? '').trim();
  for (const k of ['menu_name', 'receipt_name', 'kitchen_name']) {
    const cur = form?.[k];
    if (cur == null || String(cur).trim() === '' || String(cur).trim() === old) out[k] = name;
  }
  return out;
}

/** Take a product off the group menu everywhere (archived, never deleted). */
export function removeProductChange(ctx, productId) {
  const p = findProduct(ctx.eff, productId);
  if (!p) return { words: 'That product is not in the group menu.' };
  if (p.archived) return { change: null };
  const liveP = findProduct(ctx.live, productId);
  return { change: { target: 'product', entity_id: productId, location_id: null, op: 'update', after: { archived: true }, before: { archived: liveP ? !!liveP.archived : false } } };
}

/** Bring a removed product back. */
export function restoreProductChange(ctx, productId) {
  const p = findProduct(ctx.eff, productId);
  if (!p || !p.archived) return { change: null };
  const liveP = findProduct(ctx.live, productId);
  return { change: { target: 'product', entity_id: productId, location_id: null, op: 'update', after: { archived: false }, before: { archived: liveP ? !!liveP.archived : true } } };
}

/** Stop a site keeping its own value for a column, so the group's is used there. */
export function groupValueChange(ctx, productId, locationId, column) {
  const s = findSite(ctx.eff, productId, locationId);
  if (!s || !s.kept || !has(s.kept, column)) return { change: null };
  const kept = { ...s.kept };
  delete kept[column];
  const liveS = findSite(ctx.live, productId, locationId);
  return { change: { target: 'product_site', entity_id: productId, location_id: locationId, op: 'update', after: { kept }, before: { kept: clone(liveS?.kept ?? {}) } } };
}

// ── Categories ──────────────────────────────────────────────────────────────

/**
 * A new category. A top level one must say which existing category it is sent like (printers and
 * kitchen screens), or the tills would print nothing for it (design review, blocker 1).
 * Returns { change } or { words }.
 */
export function newCategoryChange(ctx, { id, label, parent_id = null, route_like_id = null, icon = null, color = null }) {
  const name = String(label ?? '').trim();
  if (!id) return { words: 'No id for the new category.' };
  if (!name) return { words: 'Give the category a name.' };
  if (name.length > 80) return { words: 'The name is too long (80 letters at most).' };
  if (parent_id && !findCategory(ctx.eff, parent_id)) return { words: 'Pick a category to put it under.' };
  if (!parent_id && !route_like_id) return { words: 'Pick which category it prints like, so the kitchen gets its tickets.' };
  if (route_like_id && !findCategory(ctx.eff, route_like_id)) return { words: 'Pick which category it prints like.' };
  const siblings = listOf(ctx.eff?.categories).filter((c) => (c.parent_id || null) === (parent_id || null));
  const sort = siblings.reduce((m, c) => Math.max(m, Number(c.sort_order) || 0), 0) + 1;
  return {
    change: {
      target: 'category', entity_id: id, location_id: null, op: 'create',
      after: { label: name, parent_id: parent_id || null, route_like_id: route_like_id || null, icon: icon || null, color: color || null, accounting_group: '', default_course: 1, sort_order: sort, image: null, archived: false },
      before: {},
    },
  };
}

/**
 * Rename a category the group menu has (5.12.110). Peter, 26 Nov 2026: the names could not be
 * changed in the Multi site menu, "also in categories". The new name goes to that category at
 * every site when the draft is published. Its place and colour stay as each site has them.
 * Returns { change } (null when the name is the same), or { words }.
 */
export function categoryRenameChange(ctx, categoryId, label) {
  const c = findCategory(ctx.eff, categoryId);
  if (!c) return { words: 'That category is not in the group menu.' };
  if (c.archived) return { words: 'That category has been taken off the group menu. Bring it back first.' };
  const name = String(label ?? '').trim();
  if (!name) return { words: 'Give the category a name.' };
  if (name.length > 80) return { words: 'The name is too long (80 letters at most).' };
  if (name === String(c.label ?? '').trim()) return { change: null };
  // Two categories with one name in the same place cannot be told apart on the POS or in reports.
  const twin = listOf(ctx.eff?.categories).find((x) => x.id !== categoryId && !x.archived
    && (x.parent_id || null) === (c.parent_id || null) && String(x.label ?? '').trim().toLowerCase() === name.toLowerCase());
  if (twin) return { words: `There is already a category called ${twin.label} here. Pick another name.` };
  const liveC = findCategory(ctx.live, categoryId);
  return { change: { target: 'category', entity_id: categoryId, location_id: null, op: 'update', after: { label: name }, before: { label: liveC ? liveC.label ?? null : null } } };
}

// ── SEVERAL MENUS in one group menu (5.12.116, _shared/msmMenus.js) ─────────
// Peter, 26 Nov 2026: "I like the different menus but need to be able to manage centrally in multi
// site". The group menu's other menus are one list on the menu itself, so every edit of it is ONE
// staged change (target menu, field extra_menus) with the whole list.

const menusChange = (ctx, rows) => ({
  target: 'menu', entity_id: ctx.eff?.menu?.id || ctx.live?.menu?.id || null, location_id: null, op: 'update',
  after: { extra_menus: extraMenusValue(rows) }, before: { extra_menus: extraMenusValue(allExtraMenus(ctx.live?.menu)) },
});
const catMap = (central) => new Map(listOf(central?.categories).map((c) => [c.id, c]));

/** Has this database had 20261214a? (the group menu row carries the new list) */
export const menusReady = (central) => !!central?.menu && Array.isArray(central.menu.extra_menus);

/**
 * Add a menu to the group menu.
 *   name        "Catering"
 *   opts        { idGen, venueMenus: every site's own menus rows, onVenueMenus: [{ menu_id, category_id }]
 *                 for the matched menus: the site categories on them (home or link) }
 * A site that already has a menu of that name keeps it: the new menu is matched to it, and every
 * group category that is on it at any such site is ticked in, so publishing takes nothing off it.
 * Returns { changes: [..], id, matched: [locationIds], ticked: [labels] } or { words }.
 */
export function addMenuChanges(ctx, name, opts = {}) {
  const menu = ctx.eff?.menu;
  if (!menu) return { words: 'The group menu is not loaded yet. Try again.' };
  const bad = extraMenuNameProblem(menu, name);
  if (bad) return { words: bad };
  const id = (opts.idGen || (() => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : null)))();
  if (!id) return { words: 'Could not make an id for the menu. Try again.' };
  const siteIds = new Set(listOf(ctx.eff?.sites).map((x) => x.location_id));
  const taken = [...listOf(ctx.eff?.sites).map((x) => x.venue_menu_id), ...allExtraMenus(menu).flatMap((m) => Object.values(m.sites).filter((v) => typeof v === 'string'))];
  const matched = matchSiteMenus(name, listOf(opts.venueMenus).filter((m) => m && siteIds.has(m.location_id)), taken);
  const rows = [...allExtraMenus(menu), newExtraMenu(id, name, matched)];
  const changes = [menusChange(ctx, rows)];
  // The group categories already on a matched menu at a site come in ticked.
  const venueToGroup = new Map(listOf(ctx.eff?.catSites).map((cs) => [`${cs.location_id}|${cs.venue_category_id}`, cs.category_id]));
  const matchedLoc = new Map(Object.entries(matched).map(([loc, mid]) => [mid, loc]));
  const cats = catMap(ctx.eff);
  const menuAfter = { ...menu, extra_menus: extraMenusValue(rows) };
  const tick = new Set();
  for (const l of listOf(opts.onVenueMenus)) {
    const loc = matchedLoc.get(l && l.menu_id);
    if (!loc) continue;
    const gid = venueToGroup.get(`${loc}|${l.category_id}`);
    const root = gid ? rootCategory(cats.get(gid), cats) : null;
    if (root && !root.archived) tick.add(root.id);
  }
  const ticked = [];
  for (const cid of tick) {
    const c = cats.get(cid);
    const liveC = findCategory(ctx.live, cid);
    const keys = [...menuKeysOf(c, cats, menuAfter), id];
    changes.push({ target: 'category', entity_id: cid, location_id: null, op: 'update', after: { menu_keys: menuKeysValue(keys, menuAfter) }, before: { menu_keys: liveC ? liveC.menu_keys ?? null : null } });
    ticked.push(c.label);
  }
  return { changes, id, matched: Object.keys(matched), ticked };
}

/** Rename one of the group's other menus (the group menu's own name for it; a site's menu keeps its name). */
export function renameMenuChange(ctx, id, name) {
  const menu = ctx.eff?.menu;
  const rows = allExtraMenus(menu);
  const row = rows.find((m) => m.id === id && !m.archived);
  if (!row) return { words: 'That menu is not in the group menu.' };
  const bad = extraMenuNameProblem(menu, name, id);
  if (bad) return { words: bad };
  const n = String(name).trim();
  if (n === row.name) return { change: null };
  return { change: menusChange(ctx, rows.map((m) => (m.id === id ? { ...m, name: n } : m))) };
}

/**
 * Remove one of the group's other menus. Refused while a category is ONLY on it (it would be on no
 * menu at all): move or remove those first. Publishing takes the group's categories off that menu
 * at every site; the site's menu itself stays, as the site's own.
 */
export function removeMenuChange(ctx, id) {
  const menu = ctx.eff?.menu;
  const rows = allExtraMenus(menu);
  const row = rows.find((m) => m.id === id && !m.archived);
  if (!row) return { words: 'That menu is not in the group menu.' };
  const cats = catMap(ctx.eff);
  const only = listOf(ctx.eff?.categories).filter((c) => c && !c.archived && !c.parent_id && menuKeysOf(c, cats, menu).join('|') === id);
  if (only.length) {
    const names = only.slice(0, 4).map((c) => c.label).join(', ');
    return { words: `${only.length === 1 ? 'A category is' : `${only.length} categories are`} only on ${row.name}: ${names}${only.length > 4 ? ' and more' : ''}. Tick ${only.length === 1 ? 'it' : 'them'} into another menu, or remove ${only.length === 1 ? 'it' : 'them'}, first.` };
  }
  // A menu never published (not in the live group menu) just leaves the list; one that was
  // published stays in it as removed, so publish knows which site menus to take the categories off.
  const wasLive = allExtraMenus(ctx.live?.menu).some((m) => m.id === id);
  const next = wasLive ? rows.map((m) => (m.id === id ? { ...m, archived: true } : m)) : rows.filter((m) => m.id !== id);
  const changes = [menusChange(ctx, next)];
  const menuAfter = { ...menu, extra_menus: extraMenusValue(next) };
  for (const c of listOf(ctx.eff?.categories)) {
    if (!c || !Array.isArray(c.menu_keys) || !c.menu_keys.includes(id)) continue;
    const liveC = findCategory(ctx.live, c.id);
    changes.push({ target: 'category', entity_id: c.id, location_id: null, op: 'update', after: { menu_keys: menuKeysValue(c.menu_keys.filter((k) => k !== id), menuAfter) }, before: { menu_keys: liveC ? liveC.menu_keys ?? null : null } });
  }
  return { changes, name: row.name };
}

/**
 * Which of a site's own menus one of the group's other menus is.
 *   value   a venue menu id (use that menu), false (this site does not have the menu), or null
 *           (publish makes one, or uses the one it made before)
 */
export function menuSiteChange(ctx, id, locationId, value) {
  const rows = allExtraMenus(ctx.eff?.menu);
  const row = rows.find((m) => m.id === id && !m.archived);
  if (!row) return { words: 'That menu is not in the group menu.' };
  if (!listOf(ctx.eff?.sites).some((x) => x.location_id === locationId)) return { words: 'That site is not in the group menu.' };
  if (typeof value === 'string') {
    if (listOf(ctx.eff?.sites).some((x) => x.venue_menu_id === value)) return { words: 'That is the menu the group menu already writes its main menu into. Pick another.' };
    if (rows.some((m) => m.id !== id && !m.archived && m.sites[locationId] === value)) return { words: 'Another of the group\'s menus already uses that menu at this site.' };
  }
  const sites = { ...row.sites };
  if (value === null || value === undefined) delete sites[locationId]; else sites[locationId] = value;
  if (JSON.stringify(sites) === JSON.stringify(row.sites)) return { change: null };
  return { change: menusChange(ctx, rows.map((m) => (m.id === id ? { ...m, sites } : m))) };
}

/**
 * Tick a category on to, or off, one of the group's menus. Set on its TOP category (a sub category
 * is on the menus its top category is on). Returns { change, words? } or { words }.
 */
export function categoryMenuChange(ctx, categoryId, key, on) {
  const cats = catMap(ctx.eff);
  const c = rootCategory(cats.get(categoryId), cats);
  if (!c) return { words: 'That category is not in the group menu.' };
  if (c.archived) return { words: 'That category has been taken off the group menu. Bring it back first.' };
  const menu = ctx.eff?.menu;
  if (key !== MAIN_MENU && !extraMenus(menu).some((m) => m.id === key)) return { words: 'That menu is not in the group menu.' };
  const r = toggleMenuKey(c, cats, menu, key, on);
  if (!r.ok) return { words: r.words };
  const liveC = findCategory(ctx.live, c.id);
  const was = c.menu_keys ?? null;
  if (JSON.stringify(was) === JSON.stringify(r.value)) return { change: null };
  const change = { target: 'category', entity_id: c.id, location_id: null, op: 'update', after: { menu_keys: r.value }, before: { menu_keys: liveC ? liveC.menu_keys ?? null : null } };
  return { change, label: c.label, words: `${c.label} is now on ${menuKeysWords(r.value || [MAIN_MENU], menu)}.` };
}

// ── "Shows on" for a whole category (5.12.116, lib/soldAs.js) ───────────────
// Peter, 26 Nov 2026: "I dont want certain categories to show at all ... the less menus the
// better". The rule is on each product; a category row sets it for every product in it at once.

/** The products a category row speaks for: in it or under it, sold on their own, not sizes. */
export function categoryProducts(central, categoryId) {
  const cats = listOf(central?.categories);
  const inside = new Set([categoryId]);
  let grew = true;
  while (grew) { grew = false; for (const c of cats) if (c && c.parent_id && inside.has(c.parent_id) && !inside.has(c.id)) { inside.add(c.id); grew = true; } }
  return listOf(central?.products).filter((p) => p && !p.archived && !p.parent_product_id && inside.has(p.category_id) && !isOptionOnlyItem(p));
}

/** Where a category's products show: { pos: 'on' | 'off' | 'mixed', ... } and how many products. */
export function categoryShownOn(central, categoryId) {
  const list = categoryProducts(central, categoryId);
  const out = { count: list.length };
  for (const k of SHOWN_ON_KEYS) {
    const hidden = list.filter((p) => notShownOn(p).includes(k)).length;
    out[k] = !list.length || hidden === 0 ? 'on' : hidden === list.length ? 'off' : 'mixed';
  }
  return out;
}

/** Hide (or show again) every product of a category in one place. Returns { changes, count, words }. */
export function categoryShownOnChanges(ctx, categoryId, key, shown) {
  if (!SHOWN_ON_KEYS.includes(key)) return { words: 'That is not somewhere a product shows.' };
  const c = findCategory(ctx.eff, categoryId);
  if (!c) return { words: 'That category is not in the group menu.' };
  const list = categoryProducts(ctx.eff, categoryId);
  if (!list.length) return { words: `${c.label} has no products yet.` };
  const changes = [];
  for (const p of list) {
    const r = productUpdate(ctx, p.id, { visibility: toggleShownOn(p.visibility ?? null, key, shown) ?? {} });
    if (r.change) changes.push(r.change);
  }
  const where = SHOWN_ON_WORDS[key];
  const n = changes.length;
  return { changes, count: n, words: shown ? `${c.label}: ${plural(n, 'product')} ${n === 1 ? 'shows' : 'show'} on ${where} again.` : `${c.label}: ${plural(n, 'product')} ${n === 1 ? 'is' : 'are'} hidden on ${where}.` };
}

/** Where one of the group's other menus is at a site, in words, for Menu details. */
export function menuAtSiteWords(extra, locationId, venueMenus) {
  const at = extraMenuAt(extra, locationId, venueMenus);
  const nameOf = (id) => (venueMenus && typeof venueMenus.get === 'function' ? venueMenus.get(id)?.name : null) || 'its own';
  if (at.off) return 'Not at this site';
  if (at.how === 'matched') return `Uses the site's own ${nameOf(at.id)} menu`;
  if (at.how === 'made') return `Uses the ${nameOf(at.id)} menu publish made here`;
  return 'A menu is made here on the first publish that needs it';
}

/** The database's words from before 20261214a ran, turned into what to do about it. */
export function menusGuardWords(words) {
  const w = String(words || '');
  if (/cannot be changed here: (extra_menus|menu_keys)/.test(w)) return 'More than one menu needs one database update that has not been run yet (SQL 20261214a). Nothing was changed. Ask ServOS to run it.';
  return w;
}

/**
 * The database's words from before 20261211a ran (it still refuses a category name), turned into
 * what to do about it. Any other words come back as they are.
 */
export function categoryGuardWords(words) {
  const w = String(words || '');
  if (w.includes(CATEGORY_RULE_OLD_WORDS)) return 'Renaming a category needs one database update that has not been run yet (SQL 20261211a). Nothing was changed. Ask ServOS to run it.';
  // 5.12.112: the database's words from before 20261213a ran (it knows three kinds of choice).
  if (w.includes(KINDS_RULE_OLD_WORDS)) return 'Each option only once needs one database update that has not been run yet (SQL 20261213a). Nothing was changed. Ask ServOS to run it.';
  return words;
}
// What msm_changes_guard says to a kind of choice it does not know (20261017c, as run on Ops).
export const KINDS_RULE_OLD_WORDS = 'Pick one choice, several choices, or the same choice more than once.';

// ── Many at once (the bulk bar) ─────────────────────────────────────────────

const collect = (results) => {
  const changes = [];
  const words = [];
  for (const r of results) {
    if (r.words) words.push(r.words);
    else if (r.change) changes.push(r.change, ...(r.extra || []));
    else if (r.changes) changes.push(...r.changes);
  }
  return { changes, words: [...new Set(words)] };
};

/** On or off for products at sites. */
export function activeMany(ctx, productIds, locationIds, active) {
  const out = [];
  for (const pid of listOf(productIds)) for (const loc of listOf(locationIds)) out.push(siteActiveChange(ctx, pid, loc, active));
  const r = collect(out);
  // Several products taken out of the draft together at a site: an option group only they needed
  // goes too (each one alone still saw the others needing it).
  if (!active) {
    const byLoc = new Map();
    for (const c of r.changes) if (c.dropCreate && c.target === 'product_site') byLoc.set(c.location_id, [...(byLoc.get(c.location_id) || []), c.entity_id]);
    for (const [loc, ids] of byLoc) r.changes.push(...droppedOptionRows(ctx, loc, ids));
  }
  // One change per product (or product and site), however many ticks reach it: the old "one site
  // only" mark is cleared once, and a size and its product ticked together are turned on once.
  const seen = new Set();
  r.changes = r.changes.filter((c) => { const k = `${c.target}|${c.entity_id}|${c.location_id || ''}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return r;
}

/** One price for products at sites (null = follow the group's price). */
export function priceMany(ctx, productIds, locationIds, value, channel = null) {
  const out = [];
  for (const pid of listOf(productIds)) for (const loc of listOf(locationIds)) {
    if (!findSite(ctx.eff, pid, loc)) { out.push({ words: 'Some products are not sold at those sites. Turn them on there first.' }); continue; }
    out.push(sitePriceChange(ctx, pid, loc, value, channel));
  }
  return collect(out);
}

/** Copy each product's price at one site to other sites. */
export function copyPricesMany(ctx, productIds, fromLoc, toLocs, channel = null) {
  const out = [];
  for (const pid of listOf(productIds)) {
    const p = findProduct(ctx.eff, pid);
    const src = findSite(ctx.eff, pid, fromLoc);
    if (!p) continue;
    // Never a silent skip (UI issue 10): say why nothing was copied.
    if (!src) { out.push({ words: 'Some products are not sold at the site you copy from. Turn them on there first.' }); continue; }
    // A site with no price has none to copy (17 Oct recheck): never the group price in its place.
    if (noPriceAt(p, src, channel)) { out.push({ words: 'Some products have no price at the site you copy from, so nothing was copied for them.' }); continue; }
    const v = sitePrice(p, src, channel);
    for (const loc of listOf(toLocs)) {
      if (loc === fromLoc) continue;
      if (!findSite(ctx.eff, pid, loc)) { out.push({ words: 'Some products are not sold at those sites. Turn them on there first.' }); continue; }
      out.push(sitePriceChange(ctx, pid, loc, v, channel));
    }
  }
  return collect(out);
}

/** Move products to a category (their sizes move with them). */
export function moveMany(ctx, productIds, categoryId) {
  if (!findCategory(ctx.eff, categoryId)) return { changes: [], words: ['Pick a category.'] };
  const ids = new Set(listOf(productIds));
  for (const p of listOf(ctx.eff?.products)) if (p.parent_product_id && ids.has(p.parent_product_id)) ids.add(p.id);
  return collect([...ids].map((pid) => productUpdate(ctx, pid, { category_id: categoryId })));
}

/** Paste a column of prices down the grid from one row: [{ productId, value }] at one site. */
export function pasteColumn(ctx, cells, locationId, channel = null) {
  const out = [];
  for (const c of listOf(cells)) {
    if (c.value == null) continue;
    out.push(locationId ? sitePriceChange(ctx, c.productId, locationId, c.value, channel) : defaultPriceChange(ctx, c.productId, c.value, channel));
  }
  return collect(out);
}

// ── Tax choices ─────────────────────────────────────────────────────────────

/** The VAT rates the group menu uses, by name and rate: [{ name, percent, label }]. */
export function taxChoices(central) {
  const seen = new Map();
  for (const p of listOf(central?.products)) {
    if (p.tax_rate_percent == null) continue;
    const k = `${p.tax_rate_name || ''}|${Number(p.tax_rate_percent)}`;
    if (!seen.has(k)) seen.set(k, { name: p.tax_rate_name || null, percent: Number(p.tax_rate_percent), n: 0 });
    seen.get(k).n++;
  }
  return [...seen.values()].sort((a, b) => b.n - a.n).map((t) => ({ name: t.name, percent: t.percent, label: `${t.name ? `${t.name} ` : ''}${pctText(t.percent)}` }));
}

// ── Change prices: the before of each change ────────────────────────────────

/**
 * The Change prices maths (msmPrice.applyPriceChange) works on what the grid shows (the draft
 * applied) and returns changes with no `before`. This adds the published value of each field, so
 * the draft remembers where it started (and setting a price back clears the staged row).
 */
export function withBefore(live, changes) {
  return listOf(changes).map((c) => {
    const before = {};
    if (c.target === 'product') {
      const p = findProduct(live, c.entity_id);
      for (const k of Object.keys(c.after || {})) before[k] = p ? clone(p[k] ?? null) : null;
    } else if (c.target === 'product_site') {
      const s = findSite(live, c.entity_id, c.location_id);
      for (const k of Object.keys(c.after || {})) before[k] = s ? clone(s[k] ?? null) : null;
    } else if (c.target === 'modifier_option') {
      // Round 2: Change prices on option groups.
      const o = listOf(live?.options).find((x) => x.id === c.entity_id);
      for (const k of Object.keys(c.after || {})) before[k] = o ? clone(o[k] ?? null) : null;
    } else if (c.target === 'modifier_option_site') {
      const os = listOf(live?.optionSites).find((x) => x.option_id === c.entity_id && x.location_id === c.location_id);
      for (const k of Object.keys(c.after || {})) before[k] = os ? clone(os[k] ?? null) : null;
    }
    return { ...c, before };
  });
}

/**
 * Leave out what the person unticked in the preview.
 *   offProducts   Set of product ids unticked (every change of that product goes)
 *   offSites      Set of `${productId}|${locationId}` unticked (that site's own price is left)
 */
export function withoutUnticked(changes, offProducts = new Set(), offSites = new Set()) {
  return listOf(changes).filter((c) => !offProducts.has(c.entity_id) && !((c.target === 'product_site' || c.target === 'modifier_option_site') && offSites.has(`${c.entity_id}|${c.location_id}`)));
}

/**
 * The storage name for a product photo upload (before the extension): a NEW object every time, so
 * a photo replaced in a draft never changes the photo the sites show today (the last publish points
 * at the old object); only publishing the draft moves them to the new one (round 2 review).
 */
export function photoObjectId(productId, now = Date.now()) {
  return `msm-${hex12(productId)}-${Number(now).toString(36)}`;
}
