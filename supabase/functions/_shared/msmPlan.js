// supabase/functions/_shared/msmPlan.js
//
// MULTI SITE MENU (17 Oct 2026, v5.11.75): THE PLANNER. Given the central menu (as it stands
// once a change set is applied), the list of what that set touched, and ONE venue's rows as the
// database holds them, it works out exactly which venue rows to write, and the venue as it will
// look afterwards. Pure: the screen previews with it, the msm-publish function publishes with
// it, and src/lib/msm/msmPlan.test.js proves the rules below.
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
//   * A sub item's option price and name FOLLOW the sub item (review blocker 2): when this plan
//     writes a sub item's price or name, every option pointing at it (opt.itemId) is patched.
//   * Venue products that are not in the central menu are left alone, always.
//   * pricing is written as a patch of base and channel keys only; pricing.menus is never touched.

import {
  CHANNELS, KEPT_COLUMNS, PRODUCT_COLUMN, has, sameValue, samePrice, toPence,
  newCategoryId, newMenuId, newGroupId, longCategoryId, longMenuId, longGroupId, freeId, money2,
} from './msmModel.js';

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const listOf = (v) => (Array.isArray(v) ? v : []);

// ── The touched list, from a change set's msm_changes rows ──────────────────

/**
 * Normalise a set's changes into what the planner needs:
 *   { menu: Set(fields), sitesCreated: Set(loc), categories: Map(id -> {op, fields}),
 *     products: Map(id -> {op, fields}), productSites: Map(`${id}|${loc}` -> {op, fields, keptCleared}) }
 */
export function touchedFromChanges(changes) {
  const t = { menu: new Set(), sitesCreated: new Set(), categories: new Map(), products: new Map(), productSites: new Map() };
  const merge = (map, key, op, fields, extra = {}) => {
    const cur = map.get(key) || { op: null, fields: new Set(), keptCleared: new Set() };
    // create wins over update; remove wins over everything after it
    if (op === 'create' || op === 'remove' || !cur.op) cur.op = op === 'update' && cur.op ? cur.op : op;
    for (const f of fields) cur.fields.add(f);
    for (const k of extra.keptCleared || []) cur.keptCleared.add(k);
    map.set(key, cur);
  };
  for (const c of listOf(changes)) {
    if (!c) continue;
    const after = c.after && typeof c.after === 'object' ? c.after : {};
    const fields = Object.keys(after);
    if (c.target === 'menu') fields.forEach((f) => t.menu.add(f));
    else if (c.target === 'menu_site' && c.op === 'create') t.sitesCreated.add(c.location_id);
    else if (c.target === 'category') merge(t.categories, c.entity_id, c.op, fields);
    else if (c.target === 'product') merge(t.products, c.entity_id, c.op, fields);
    else if (c.target === 'product_site') {
      let keptCleared = [];
      if (has(after, 'kept')) {
        const was = (c.before && c.before.kept) || {};
        const now = after.kept || {};
        keptCleared = Object.keys(was).filter((k) => !has(now, k));
      }
      merge(t.productSites, `${c.entity_id}|${c.location_id}`, c.op, fields, { keptCleared });
    }
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
  const rates = listOf(taxRates).filter((r) => r && r.active !== false);
  const pctN = pct == null || pct === '' ? null : Number(pct);
  const sameRate = (r) => pctN == null || Math.abs(Number(r.rate) - pctN) < 0.0001;
  const byName = rates.filter((r) => String(r.name || '').trim().toLowerCase() === String(name || '').trim().toLowerCase() && sameRate(r));
  if (byName.length === 1) return { id: byName[0].id, ok: true };
  if (pctN != null) {
    const byPct = rates.filter(sameRate);
    if (byPct.length === 1) return { id: byPct[0].id, ok: true };
  }
  return { id: null, ok: false };
}

// ── The planner ─────────────────────────────────────────────────────────────

/**
 * Plan one venue.
 *   central    { menu, sites, categories, catSites, groups, groupSites, products, productSites }
 *              (central state with the set applied; *Sites rows carry location_id)
 *   touched    touchedFromChanges(changes), or the raw changes array
 *   locationId the venue
 *   orgId      the company (new venue rows carry it)
 *   venue      readVenueRaw(...) or the same shape: { menus, categories, items, links, groups,
 *              taxRates, printRouting }
 * Returns { locationId, writes, applied, lines, problems, counts, newCategories, empty }.
 *   writes    what public.msm_apply_site writes (see the migration for the contract)
 *   applied   the venue rows with the writes applied (for the push snapshot and the health check)
 *   lines     one per written value: { table, id, column, before, after, productId?, categoryId? }
 *   problems  raw facts for msmHealth.js: { code, level, words, productId?, categoryId? }
 */
export function planSite({ central, touched, locationId: loc, orgId = null, venue }) {
  const T = touched instanceof Map || (touched && touched.products instanceof Map) ? touched : touchedFromChanges(touched);
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
  const productById = new Map(listOf(C.products).map((p) => [p.id, p]));
  const psBy = new Map(listOf(C.productSites).filter((r) => r.location_id === loc).map((r) => [r.product_id, r]));

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
    links: { insert: [], delete: [] }, groups: { insert: [] }, options: [], routing: [],
    maps: { categories: [], groups: [], menu_site: null },
  };
  const upd = { menus: new Map(), categories: new Map(), items: new Map() };
  const insertedItems = new Set();
  const writtenItems = new Set();
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

  // ── 1. The venue menu this central menu writes into ───────────────────────
  let venueMenuId = site?.venue_menu_id || null;
  if (!site) {
    return finish(true);
  }
  if (!venueMenuId || !menuById.has(venueMenuId)) {
    if (!T.sitesCreated.has(loc)) {
      problem('no_venue_menu', 'block', venueMenuId
        ? 'The menu this site used is gone at the venue. Pick its menu again in Menu details.'
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

  // ── Modifier group helpers ────────────────────────────────────────────────
  function ensureGroup(gid) {
    const gs = groupSite.get(gid);
    if (gs?.venue_group_id && vGroupById.has(gs.venue_group_id)) return gs.venue_group_id;
    const g = groupById.get(gid);
    if (!g) { problem('group_missing', 'warn', 'A modifier group on this product is not in the group menu, so it was left off.'); return null; }
    const id = gs?.venue_group_id || freeId(newGroupId(gid, loc), longGroupId(gid, loc), (x) => vGroupById.has(x));
    if (!id) { problem('id_taken', 'block', `The id for modifier group "${g.name}" is already taken at this site.`); return null; }
    const dropped = [];
    const options = listOf(g.options).map((o) => {
      if (!o) return null;
      const { productId, ...rest } = o;
      if (!productId) return { ...rest };
      const ps = psBy.get(productId);
      if (!ps || ps.active === false) { dropped.push(o.name || 'an option'); return null; }
      return { ...rest, itemId: ps.venue_item_id };
    }).filter(Boolean);
    if (dropped.length) problem('option_dropped', 'warn', `"${g.name}" at this site leaves out ${dropped.join(', ')}: not on this site's menu.`);
    const row = {
      id, name: g.name || 'Options', min: g.min ?? 0, max: g.max ?? 1, min_select: g.min ?? 0, max_select: g.max ?? 1,
      selection_type: g.selection_type || 'single', options, sort_order: g.sort_order ?? 0,
    };
    W.groups.insert.push(row);
    const vrow = { ...row, location_id: loc };
    applied.groups.push(vrow);
    vGroupById.set(id, vrow);
    if (!gs) W.maps.groups.push({ group_id: gid, venue_group_id: id });
    groupSite.set(gid, { group_id: gid, location_id: loc, venue_group_id: id });
    return id;
  }

  // ── Product value helpers (central -> this venue) ─────────────────────────
  const siteActive = (p, ps) => !!ps && ps.active !== false && !p.archived;
  const basePrice = (p, ps) => (ps && ps.price != null ? Number(ps.price) : (p.default_price == null ? null : Number(p.default_price)));
  const channelPrice = (p, ps, k) => {
    const own = ps?.channel_prices && ps.channel_prices[k] != null ? ps.channel_prices[k] : null;
    if (own != null) return Number(own);
    const def = p.default_channels && p.default_channels[k] != null ? p.default_channels[k] : null;
    return def == null ? null : Number(def);
  };
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
  const mapTax = (p) => {
    const r = mapTaxRate(p, applied.taxRates);
    if (!r.ok) {
      const pct = p.tax_rate_percent == null ? '' : `${Number(p.tax_rate_percent)}% `;
      problem('no_tax_rate', 'block', `This site has no ${pct}VAT rate${p.tax_rate_name ? ` called "${p.tax_rate_name}"` : ''} for "${p.name}". Add it in Settings, Tax.`, { productId: p.id });
    }
    return r;
  };
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

  // ── 3. Which products this site must look at ──────────────────────────────
  const work = new Map();   // productId -> { prodOp, prodFields:Set, siteOp, siteFields:Set, keptCleared:Set }
  const add = (pid) => { if (!work.has(pid)) work.set(pid, { prodOp: null, prodFields: new Set(), siteOp: null, siteFields: new Set(), keptCleared: new Set() }); return work.get(pid); };
  for (const [pid, t] of T.products) { const w = add(pid); w.prodOp = t.op; t.fields.forEach((f) => w.prodFields.add(f)); }
  for (const [key, t] of T.productSites) {
    const [pid, l] = key.split('|');
    if (l !== loc) continue;
    const w = add(pid); w.siteOp = t.op; t.fields.forEach((f) => w.siteFields.add(f)); t.keptCleared.forEach((k) => w.keptCleared.add(k));
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
      for (const k of CHANNELS) pricing[k] = channelPrice(p, ps, k);
      const row = {
        id: ps.venue_item_id, name: p.name, menu_name: p.menu_name ?? p.name, receipt_name: p.receipt_name ?? p.name,
        kitchen_name: p.kitchen_name ?? p.name, description: p.description ?? '', type: p.type || 'simple',
        cat: columnValue(p, ps, 'cat'), cats: mapCats(p), parent_id: mapParent(p), sort_order: p.sort_order ?? 0,
        pricing, allergens: listOf(p.allergens), assigned_modifier_groups: mapGroups(p),
        visibility: p.visibility || { pos: true, kiosk: true, online: true }, sold_alone: !!p.sold_alone, archived: false,
        tax_rate_id: tax.ok ? tax.id : null, image: p.image ?? null, scope: 'local', org_id: orgId,
        tags: listOf(p.tags), item_code: p.item_code ?? null,
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
    if (w.prodOp === 'remove') cols.add('archived');
    for (const f of w.prodFields) {
      if (f === 'default_price') { if (ps.price == null) pricingKeys.add('base'); continue; }
      if (f === 'default_channels') { CHANNELS.forEach((k) => { if (!(ps.channel_prices && ps.channel_prices[k] != null)) pricingKeys.add(k); }); continue; }
      const col = PRODUCT_COLUMN[f];
      if (col && col !== 'pricing') cols.add(col);
    }
    for (const f of w.siteFields) {
      if (f === 'active') cols.add('archived');
      else if (f === 'price') pricingKeys.add('base');
      else if (f === 'channel_prices') CHANNELS.forEach((k) => pricingKeys.add(k));
    }
    w.keptCleared.forEach((k) => cols.add(k));

    for (const col of cols) {
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

  // ── 5. Routing for the categories this plan creates (review blocker 1) ────
  const routingRow = applied.printRouting;
  const hasCentres = listOf(routingRow?.centres).length > 0;
  for (const nc of newCategories) {
    if (!hasCentres) { problem('no_print_centres', 'warn', `This site has no printers or kitchen screens set up, so "${nc.label}" prints nowhere.`, { categoryId: nc.categoryId }); continue; }
    if (centresFor(nc.venueCategoryId, routingRow, parentOf()).length) continue;      // a parent routes
    const c = catById.get(nc.categoryId);
    const likeVid = c?.route_like_id ? venueCatOf(c.route_like_id) : null;
    const centreIds = likeVid ? centresFor(likeVid, routingRow, parentOf()) : [];
    if (!centreIds.length) {
      problem('new_category_unrouted', 'block', `New category "${nc.label}" at this site is not sent to any printer or kitchen screen. Pick "Send like" a category that is.`, { categoryId: nc.categoryId });
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

  // ── 6. Option prices and names follow their sub item (review blocker 2) ───
  for (const id of writtenItems) {
    if (insertedItems.has(id)) continue;
    const row = vItemById.get(id);
    const u = upd.items.get(id);
    if (!row || !u) continue;
    const priceMoved = u.pricing && has(u.pricing, 'base');
    const nameMoved = has(u.set, 'menu_name') || has(u.set, 'name');
    if (!priceMoved && !nameMoved) continue;
    const price = row.pricing?.base == null ? null : Number(row.pricing.base);
    const name = row.menu_name || row.name;
    let touchedAny = false;
    for (const g of applied.groups) {
      let changed = false;
      const opts = listOf(g.options).map((o) => {
        if (!o || o.itemId !== id) return o;
        const next = { ...o };
        if (priceMoved && price != null && !samePrice(o.price, price)) { next.price = price; changed = true; }
        if (nameMoved && name && o.name !== name) { next.name = name; changed = true; }
        if (next !== o && (next.price !== o.price || next.name !== o.name)) {
          lines.push({ table: 'groups', id: g.id, column: 'option', before: { name: o.name, price: o.price }, after: { name: next.name, price: next.price }, productId: undefined, itemId: id });
        }
        return next;
      });
      if (changed) { g.options = opts; touchedAny = true; }
    }
    if (touchedAny) W.options.push({ item_id: id, ...(priceMoved && price != null ? { price } : {}), ...(nameMoved && name ? { name } : {}) });
  }

  return finish(false);

  function finish(noSite) {
    for (const [table, map] of Object.entries(upd)) for (const u of map.values()) W[table].update.push(u);
    const counts = countLines(lines, W);
    const empty = !W.menus.insert.length && !W.menus.update.length && !W.categories.insert.length && !W.categories.update.length
      && !W.items.insert.length && !W.items.update.length && !W.links.insert.length && !W.links.delete.length
      && !W.groups.insert.length && !W.options.length && !W.routing.length;
    return {
      locationId: loc, notAtSite: noSite, writes: W, applied, lines, problems, counts, newCategories,
      insertedItemIds: [...insertedItems], writtenItemIds: [...writtenItems], venueMenuId, empty,
    };
  }
}

function countLines(lines, W) {
  const c = { prices: 0, newProducts: W.items.insert.length, turnedOn: 0, turnedOff: 0, renamed: 0, other: 0, categoriesNew: W.categories.insert.length, categoriesOff: W.links.delete.length, options: W.options.length };
  for (const l of lines) {
    if (l.table !== 'items' || l.column === '(new)') continue;
    if (l.column.startsWith('pricing.')) c.prices++;
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
  n('turnedOn', 'turned on', 'turned on');
  n('turnedOff', 'turned off', 'turned off');
  n('renamed', 'renamed', 'renamed');
  n('categoriesNew', 'new category', 'new categories');
  n('categoriesOff', 'category off the menu', 'categories off the menu');
  n('options', 'option price followed', 'option prices followed');
  n('other', 'other change', 'other changes');
  return parts.join(', ');
}

/** One line in plain words: "Latte: 2.80 to 2.95". */
export function lineWords(line, names = {}) {
  const who = names[line.productId] || names[line.id] || line.id;
  if (line.column === '(new)') return `${line.after}: new here`;
  if (line.column === '(off menu)') return `${names[line.categoryId] || line.id}: taken off the menu`;
  if (line.column.startsWith('pricing.')) {
    const k = line.column.slice(8);
    const label = k === 'base' ? '' : ` (${k})`;
    return `${who}${label}: ${line.before == null ? 'none' : money2(line.before)} to ${line.after == null ? 'none' : money2(line.after)}`;
  }
  if (line.column === 'archived') return `${who}: ${line.after ? 'turned off' : 'turned on'}`;
  if (line.column === 'option') return `Option ${line.before?.name || ''}: ${money2(line.before?.price)} to ${money2(line.after?.price)}`;
  const show = (v) => (v == null ? 'none' : typeof v === 'object' ? 'changed' : String(v));
  return `${who}: ${line.column.replace(/_/g, ' ')} ${show(line.before)} to ${show(line.after)}`;
}

/** Is this KEPT column one msmModel allows? (kept rows from the database are checked) */
export const isKeptColumn = (k) => KEPT_COLUMNS.includes(k);

export { toPence };
