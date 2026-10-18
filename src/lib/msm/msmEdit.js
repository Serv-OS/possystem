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

import { STAGE_FIELDS, CHANNELS, has, sameValue, samePrice, newItemId, toPence, fromPence, channelFallback, hex12, pctText } from '../../../supabase/functions/_shared/msmModel.js';
import { optionRowsForNewSites } from './msmGroupEdit.js';

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

/** The price a site charges now (In store or a channel). */
export function sitePrice(product, site, channel = null) {
  const ch = okChannel(channel);
  if (!site) return null;
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
  if (p.type === 'variants') return { words: VARIANTS_WORDS };
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
  if (hasSizes(ctx.eff, p)) {
    for (const size of listOf(ctx.eff?.products).filter((x) => x.parent_product_id === p.id && !x.archived)) {
      const sr = siteActiveOne(ctx, size.id, locationId, active);
      if (sr.change) more.push(sr.change, ...(sr.extra || []));
    }
  }
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
  if (p.type === 'subitem' && p.sold_alone !== true) return [];
  const want = new Set(listOf(p.modifier_groups).map(gidOf).filter(Boolean));
  for (let round = 0; round < 10; round++) {
    const n = want.size;
    for (const o of listOf(ctx.eff?.options)) if (!o.archived && o.sub_group_id && want.has(o.group_id)) want.add(o.sub_group_id);
    if (want.size === n) break;
  }
  const out = [];
  for (const gid of want) {
    if (listOf(ctx.eff?.groupSites).some((r) => r.group_id === gid && r.location_id === locationId)) continue;
    out.push(...optionRowsForNewSites(ctx, gid, [locationId]));
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
  if (p.type === 'variants') return { words: VARIANTS_WORDS };
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
  const needsTax = listOf(ctx.eff?.products).some((p) => p.tax_rate_name || p.tax_rate_percent != null);
  if (needsTax && (f.tax_rate_percent == null || f.tax_rate_percent === '')) out.push('Pick the VAT rate.');
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
