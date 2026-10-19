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
  const ratesOf = () => listOf(raw?.taxRates);
  const groupsHere = new Map(listOf(raw?.groups).filter(Boolean).map((g) => [g.id, g]));
  const affected = { products: new Set(), groups: new Set() };
  const siteRows = { ps: new Map(), gs: new Map(), os: new Map() };   // our create changes, to settle

  // ── Products (the product and its sizes) ──────────────────────────────────
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
  const centralOfVenueGroup = new Map(listOf(C.groupSites).filter((gs) => gs.location_id === loc).map((gs) => [gs.venue_group_id, gs.group_id]));
  const visiting = new Set();
  const problems = [];
  function mapGroup(vgid) {
    if (centralOfVenueGroup.has(vgid)) return centralOfVenueGroup.get(vgid);
    const vg = groupsHere.get(vgid);
    if (!vg || visiting.has(vgid)) return null;
    visiting.add(vgid);
    for (const e of listOf(vg.options)) if (e && e.subGroupId) mapGroup(e.subGroupId);
    const fam = familyOf(vg);
    const existing = listOf(C.groups).find((g) => g && !g.archived && !listOf(C.groupSites).some((gs) => gs.group_id === g.id && gs.location_id === loc)
      && (g.family_base === fam || normName(g.name) === normName(vg.name)));
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
      const g = { name: vg.name || 'Options', min: Number(vg.min ?? 0), max: Number(vg.max ?? 1), selection_type: vg.selection_type || 'single', sort_order: Number(vg.sort_order ?? 0), family_base: fam };
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
      words.push(`Option group ${vg.name || 'Options'} comes in too (new in the group menu, at ${siteName} only).`);
    }
    affected.groups.add(gid);
    visiting.delete(vgid);
    return gid;
  }
  // A site option the group menu does not have: a new option, on here (same venue id), off elsewhere.
  function newOption(gid, e, sortOrder, onlyHere) {
    const oid = idGen();
    const pid = e.itemId ? productOfItem.get(e.itemId) || null : null;
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
      const pid = e.itemId ? productOfItem.get(e.itemId) || null : null;
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
  let last = null;
  for (let pass = 0; pass < 6; pass++) {
    const after = applyChanges(central, changes).central;
    const touched = touchedFromChanges(touchEverything({
      products: listOf(after.products).filter((p) => affected.products.has(p.id)),
      productSites: listOf(after.productSites).filter((ps) => ps.location_id === loc && affected.products.has(ps.product_id)),
      groups: listOf(after.groups).filter((g) => affected.groups.has(g.id)),
      options: listOf(after.options).filter((o) => affected.groups.has(o.group_id)),
      optionSites: listOf(after.optionSites).filter((os) => os.location_id === loc && listOf(after.options).some((o) => o.id === os.option_id && affected.groups.has(o.group_id))),
    }));
    const plan = planSite({ central: after, touched, locationId: loc, orgId: null, venue: raw });
    last = plan;
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
  // The proof.
  const after = applyChanges(central, changes).central;
  const touched = touchedFromChanges(touchEverything({
    products: listOf(after.products).filter((p) => affected.products.has(p.id)),
    productSites: listOf(after.productSites).filter((ps) => ps.location_id === loc && affected.products.has(ps.product_id)),
    groups: listOf(after.groups).filter((g) => affected.groups.has(g.id)),
    options: listOf(after.options).filter((o) => affected.groups.has(o.group_id)),
    optionSites: listOf(after.optionSites).filter((os) => os.location_id === loc && listOf(after.options).some((o) => o.id === os.option_id && affected.groups.has(o.group_id))),
  }));
  last = planSite({ central: after, touched, locationId: loc, orgId: null, venue: raw });
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
  // In the order the database guard checks references: a group before the products that use it,
  // a product before its site rows and the options that offer it, an option before its site rows.
  const RANK = { modifier_group: 0, product: 1, product_site: 2, modifier_group_site: 3, modifier_option: 4, modifier_option_site: 5 };
  const ordered = changes.map((c, i) => ({ c, i })).sort((a, b) => (RANK[a.c.target] - RANK[b.c.target]) || (a.i - b.i)).map((x) => x.c);
  return { ok: true, changes: ordered, words, problems: [], productId: mainId };
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

export { money2 };
