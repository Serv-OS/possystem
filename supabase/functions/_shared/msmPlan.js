// supabase/functions/_shared/msmPlan.js
//
// MULTI SITE MENU (17 Oct 2026, v5.11.75): THE PLANNER. Given the central menu (as it stands
// once a change set is applied), the list of what that set touched, and ONE venue's rows as the
// database holds them, it works out exactly which venue rows to write, and the venue as it will
// look afterwards. Pure: the screen previews with it, the msm-publish function publishes with
// it, and src/lib/msm/msmPlan.test.js and msmGroups.test.js prove the rules below.
//
// THE RULES (design 1.3 to 1.11 and the design review)
//   * Only what a change touched is written. A central field the set did not touch is never
//     written, so a venue's button order, print centre, tier prices and the rest stay as they are.
//     And only columns whose value really differs: an import with no changes plans zero writes.
//   * Values come from central state at run time; the set only says which fields to touch.
//   * Ids never change: an existing venue row is updated in place by its own id. New rows get
//     <base>_<last 8 of the venue id> (msmModel.js).
//   * A kept venue value (msm_product_sites.kept) is never written at that site, unless a change
//     clears it there ("Use the group's").
//   * Tax maps by name and rate, then by the only venue rate with that percent, else a blocking
//     problem. Never a foreign id (the 27 Sep tax lesson).
//   * A category is created at a site the first time a product needs it there (parents first),
//     with its menu link. Removing a category takes it OFF the venue menu (menu_id cleared, link
//     removed); it is never deleted. A category a venue emptied or deleted by hand is never
//     filled or re-added unless a change says so (the 29 Sep hand removed category lesson).
//   * A NEW venue category must be sent to a printer or KDS: through a parent that routes, or
//     by "Send like <category>" (route_like_id), which adds it to every centre that takes that
//     category. Otherwise it is a blocking problem (review blocker 1: a till has no fallback).
//   * Venue products that are not in the central menu are left alone, always.
//   * pricing is written as a patch of base and channel keys only; pricing.menus is never touched.
//
// ROUND 2 (option groups, sub items, VAT per order type)
//   * An option group is written IN PLACE by the venue's own group id. Its name and rules only when
//     a change touched them (and the site does not keep its own). Its options ONE BY ONE, matched
//     by the venue option id (msm_modifier_option_sites.venue_option_id): a patch of only the keys a
//     change touched (a price change writes only the price), an add with the place it goes, or a
//     leave out when the option is off at that site. Options the group menu does not know (added at
//     the venue) stay exactly where they are. Turning an option back on puts back the SAME id.
//   * A new option id is `opt-msm-<12 hex>`, recorded centrally in the same transaction
//     (writes.maps.options); an entry that already carries that id is adopted, never doubled.
//   * No option site row means "off at that site".
//   * An option on at a site whose sub item is not there: the sub item is added there in the same
//     write, as an option only sub item (type subitem, not sold on its own, hidden everywhere), and
//     recorded centrally (writes.maps.items). Never a missing or foreign item id.
//   * "Then ask" (subGroupId) is mapped to that site's own group, created first when it lacks it;
//     a loop is blocking.
//   * A group removed from the group menu is NEVER deleted at a venue: it is taken off the group
//     menu's products there. A site's own products that use it keep it (and are listed).
//   * The round 1 rule "an option's price follows its sub item" is GONE (it would have rewritten 357
//     live option prices). Option prices are set on the option.
//   * VAT per order type: only the four keys (dine-in, takeaway, delivery, bar), one by one, as a
//     patch the database applies to the row it locked; every other key and every explicit null the
//     site has stays as it is (msmTax.js). A size with overrides of its own gets the full set.
//     A tax profile that is still a generated copy of the item's own rate is cleared (it hid the
//     order type VAT), and can be put back later; a real profile blocks, in words.

import {
  PUBLISHED_CHANNELS, ORDER_TYPE_TAX_KEYS, PRODUCT_COLUMN, has, sameValue, samePrice,
  newCategoryId, newMenuId, newGroupId, longCategoryId, longMenuId, longGroupId, newOptionId, longOptionId,
  newItemId, freeId, money2, toPence, KEPT_COLUMNS,
} from './msmModel.js';
import { mapRateDescriptor, effectiveTaxByType, venueProfileIsMirror, TAX_KEY_LABEL } from './msmTax.js';

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const listOf = (v) => (Array.isArray(v) ? v : []);
const gidOf = (a) => (typeof a === 'string' ? a : a && typeof a === 'object' ? (a.groupId ?? a.id ?? null) : null);

// ── The touched list, from a change set's msm_changes rows ──────────────────

/**
 * Normalise a set's changes into what the planner needs:
 *   { menu: Set(fields), sitesCreated: Set(loc), categories: Map(id -> {op, fields}),
 *     products: Map(id -> {op, fields}), productSites: Map(`${id}|${loc}` -> {op, fields, keptCleared}),
 *     groups, groupSites, options, optionSites (the same shapes, round 2) }
 * keptCleared holds the kept keys a change took away ("Use the group's"); for a product site's kept
 * tax_overrides it also holds `tax_overrides:<key>` for each order type key given back.
 */
export function touchedFromChanges(changes) {
  const t = {
    menu: new Set(), sitesCreated: new Set(), categories: new Map(), products: new Map(), productSites: new Map(),
    groups: new Map(), groupSites: new Map(), options: new Map(), optionSites: new Map(),
  };
  const merge = (map, key, op, fields, extra = {}) => {
    const cur = map.get(key) || { op: null, fields: new Set(), keptCleared: new Set() };
    // create wins over update; remove wins over everything after it
    if (op === 'create' || op === 'remove' || !cur.op) cur.op = op === 'update' && cur.op ? cur.op : op;
    for (const f of fields) cur.fields.add(f);
    for (const k of extra.keptCleared || []) cur.keptCleared.add(k);
    map.set(key, cur);
  };
  const clearedOf = (c, after) => {
    if (!has(after, 'kept')) return [];
    const was = (c.before && c.before.kept) || {};
    const now = after.kept || {};
    const out = Object.keys(was).filter((k) => !has(now, k));
    // tax_overrides is kept per order type key
    const wt = was.tax_overrides && typeof was.tax_overrides === 'object' ? was.tax_overrides : null;
    if (wt) {
      const nt = now.tax_overrides && typeof now.tax_overrides === 'object' ? now.tax_overrides : {};
      for (const k of Object.keys(wt)) if (!has(nt, k)) out.push(`tax_overrides:${k}`);
    }
    return out;
  };
  for (const c of listOf(changes)) {
    if (!c) continue;
    const after = c.after && typeof c.after === 'object' ? c.after : {};
    const fields = Object.keys(after);
    if (c.target === 'menu') fields.forEach((f) => t.menu.add(f));
    else if (c.target === 'menu_site' && c.op === 'create') t.sitesCreated.add(c.location_id);
    else if (c.target === 'category') merge(t.categories, c.entity_id, c.op, fields);
    else if (c.target === 'product') merge(t.products, c.entity_id, c.op, fields);
    else if (c.target === 'product_site') merge(t.productSites, `${c.entity_id}|${c.location_id}`, c.op, fields, { keptCleared: clearedOf(c, after) });
    else if (c.target === 'modifier_group') merge(t.groups, c.entity_id, c.op, fields);
    else if (c.target === 'modifier_group_site') merge(t.groupSites, `${c.entity_id}|${c.location_id}`, c.op, fields, { keptCleared: clearedOf(c, after) });
    else if (c.target === 'modifier_option') merge(t.options, c.entity_id, c.op, fields);
    else if (c.target === 'modifier_option_site') merge(t.optionSites, `${c.entity_id}|${c.location_id}`, c.op, fields, { keptCleared: clearedOf(c, after) });
  }
  return t;
}

// ── Routing helpers (the same rule as src/lib/productionRouting.js centresForCategory) ──

function categoryChain(catId, parentOf) {
  const chain = [];
  const seen = new Set();
  let cur = catId;
  while (cur && !seen.has(cur) && chain.length < 25) { chain.push(cur); seen.add(cur); cur = parentOf.get(cur) || null; }
  return chain;
}

export function centresFor(catId, routingRow, parentOf) {
  const centres = listOf(routingRow?.centres).filter(Boolean);
  const routing = routingRow?.routing || {};
  const chain = categoryChain(catId, parentOf);
  for (let k = 0; k < chain.length; k++) {
    const takers = centres.filter((c) => listOf(routing[c.id]?.assignedCategories).includes(chain[k]));
    if (!takers.length) continue;
    const below = chain.slice(0, k);
    return takers.filter((c) => !below.some((b) => listOf(routing[c.id]?.excludedCategories).includes(b))).map((c) => c.id);
  }
  return [];
}

// ── Tax by name and rate (design 1.3, never a foreign id) ───────────────────

export function mapTaxRate(product, taxRates) {
  const name = product?.tax_rate_name;
  const pct = product?.tax_rate_percent;
  if ((name == null || name === '') && (pct == null || pct === '')) return { id: null, ok: true };
  return mapRateDescriptor({ name, percent: pct == null || pct === '' ? null : Number(pct) }, taxRates);
}

// ── The options of a central group ──────────────────────────────────────────

/**
 * A group's options as rows, in order. A group imported before round 2 that has no option rows yet
 * (its options only in the old jsonb, before the one time refresh) gives in memory rows from that
 * jsonb, on at every site with their own ids, so a new site still gets them as round 1 did.
 * Returns { rows, legacy }.
 */
export function groupOptionRows(group, optionRows) {
  const rows = listOf(optionRows).filter((o) => o && o.group_id === group?.id)
    .sort((a, b) => (Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0)) || String(a.id).localeCompare(String(b.id)));
  if (rows.length || !listOf(group?.options).length) return { rows, legacy: false };
  return {
    legacy: true,
    rows: listOf(group.options).filter(Boolean).map((o, i) => ({
      id: `legacy:${group.id}:${i}`, group_id: group.id, name: o.name ?? 'Option', price: o.price ?? 0,
      product_id: o.productId || null, sub_group_id: null, sort_order: i, archived: false,
      _legacyVenueId: o.id ?? null,
    })),
  };
}

/** Does a central menu still need the one time option group refresh (groups with jsonb options only)? */
export function groupsNeedRefresh(central) {
  if (central?.menu && central.menu.refreshed_at) return false;
  return listOf(central?.groups).some((g) => g && !g.archived && groupOptionRows(g, central?.options).legacy);
}

// ── The planner ─────────────────────────────────────────────────────────────

/**
 * Plan one venue.
 *   central    { menu, sites, categories, catSites, groups, groupSites, options, optionSites,
 *                products, productSites } (central state with the set applied; *Sites rows carry
 *                location_id)
 *   touched    touchedFromChanges(changes), or the raw changes array
 *   locationId the venue
 *   orgId      the company (new venue rows carry it)
 *   venue      readVenueRaw(...) or the same shape: { menus, categories, items, links, groups,
 *              taxRates, taxProfiles, taxProfileLines, printRouting }
 * Returns { locationId, writes, applied, lines, problems, counts, newCategories, empty, ... }.
 *   writes    what public.msm_apply_site writes (see 20261017c for the contract)
 *   applied   the venue rows with the writes applied (for the push snapshot and the health check)
 *   lines     one per written value: { table, id, column, before, after, productId?, categoryId?, groupId? }
 *   problems  raw facts for msmHealth.js: { code, level, words, productId?, categoryId?, groupId? }
 */
export function planSite({ central, touched, locationId: loc, orgId = null, venue }) {
  const T0 = touched instanceof Map || (touched && touched.products instanceof Map) ? touched : touchedFromChanges(touched);
  const T = { groups: new Map(), groupSites: new Map(), options: new Map(), optionSites: new Map(), ...T0 };
  const C = central || {};
  const V = venue || {};
  const problems = [];
  const lines = [];
  const problem = (code, level, words, extra = {}) => problems.push({ code, level, words, location: loc, ...extra });

  // Central indexes for this site.
  const site = listOf(C.sites).find((s) => s.location_id === loc) || null;
  const catById = new Map(listOf(C.categories).map((c) => [c.id, c]));
  const catSite = new Map(listOf(C.catSites).filter((r) => r.location_id === loc).map((r) => [r.category_id, r]));
  const groupById = new Map(listOf(C.groups).map((g) => [g.id, g]));
  const groupSite = new Map(listOf(C.groupSites).filter((r) => r.location_id === loc).map((r) => [r.group_id, r]));
  const optionById = new Map(listOf(C.options).map((o) => [o.id, o]));
  const osBy = new Map(listOf(C.optionSites).filter((r) => r.location_id === loc).map((r) => [r.option_id, r]));
  const productById = new Map(listOf(C.products).map((p) => [p.id, p]));
  const psBy = new Map(listOf(C.productSites).filter((r) => r.location_id === loc).map((r) => [r.product_id, r]));
  const optionRowsCache = new Map();
  const optionsOf = (g) => { if (!optionRowsCache.has(g.id)) optionRowsCache.set(g.id, groupOptionRows(g, C.options)); return optionRowsCache.get(g.id); };

  // The venue as it will be (applied), indexed.
  const applied = {
    menus: clone(listOf(V.menus)), categories: clone(listOf(V.categories)), items: clone(listOf(V.items)),
    links: clone(listOf(V.links)), groups: clone(listOf(V.groups)), printRouting: clone(V.printRouting || null),
    taxRates: listOf(V.taxRates),
  };
  const menuById = new Map(applied.menus.map((m) => [m.id, m]));
  const vCatById = new Map(applied.categories.map((c) => [c.id, c]));
  const vItemById = new Map(applied.items.map((i) => [i.id, i]));
  const vGroupById = new Map(applied.groups.map((g) => [g.id, g]));

  const W = {
    menus: { insert: [], update: [] }, categories: { insert: [], update: [] }, items: { insert: [], update: [] },
    links: { insert: [], delete: [] }, groups: { insert: [], update: [] }, routing: [],
    maps: { categories: [], groups: [], menu_site: null, options: [], items: [] },
  };
  const upd = { menus: new Map(), categories: new Map(), items: new Map() };
  const groupUpd = new Map();               // venue group id -> { id, set, options: [ops] }
  const insertedItems = new Set();
  const writtenItems = new Set();
  const writtenGroups = new Set();
  const newCategories = [];

  const setCol = (table, row, column, value, meta = {}) => {
    if (sameValue(row[column], value)) return false;
    const map = upd[table];
    const u = map.get(row.id) || { id: row.id, set: {} };
    u.set[column] = value;
    map.set(row.id, u);
    lines.push({ table, id: row.id, column, before: clone(row[column]), after: clone(value), ...meta });
    row[column] = clone(value);
    if (table === 'items') writtenItems.add(row.id);
    return true;
  };
  const setPrice = (row, key, value, meta = {}) => {
    const cur = row.pricing && typeof row.pricing === 'object' ? row.pricing : {};
    if (samePrice(cur[key], value)) return false;
    const map = upd.items;
    const u = map.get(row.id) || { id: row.id, set: {} };
    u.pricing = u.pricing || {};
    u.pricing[key] = value == null ? null : Number(value);
    map.set(row.id, u);
    lines.push({ table: 'items', id: row.id, column: `pricing.${key}`, before: cur[key] ?? null, after: value == null ? null : Number(value), ...meta });
    row.pricing = { ...cur, [key]: value == null ? null : Number(value) };
    writtenItems.add(row.id);
    return true;
  };
  // One order type VAT key, as a patch: a rate id to set, or undefined to take the key away.
  const setTaxKey = (row, key, value, meta = {}) => {
    const cur = row.tax_overrides && typeof row.tax_overrides === 'object' ? row.tax_overrides : {};
    if (value === undefined ? !has(cur, key) : (has(cur, key) && cur[key] === value)) return false;
    const u = upd.items.get(row.id) || { id: row.id, set: {} };
    u.tax_overrides = u.tax_overrides || { set: {}, remove: [] };
    if (value === undefined) { delete u.tax_overrides.set[key]; if (!u.tax_overrides.remove.includes(key)) u.tax_overrides.remove.push(key); }
    else { u.tax_overrides.set[key] = value; u.tax_overrides.remove = u.tax_overrides.remove.filter((k) => k !== key); }
    upd.items.set(row.id, u);
    lines.push({ table: 'items', id: row.id, column: `tax_overrides.${key}`, before: has(cur, key) ? cur[key] : undefined, after: value, ...meta });
    const next = { ...cur };
    if (value === undefined) delete next[key]; else next[key] = value;
    row.tax_overrides = next;
    writtenItems.add(row.id);
    return true;
  };

  // ── 1. The venue menu this central menu writes into ───────────────────────
  let venueMenuId = site?.venue_menu_id || null;
  if (!site) {
    return finish(true);
  }
  if (!venueMenuId || !menuById.has(venueMenuId)) {
    if (!T.sitesCreated.has(loc)) {
      problem('no_venue_menu', 'block', venueMenuId
        // Menu details cannot re pick a site's menu yet (UI issue 12b): say what really helps.
        ? 'The site\'s own menu that the group menu writes into was deleted at the site, so nothing is written here. Ask ServOS support to point the group menu at that site\'s menu. The other sites still publish.'
        : 'This site has no menu for the group menu to go into. Add the site again from Sites.');
      return finish(false);
    }
    // A new site (Add a site): its venue menu is created first, in the same transaction.
    const id = venueMenuId || freeId(newMenuId(C.menu?.id, loc), longMenuId(C.menu?.id, loc), (x) => menuById.has(x));
    if (!id) { problem('id_taken', 'block', 'The id for this site\'s new menu is already taken. Nothing was changed.'); return finish(false); }
    const row = {
      id, name: C.menu?.name || 'Menu', description: C.menu?.description || '', is_default: applied.menus.length === 0,
      is_active: true, sort_order: applied.menus.length, scope: 'local', org_id: orgId,
    };
    W.menus.insert.push(row);
    const vrow = { ...row, location_id: loc };
    applied.menus.push(vrow);
    menuById.set(id, vrow);
    if (!site.venue_menu_id) W.maps.menu_site = { venue_menu_id: id };
    lines.push({ table: 'menus', id, column: '(new)', before: null, after: row.name });
    venueMenuId = id;
  }

  // ── 2. Menu name and description, only when "use at every site" is on ─────
  const menuRow = menuById.get(venueMenuId);
  if (C.menu?.use_name_everywhere && menuRow && (T.menu.has('name') || T.menu.has('description') || T.menu.has('use_name_everywhere'))) {
    if (!W.menus.insert.some((r) => r.id === venueMenuId)) {
      setCol('menus', menuRow, 'name', C.menu.name || menuRow.name);
      setCol('menus', menuRow, 'description', C.menu.description ?? '');
    }
  }

  // ── Category helpers ──────────────────────────────────────────────────────
  const parentOf = () => new Map(applied.categories.map((c) => [c.id, c.parent_id || null]));
  const ensuring = new Set();
  function ensureCategory(cid, why) {
    if (!cid) return null;
    const c = catById.get(cid);
    if (!c) { problem('category_missing', 'block', 'A category this product needs is not in the group menu.', { categoryId: cid }); return null; }
    const cs = catSite.get(cid);
    const existing = cs?.venue_category_id && vCatById.has(cs.venue_category_id) ? cs.venue_category_id : null;
    if (existing) return existing;
    if (c.archived) { problem('category_removed', 'block', `"${c.label}" has been taken off the group menu, so nothing can go into it.`, { categoryId: cid }); return null; }
    if (ensuring.has(cid)) return null;           // a parent loop: never recurse forever
    ensuring.add(cid);
    const parentVid = c.parent_id ? ensureCategory(c.parent_id, why) : null;
    const id = cs?.venue_category_id || freeId(newCategoryId(cid, loc), longCategoryId(cid, loc), (x) => vCatById.has(x));
    if (!id) { problem('id_taken', 'block', `The id for new category "${c.label}" is already taken at this site.`, { categoryId: cid }); ensuring.delete(cid); return null; }
    const row = {
      id, menu_id: venueMenuId, parent_id: parentVid, label: c.label || 'Category', icon: c.icon ?? '🍽',
      color: c.color ?? '#3b82f6', accounting_group: c.accounting_group ?? '', sort_order: c.sort_order ?? 0,
      default_course: c.default_course ?? 1, image: c.image ?? null, scope: 'local', org_id: orgId,
    };
    W.categories.insert.push(row);
    const vrow = { ...row, location_id: loc };
    applied.categories.push(vrow);
    vCatById.set(id, vrow);
    W.links.insert.push({ menu_id: venueMenuId, category_id: id, sort_order: row.sort_order });
    applied.links.push({ menu_id: venueMenuId, category_id: id, sort_order: row.sort_order });
    if (!cs) W.maps.categories.push({ category_id: cid, venue_category_id: id });
    catSite.set(cid, { category_id: cid, location_id: loc, venue_category_id: id });
    newCategories.push({ categoryId: cid, venueCategoryId: id, label: row.label, why });
    lines.push({ table: 'categories', id, column: '(new)', before: null, after: row.label, categoryId: cid });
    ensuring.delete(cid);
    return id;
  }
  const venueCatOf = (cid) => {
    const cs = catSite.get(cid);
    return cs?.venue_category_id && vCatById.has(cs.venue_category_id) ? cs.venue_category_id : null;
  };

  // ── Product value helpers (central -> this venue) ─────────────────────────
  const siteActive = (p, ps) => !!ps && ps.active !== false && !p.archived;
  const basePrice = (p, ps) => (ps && ps.price != null ? Number(ps.price) : (p.default_price == null ? null : Number(p.default_price)));
  const channelPrice = (p, ps, k) => {
    const own = ps?.channel_prices && ps.channel_prices[k] != null ? ps.channel_prices[k] : null;
    if (own != null) return Number(own);
    const def = p.default_channels && p.default_channels[k] != null ? p.default_channels[k] : null;
    return def == null ? null : Number(def);
  };
  const mapTax = (p, { quiet = false } = {}) => {
    const r = mapTaxRate(p, applied.taxRates);
    if (!r.ok && !quiet) {
      const pct = p.tax_rate_percent == null ? '' : `${Number(p.tax_rate_percent)}% `;
      problem('no_tax_rate', 'block', `This site has no ${pct}VAT rate${p.tax_rate_name ? ` called "${p.tax_rate_name}"` : ''} for "${p.name}". Add it in Settings, Tax.`, { productId: p.id });
    }
    return r;
  };

  // ── Sub items for options (round 2) ───────────────────────────────────────
  // The venue item an option points at for central product `pid` at this site. A sub item with no
  // row here is added in this same write as an option only sub item. null = cannot (blocking).
  function ensureSubItem(pid, why) {
    const p = productById.get(pid);
    const ps = psBy.get(pid);
    if (ps && vItemById.has(ps.venue_item_id)) return ps.venue_item_id;
    // On sale here and about to be inserted by this same plan (step 3 below): items are written
    // before groups, so the option can point at it.
    if (p && ps && willInsert(p, ps)) return ps.venue_item_id;
    if (!p) { problem('sub_item_missing', 'block', `The option "${why}" uses a sub item that is not in the group menu.`); return null; }
    if (p.archived) { problem('sub_item_removed', 'block', `The option "${why}" uses "${p.name}", which was removed from the group menu. Turn the option off or pick another sub item.`, { productId: pid }); return null; }
    const id = ps?.venue_item_id || newItemId(p, loc);
    if (vItemById.has(id)) { problem('id_taken', 'block', `The id for sub item "${p.name}" is already taken at this site.`, { productId: pid }); return null; }
    const tax = mapTax(p, { quiet: true });
    const pricing = { base: p.default_price == null ? 0 : Number(p.default_price) };
    const row = {
      id, name: p.name, menu_name: p.menu_name ?? p.name, receipt_name: p.receipt_name ?? p.name, kitchen_name: p.kitchen_name ?? p.name,
      description: p.description ?? '', type: 'subitem', cat: null, cats: [], parent_id: null, sort_order: p.sort_order ?? 0,
      pricing, allergens: listOf(p.allergens), assigned_modifier_groups: [],
      visibility: { pos: false, kiosk: false, online: false, onlineDelivery: false }, sold_alone: false, archived: false,
      tax_rate_id: tax.ok ? tax.id : null, image: p.image ?? null, scope: 'local', org_id: orgId, tags: listOf(p.tags), item_code: null,
    };
    W.items.insert.push(row);
    const vr = { ...row, location_id: loc };
    applied.items.push(vr);
    vItemById.set(id, vr);
    insertedItems.add(id);
    writtenItems.add(id);
    if (!ps) {
      W.maps.items.push({ product_id: pid, venue_item_id: id });
      psBy.set(pid, { product_id: pid, location_id: loc, venue_item_id: id, active: true, price: null, channel_prices: null, kept: {} });
    }
    lines.push({ table: 'items', id, column: '(new)', before: null, after: p.name, productId: pid, subItemFor: why });
    return id;
  }

  // ── Modifier group helpers ────────────────────────────────────────────────
  const ensuringGroups = new Set();
  const optionKept = (os) => (os && os.kept && typeof os.kept === 'object' ? os.kept : {});
  const optionActive = (o, os, g) => !!os && os.active === true && !o.archived && !g.archived;
  // The venue option ids OTHER options of the same group already hold at this site (recorded
  // centrally, on or off): never adopted or minted for another option (two central ids can share
  // their first 12 characters; found by the SQL harness, 17 Oct 2026).
  const heldByOthers = (o) => new Set(listOf(C.options).filter((x) => x.group_id === o.group_id && x.id !== o.id)
    .map((x) => osBy.get(x.id)?.venue_option_id).filter(Boolean));
  // A free option id inside one venue group's list.
  const freeOptionId = (o, entries) => { const held = heldByOthers(o); return freeId(newOptionId(o.id), longOptionId(o.id), (x) => held.has(x) || entries.some((e) => e && e.id === x)); };
  // One venue option entry for central option o at this site.
  function buildEntry(o, os, id, legacy) {
    const kept = optionKept(os);
    const e = { id, name: has(kept, 'name') ? kept.name : (o.name ?? 'Option'), price: os && os.price != null ? Number(os.price) : Number(o.price ?? 0) };
    if (has(kept, 'item_link')) { if (kept.item_link) e.itemId = kept.item_link; }
    else if (o.product_id) {
      const iid = ensureSubItem(o.product_id, e.name);
      if (!iid) return null;
      e.itemId = iid;
    }
    if (has(kept, 'sub_group')) { if (kept.sub_group) e.subGroupId = kept.sub_group; }
    else if (o.sub_group_id && !legacy) {
      const sg = ensureGroup(o.sub_group_id, e.name);
      if (!sg) return null;
      e.subGroupId = sg;
    }
    return e;
  }
  function ensureGroup(gid, why = null) {
    const gs = groupSite.get(gid);
    if (gs?.venue_group_id && vGroupById.has(gs.venue_group_id)) return gs.venue_group_id;
    const g = groupById.get(gid);
    if (!g) { problem(why ? 'then_ask_missing' : 'group_missing', why ? 'block' : 'warn', why ? `The option "${why}" asks a group that is not in the group menu.` : 'A modifier group on this product is not in the group menu, so it was left off.', { groupId: gid }); return null; }
    if (g.archived) {
      if (why) problem('then_ask_removed', 'block', `The option "${why}" asks "${g.name}", which was removed from the group menu.`, { groupId: gid });
      return null;                            // removed: never put on a product again
    }
    if (ensuringGroups.has(gid)) { problem('then_ask_loop', 'block', `"${g.name}" asks itself again through "Then ask", so customers could never finish. Change one of the "Then ask" groups.`, { groupId: gid }); return null; }
    ensuringGroups.add(gid);
    const id = gs?.venue_group_id || freeId(newGroupId(gid, loc), longGroupId(gid, loc), (x) => vGroupById.has(x));
    if (!id) { problem('id_taken', 'block', `The id for modifier group "${g.name}" is already taken at this site.`, { groupId: gid }); ensuringGroups.delete(gid); return null; }
    const { rows, legacy } = optionsOf(g);
    const options = [];
    let failed = false;
    for (const o of rows) {
      const os = legacy ? { active: true, price: null, venue_option_id: o._legacyVenueId, kept: {} } : osBy.get(o.id);
      if (!optionActive(o, os, g)) continue;
      const oid = os.venue_option_id || freeOptionId(o, options);
      if (!oid) { problem('id_taken', 'block', `The id for option "${o.name}" in "${g.name}" is already taken.`, { groupId: gid }); failed = true; continue; }
      const e = buildEntry(o, os, oid, legacy);
      if (!e) { failed = true; continue; }
      options.push(e);
      if (!legacy && os.venue_option_id !== oid) { W.maps.options.push({ option_id: o.id, venue_option_id: oid }); osBy.set(o.id, { ...os, venue_option_id: oid }); }
    }
    ensuringGroups.delete(gid);
    if (failed && why) return null;
    const row = {
      id, name: g.name || 'Options', min: g.min ?? 0, max: g.max ?? 1, min_select: g.min ?? 0, max_select: g.max ?? 1,
      selection_type: g.selection_type || 'single', options, sort_order: g.sort_order ?? 0,
    };
    W.groups.insert.push(row);
    const vrow = { ...row, location_id: loc };
    applied.groups.push(vrow);
    vGroupById.set(id, vrow);
    writtenGroups.add(id);
    if (!gs) W.maps.groups.push({ group_id: gid, venue_group_id: id });
    groupSite.set(gid, { group_id: gid, location_id: loc, venue_group_id: id, kept: {} });
    lines.push({ table: 'groups', id, column: '(new)', before: null, after: row.name, groupId: gid });
    return id;
  }

  const mapCats = (p) => listOf(p.extra_category_ids).map((cid) => venueCatOf(cid) || ensureCategory(cid, p.name)).filter(Boolean);
  const mapParent = (p) => {
    if (!p.parent_product_id) return null;
    const pps = psBy.get(p.parent_product_id);
    if (!pps) { problem('size_parent_missing', 'block', `"${p.name}" is a size of a product that is not at this site.`, { productId: p.id }); return null; }
    return pps.venue_item_id;
  };
  const mapGroups = (p) => listOf(p.modifier_groups).map((g) => {
    if (!g) return null;
    const { groupId, ...rest } = typeof g === 'string' ? { groupId: g } : g;
    const vid = groupId ? ensureGroup(groupId) : null;
    return vid ? { ...rest, groupId: vid } : null;
  }).filter(Boolean);
  // The venue value of one column for product p at this site. undefined = cannot be worked out.
  const columnValue = (p, ps, column) => {
    switch (column) {
      case 'name': return p.name;
      case 'menu_name': return p.menu_name ?? p.name;
      case 'receipt_name': return p.receipt_name ?? p.name;
      case 'kitchen_name': return p.kitchen_name ?? p.name;
      case 'description': return p.description ?? '';
      case 'type': return p.type || 'simple';
      case 'cat': return p.category_id ? (venueCatOf(p.category_id) || ensureCategory(p.category_id, p.name)) : null;
      case 'cats': return mapCats(p);
      case 'parent_id': return mapParent(p);
      case 'allergens': return listOf(p.allergens);
      case 'tags': return listOf(p.tags);
      case 'image': return p.image ?? null;
      case 'visibility': return p.visibility || { pos: true, kiosk: true, online: true };
      case 'sold_alone': return !!p.sold_alone;
      case 'item_code': return p.item_code ?? null;
      case 'assigned_modifier_groups': return mapGroups(p);
      case 'archived': return !siteActive(p, ps);
      case 'tax_rate_id': { const r = mapTax(p); return r.ok ? r.id : undefined; }
      default: return undefined;
    }
  };

  // VAT by order type for a NEW venue row: the four keys mapped (a size inherits, so none).
  const newRowTaxOverrides = (p) => {
    if (p.parent_product_id) return {};
    const eff = effectiveTaxByType(p, productById);
    const out = {};
    for (const k of ORDER_TYPE_TAX_KEYS) {
      if (!eff[k]) continue;
      const m = mapRateDescriptor(eff[k], applied.taxRates);
      if (!m.ok) { problem('no_tax_rate_type', 'block', `This site has no ${Number(eff[k].percent)}% VAT rate called "${eff[k].name}" for "${p.name}" (${TAX_KEY_LABEL[k]}). Add it in Settings, Tax.`, { productId: p.id }); continue; }
      out[k] = m.id;
    }
    return out;
  };

  // VAT by order type on an existing venue row (design 5.3, review blockers 2 and 3).
  function planTypeVat(p, ps, vrow, keys, meta, w) {
    const kept = ps.kept && typeof ps.kept === 'object' ? ps.kept : {};
    const keptTax = kept.tax_overrides && typeof kept.tax_overrides === 'object' && !w.keptCleared.has('tax_overrides') ? kept.tax_overrides : {};
    const keptKey = (k) => has(keptTax, k) && !w.keptCleared.has(`tax_overrides:${k}`);
    const cur = vrow.tax_overrides && typeof vrow.tax_overrides === 'object' ? vrow.tax_overrides : {};
    const isSize = !!p.parent_product_id;
    if (isSize && !Object.keys(cur).length) return;          // a size with none of its own inherits
    const eff = effectiveTaxByType(p, productById);
    // A size with its own overrides gets the full set (sizes do not merge with their product).
    const want = isSize ? [...ORDER_TYPE_TAX_KEYS] : keys;
    let wrote = false;
    for (const k of want) {
      if (keptKey(k)) continue;
      if (!eff[k]) { wrote = setTaxKey(vrow, k, undefined, meta) || wrote; continue; }
      const m = mapRateDescriptor(eff[k], applied.taxRates);
      if (!m.ok) { problem('no_tax_rate_type', 'block', `This site has no ${Number(eff[k].percent)}% VAT rate called "${eff[k].name}" for "${p.name}" (${TAX_KEY_LABEL[k]}). Add it in Settings, Tax.`, meta); continue; }
      wrote = setTaxKey(vrow, k, m.id, meta) || wrote;
    }
    // Drive thru and collection read takeaway only when the site has no key of their own.
    if (eff.takeaway && keys.includes('takeaway')) {
      const own = ['drive-thru', 'collection'].filter((k) => has(vrow.tax_overrides || {}, k));
      if (own.length) problem('own_alias_vat', 'warn', `This site has its own ${own.map((k) => (k === 'drive-thru' ? 'Drive thru' : 'Collection')).join(' and ')} VAT on "${p.name}", so the group Takeaway VAT will not reach ${own.length === 1 ? 'it' : 'them'} there.`, meta);
    }
    if (!wrote) return;
    const anyType = ORDER_TYPE_TAX_KEYS.some((k) => has(vrow.tax_overrides || {}, k));
    const rateAfter = vrow.tax_rate_id ?? null;
    if (vrow.tax_profile_id) {
      if (!anyType) return;
      const mirror = venueProfileIsMirror(V, vrow.tax_profile_id, rateAfter);
      if (mirror === null) { problem('tax_profiles_unread', 'block', `Could not read this site's tax profiles, so VAT by order type for "${p.name}" was not checked. Try again.`, meta); return; }
      if (!mirror) { problem('real_tax_profile', 'block', `This site uses a tax profile on "${p.name}". Set its tax in Settings, Tax.`, meta); return; }
      setCol('items', vrow, 'tax_profile_id', null, { ...meta, profileCleared: true });
    } else if (!anyType && ps.cleared_tax_profile_id) {
      // The order type VAT is gone again (Undo): the old copy of its own rate goes back.
      if (venueProfileIsMirror(V, ps.cleared_tax_profile_id, rateAfter) === true) setCol('items', vrow, 'tax_profile_id', ps.cleared_tax_profile_id, { ...meta, profileRestored: true });
    }
  }

  // Will step 3 insert this product here? (the same test as the loop below)
  function willInsert(p, ps) {
    const w = work.get(p.id);
    if (!w || !siteActive(p, ps) || vItemById.has(ps.venue_item_id)) return false;
    return w.prodOp === 'create' || w.siteOp === 'create' || T.sitesCreated.has(loc) || w.siteFields.has('active') || w.prodFields.has('archived');
  }

  // ── 3. Which products this site must look at ──────────────────────────────
  const work = new Map();   // productId -> { prodOp, prodFields:Set, siteOp, siteFields:Set, keptCleared:Set }
  const add = (pid) => { if (!work.has(pid)) work.set(pid, { prodOp: null, prodFields: new Set(), siteOp: null, siteFields: new Set(), keptCleared: new Set() }); return work.get(pid); };
  for (const [pid, t] of T.products) { const w = add(pid); w.prodOp = t.op; t.fields.forEach((f) => w.prodFields.add(f)); }
  for (const [key, t] of T.productSites) {
    const [pid, l] = key.split('|');
    if (l !== loc) continue;
    const w = add(pid); w.siteOp = t.op; t.fields.forEach((f) => w.siteFields.add(f)); t.keptCleared.forEach((k) => w.keptCleared.add(k));
  }
  // A product's VAT by order type reaches its sizes that carry overrides of their own.
  for (const p of listOf(C.products)) {
    if (!p.parent_product_id) continue;
    const pt = T.products.get(p.parent_product_id);
    if (pt && pt.fields.has('tax_by_type')) add(p.id).prodFields.add('tax_by_type');
  }
  if (T.sitesCreated.has(loc)) for (const pid of psBy.keys()) { const w = add(pid); if (!w.siteOp) w.siteOp = 'create'; }

  // Parents before sizes, so a new parent's id is planned before its sizes point at it.
  const order = [...work.keys()].filter((pid) => productById.has(pid) && psBy.has(pid));
  const depth = (pid, n = 0) => { const p = productById.get(pid); return p?.parent_product_id && n < 10 ? 1 + depth(p.parent_product_id, n + 1) : 0; };
  order.sort((a, b) => depth(a) - depth(b));

  for (const pid of order) {
    const p = productById.get(pid);
    const ps = psBy.get(pid);
    const w = work.get(pid);
    const meta = { productId: pid };
    const vrow = vItemById.get(ps.venue_item_id);
    const kept = ps.kept && typeof ps.kept === 'object' ? ps.kept : {};
    const keptBlocks = (col) => has(kept, col) && !w.keptCleared.has(col);

    if (!vrow) {
      // Not at the venue: insert only when it should be on sale there.
      if (!siteActive(p, ps)) continue;
      const creating = w.prodOp === 'create' || w.siteOp === 'create' || T.sitesCreated.has(loc);
      if (!creating && !(w.siteFields.has('active') || w.prodFields.has('archived'))) {
        problem('venue_product_missing', 'warn', `"${p.name}" is no longer at the venue (removed by hand). Turn it on at this site again to put it back.`, meta);
        continue;
      }
      const tax = mapTax(p);
      const pricing = { base: basePrice(p, ps) };
      // Delivery is a platform price (set at each site by the menu its platform uses): never written.
      for (const k of PUBLISHED_CHANNELS) pricing[k] = channelPrice(p, ps, k);
      const row = {
        id: ps.venue_item_id, name: p.name, menu_name: p.menu_name ?? p.name, receipt_name: p.receipt_name ?? p.name,
        kitchen_name: p.kitchen_name ?? p.name, description: p.description ?? '', type: p.type || 'simple',
        cat: columnValue(p, ps, 'cat'), cats: mapCats(p), parent_id: mapParent(p), sort_order: p.sort_order ?? 0,
        pricing, allergens: listOf(p.allergens), assigned_modifier_groups: mapGroups(p),
        visibility: p.visibility || { pos: true, kiosk: true, online: true }, sold_alone: !!p.sold_alone, archived: false,
        tax_rate_id: tax.ok ? tax.id : null, image: p.image ?? null, scope: 'local', org_id: orgId,
        tags: listOf(p.tags), item_code: p.item_code ?? null, tax_overrides: newRowTaxOverrides(p),
      };
      W.items.insert.push(row);
      const vr = { ...row, location_id: loc };
      applied.items.push(vr);
      vItemById.set(row.id, vr);
      insertedItems.add(row.id);
      writtenItems.add(row.id);
      lines.push({ table: 'items', id: row.id, column: '(new)', before: null, after: p.name, ...meta });
      continue;
    }

    // An existing venue row: only the touched columns, and only where the value differs (an
    // adopted or imported product whose values came from this row plans nothing).
    const cols = new Set();
    const pricingKeys = new Set();
    const taxKeys = new Set();
    if (w.prodOp === 'remove') cols.add('archived');
    for (const f of w.prodFields) {
      if (f === 'default_price') { if (ps.price == null) pricingKeys.add('base'); continue; }
      if (f === 'default_channels') { PUBLISHED_CHANNELS.forEach((k) => { if (!(ps.channel_prices && ps.channel_prices[k] != null)) pricingKeys.add(k); }); continue; }
      if (f === 'tax_by_type') { ORDER_TYPE_TAX_KEYS.forEach((k) => taxKeys.add(k)); continue; }
      const col = PRODUCT_COLUMN[f];
      if (col && col !== 'pricing') cols.add(col);
    }
    for (const f of w.siteFields) {
      if (f === 'active') cols.add('archived');
      else if (f === 'price') pricingKeys.add('base');
      else if (f === 'channel_prices') PUBLISHED_CHANNELS.forEach((k) => pricingKeys.add(k));
    }
    for (const k of w.keptCleared) {
      if (k === 'tax_overrides') ORDER_TYPE_TAX_KEYS.forEach((x) => taxKeys.add(x));
      else if (k.startsWith('tax_overrides:')) taxKeys.add(k.slice(14));
      else cols.add(k);
    }

    for (const col of cols) {
      // Where a product shows (till, kiosk, online, delivery) stays the site's own, as the normal
      // menu builder leaves it (Peter, 17 Oct 2026, UI issue 2). A new row still gets one.
      if (col === 'visibility') continue;
      if (col !== 'archived' && keptBlocks(col)) continue;
      const v = columnValue(p, ps, col);
      if (v === undefined) continue;
      setCol('items', vrow, col, v, meta);
    }
    for (const k of pricingKeys) {
      const v = k === 'base' ? basePrice(p, ps) : channelPrice(p, ps, k);
      if (k === 'base' && v == null) { problem('no_price', 'block', `"${p.name}" has no price at this site.`, meta); continue; }
      setPrice(vrow, k, v, meta);
    }
    if (taxKeys.size) planTypeVat(p, ps, vrow, [...taxKeys].filter((k) => ORDER_TYPE_TAX_KEYS.includes(k)), meta, w);
  }

  // ── 4. Categories the set touched ─────────────────────────────────────────
  for (const [cid, t] of T.categories) {
    const c = catById.get(cid);
    if (!c) continue;
    const vid = venueCatOf(cid);
    if (!vid) continue;                         // created lazily when a product needs it
    const vrow = vCatById.get(vid);
    const meta = { categoryId: cid };
    if (t.op === 'remove' || (t.fields.has('archived') && c.archived)) {
      if (vrow.menu_id === venueMenuId) setCol('categories', vrow, 'menu_id', null, meta);
      const had = applied.links.filter((l) => l.menu_id === venueMenuId && l.category_id === vid);
      if (had.length) {
        W.links.delete.push({ menu_id: venueMenuId, category_id: vid });
        applied.links = applied.links.filter((l) => !(l.menu_id === venueMenuId && l.category_id === vid));
        lines.push({ table: 'links', id: vid, column: '(off menu)', before: venueMenuId, after: null, ...meta });
      }
      continue;
    }
    // Brought back (archived false, directly or by Undo): back on the venue menu, with its link,
    // so its products show on the tills again (design 1.9: removal is reversible).
    if (t.fields.has('archived') && !c.archived) {
      if (vrow.menu_id !== venueMenuId) setCol('categories', vrow, 'menu_id', venueMenuId, meta);
      if (!applied.links.some((l) => l.menu_id === venueMenuId && l.category_id === vid)) {
        const link = { menu_id: venueMenuId, category_id: vid, sort_order: c.sort_order ?? 0 };
        W.links.insert.push(link);
        applied.links.push({ ...link });
        lines.push({ table: 'links', id: vid, column: '(on menu)', before: null, after: venueMenuId, ...meta });
      }
    }
    for (const f of t.fields) {
      if (f === 'route_like_id' || f === 'archived') continue;
      if (f === 'parent_id') {
        const pv = c.parent_id ? (venueCatOf(c.parent_id) || ensureCategory(c.parent_id, c.label)) : null;
        if (pv === vid) continue;
        setCol('categories', vrow, 'parent_id', pv, meta);
      } else if (['label', 'icon', 'color', 'accounting_group', 'default_course', 'sort_order', 'image'].includes(f)) {
        setCol('categories', vrow, f, c[f] ?? null, meta);
      }
    }
  }

  // ── 5. Option groups the set touched (round 2) ────────────────────────────
  const groupWork = new Set();
  for (const gid of T.groups.keys()) groupWork.add(gid);
  for (const key of T.groupSites.keys()) { const [gid, l] = key.split('|'); if (l === loc) groupWork.add(gid); }
  for (const oid of T.options.keys()) { const o = optionById.get(oid); if (o) groupWork.add(o.group_id); }
  for (const key of T.optionSites.keys()) { const [oid, l] = key.split('|'); if (l !== loc) continue; const o = optionById.get(oid); if (o) groupWork.add(o.group_id); }
  for (const gid of groupWork) planGroupAt(gid);

  function groupOp(vg) {
    const u = groupUpd.get(vg.id) || { id: vg.id, set: {}, options: [] };
    groupUpd.set(vg.id, u);
    writtenGroups.add(vg.id);
    return u;
  }
  function planGroupAt(gid) {
    const g = groupById.get(gid);
    const gs = groupSite.get(gid);
    const vg = gs?.venue_group_id ? vGroupById.get(gs.venue_group_id) : null;
    if (!g || !vg) return;                      // not at this site: made when a product needs it
    if (W.groups.insert.some((r) => r.id === vg.id)) return;   // made whole by this plan already
    const meta = { groupId: gid };
    const tg = T.groups.get(gid) || { op: null, fields: new Set() };
    const tgs = T.groupSites.get(`${gid}|${loc}`) || { op: null, fields: new Set(), keptCleared: new Set() };
    const kept = gs.kept && typeof gs.kept === 'object' ? gs.kept : {};
    const keptBlocks = (k) => has(kept, k) && !tgs.keptCleared.has(k);

    // Removed from the group menu: never deleted here. Taken off the group menu's products at this
    // site; a site's own products that use it keep it (they get the group as it stands).
    if (g.archived && (tg.op === 'remove' || tg.fields.has('archived'))) {
      const own = [];
      for (const i of applied.items) {
        if (!i || !listOf(i.assigned_modifier_groups).some((a) => gidOf(a) === vg.id)) continue;
        const managedPs = [...psBy.values()].find((x) => x.venue_item_id === i.id);
        if (!managedPs) { if (i.archived === false) own.push(i.menu_name || i.name || i.id); continue; }
        const mk = managedPs.kept && typeof managedPs.kept === 'object' ? managedPs.kept : {};
        if (has(mk, 'assigned_modifier_groups')) continue;
        setCol('items', i, 'assigned_modifier_groups', listOf(i.assigned_modifier_groups).filter((a) => gidOf(a) !== vg.id), { productId: managedPs.product_id, groupId: gid });
      }
      if (own.length) problem('group_used_by_own', 'warn', `"${g.name}" stays on ${own.length} of this site's own product${own.length === 1 ? '' : 's'} (not in the group menu): ${own.slice(0, 3).join(', ')}${own.length > 3 ? ' and more' : ''}.`, meta);
      lines.push({ table: 'groups', id: vg.id, column: '(off products)', before: null, after: g.name, groupId: gid });
      return;
    }

    // The group's own columns.
    const fieldTouched = (f) => tg.op === 'create' || tg.fields.has(f) || tgs.keptCleared.has(f);
    const u0 = {};
    const consider = (col, value, mirror = null) => {
      if (!fieldTouched(col) || keptBlocks(col)) return;
      if (sameValue(vg[col], value)) return;
      u0[col] = value;
      lines.push({ table: 'groups', id: vg.id, column: col, before: clone(vg[col]), after: clone(value), groupId: gid });
      vg[col] = value;
      // min_select and max_select mirror min and max, as Menu Manager writes them (only with them).
      if (mirror) { u0[mirror] = value; vg[mirror] = value; }
    };
    consider('name', g.name || 'Options');
    consider('min', Number(g.min ?? 0), 'min_select');
    consider('max', Number(g.max ?? 1), 'max_select');
    consider('selection_type', g.selection_type || 'single');
    if (Object.keys(u0).length) Object.assign(groupOp(vg).set, u0);

    // Its options, one by one.
    const { rows, legacy } = optionsOf(g);
    if (legacy) return;                         // before the one time refresh: options are the site's
    const entries = listOf(vg.options).map((e) => (e && typeof e === 'object' ? { ...e } : e));
    let orderTouched = false;
    for (const o of rows) {
      const to = T.options.get(o.id) || null;
      const tos = T.optionSites.get(`${o.id}|${loc}`) || null;
      if (to?.fields.has('sort_order') || to?.op === 'create') orderTouched = true;
      if (!to && !tos && tg.op !== 'create') continue;
      const os = osBy.get(o.id) || null;
      const kept2 = optionKept(os);
      const cleared = tos?.keptCleared || new Set();
      const keptB = (k) => has(kept2, k) && !cleared.has(k);
      const touchedF = (f) => to?.op === 'create' || to?.fields.has(f) || tos?.fields.has(f) || tos?.op === 'create';
      const active = optionActive(o, os, g);
      let vid = os?.venue_option_id || null;
      let entry = vid ? entries.find((e) => e && e.id === vid) : null;
      if (!vid) {
        // An entry that already carries this option's own id is adopted, never doubled (unless
        // another option of the group holds that id here).
        const held = heldByOthers(o);
        const mine = entries.find((e) => e && !held.has(e.id) && (e.id === newOptionId(o.id) || e.id === longOptionId(o.id)));
        if (mine) { entry = mine; vid = mine.id; W.maps.options.push({ option_id: o.id, venue_option_id: vid }); if (os) osBy.set(o.id, { ...os, venue_option_id: vid }); }
      }
      const name = keptB('name') ? kept2.name : (o.name ?? 'Option');
      if (active && entry) {
        const set = {};
        const unset = [];
        if (touchedF('price') || touchedF('active')) {
          const want = os && os.price != null ? Number(os.price) : Number(o.price ?? 0);
          if (!samePrice(entry.price, want)) set.price = want;
        }
        if ((touchedF('name') || cleared.has('name')) && !keptB('name') && entry.name !== name) set.name = name;
        if ((touchedF('product_id') || cleared.has('item_link')) && !keptB('item_link')) {
          if (o.product_id) {
            const iid = ensureSubItem(o.product_id, name);
            if (iid && entry.itemId !== iid) set.itemId = iid;
          } else if (has(entry, 'itemId')) unset.push('itemId');
        }
        if ((touchedF('sub_group_id') || cleared.has('sub_group')) && !keptB('sub_group')) {
          if (o.sub_group_id) {
            const sg = ensureGroup(o.sub_group_id, name);
            if (sg && entry.subGroupId !== sg) set.subGroupId = sg;
          } else if (has(entry, 'subGroupId')) unset.push('subGroupId');
        }
        if (Object.keys(set).length || unset.length) {
          const before = { ...entry };
          Object.assign(entry, set);
          for (const k of unset) delete entry[k];
          groupOp(vg).options.push({ op: 'patch', id: entry.id, set, ...(unset.length ? { unset } : {}) });
          lines.push({ table: 'groups', id: vg.id, column: 'option', optionId: o.id, before: { name: before.name, price: before.price }, after: { name: entry.name, price: entry.price }, groupId: gid, keys: [...Object.keys(set), ...unset] });
        }
      } else if (active && !entry) {
        const id = vid || freeOptionId(o, entries);
        if (!id) { problem('id_taken', 'block', `The id for option "${o.name}" in "${g.name}" is already taken at this site.`, meta); continue; }
        const e = buildEntry(o, os, id, false);
        if (!e) continue;
        // Its place: right after the option before it in the group menu's order that is here,
        // else right before the next one that is here, else at the end.
        const idx = rows.indexOf(o);
        const here = (x) => { const xv = osBy.get(x.id)?.venue_option_id || null; return xv && entries.some((en) => en && en.id === xv) ? xv : null; };
        let after = null, beforeId = null;
        for (let j = idx - 1; j >= 0 && !after; j--) after = here(rows[j]);
        if (!after) for (let j = idx + 1; j < rows.length && !beforeId; j++) beforeId = here(rows[j]);
        const at = after ? entries.findIndex((en) => en && en.id === after) + 1 : beforeId ? entries.findIndex((en) => en && en.id === beforeId) : entries.length;
        entries.splice(at, 0, e);
        groupOp(vg).options.push({ op: 'add', entry: e, after, before: after ? null : beforeId });
        if (os?.venue_option_id !== id) { W.maps.options.push({ option_id: o.id, venue_option_id: id }); osBy.set(o.id, { ...(os || { option_id: o.id, location_id: loc, active: true, price: null, kept: {} }), venue_option_id: id }); }
        lines.push({ table: 'groups', id: vg.id, column: '(option added)', optionId: o.id, before: null, after: { name: e.name, price: e.price }, groupId: gid });
      } else if (!active && entry) {
        const i = entries.indexOf(entry);
        entries.splice(i, 1);
        groupOp(vg).options.push({ op: 'drop', id: entry.id });
        lines.push({ table: 'groups', id: vg.id, column: '(option off)', optionId: o.id, before: { name: entry.name, price: entry.price }, after: null, groupId: gid });
      }
    }
    // Order: only when an order change is staged. The group menu's options take the places its
    // options already hold, in its order; options the group menu does not know keep their places.
    if (orderTouched) {
      const want = [];
      for (const o of rows) {
        const id = osBy.get(o.id)?.venue_option_id || null;
        if (id && entries.some((e) => e && e.id === id) && !want.includes(id)) want.push(id);
      }
      const slots = entries.map((e, i) => (e && want.includes(e.id) ? i : -1)).filter((i) => i >= 0);
      const now = slots.map((i) => entries[i].id);
      if (!sameValue(now, want)) {
        const byId = new Map(slots.map((i) => [entries[i].id, entries[i]]));
        slots.forEach((slot, k) => { entries[slot] = byId.get(want[k]); });
        groupOp(vg).options.push({ op: 'order', ids: want });
        lines.push({ table: 'groups', id: vg.id, column: '(option order)', before: now, after: want, groupId: gid });
      }
    }
    if (groupUpd.has(vg.id)) vg.options = entries;
  }

  // ── 6. Routing for the categories this plan creates (review blocker 1) ────
  const routingRow = applied.printRouting;
  const hasCentres = listOf(routingRow?.centres).length > 0;
  for (const nc of newCategories) {
    if (!hasCentres) { problem('no_print_centres', 'warn', `This site has no printers or kitchen screens set up, so "${nc.label}" prints nowhere.`, { categoryId: nc.categoryId }); continue; }
    if (centresFor(nc.venueCategoryId, routingRow, parentOf()).length) continue;      // a parent routes
    const c = catById.get(nc.categoryId);
    const likeVid = c?.route_like_id ? venueCatOf(c.route_like_id) : null;
    const centreIds = likeVid ? centresFor(likeVid, routingRow, parentOf()) : [];
    if (!centreIds.length) {
      // A brand new site (this publish makes its menu) sells nothing yet, so its printers are set
      // up there before it opens: a warning. A site that already has a menu is trading: blocking.
      if (W.menus.insert.length) problem('new_category_unrouted_new_site', 'warn', `"${nc.label}" is not sent to any printer or kitchen screen at this new site yet. Set it up in Back Office, Printers, before the site opens.`, { categoryId: nc.categoryId });
      else problem('new_category_unrouted', 'block', `"${nc.label}" is new at this site and would print nowhere. In Review and publish, pick which category it prints like, so its tickets reach the right printer.`, { categoryId: nc.categoryId });
      continue;
    }
    for (const cid of centreIds) {
      routingRow.routing = routingRow.routing || {};
      const r = routingRow.routing[cid] = routingRow.routing[cid] || { assignedCategories: [], excludedItems: [] };
      r.assignedCategories = listOf(r.assignedCategories);
      if (!r.assignedCategories.includes(nc.venueCategoryId)) r.assignedCategories.push(nc.venueCategoryId);
      W.routing.push({ centre_id: cid, category_id: nc.venueCategoryId });
    }
  }

  // ── 7. A group on the group menu's products here that a site's own products use too ──
  for (const vgid of writtenGroups) {
    if (W.groups.insert.some((r) => r.id === vgid)) continue;
    const gid = [...groupSite.values()].find((x) => x.venue_group_id === vgid)?.group_id;
    const own = applied.items.filter((i) => i && i.archived === false && listOf(i.assigned_modifier_groups).some((a) => gidOf(a) === vgid)
      && ![...psBy.values()].some((x) => x.venue_item_id === i.id));
    if (own.length) {
      const g = groupById.get(gid);
      problem('group_shared_with_own', 'warn', `"${g?.name || 'This option group'}" is also used by ${own.length} of this site's own product${own.length === 1 ? '' : 's'} (not in the group menu). ${own.length === 1 ? 'It gets' : 'They get'} this change too.`, { groupId: gid });
    }
  }

  return finish(false);

  function finish(noSite) {
    for (const [table, map] of Object.entries(upd)) for (const u of map.values()) W[table].update.push(u);
    for (const u of groupUpd.values()) if (Object.keys(u.set).length || u.options.length) W.groups.update.push(u);
    const counts = countLines(lines, W);
    const empty = !W.menus.insert.length && !W.menus.update.length && !W.categories.insert.length && !W.categories.update.length
      && !W.items.insert.length && !W.items.update.length && !W.links.insert.length && !W.links.delete.length
      && !W.groups.insert.length && !W.groups.update.length && !W.routing.length
      && !W.maps.options.length && !W.maps.items.length;
    return {
      locationId: loc, notAtSite: noSite, writes: W, applied, lines, problems, counts, newCategories,
      insertedItemIds: [...insertedItems], writtenItemIds: [...writtenItems], writtenGroupIds: [...writtenGroups], venueMenuId, empty,
    };
  }
}

function countLines(lines, W) {
  const c = {
    prices: 0, newProducts: 0, subItems: 0, turnedOn: 0, turnedOff: 0, renamed: 0, other: 0,
    categoriesNew: W.categories.insert.length, categoriesOff: W.links.delete.length,
    groupsNew: W.groups.insert.length, groups: 0, vat: 0,
  };
  for (const l of lines) {
    if (l.table === 'groups') { if (l.column !== '(new)') c.groups++; continue; }
    if (l.table !== 'items') continue;
    if (l.column === '(new)') { if (l.subItemFor) c.subItems++; else c.newProducts++; continue; }
    if (l.column.startsWith('pricing.')) c.prices++;
    else if (l.column.startsWith('tax_overrides.') || l.column === 'tax_profile_id') c.vat++;
    else if (l.column === 'archived') { if (l.after === false) c.turnedOn++; else c.turnedOff++; }
    else if (['name', 'menu_name'].includes(l.column)) c.renamed++;
    else c.other++;
  }
  return c;
}

/** "12 prices, 3 new products" for one site's counts (empty string when nothing). */
export function countsWords(counts) {
  const c = counts || {};
  const parts = [];
  const n = (k, one, many) => { if (c[k]) parts.push(`${c[k]} ${c[k] === 1 ? one : many}`); };
  n('prices', 'price', 'prices');
  n('newProducts', 'new product', 'new products');
  n('subItems', 'sub item added', 'sub items added');
  n('turnedOn', 'turned on', 'turned on');
  n('turnedOff', 'turned off', 'turned off');
  n('renamed', 'renamed', 'renamed');
  n('categoriesNew', 'new category', 'new categories');
  n('categoriesOff', 'category off the menu', 'categories off the menu');
  n('groupsNew', 'new option group', 'new option groups');
  n('groups', 'option group change', 'option group changes');
  n('vat', 'VAT change', 'VAT changes');
  n('other', 'other change', 'other changes');
  return parts.join(', ');
}

/** One line in plain words: "Latte: 2.80 to 2.95". */
export function lineWords(line, names = {}) {
  const who = names[line.productId] || names[line.groupId] || names[line.id] || 'A product';
  if (line.column === '(new)') return line.subItemFor ? `${line.after}: added here as a sub item for "${line.subItemFor}"` : `${line.after}: new here`;
  if (line.column === '(off menu)') return `${names[line.categoryId] || 'A category'}: taken off the menu`;
  if (line.column === '(on menu)') return `${names[line.categoryId] || 'A category'}: back on the menu`;
  if (line.column.startsWith('pricing.')) {
    const k = line.column.slice(8);
    const label = k === 'base' ? '' : ` (${{ dineIn: 'eat in', takeaway: 'takeaway', collection: 'collection', delivery: 'delivery', driveThru: 'drive thru' }[k] || 'order type'})`;
    return `${who}${label}: ${line.before == null ? 'none' : money2(line.before)} to ${line.after == null ? 'none' : money2(line.after)}`;
  }
  if (line.column.startsWith('tax_overrides.')) {
    const k = line.column.slice(14);
    return `${who}: ${TAX_KEY_LABEL[k] || 'order type'} VAT ${line.after === undefined ? 'now the same as the product' : 'changed'}`;
  }
  if (line.column === 'tax_profile_id') {
    return line.after == null
      ? `${who} will now use its VAT by order type on the till. Until now an old tax profile hid it.`
      : `${who}: its old tax profile is put back`;
  }
  if (line.column === 'archived') return `${who}: ${line.after ? 'turned off' : 'turned on'}`;
  if (line.table === 'groups') {
    const g = names[line.groupId] || 'An option group';
    if (line.column === 'option') {
      const b = line.before || {}, a = line.after || {};
      if (b.price !== a.price) return `${g}, ${a.name || b.name || 'an option'}: ${money2(b.price)} to ${money2(a.price)}`;
      if (b.name !== a.name) return `${g}: ${b.name || 'an option'} renamed to ${a.name}`;
      return `${g}, ${a.name || 'an option'}: changed`;
    }
    if (line.column === '(option added)') return `${g}: ${line.after?.name || 'an option'} added (${money2(line.after?.price)})`;
    if (line.column === '(option off)') return `${g}: ${line.before?.name || 'an option'} turned off here`;
    if (line.column === '(option order)') return `${g}: options in a new order`;
    if (line.column === '(off products)') return `${g}: taken off the group menu's products here`;
    if (line.column === 'min' || line.column === 'max') return `${g}: customers now choose ${line.column === 'min' ? 'at least' : 'up to'} ${line.after}`;
    if (line.column === 'selection_type') return `${g}: ${{ single: 'one choice', multiple: 'several choices', quantity: 'the same choice more than once' }[line.after] || 'choices changed'}`;
    if (line.column === 'name') return `${g}: renamed to ${line.after}`;
  }
  const show = (v) => (v == null ? 'none' : typeof v === 'object' ? 'changed' : String(v));
  return `${who}: ${line.column.replace(/_/g, ' ')} ${show(line.before)} to ${show(line.after)}`;
}

/** Is this KEPT column one msmModel allows? (kept rows from the database are checked) */
export const isKeptColumn = (k) => KEPT_COLUMNS.includes(k);

export { toPence };
