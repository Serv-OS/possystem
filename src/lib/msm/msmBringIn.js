// src/lib/msm/msmBringIn.js
//
// MULTI SITE MENU, ROUND 2 (17 Oct 2026, v5.11.75, design 3.1): BRING A SITE'S OWN PRODUCTS INTO THE
// GROUP MENU. Pure, tested (msmBringIn.test.js).
//
// A site sells products the group menu does not manage (made there by hand, or left out at the
// first import). For each one the person picks:
//   * "Link to Latte": it becomes this site's copy of Latte in the group menu, or
//   * "Bring in as a new product": a new group menu product, on at this site only.
// It goes into the draft as product (and size) creates and product_site creates carrying the
// EXISTING venue item id. The option groups it uses come in with it: a group the group menu
// already manages here is used as it is; a group with the same family or name that is not here yet
// is linked (its options matched by sub item and name, a site option the group does not have comes
// in as a new option on at this site only); otherwise it comes in as a new group. "Then ask" groups
// first.
//
// THE RULE: BRINGING IN WRITES NOTHING AT THE SITE. Every value the site has that differs from the
// group menu's becomes this site's own (kept, its own price, an option off or its own name), worked
// out with the real planner (msmPlan.planSite) with every field of everything brought in touched,
// until it plans zero writes. If it cannot get there, nothing is staged and the reason is said in
// words. The guard in the database refuses a venue item that is already managed.
//
// BRING IN THIS GROUP (2 Nov 2026, v5.12.29): the same for one of a site's own option groups (a
// modifier group at the venue the group menu does not manage). A site built its groups by hand and
// had no way to get them into the group menu: Bring in only carried a group riding on a product, and
// a site's own group is not drift, so the Sites screen said "in sync". Now the Sites screen lists
// them (ownGroups) with "Link to Which syrup" or "Bring in as a new group" (bringInGroupChanges):
// the same rules, the same machinery, the same proof. Head office then puts the group on products
// with Add to products on the group and publishes.

import { planSite, touchedFromChanges, groupOptionRows } from '../../../supabase/functions/_shared/msmPlan.js';
import { applyChanges } from '../../../supabase/functions/_shared/msmDiff.js';
import { touchEverything } from '../../../supabase/functions/_shared/msmImport.js';
import { importTaxByType, sizeKeptTax } from '../../../supabase/functions/_shared/msmTax.js';
import {
  familyOf, normName, has, samePrice, sameValue, money2, KEPT_COLUMNS, GROUP_KEPT_COLUMNS, PUBLISHED_CHANNELS,
} from '../../../supabase/functions/_shared/msmModel.js';

const listOf = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const gidOf = (a) => (typeof a === 'string' ? a : a && typeof a === 'object' ? (a.groupId ?? a.id ?? null) : null);
const nameOf = (row) => row?.menu_name || row?.name || 'A product';
const optionOnly = (row) => row?.type === 'subitem' && row?.sold_alone !== true;

const defaultUuid = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
};

// The venue categories in the venue menu the group menu writes into (by menu_id or a link), with
// their parents: a product of a site's second menu (catering, say) is never offered.
function categoriesInMenu(raw, venueMenuId) {
  const cats = listOf(raw?.categories);
  const linked = new Set(listOf(raw?.links).filter((l) => l.menu_id === venueMenuId).map((l) => l.category_id));
  const byId = new Map(cats.map((c) => [c.id, c]));
  const out = new Set(cats.filter((c) => c.menu_id === venueMenuId || linked.has(c.id)).map((c) => c.id));
  for (const id of [...out]) { let p = byId.get(id)?.parent_id, n = 0; while (p && byId.has(p) && n++ < 20) { out.add(p); p = byId.get(p).parent_id; } }
  return { inMenu: out, known: new Set(cats.map((c) => c.id)) };
}

/**
 * The site's own products (not managed by the group menu), each with what it looks like.
 *   central   the group menu (the draft applied)
 *   raw       readVenueRaw(...) of that site
 * Returns [{ id, name, row, sizes, archived, match: { productId, name, how } | null, groups: [names] }],
 * products on sale first, then by name. Sizes come with their product; option only sub items come
 * with the options that use them (never listed alone).
 */
export function ownProducts(central, locationId, raw) {
  const managed = new Set(listOf(central?.productSites).filter((ps) => ps.location_id === locationId).map((ps) => ps.venue_item_id));
  const site = listOf(central?.sites).find((s) => s.location_id === locationId);
  const { inMenu, known } = categoriesInMenu(raw, site?.venue_menu_id || null);
  const items = listOf(raw?.items).filter(Boolean);
  const groupName = new Map(listOf(raw?.groups).map((g) => [g.id, g.name || 'Options']));
  const out = [];
  for (const row of items) {
    if (managed.has(row.id) || row.parent_id || optionOnly(row) || row.type === 'spacer' || String(row.id).startsWith('demo-')) continue;
    const cats = [row.cat, ...listOf(row.cats)].filter((c) => c && known.has(c));
    if (cats.length && !cats.some((c) => inMenu.has(c))) continue;          // another menu at the site
    const sizes = items.filter((i) => i.parent_id === row.id && !managed.has(i.id));
    out.push({
      id: row.id, name: nameOf(row), row, sizes, archived: row.archived === true,
      match: matchFor(central, locationId, row),
      groups: [...new Set(listOf(row.assigned_modifier_groups).map(gidOf).filter(Boolean).map((g) => groupName.get(g)).filter(Boolean))],
    });
  }
  return out.sort((a, b) => (Number(a.archived) - Number(b.archived)) || a.name.localeCompare(b.name));
}

// "Looks like Latte in the group menu": the same shared family, else the same normalised name and
// type, among products not at this site yet (a product has one row per site).
function matchFor(central, loc, row) {
  const here = new Set(listOf(central?.productSites).filter((ps) => ps.location_id === loc).map((ps) => ps.product_id));
  const free = listOf(central?.products).filter((p) => p && !p.archived && !p.parent_product_id && !here.has(p.id));
  const fam = familyOf(row);
  const famOf = new Map();
  for (const ps of listOf(central?.productSites)) if (!famOf.has(ps.product_id)) famOf.set(ps.product_id, familyOf({ id: ps.venue_item_id }));
  const byFamily = free.find((p) => p.family_base === fam || famOf.get(p.id) === fam);
  if (byFamily) return { productId: byFamily.id, name: byFamily.menu_name || byFamily.name, how: 'family' };
  const n = normName(nameOf(row));
  const byName = free.find((p) => normName(p.menu_name || p.name) === n && (p.type || 'simple') === (row.type || 'simple'));
  return byName ? { productId: byName.id, name: byName.menu_name || byName.name, how: 'name' } : null;
}

/**
 * The draft changes that bring one of a site's own products in, settled so publishing them writes
 * nothing at the site.
 *   central      the group menu with the draft applied (eff)
 *   locationId   the site
 *   raw          readVenueRaw(...) of that site
 *   venueItemId  the site's product
 *   opts         { linkTo: central product id | null, idGen, siteName }
 * Returns { ok, changes, words: [sentences], problems: [words] }.
 */
export function bringInChanges(central, locationId, raw, venueItemId, opts = {}) {
  const idGen = opts.idGen || defaultUuid;
  const loc = locationId;
  const siteName = opts.siteName || 'this site';
  const items = listOf(raw?.items).filter(Boolean);
  const row = items.find((i) => i.id === venueItemId);
  const fail = (w) => ({ ok: false, changes: [], words: [], problems: [w] });
  if (!row) return fail('That product is no longer at the site. Check the sites again.');
  if (listOf(central?.productSites).some((ps) => ps.location_id === loc && ps.venue_item_id === row.id)) return fail(`${nameOf(row)} is already in the group menu.`);
  if (!listOf(central?.sites).some((s) => s.location_id === loc)) return fail('That site is not in the group menu yet. Add the site first.');
  const link = opts.linkTo ? listOf(central?.products).find((p) => p.id === opts.linkTo && !p.archived) : null;
  if (opts.linkTo && !link) return fail('The product to link to is not in the group menu any more.');
  if (link && listOf(central?.productSites).some((ps) => ps.product_id === link.id && ps.location_id === loc)) return fail(`${link.name} is already at ${siteName}. Bring this one in as a new product instead.`);

  const changes = [];
  const words = [];
  const C = applyChanges(central, []).central;          // a working copy we add to as we go
  const productOfItem = new Map(listOf(C.productSites).filter((ps) => ps.location_id === loc).map((ps) => [ps.venue_item_id, ps.product_id]));
  const groupsHere = new Map(listOf(raw?.groups).filter(Boolean).map((g) => [g.id, g]));
  const affected = { products: new Set(), groups: new Set() };
  const siteRows = { ps: new Map(), gs: new Map(), os: new Map() };   // our create changes, to settle
  const { productFields, addProductSite, mapGroup } = bringMachinery({ C, changes, loc, raw, items, idGen, siteName, words, productOfItem, siteRows, affected, groupsHere });

  // ── Products (the product and its sizes) ──────────────────────────────────
  let mainId;
  const sizes = items.filter((i) => i.parent_id === row.id && !productOfItem.has(i.id));
  if (link) {
    mainId = link.id;
    addProductSite(mainId, row, link);
    const centralSizes = listOf(C.products).filter((p) => p.parent_product_id === link.id && !p.archived);
    const taken = new Set();
    for (const s of sizes) {
      const hit = centralSizes.find((p) => !taken.has(p.id) && normName(p.menu_name || p.name) === normName(nameOf(s))
        && !listOf(C.productSites).some((ps) => ps.product_id === p.id && ps.location_id === loc));
      if (hit) { taken.add(hit.id); addProductSite(hit.id, s, hit); continue; }
      const sid = idGen();
      const f = productFields(s, link.id);
      changes.push({ target: 'product', entity_id: sid, location_id: null, op: 'create', after: f });
      C.products.push({ id: sid, ...f });
      addProductSite(sid, s, f);
      words.push(`${nameOf(s)} comes in as a new size of ${link.name}, on at ${siteName} only.`);
    }
    words.unshift(`${nameOf(row)} at ${siteName} becomes ${siteName}'s copy of ${link.menu_name || link.name}.`);
  } else {
    mainId = idGen();
    const f = productFields(row, null);
    changes.push({ target: 'product', entity_id: mainId, location_id: null, op: 'create', after: f });
    C.products.push({ id: mainId, ...f });
    addProductSite(mainId, row, f);
    for (const s of sizes) {
      const sid = idGen();
      const sf = productFields(s, mainId);
      changes.push({ target: 'product', entity_id: sid, location_id: null, op: 'create', after: sf });
      C.products.push({ id: sid, ...sf });
      addProductSite(sid, s, sf);
    }
    words.unshift(`${nameOf(row)} comes into the group menu as a product on at ${siteName} only${sizes.length ? `, with its ${sizes.length} size${sizes.length === 1 ? '' : 's'}` : ''}.`);
  }

  // ── Option groups (Then ask first) ────────────────────────────────────────
  const problems = [];

  const usedGroups = new Set();
  for (const r of [row, ...sizes]) for (const a of listOf(r.assigned_modifier_groups)) { const g = gidOf(a); if (g) usedGroups.add(g); }
  const mapped = new Map();
  for (const vgid of usedGroups) { const g = mapGroup(vgid); if (g) mapped.set(vgid, g); }
  // A NEW product takes the site's groups, mapped (a linked product keeps the group menu's; the
  // site's own list is kept by the settle below).
  if (!link) {
    for (const r of [row, ...sizes]) {
      const pid = productOfItem.get(r.id);
      const pc = changes.find((c) => c.target === 'product' && c.entity_id === pid);
      if (!pc) continue;
      pc.after.modifier_groups = listOf(r.assigned_modifier_groups).map((a) => {
        const g = mapped.get(gidOf(a));
        if (!g) return null;
        return typeof a === 'string' ? { groupId: g } : { ...a, groupId: g };
      }).filter(Boolean);
    }
  }

  // ── The settle: every value that differs becomes the site's own, until nothing is written ──
  const vItem = new Map(items.map((i) => [i.id, i]));
  const last = settleAtSite({ central, changes, loc, raw, affected, siteRows, groupsHere, items });
  if (last.lines.length) {
    for (const l of last.lines.slice(0, 3)) problems.push(`${l.table === 'groups' ? 'An option group' : nameOf(vItem.get(l.id) || row)} at ${siteName} would change (${String(l.column).replace(/[()._]/g, ' ').trim()}), so nothing was added to the draft. Tell ServOS if this stays.`);
    return { ok: false, changes: [], words: [], problems };
  }
  // What the site keeps, in words.
  const keptCols = new Set();
  let noPrice = false;
  for (const c of siteRows.ps.values()) {
    for (const k of Object.keys(c.after.kept || {})) { if (k === 'no_price') noPrice = true; else keptCols.add(k); }
    if (c.after.price != null) keptCols.add('price');
  }
  if (noPrice) words.push(`"${nameOf(row)}" has no price at ${siteName}, and keeps none there until someone sets one in the group menu.`);
  if (keptCols.size && link) {
    const w = { price: 'its own price', cat: 'its own category', name: 'its own name', menu_name: 'its own name', image: 'its own photo', tax_rate_id: 'its own VAT', tax_overrides: 'its own VAT by order type', assigned_modifier_groups: 'its own option groups', description: 'its own description', allergens: 'its own allergens' };
    const list = [...new Set([...keptCols].map((k) => w[k] || 'some settings of its own'))];
    const said = list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
    words.push(`${siteName} keeps ${said}, so nothing changes there until someone changes it in the group menu.`);
  } else {
    words.push(`Nothing changes at ${siteName}: the tills keep selling it exactly as they do now.`);
  }
  return { ok: true, changes: orderForGuard(changes), words, problems: [], productId: mainId };
}

// In the order the database guard checks references: a group before the products that use it, a
// product before its site rows and the options that offer it, an option before its site rows.
function orderForGuard(changes) {
  const RANK = { modifier_group: 0, product: 1, product_site: 2, modifier_group_site: 3, modifier_option: 4, modifier_option_site: 5 };
  return changes.map((c, i) => ({ c, i })).sort((a, b) => (RANK[a.c.target] - RANK[b.c.target]) || (a.i - b.i)).map((x) => x.c);
}

// "Looks like Which syrup in the group menu": the same shared family, else the same normalised
// name, among groups not at this site yet. The one rule for a product's groups, a Then ask group
// and Bring in this group.
function groupLike(C, loc, vg) {
  const fam = familyOf(vg);
  const free = listOf(C?.groups).filter((g) => g && !g.archived && !listOf(C?.groupSites).some((gs) => gs.group_id === g.id && gs.location_id === loc));
  const byFamily = free.find((g) => g.family_base === fam);
  if (byFamily) return { group: byFamily, how: 'family' };
  const byName = free.find((g) => normName(g.name) === normName(vg.name));
  return byName ? { group: byName, how: 'name' } : null;
}

// The machinery Bring in (a product, its sizes and its groups), Bring in this group, Bring the sub
// items in and Bring in all share. It adds to ctx.changes, ctx.C (the working copy), ctx.siteRows,
// ctx.affected and ctx.words as it goes.
//   ctx: { C, changes, loc, raw, items, idGen, siteName, words, productOfItem, siteRows, affected, groupsHere }
function bringMachinery(ctx) {
  const { C, changes, loc, raw, items, idGen, siteName, words, productOfItem, siteRows, affected, groupsHere } = ctx;
  const vItem = new Map(items.map((i) => [i.id, i]));
  const ratesOf = () => listOf(raw?.taxRates);
  const catOf = (vcat) => (vcat ? listOf(C.catSites).find((cs) => cs.location_id === loc && cs.venue_category_id === vcat)?.category_id || null : null);
  const rateOf = (id) => listOf(raw?.taxRates).find((r) => r.id === id) || null;
  const productFields = (r, parentId) => {
    const rate = r.tax_rate_id ? rateOf(r.tax_rate_id) : null;
    const channels = {};
    for (const k of PUBLISHED_CHANNELS) channels[k] = num(r.pricing?.[k]);
    return {
      category_id: catOf(r.cat), extra_category_ids: listOf(r.cats).map(catOf).filter(Boolean), parent_product_id: parentId,
      type: r.type || 'simple', name: r.name ?? r.menu_name ?? 'Item', menu_name: r.menu_name ?? null, receipt_name: r.receipt_name ?? null,
      kitchen_name: r.kitchen_name ?? null, description: r.description ?? '', default_price: num(r.pricing?.base) ?? 0,
      default_channels: channels, tax_rate_name: rate ? rate.name : null, tax_rate_percent: rate ? Number(rate.rate) : null,
      allergens: listOf(r.allergens), tags: listOf(r.tags), image: r.image ?? null, modifier_groups: [],
      visibility: r.visibility ?? null, sold_alone: !!r.sold_alone, item_code: r.item_code ?? null, site_only_location_id: null,
      archived: false, sort_order: r.sort_order ?? 0, family_base: familyOf(r),
      tax_by_type: parentId ? null : importTaxByType([{ loc, row: r }], ratesOf, loc).taxByType,
    };
  };
  const addProductSite = (pid, r, product) => {
    const price = num(r.pricing?.base);
    const ch = {};
    for (const k of PUBLISHED_CHANNELS) {
      const v = num(r.pricing?.[k]);
      const def = num(product?.default_channels?.[k]);
      if (v != null && !samePrice(v, def)) ch[k] = v;
    }
    // VAT by order type: what this site has that differs from the product's, and its other keys
    // (counter, drive-thru, collection, an explicit null), kept as they are (as the import does).
    const hasOwnTax = r.tax_overrides && typeof r.tax_overrides === 'object' && Object.keys(r.tax_overrides).length;
    // A size follows its product's row at the site (17 Oct recheck): it keeps only what differs.
    const sizeOf = product?.parent_product_id && r.parent_id ? items.find((i) => i && i.id === r.parent_id) : null;
    const taxKept = sizeOf ? sizeKeptTax(r, sizeOf)
      : hasOwnTax ? importTaxByType([{ loc, row: r }], ratesOf, loc, product?.tax_by_type || {}).kept.get(loc) : null;
    const after = {
      venue_item_id: r.id, active: r.archived !== true,
      price: price == null || samePrice(price, product?.default_price) ? null : price,
      channel_prices: Object.keys(ch).length ? ch : null, kept: taxKept ? { tax_overrides: taxKept } : {},
    };
    const c = { target: 'product_site', entity_id: pid, location_id: loc, op: 'create', after };
    changes.push(c);
    siteRows.ps.set(pid, c);
    productOfItem.set(r.id, pid);
    affected.products.add(pid);
  };


  // AN OPTION'S SUB ITEM (2 Nov 2026, 5.12.31). A site option points at a sub item of the site's
  // own (Gouda, say). It used to stay the site's own link (kept item_link, product_id null), so head
  // office could not pick Gouda for another group or send it to another site, and the group menu did
  // not manage it. Now it comes in as a product: linked to the group menu product that looks like it
  // (same family, or same name and kind) or new (type and sold on its own as the row is, hidden on the
  // menus when the row says nothing), with a product site carrying the EXISTING venue item id, so the
  // option's product_id points at it and publishing writes nothing. A sub item already managed here
  // is used, never doubled. A size, a product with sizes or a demo row stays the site's own link.
  // Returns the group menu product id, or null.
  function bringSubItem(itemId) {
    if (!itemId) return null;
    if (productOfItem.has(itemId)) return productOfItem.get(itemId);
    const r = vItem.get(itemId);
    if (!r || r.parent_id || r.type === 'spacer' || String(r.id).startsWith('demo-') || items.some((i) => i && i.parent_id === r.id)) return null;
    const m = matchFor(C, loc, r);
    const existing = m ? listOf(C.products).find((p) => p.id === m.productId) : null;
    if (existing) {
      addProductSite(existing.id, r, existing);
      words.push(`Sub item ${nameOf(r)} at ${siteName} becomes ${siteName}'s copy of the group menu's ${existing.menu_name || existing.name}.`);
      return existing.id;
    }
    const pid = idGen();
    const f = productFields(r, null);
    if (!f.visibility) f.visibility = { pos: false, kiosk: false, online: false, onlineDelivery: false };
    changes.push({ target: 'product', entity_id: pid, location_id: null, op: 'create', after: f });
    C.products.push({ id: pid, ...f });
    addProductSite(pid, r, f);
    words.push(`Sub item ${nameOf(r)} comes into the group menu too, on at ${siteName} only.`);
    return pid;
  }
  const centralOfVenueGroup = new Map(listOf(C.groupSites).filter((gs) => gs.location_id === loc).map((gs) => [gs.venue_group_id, gs.group_id]));
  const visiting = new Set();
  // link: undefined = the group menu group that looks like it, if any (a product's groups, a Then
  // ask group); null = a new group whatever is there; a group menu group = that one (Bring in this
  // group's choice). top = the group the person pressed (its own sentence).
  function mapGroup(vgid, link, top = false) {
    if (centralOfVenueGroup.has(vgid)) return centralOfVenueGroup.get(vgid);
    const vg = groupsHere.get(vgid);
    if (!vg || visiting.has(vgid)) return null;
    visiting.add(vgid);
    for (const e of listOf(vg.options)) if (e && e.subGroupId) mapGroup(e.subGroupId);
    const existing = link === undefined ? (groupLike(C, loc, vg)?.group || null) : link;
    let gid;
    if (existing) {
      gid = existing.id;
      const gsC = { target: 'modifier_group_site', entity_id: gid, location_id: loc, op: 'create', after: { venue_group_id: vg.id, kept: {} } };
      changes.push(gsC);
      siteRows.gs.set(gid, gsC);
      C.groupSites.push({ group_id: gid, location_id: loc, venue_group_id: vg.id, kept: {} });
      centralOfVenueGroup.set(vg.id, gid);
      linkOptions(existing, vg);
      words.push(`${vg.name || 'An option group'} at ${siteName} becomes ${siteName}'s copy of the group menu's ${existing.name}.`);
    } else {
      gid = idGen();
      const g = { name: vg.name || 'Options', min: Number(vg.min ?? 0), max: Number(vg.max ?? 1), selection_type: vg.selection_type || 'single', sort_order: Number(vg.sort_order ?? 0), family_base: familyOf(vg) };
      changes.push({ target: 'modifier_group', entity_id: gid, location_id: null, op: 'create', after: g });
      C.groups.push({ id: gid, archived: false, options: [], ...g });
      const gsC = { target: 'modifier_group_site', entity_id: gid, location_id: loc, op: 'create', after: { venue_group_id: vg.id, kept: {} } };
      changes.push(gsC);
      siteRows.gs.set(gid, gsC);
      C.groupSites.push({ group_id: gid, location_id: loc, venue_group_id: vg.id, kept: {} });
      centralOfVenueGroup.set(vg.id, gid);
      let i = 0;
      for (const e of listOf(vg.options)) {
        if (!e || typeof e !== 'object' || e.id == null || e.id === '') continue;
        newOption(gid, e, i++, true);
      }
      words.push(top
        ? `Option group ${vg.name || 'Options'} comes into the group menu, on at ${siteName} only, with its ${i} option${i === 1 ? '' : 's'}.`
        : `Option group ${vg.name || 'Options'} comes in too (new in the group menu, at ${siteName} only).`);
    }
    affected.groups.add(gid);
    visiting.delete(vgid);
    return gid;
  }
  // A site option the group menu does not have: a new option, on here (same venue id), off elsewhere.
  function newOption(gid, e, sortOrder, onlyHere) {
    const oid = idGen();
    const pid = bringSubItem(e.itemId);
    const sub = e.subGroupId ? centralOfVenueGroup.get(e.subGroupId) || null : null;
    const o = { group_id: gid, name: e.name ?? 'Option', price: Number(e.price ?? 0), product_id: pid, sub_group_id: sub, sort_order: sortOrder };
    changes.push({ target: 'modifier_option', entity_id: oid, location_id: null, op: 'create', after: o });
    C.options.push({ id: oid, archived: false, ...o });
    const osC = { target: 'modifier_option_site', entity_id: oid, location_id: loc, op: 'create', after: { venue_option_id: e.id, active: true, price: null, kept: keptForEntry(o, e) } };
    changes.push(osC);
    siteRows.os.set(oid, osC);
    C.optionSites.push({ option_id: oid, location_id: loc, ...osC.after });
    if (!onlyHere) {
      for (const gs of listOf(C.groupSites).filter((x) => x.group_id === gid && x.location_id !== loc)) {
        changes.push({ target: 'modifier_option_site', entity_id: oid, location_id: gs.location_id, op: 'create', after: { active: false, price: null } });
        C.optionSites.push({ option_id: oid, location_id: gs.location_id, venue_option_id: null, active: false, price: null, kept: {} });
      }
    }
    return oid;
  }
  // What a site keeps on one option: its own name, its own sub item link (or none), its own Then ask.
  function keptForEntry(o, e) {
    const kept = {};
    if ((e.name ?? 'Option') !== (o.name ?? 'Option')) kept.name = e.name ?? null;
    // A sub item or a Then ask group the site does not have would be ADDED there by publish: the
    // site keeps its own link instead (or none), so nothing is written.
    const wantItem = o.product_id ? (listOf(C.productSites).find((ps) => ps.product_id === o.product_id && ps.location_id === loc)?.venue_item_id || productItemAfter(o.product_id)) : null;
    if ((o.product_id && !wantItem) || (e.itemId || null) !== (wantItem || null)) kept.item_link = e.itemId || false;
    const wantSub = o.sub_group_id ? listOf(C.groupSites).find((gs) => gs.group_id === o.sub_group_id && gs.location_id === loc)?.venue_group_id || null : null;
    if ((o.sub_group_id && !wantSub) || (e.subGroupId || null) !== (wantSub || null)) kept.sub_group = e.subGroupId || false;
    return kept;
  }
  // The venue item of a product brought in by this same set (its product site is not in C yet).
  function productItemAfter(pid) {
    if (!pid) return null;
    return siteRows.ps.get(pid)?.after?.venue_item_id || null;
  }
  // An existing group menu group linked to this site's group: options matched by sub item and name.
  function linkOptions(g, vg) {
    const { rows } = groupOptionRows(g, C.options);
    const taken = new Set();
    let next = rows.length;
    for (const e of listOf(vg.options)) {
      if (!e || typeof e !== 'object' || e.id == null || e.id === '') continue;
      const pid = bringSubItem(e.itemId);
      const nk = normName(e.name);
      const free = rows.filter((o) => !taken.has(o.id) && !o.archived);
      const hit = (pid && free.find((o) => o.product_id === pid && normName(o.name) === nk))
        || (pid && free.find((o) => o.product_id === pid))
        || free.find((o) => normName(o.name) === nk && (!o.product_id || !pid || o.product_id === pid)) || null;
      if (!hit) { newOption(g.id, e, next++, false); continue; }
      taken.add(hit.id);
      const after = { venue_option_id: e.id, active: true, price: samePrice(e.price ?? 0, hit.price) ? null : Number(e.price ?? 0), kept: keptForEntry(hit, e) };
      const osC = { target: 'modifier_option_site', entity_id: hit.id, location_id: loc, op: 'create', after };
      changes.push(osC);
      siteRows.os.set(hit.id, osC);
      C.optionSites.push({ option_id: hit.id, location_id: loc, ...after });
    }
    // The group's options this site does not have: off here (an explicit row).
    for (const o of rows) {
      if (taken.has(o.id) || o.archived || siteRows.os.has(o.id)) continue;
      if (listOf(C.optionSites).some((os) => os.option_id === o.id && os.location_id === loc)) continue;
      const osC = { target: 'modifier_option_site', entity_id: o.id, location_id: loc, op: 'create', after: { active: false, price: null } };
      changes.push(osC);
      siteRows.os.set(o.id, osC);
      C.optionSites.push({ option_id: o.id, location_id: loc, venue_option_id: null, active: false, price: null, kept: {} });
    }
  }
  return { productFields, addProductSite, mapGroup, bringSubItem };
}

// THE SETTLE, then the proof: every value the site has that differs from what the create changes
// say becomes the site's own (mutating the create changes in siteRows), with the real planner and
// every field of everything brought in touched, until it plans zero writes (six passes at most).
// Returns the final plan: lines.length === 0 is the proof.
// touchGroups false (Bring the sub items in): the groups are published already, so only the changes
// themselves are touched there (a price changed by hand at the site in that group is not our business).
function settleAtSite({ central, changes, loc, raw, affected, siteRows, groupsHere, items, touchGroups = true }) {
  const vItem = new Map(items.map((i) => [i.id, i]));
  const planNow = () => {
    const after = applyChanges(central, changes).central;
    const touched = touchedFromChanges([...touchEverything({
      products: listOf(after.products).filter((p) => affected.products.has(p.id)),
      productSites: listOf(after.productSites).filter((ps) => ps.location_id === loc && affected.products.has(ps.product_id)),
      groups: touchGroups ? listOf(after.groups).filter((g) => affected.groups.has(g.id)) : [],
      options: touchGroups ? listOf(after.options).filter((o) => affected.groups.has(o.group_id)) : [],
      optionSites: touchGroups ? listOf(after.optionSites).filter((os) => os.location_id === loc && listOf(after.options).some((o) => o.id === os.option_id && affected.groups.has(o.group_id))) : [],
    }), ...(touchGroups ? [] : changes)]);
    return { after, plan: planSite({ central: after, touched, locationId: loc, orgId: null, venue: raw }) };
  };
  for (let pass = 0; pass < 6; pass++) {
    const { after, plan } = planNow();
    let changed = 0;
    for (const pr of plan.problems) {
      if (!pr.productId || pr.level !== 'block') continue;
      const c = siteRows.ps.get(pr.productId);
      const vr = c && vItem.get(c.after.venue_item_id);
      const col = pr.code === 'no_tax_rate' ? 'tax_rate_id' : pr.code === 'size_parent_missing' ? 'parent_id' : null;
      if (vr && col && !has(c.after.kept, col)) { c.after.kept[col] = vr[col] ?? null; changed++; }
    }
    for (const l of plan.lines) {
      if (l.table === 'items' && l.column !== '(new)') {
        const pid = l.productId;
        const c = siteRows.ps.get(pid);
        const vr = vItem.get(l.id);
        if (!c || !vr) continue;
        if (l.column === 'archived') { c.after.active = vr.archived !== true; changed++; continue; }
        if (l.column.startsWith('pricing.')) {
          const k = l.column.slice(8);
          // No Standard price at the site (17 Oct recheck): it keeps "no price", as the import does.
          if (k === 'base' && num(vr.pricing?.base) == null) { c.after.price = null; c.after.kept = { ...(c.after.kept || {}), no_price: true }; changed++; continue; }
          if (k === 'base') c.after.price = num(vr.pricing?.base);
          else c.after.channel_prices = { ...(c.after.channel_prices || {}), [k]: num(vr.pricing?.[k]) };
          changed++;
          continue;
        }
        if (l.column.startsWith('tax_overrides.')) {
          const k = l.column.slice(14);
          const cur = vr.tax_overrides && typeof vr.tax_overrides === 'object' ? vr.tax_overrides : {};
          c.after.kept.tax_overrides = { ...(c.after.kept.tax_overrides || {}), [k]: has(cur, k) ? cur[k] : false };
          changed++;
          continue;
        }
        if (KEPT_COLUMNS.includes(l.column) && !sameValue(c.after.kept[l.column], vr[l.column] ?? null)) { c.after.kept[l.column] = vr[l.column] ?? null; changed++; }
        else if (KEPT_COLUMNS.includes(l.column) && !has(c.after.kept, l.column)) { c.after.kept[l.column] = vr[l.column] ?? null; changed++; }
        continue;
      }
      if (l.table === 'groups' && l.column !== '(new)' && l.groupId && siteRows.gs.has(l.groupId)) {
        const vg = groupsHere.get(l.id);
        if (!vg) continue;
        if (GROUP_KEPT_COLUMNS.includes(l.column)) { siteRows.gs.get(l.groupId).after.kept[l.column] = l.column === 'name' ? (vg.name ?? null) : (l.column === 'selection_type' ? (vg.selection_type || 'single') : Number(vg[l.column] ?? 0)); changed++; continue; }
        const osC = l.optionId ? siteRows.os.get(l.optionId) : null;
        if (!osC) continue;
        if (l.column === '(option added)') { osC.after.active = false; changed++; continue; }
        if (l.column === '(option off)') { osC.after.active = true; changed++; continue; }
        if (l.column === 'option') {
          const e = listOf(vg.options).find((x) => x && x.id === osC.after.venue_option_id);
          if (!e) continue;
          const o = listOf(after.options).find((x) => x.id === l.optionId);
          for (const k of listOf(l.keys)) {
            if (k === 'price') osC.after.price = samePrice(e.price ?? 0, o?.price) ? null : Number(e.price ?? 0);
            else if (k === 'name') osC.after.kept = { ...(osC.after.kept || {}), name: e.name ?? null };
            else if (k === 'itemId') osC.after.kept = { ...(osC.after.kept || {}), item_link: e.itemId || false };
            else if (k === 'subGroupId') osC.after.kept = { ...(osC.after.kept || {}), sub_group: e.subGroupId || false };
          }
          changed++;
        }
      }
    }
    if (!changed) break;
  }
  return planNow().plan;
}

/**
 * JOIN A SITE THAT ALREADY SELLS THE GROUP'S PRODUCTS (Builder B recheck, item 6). Add a site is for
 * a site that sells none of them (it writes every product there); Bring in only worked for a site
 * already in the group menu. A site of the company that sells the group's products as its own
 * (the same shared products, made by the sharing engine) had no way in. Now it joins in ONE draft:
 * the site row, writing into the site's own menu, and each of its products that IS one of the group
 * menu's (the same family) linked to it with Bring in, so everything it does differently stays its
 * own. The whole set is planned once more and must write NOTHING at the site, or nothing is staged.
 * Products it sells that are not the group's stay its own (Bring them in from the Sites tab later);
 * the group's products it does not sell stay off there (turn them on from Products when wanted).
 *   live         the group menu as published
 *   opts         { locationId, venueMenuId (one of the site's menus), raw (readVenueRaw), idGen, siteName, orgId }
 * Returns { ok, changes, linked: [names], own: [names], notSold, words: [sentences], problems: [words] }.
 */
export function planJoinSite(live, opts = {}) {
  const steps = joinSteps(live, opts);
  for (;;) { const n = steps.next(); if (n.done) return n.value; }
}

/**
 * The same, a product at a time, so a screen can show its progress and stay responsive (a site with
 * 280 of the group's products takes some seconds: each link is proven to write nothing).
 *   onProgress(done, total)   after each product
 *   shouldStop()              true stops it (the sheet was closed): resolves null
 */
export async function planJoinSiteAsync(live, opts = {}, { onProgress = () => {}, shouldStop = () => false, pause = () => new Promise((r) => setTimeout(r, 0)) } = {}) {
  const steps = joinSteps(live, opts);
  for (;;) {
    const n = steps.next();
    if (n.done) return n.value;
    if (shouldStop()) return null;
    try { onProgress(n.value.done, n.value.total); } catch { /* a progress line is never a reason to stop */ }
    await pause();
  }
}

/** Products of the site that are the group's own (the same family): the ones a join links. */
export function joinableProducts(live, locationId, raw, venueMenuId) {
  if (!locationId || !raw || !venueMenuId) return [];
  const C = applyChanges(live, [{ target: 'menu_site', entity_id: live?.menu?.id || null, location_id: locationId, op: 'create', after: { venue_menu_id: venueMenuId } }]).central;
  return ownProducts(C, locationId, raw).filter((o) => !o.archived && o.match && o.match.how === 'family');
}

function* joinSteps(live, opts) {
  const loc = opts.locationId;
  const raw = opts.raw;
  const siteName = opts.siteName || 'This site';
  const fail = (w) => ({ ok: false, changes: [], linked: [], own: [], notSold: 0, words: [], problems: [w] });
  if (!loc || !raw) return fail('Pick a site.');
  if (listOf(live?.sites).some((s) => s.location_id === loc)) return fail(`${siteName} is already in the group menu.`);
  const menus = listOf(raw.menus).filter((m) => m && m.is_active !== false);
  if (!opts.venueMenuId || !menus.some((m) => m.id === opts.venueMenuId)) return fail(`Pick the menu ${siteName}'s products are in.`);
  let changes = [{ target: 'menu_site', entity_id: live?.menu?.id || null, location_id: loc, op: 'create', after: { venue_menu_id: opts.venueMenuId } }];
  let C = applyChanges(live, changes).central;
  const linked = [], own = [], problems = [];
  const list = ownProducts(C, loc, raw).filter((o) => !o.archived);
  let done = 0;
  for (const o of list) {
    done++;
    if (!o.match || o.match.how !== 'family') own.push(o.name);
    else {
      const r = bringInChanges(C, loc, raw, o.id, { linkTo: o.match.productId, idGen: opts.idGen, siteName });
      if (!r.ok) { own.push(o.name); problems.push(...r.problems); } else {
        changes = [...changes, ...r.changes];
        C = applyChanges(C, r.changes).central;
        linked.push(o.name);
      }
    }
    yield { done, total: list.length };
  }
  if (!linked.length) return { ...fail(`${siteName} sells none of the group menu's products as its own copy. Use Add a site with a new menu instead.`), own };
  // The whole set, planned as the server will: it must write nothing at the site.
  const plan = planSite({ central: C, touched: touchedFromChanges(changes), locationId: loc, orgId: opts.orgId || null, venue: raw });
  if (plan.lines.length) return { ...fail(`Joining would change ${plan.lines.length} thing${plan.lines.length === 1 ? '' : 's'} at ${siteName}, so nothing was put in a draft. Ask ServOS to look at it.`), own };
  const here = new Set(listOf(C.productSites).filter((ps) => ps.location_id === loc).map((ps) => ps.product_id));
  const notSold = listOf(C.products).filter((p) => !p.archived && !p.parent_product_id && !optionOnly(p) && !here.has(p.id)).length;
  const words = [
    `${siteName} joins the group menu with the ${linked.length} product${linked.length === 1 ? '' : 's'} of the group's it already sells, writing into its menu as it is. Nothing changes at ${siteName} when you publish: what it does differently stays its own.`,
  ];
  if (own.length) words.push(`${own.length} product${own.length === 1 ? '' : 's'} it sells ${own.length === 1 ? 'is' : 'are'} not the group's (like ${own.slice(0, 2).join(' and ')}). ${own.length === 1 ? 'It stays' : 'They stay'} its own: bring ${own.length === 1 ? 'it' : 'them'} in from the Sites tab after publishing, if you want.`);
  if (notSold) words.push(`${notSold} of the group's products ${notSold === 1 ? 'is' : 'are'} not sold there and stay off. Turn them on there from Products when you want.`);
  return { ok: true, changes, linked, own, notSold, words, problems };
}

/** "Leeds has 17 products of its own, not in the group menu." */
export function ownCountWords(n, siteName) {
  if (!n) return `Every product ${siteName} sells is in the group menu.`;
  return `${siteName} has ${n} product${n === 1 ? '' : 's'} of its own, not in the group menu.`;
}

/**
 * The site's own option groups (not managed by the group menu), each with what it looks like.
 *   central   the group menu (the draft applied)
 *   raw       readVenueRaw(...) of that site
 * Returns [{ id, name, row, options, usedBy: [product names], thenAskOf: [group names],
 *            match: { groupId, name, how } | null }], by name. A group already in the group menu
 * here (a modifier_group_site row) is never listed; a Then ask group of another own group is (it
 * comes in with its parent, and drops out of the list once it is in the draft).
 */
export function ownGroups(central, locationId, raw) {
  const managed = new Set(listOf(central?.groupSites).filter((gs) => gs.location_id === locationId).map((gs) => gs.venue_group_id));
  const groups = listOf(raw?.groups).filter((g) => g && g.id != null && g.id !== '');
  const items = listOf(raw?.items).filter(Boolean);
  const out = [];
  for (const vg of groups) {
    if (managed.has(vg.id) || String(vg.id).startsWith('demo-')) continue;
    const entries = listOf(vg.options).filter((e) => e && typeof e === 'object' && e.id != null && e.id !== '');
    const usedBy = items.filter((i) => i.archived !== true && !i.parent_id && listOf(i.assigned_modifier_groups).some((a) => gidOf(a) === vg.id)).map(nameOf);
    const thenAskOf = groups.filter((g) => g.id !== vg.id && listOf(g.options).some((e) => e && e.subGroupId === vg.id)).map((g) => g.name || 'Options');
    const like = groupLike(central, locationId, vg);
    out.push({
      id: vg.id, name: vg.name || 'Options', row: vg, options: entries.length,
      usedBy: [...new Set(usedBy)], thenAskOf: [...new Set(thenAskOf)],
      match: like ? { groupId: like.group.id, name: like.group.name, how: like.how } : null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The draft changes that bring one of a site's own option groups in, settled so publishing them
 * writes nothing at the site.
 *   central        the group menu with the draft applied (eff)
 *   locationId     the site
 *   raw            readVenueRaw(...) of that site
 *   venueGroupId   the site's group
 *   opts           { linkTo: central group id | null, idGen, siteName }
 * Linked: the site's group becomes this site's copy of that group menu group; its options are
 * matched by sub item and name (the site's own price kept), a site option the group does not have
 * comes in as a new option on here and off at the other sites, the group's options the site does not
 * offer stay off here, and a rule the site has of its own (name, Choose up to) is kept. New: a new
 * group on at this site only, with every option. A Then ask group it asks comes in first, by the
 * same rules. Returns { ok, changes, words: [sentences], problems: [words], groupId }.
 */
export function bringInGroupChanges(central, locationId, raw, venueGroupId, opts = {}) {
  const idGen = opts.idGen || defaultUuid;
  const loc = locationId;
  const siteName = opts.siteName || 'this site';
  const items = listOf(raw?.items).filter(Boolean);
  const groupsHere = new Map(listOf(raw?.groups).filter(Boolean).map((g) => [g.id, g]));
  const vg = groupsHere.get(venueGroupId);
  const fail = (w) => ({ ok: false, changes: [], words: [], problems: [w] });
  if (!vg) return fail('That option group is no longer at the site. Check the sites again.');
  const gname = vg.name || 'That option group';
  if (listOf(central?.groupSites).some((gs) => gs.location_id === loc && gs.venue_group_id === vg.id)) return fail(`${gname} is already in the group menu.`);
  if (!listOf(central?.sites).some((s) => s.location_id === loc)) return fail('That site is not in the group menu yet. Add the site first.');
  const link = opts.linkTo ? listOf(central?.groups).find((g) => g.id === opts.linkTo && !g.archived) : null;
  if (opts.linkTo && !link) return fail('The option group to link to is not in the group menu any more.');
  if (link && listOf(central?.groupSites).some((gs) => gs.group_id === link.id && gs.location_id === loc)) return fail(`${link.name} is already at ${siteName}. Bring this one in as a new group instead.`);

  const changes = [];
  const words = [];
  const C = applyChanges(central, []).central;
  const productOfItem = new Map(listOf(C.productSites).filter((ps) => ps.location_id === loc).map((ps) => [ps.venue_item_id, ps.product_id]));
  const affected = { products: new Set(), groups: new Set() };
  const siteRows = { ps: new Map(), gs: new Map(), os: new Map() };
  const { mapGroup } = bringMachinery({ C, changes, loc, raw, items, idGen, siteName, words, productOfItem, siteRows, affected, groupsHere });
  const gid = mapGroup(vg.id, link || null, true);
  if (!gid) return fail(`${gname} could not be worked out. Check the sites again.`);
  // The pressed group's sentence first, then the Then ask groups that came with it.
  const mine = words.pop();
  words.unshift(mine);

  const last = settleAtSite({ central, changes, loc, raw, affected, siteRows, groupsHere, items });
  if (last.lines.length) {
    const problems = last.lines.slice(0, 3).map((l) => `${groupsHere.get(l.id)?.name || gname} at ${siteName} would change (${String(l.column).replace(/[()._]/g, ' ').trim()}), so nothing was added to the draft. Tell ServOS if this stays.`);
    return { ok: false, changes: [], words: [], problems };
  }

  // What the site keeps, in words.
  const gsC = siteRows.gs.get(gid);
  const keptRule = Object.keys(gsC?.after?.kept || {});
  const mineOs = changes.filter((c) => c.target === 'modifier_option_site' && c.location_id === loc && listOf(C.options).find((o) => o.id === c.entity_id)?.group_id === gid);
  const ownPrices = mineOs.filter((c) => c.after.venue_option_id && c.after.price != null).length;
  const ownNames = mineOs.filter((c) => c.after.venue_option_id && has(c.after.kept, 'name')).length;
  const offHere = mineOs.filter((c) => !c.after.venue_option_id && c.after.active === false).length;
  const newOpts = changes.filter((c) => c.target === 'modifier_option' && c.after.group_id === gid).map((c) => c.after.name);
  if (link) {
    const kept = [];
    if (keptRule.includes('name')) kept.push('its own name for it');
    if (keptRule.some((k) => k !== 'name')) kept.push('its own rule (how many to choose)');
    if (ownPrices) kept.push(`its own price on ${ownPrices} option${ownPrices === 1 ? '' : 's'}`);
    if (ownNames) kept.push(`its own name on ${ownNames} option${ownNames === 1 ? '' : 's'}`);
    if (kept.length) words.push(`${siteName} keeps ${kept.length === 1 ? kept[0] : `${kept.slice(0, -1).join(', ')} and ${kept[kept.length - 1]}`}, so nothing changes there until someone changes it in the group menu.`);
    if (newOpts.length) words.push(`${newOpts.join(', ')} ${newOpts.length === 1 ? 'is' : 'are'} new in the group menu: on at ${siteName}, off at the other sites.`);
    if (offHere) words.push(`${offHere} of ${link.name}'s options ${offHere === 1 ? 'is' : 'are'} not offered at ${siteName} and ${offHere === 1 ? 'stays' : 'stay'} off there.`);
  }
  words.push(`Nothing changes at ${siteName}: the tills keep asking it exactly as they do now.`);
  if (!link) words.push('Put it on products from Option groups (Add to products), then publish.');
  return { ok: true, changes: orderForGuard(changes), words, problems: [], groupId: gid };
}

/**
 * OPTIONS THAT POINT AT SUB ITEMS THE GROUP MENU DOES NOT MANAGE (2 Nov 2026, 5.12.31): the groups
 * brought in before the sub items came with them (and an option brought in from Find changes made
 * at sites). The option is managed here (a site row with the venue option id), the venue entry has a
 * sub item, that sub item is not a managed product here, and the option has no sub item of its own.
 * Returns [{ optionId, optionName, groupId, groupName, itemId, itemName }], by group then option.
 */
export function unmanagedSubItems(central, locationId, raw) {
  const loc = locationId;
  const managedItem = new Set(listOf(central?.productSites).filter((ps) => ps.location_id === loc).map((ps) => ps.venue_item_id));
  const vItem = new Map(listOf(raw?.items).filter(Boolean).map((i) => [i.id, i]));
  const vGroup = new Map(listOf(raw?.groups).filter(Boolean).map((g) => [g.id, g]));
  const out = [];
  for (const gs of listOf(central?.groupSites).filter((x) => x.location_id === loc && x.venue_group_id)) {
    const g = listOf(central?.groups).find((x) => x.id === gs.group_id && !x.archived);
    const vg = vGroup.get(gs.venue_group_id);
    if (!g || !vg) continue;
    for (const o of groupOptionRows(g, central?.options).rows) {
      if (o.archived || o.product_id || String(o.id).startsWith('legacy:')) continue;
      const os = listOf(central?.optionSites).find((x) => x.option_id === o.id && x.location_id === loc);
      if (!os || !os.venue_option_id || os.active === false) continue;
      const e = listOf(vg.options).find((x) => x && x.id === os.venue_option_id);
      if (!e || !e.itemId || managedItem.has(e.itemId)) continue;
      const r = vItem.get(e.itemId);
      if (!r || r.parent_id || String(r.id).startsWith('demo-')) continue;
      out.push({ optionId: o.id, optionName: e.name ?? o.name, groupId: g.id, groupName: g.name, itemId: e.itemId, itemName: nameOf(r) });
    }
  }
  return out;
}

/**
 * BRING THE SUB ITEMS IN (the repair): for every option listed by unmanagedSubItems, the sub item
 * comes in as a product (bringSubItem: linked or new, the EXISTING venue item id), the option's
 * product_id is set to it, and the site's kept item_link goes. Planned with the real planner (the
 * products with every field touched, the options by the changes) until it writes nothing at the site.
 *   opts   { idGen, siteName, only: [optionId] (default every one) }
 * Returns { ok, changes, words, problems, count }.
 */
export function repairSubItemsChanges(central, locationId, raw, opts = {}) {
  const idGen = opts.idGen || defaultUuid;
  const loc = locationId;
  const siteName = opts.siteName || 'this site';
  const items = listOf(raw?.items).filter(Boolean);
  const fail = (w) => ({ ok: false, changes: [], words: [], problems: [w], count: 0 });
  if (!listOf(central?.sites).some((s) => s.location_id === loc)) return fail('That site is not in the group menu yet. Add the site first.');
  let list = unmanagedSubItems(central, loc, raw);
  if (opts.only) list = list.filter((u) => opts.only.includes(u.optionId));
  if (!list.length) return fail(`Every sub item ${siteName}'s options use is in the group menu.`);

  const changes = [];
  const words = [];
  const C = applyChanges(central, []).central;
  const productOfItem = new Map(listOf(C.productSites).filter((ps) => ps.location_id === loc).map((ps) => [ps.venue_item_id, ps.product_id]));
  const groupsHere = new Map(listOf(raw?.groups).filter(Boolean).map((g) => [g.id, g]));
  const affected = { products: new Set(), groups: new Set() };
  const siteRows = { ps: new Map(), gs: new Map(), os: new Map() };
  const { bringSubItem } = bringMachinery({ C, changes, loc, raw, items, idGen, siteName, words, productOfItem, siteRows, affected, groupsHere });
  const problems = [];
  let count = 0;
  const elsewhere = new Set();
  for (const u of list) {
    const pid = bringSubItem(u.itemId);
    if (!pid) { problems.push(`${u.itemName} (${u.groupName}: ${u.optionName}) has sizes or is a size, so it stays ${siteName}'s own.`); continue; }
    const o = listOf(C.options).find((x) => x.id === u.optionId);
    changes.push({ target: 'modifier_option', entity_id: u.optionId, location_id: null, op: 'update', after: { product_id: pid }, before: { product_id: o?.product_id ?? null } });
    o.product_id = pid;
    const os = listOf(C.optionSites).find((x) => x.option_id === u.optionId && x.location_id === loc);
    if (os && has(os.kept, 'item_link')) {
      const kept = { ...os.kept };
      delete kept.item_link;
      changes.push({ target: 'modifier_option_site', entity_id: u.optionId, location_id: loc, op: 'update', after: { kept }, before: { kept: os.kept } });
      os.kept = kept;
    }
    for (const x of listOf(C.optionSites)) if (x.option_id === u.optionId && x.location_id !== loc && x.active !== false) elsewhere.add(x.location_id);
    affected.groups.add(u.groupId);
    count++;
  }
  if (!count) return { ok: false, changes: [], words: [], problems, count: 0 };

  const last = settleAtSite({ central, changes, loc, raw, affected, siteRows, groupsHere, items, touchGroups: false });
  if (last.lines.length) {
    const vItem = new Map(items.map((i) => [i.id, i]));
    for (const l of last.lines.slice(0, 3)) problems.unshift(`${l.table === 'groups' ? (groupsHere.get(l.id)?.name || 'An option group') : nameOf(vItem.get(l.id))} at ${siteName} would change (${String(l.column).replace(/[()._]/g, ' ').trim()}), so nothing was added to the draft. Tell ServOS if this stays.`);
    return { ok: false, changes: [], words: [], problems, count: 0 };
  }
  const groups = new Set(list.filter((u) => changes.some((c) => c.target === 'modifier_option' && c.entity_id === u.optionId)).map((u) => u.groupId));
  words.unshift(`${count} option${count === 1 ? '' : 's'} in ${groups.size} group${groups.size === 1 ? '' : 's'} at ${siteName} now ${count === 1 ? 'points' : 'point'} at ${count === 1 ? 'a sub item' : 'sub items'} the group menu manages.`);
  words.push(`Nothing changes at ${siteName}: the tills keep selling them exactly as they do now.`);
  if (elsewhere.size) words.push(`${elsewhere.size} other site${elsewhere.size === 1 ? ' has' : 's have'} ${count === 1 ? 'this option' : 'these options'} on without the sub item${count === 1 ? '' : 's'}: the next publish puts ${count === 1 ? 'it' : 'them'} there, hidden from the menus.`);
  return { ok: true, changes: orderForGuard(changes), words, problems, count };
}

/** "Provo: 23 options in 3 groups point at sub items the group menu does not manage." */
export function subItemCountWords(list, siteName) {
  const n = listOf(list).length;
  if (!n) return `Every sub item ${siteName}'s options use is in the group menu.`;
  const g = new Set(list.map((u) => u.groupId)).size;
  return `${siteName}: ${n} option${n === 1 ? '' : 's'} in ${g} group${g === 1 ? '' : 's'} point${n === 1 ? 's' : ''} at sub items the group menu does not manage.`;
}

/**
 * BRING IN ALL (Sync from sites, 5.12.31): everything a site has that the group menu does not, in
 * one set of changes: its own option groups first (linked to the group that looks like them, else
 * new), then its own products (linked to the product that looks like them, by family or name, else
 * new, with their sizes), then the sub items its managed options still point at. Each step is worked
 * out on the draft as the steps before it left it, and each must write nothing at the site on its
 * own (a step that cannot is left out and said). Then the whole set is planned once more and must
 * write nothing. Returns { ok, changes, words, problems, counts: { groups, products, subItems } }.
 */
export function bringInAllChanges(central, locationId, raw, opts = {}) {
  const loc = locationId;
  const siteName = opts.siteName || 'this site';
  const idGen = opts.idGen || defaultUuid;
  const fail = (w) => ({ ok: false, changes: [], words: [], problems: [w], counts: { groups: 0, products: 0, subItems: 0 } });
  if (!raw) return fail('Read the sites first.');
  if (!listOf(central?.sites).some((s) => s.location_id === loc)) return fail('That site is not in the group menu yet. Add the site first.');
  let C = applyChanges(central, []).central;
  let changes = [];
  const words = [];
  const problems = [];
  const counts = { groups: 0, products: 0, subItems: 0 };
  const take = (r, kind) => {
    if (!r.ok) { problems.push(...r.problems); return false; }
    changes = [...changes, ...r.changes];
    C = applyChanges(C, r.changes).central;
    counts[kind]++;
    return true;
  };
  for (const g of ownGroups(C, loc, raw)) {
    if (listOf(C.groupSites).some((gs) => gs.location_id === loc && gs.venue_group_id === g.id)) continue;   // came in as a Then ask group
    const r = bringInGroupChanges(C, loc, raw, g.id, { linkTo: g.match?.groupId || null, idGen, siteName });
    if (take(r, 'groups')) words.push(r.words[0]);
  }
  for (const o of ownProducts(C, loc, raw).filter((x) => !x.archived)) {
    if (listOf(C.productSites).some((ps) => ps.location_id === loc && ps.venue_item_id === o.id)) continue;   // came in as a sub item
    const r = bringInChanges(C, loc, raw, o.id, { linkTo: o.match?.productId || null, idGen, siteName });
    if (take(r, 'products')) words.push(r.words[0]);
  }
  const subs = unmanagedSubItems(C, loc, raw);
  if (subs.length) {
    const r = repairSubItemsChanges(C, loc, raw, { idGen, siteName });
    if (r.ok) { changes = [...changes, ...r.changes]; C = applyChanges(C, r.changes).central; counts.subItems = r.count; words.push(r.words[0]); }
    problems.push(...r.problems);
  }
  if (!changes.length) return { ...fail(`Everything ${siteName} sells is in the group menu.`), problems: [`Everything ${siteName} sells is in the group menu.`, ...problems] };
  // The whole set, planned as the server will: it must write nothing at the site.
  const plan = planSite({ central: C, touched: touchedFromChanges(changes), locationId: loc, orgId: opts.orgId || null, venue: raw });
  if (plan.lines.length) return { ...fail(`Bringing everything in would change ${plan.lines.length} thing${plan.lines.length === 1 ? '' : 's'} at ${siteName}, so nothing was put in the draft. Bring them in one at a time to see which.`), problems };
  words.push(`Nothing changes at ${siteName} when you publish: what it does differently stays its own.`);
  return { ok: true, changes, words, problems, counts };
}

/** "Leeds has 3 option groups of its own, not in the group menu." */
export function ownGroupCountWords(n, siteName) {
  if (!n) return `Every option group ${siteName} asks is in the group menu.`;
  return `${siteName} has ${n} option group${n === 1 ? '' : 's'} of its own, not in the group menu.`;
}

export { money2 };
