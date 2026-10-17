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
//     new venue id in the sharing engine's scheme (msmModel.newItemId). A site only extra belongs
//     to its one site and is never added elsewhere.
//   * Nothing is ever deleted: "remove" is archived, off is active false.

import { STAGE_FIELDS, CHANNELS, has, sameValue, samePrice, newItemId, toPence, fromPence, channelFallback } from '../../../supabase/functions/_shared/msmModel.js';

const listOf = (v) => (Array.isArray(v) ? v : []);
const findProduct = (c, id) => listOf(c?.products).find((p) => p.id === id) || null;
const findSite = (c, pid, loc) => listOf(c?.productSites).find((s) => s.product_id === pid && s.location_id === loc) || null;
const findCategory = (c, id) => listOf(c?.categories).find((x) => x.id === id) || null;
const okChannel = (ch) => (ch && CHANNELS.includes(ch) ? ch : null);
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
  const p = findProduct(ctx.eff, productId);
  if (!p) return { words: 'That product is not in the group menu.' };
  const s = findSite(ctx.eff, productId, locationId);
  if (!s) {
    if (!active) return { change: null };
    if (p.site_only_location_id && p.site_only_location_id !== locationId) return { words: 'This is another site\'s own extra. Make a new product to sell it here too.' };
    if (!listOf(ctx.eff?.sites).some((x) => x.location_id === locationId)) return { words: 'That site is not in the group menu yet.' };
    return { change: { target: 'product_site', entity_id: productId, location_id: locationId, op: 'create', after: { venue_item_id: newItemId(p, locationId), active: true, price: null, channel_prices: null }, before: {} } };
  }
  if ((s.active !== false) === !!active) return { change: null };
  const liveS = findSite(ctx.live, productId, locationId);
  return { change: { target: 'product_site', entity_id: productId, location_id: locationId, op: 'update', after: { active: !!active }, before: { active: liveS ? liveS.active !== false : null } } };
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

/** Plain words for what is wrong with a product's fields ([] when nothing). */
export function productProblems(fields, ctx = {}) {
  const out = [];
  const f = fields || {};
  const name = String(f.name ?? '').trim();
  if (!name) out.push('Give the product a name.');
  if (name.length > 120) out.push('The name is too long (120 letters at most).');
  if (!f.category_id) out.push('Pick a category.');
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
  for (const k of PRODUCT_EDITABLE) {
    if (!has(fields, k)) continue;
    if (sameValue(p[k], fields[k])) continue;
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
 * A new product (or a site only extra when fields.site_only_location_id is set).
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
  if (!chosen.length) return { words: 'Pick at least one site to sell it at.' };
  const after = {
    name: String(f.name).trim(), menu_name: f.menu_name ? String(f.menu_name).trim() : String(f.name).trim(),
    receipt_name: f.receipt_name ? String(f.receipt_name).trim() : null, kitchen_name: f.kitchen_name ? String(f.kitchen_name).trim() : null,
    description: f.description || '', category_id: f.category_id, extra_category_ids: listOf(f.extra_category_ids),
    parent_product_id: f.parent_product_id || null, type: f.type || 'simple',
    default_price: fromPence(toPence(f.default_price)), default_channels: f.default_channels || null,
    tax_rate_name: f.tax_rate_name ?? null, tax_rate_percent: f.tax_rate_percent == null || f.tax_rate_percent === '' ? null : Number(f.tax_rate_percent),
    allergens: listOf(f.allergens), tags: listOf(f.tags), image: f.image || null, modifier_groups: listOf(f.modifier_groups),
    visibility: f.visibility || { pos: true, kiosk: true, online: true, onlineDelivery: true },
    sold_alone: f.sold_alone !== false, item_code: f.item_code ? String(f.item_code).trim() : null,
    site_only_location_id: siteOnly, archived: false, sort_order: Number(f.sort_order) || 0,
  };
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
    else if (r.change) changes.push(r.change);
    else if (r.changes) changes.push(...r.changes);
  }
  return { changes, words: [...new Set(words)] };
};

/** On or off for products at sites. */
export function activeMany(ctx, productIds, locationIds, active) {
  const out = [];
  for (const pid of listOf(productIds)) for (const loc of listOf(locationIds)) {
    const p = findProduct(ctx.eff, pid);
    if (active && p?.site_only_location_id && p.site_only_location_id !== loc) continue;   // never spread an extra
    out.push(siteActiveChange(ctx, pid, loc, active));
  }
  return collect(out);
}

/** One price for products at sites (null = follow the group's price). */
export function priceMany(ctx, productIds, locationIds, value, channel = null) {
  const out = [];
  for (const pid of listOf(productIds)) for (const loc of listOf(locationIds)) {
    if (!findSite(ctx.eff, pid, loc)) continue;
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
    if (!p || !src) continue;
    const v = sitePrice(p, src, channel);
    for (const loc of listOf(toLocs)) {
      if (loc === fromLoc || !findSite(ctx.eff, pid, loc)) continue;
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
  return [...seen.values()].sort((a, b) => b.n - a.n).map((t) => ({ name: t.name, percent: t.percent, label: `${t.name ? `${t.name} ` : ''}${t.percent}%` }));
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
  return listOf(changes).filter((c) => !offProducts.has(c.entity_id) && !(c.target === 'product_site' && offSites.has(`${c.entity_id}|${c.location_id}`)));
}
