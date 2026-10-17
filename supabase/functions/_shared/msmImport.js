// supabase/functions/_shared/msmImport.js
//
// MULTI SITE MENU (17 Oct 2026, v5.11.75): the FIRST IMPORT. Turns the menus the venues have
// today into one central menu, WRITING NOTHING AT ANY VENUE. Pure, tested on a coffee chain shaped
// fixture (src/lib/msm/msmImport.test.js): shared families, masters demoted to local, master_id
// equal to its own id, null masters, copies with no category, products archived at one venue.
//
// HOW IT MATCHES (strongest first, design section 2)
//   1. Same shared family: master_id, or the id with its `_<8 hex>` venue suffix removed.
//   2. Same normalised name (lower case, punctuation gone, "&" as "and"), same type and the same
//      parent for sizes. Shown side by side; must be ticked.
//   3. Only at one site: a site only extra, or Leave out (stays the venue's own, not managed).
//      Archived local only rows default to Leave out.
//   Clashes (two products with one name at one site) are listed and must be settled by hand.
//
// WHAT IT KEEPS (design review, blocker 3)
//   Shared lets a venue keep its own category, photo and names. The central model has one of
//   each, so every venue value that differs from the group's is stored in
//   msm_product_sites.kept, by venue column, instead of refusing the product. Publish never
//   writes a kept column at that site unless a change clears it there.
//
// THE SELF CHECK
//   The planner is run for every site with EVERY managed field of every product touched. It must
//   plan ZERO writes. Anything left is listed in words and the import cannot be created.
//   This is the real proof that "publishing now would change 0 things at 0 sites".

import { familyOf, normName, toPence, fromPence, CHANNELS, KEPT_COLUMNS, STAGE_FIELDS, sameValue } from './msmModel.js';
import { planSite, touchedFromChanges } from './msmPlan.js';

const listOf = (v) => (Array.isArray(v) ? v : []);
const keyOf = (loc, id) => `${loc}|${id}`;

const defaultUuid = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // Not for production: tests pass their own idGen.
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
};

// The categories in a venue menu: menu_id is the menu or a link says so, plus their parents.
function categoriesInMenu(raw, venueMenuId) {
  const cats = listOf(raw.categories);
  const linked = new Set(listOf(raw.links).filter((l) => l.menu_id === venueMenuId).map((l) => l.category_id));
  const byId = new Map(cats.map((c) => [c.id, c]));
  const out = new Set(cats.filter((c) => c.menu_id === venueMenuId || linked.has(c.id)).map((c) => c.id));
  for (const id of [...out]) {
    let p = byId.get(id)?.parent_id, n = 0;
    while (p && byId.has(p) && n++ < 20) { out.add(p); p = byId.get(p).parent_id; }
  }
  return out;
}

const rateOf = (raw, id) => listOf(raw.taxRates).find((r) => r.id === id) || null;

/**
 * Propose a central menu from the venues.
 *   sites    [{ location_id, name, venue_menu_id, raw }]   raw = readVenueRaw(...) shape
 *   opts     { idGen }
 * Returns a proposal: { masterSite, sites, categories, catSites, groups, groupSites, products,
 *   productSites, review: { family, name, differentNames, onlyOne, clashes, categoryNames } }.
 * Nothing is linked for the name only matches until the person ticks them (buildCentral).
 */
export function proposeImport(sites, opts = {}) {
  const idGen = opts.idGen || defaultUuid;
  const S = listOf(sites).filter((s) => s && s.raw && s.location_id);

  // ── The site holding most masters sets the central order and the central values ──
  const masterCount = (s) => listOf(s.raw.items).filter((i) => !i.master_id && familyOf(i) === i.id && !/_[0-9a-f]{8}$/i.test(i.id)).length;
  const masterSite = [...S].sort((a, b) => masterCount(b) - masterCount(a))[0]?.location_id || null;
  const siteOrder = [...S].sort((a, b) => (a.location_id === masterSite ? -1 : b.location_id === masterSite ? 1 : 0));

  // ── Categories: union across sites, by family then label and parent ──
  const categories = [];
  const catSites = [];
  const catKeyToCentral = new Map();      // `${loc}|${venueCatId}` -> central id
  const catFamily = new Map();            // family -> central id
  const catLabel = new Map();             // `${normLabel}|${centralParent}` -> central id
  const categoryNames = [];
  for (const s of siteOrder) {
    const inMenu = categoriesInMenu(s.raw, s.venue_menu_id);
    const cats = listOf(s.raw.categories).filter((c) => inMenu.has(c.id));
    const byId = new Map(cats.map((c) => [c.id, c]));
    const depth = (c, n = 0) => (c.parent_id && byId.has(c.parent_id) && n < 20 ? 1 + depth(byId.get(c.parent_id), n + 1) : 0);
    cats.sort((a, b) => depth(a) - depth(b) || (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.id).localeCompare(String(b.id)));
    for (const c of cats) {
      const fam = familyOf(c);
      const parentCentral = c.parent_id ? catKeyToCentral.get(keyOf(s.location_id, c.parent_id)) || null : null;
      const lk = `${normName(c.label)}|${parentCentral || ''}`;
      let cid = catFamily.get(fam) || catLabel.get(lk) || null;
      if (cid && catSites.some((r) => r.category_id === cid && r.location_id === s.location_id)) cid = null;   // one per site
      if (!cid) {
        cid = idGen();
        categories.push({
          id: cid, parent_id: parentCentral, label: c.label || 'Category', icon: c.icon ?? '🍽', color: c.color ?? '#3b82f6',
          accounting_group: c.accounting_group ?? '', default_course: c.default_course ?? 1, sort_order: c.sort_order ?? 0,
          image: c.image ?? null, archived: false, route_like_id: null,
        });
      } else {
        const central = categories.find((x) => x.id === cid);
        if (central && normName(central.label) !== normName(c.label)) categoryNames.push({ categoryId: cid, location_id: s.location_id, label: c.label, central: central.label });
      }
      catFamily.set(fam, catFamily.get(fam) || cid);
      catLabel.set(lk, catLabel.get(lk) || cid);
      catKeyToCentral.set(keyOf(s.location_id, c.id), cid);
      catSites.push({ category_id: cid, location_id: s.location_id, venue_category_id: c.id });
    }
  }

  // ── Products: families first ──
  const all = [];   // { loc, row }
  for (const s of S) for (const row of listOf(s.raw.items)) if (row && !String(row.id).startsWith('demo-')) all.push({ loc: s.location_id, row });
  const families = new Map();
  for (const x of all) {
    const f = familyOf(x.row);
    if (!families.has(f)) families.set(f, []);
    families.get(f).push(x);
  }
  const groupsOfItems = [];          // [{ kind: 'family'|'name'|'one', members: [{loc,row}] }]
  const leftovers = [];
  const clashes = [];
  for (const [fam, members] of families) {
    const locs = new Set(members.map((m) => m.loc));
    if (locs.size !== members.length) {
      // Two rows of one family at one site: a clash, settled by hand.
      const byLoc = new Map();
      for (const m of members) { if (!byLoc.has(m.loc)) byLoc.set(m.loc, []); byLoc.get(m.loc).push(m); }
      for (const [loc, ms] of byLoc) if (ms.length > 1) clashes.push({ location_id: loc, name: ms[0].row.name, ids: ms.map((m) => m.row.id), family: fam });
      // Keep the first per site in the family; the rest are left as the venue's own.
      const firsts = [...byLoc.values()].map((ms) => ms[0]);
      if (firsts.length > 1) groupsOfItems.push({ kind: 'family', members: firsts });
      else leftovers.push(firsts[0]);
      continue;
    }
    if (members.length > 1) groupsOfItems.push({ kind: 'family', members });
    else leftovers.push(members[0]);
  }
  // Name matches among the leftovers: same normalised name, same type, same parent family.
  const parentFam = (x) => {
    const pid = x.row.parent_id;
    if (!pid) return '';
    const p = all.find((y) => y.loc === x.loc && y.row.id === pid);
    return p ? familyOf(p.row) : `?${pid}`;
  };
  const byName = new Map();
  for (const x of leftovers) {
    const k = `${normName(x.row.menu_name || x.row.name)}|${x.row.type || 'simple'}|${parentFam(x)}`;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(x);
  }
  for (const [, xs] of byName) {
    const locs = new Set(xs.map((x) => x.loc));
    if (xs.length > 1 && locs.size === xs.length) groupsOfItems.push({ kind: 'name', members: xs });
    else if (xs.length > 1) {
      // Same name twice at one site: a clash; each stays its own.
      const byLoc = new Map();
      for (const x of xs) { if (!byLoc.has(x.loc)) byLoc.set(x.loc, []); byLoc.get(x.loc).push(x); }
      for (const [loc, ms] of byLoc) if (ms.length > 1) clashes.push({ location_id: loc, name: ms[0].row.name, ids: ms.map((m) => m.row.id) });
      for (const x of xs) groupsOfItems.push({ kind: 'one', members: [x] });
    } else groupsOfItems.push({ kind: 'one', members: xs });
  }

  // ── Central products from each group ──
  const products = [];
  const productSites = [];
  const itemKeyToCentral = new Map();
  const review = { family: [], name: [], differentNames: [], onlyOne: [], clashes, categoryNames };
  for (const g of groupsOfItems) {
    const id = idGen();
    const members = g.members;
    for (const m of members) itemKeyToCentral.set(keyOf(m.loc, m.row.id), id);
    // The master row: the bare master id, else the master site's copy, else the first.
    const master = members.find((m) => m.row.id === familyOf(m.row) && !m.row.master_id) || members.find((m) => m.loc === masterSite) || members[0];
    products.push({ id, _group: g, _master: master });
    const names = new Set(members.map((m) => (m.row.menu_name || m.row.name || '').trim()));
    if (g.kind === 'family') review.family.push({ productId: id, sites: members.length });
    if (g.kind === 'name') review.name.push({ productId: id, sites: members.length, names: members.map((m) => ({ location_id: m.loc, id: m.row.id, name: m.row.menu_name || m.row.name })) });
    if (names.size > 1) review.differentNames.push({ productId: id, names: members.map((m) => ({ location_id: m.loc, name: m.row.menu_name || m.row.name })) });
    if (g.kind === 'one') review.onlyOne.push({ productId: id, location_id: members[0].loc, archived: members[0].row.archived === true, name: members[0].row.menu_name || members[0].row.name, defaultChoice: members[0].row.archived === true ? 'leave' : 'extra' });
  }

  // ── Modifier groups: those the products use, by family then name ──
  const groups = [];
  const groupSites = [];
  const groupKeyToCentral = new Map();
  const groupFamily = new Map();
  const groupName = new Map();
  for (const s of siteOrder) {
    const used = new Set();
    for (const i of listOf(s.raw.items)) for (const a of listOf(i.assigned_modifier_groups)) if (a && a.groupId) used.add(a.groupId);
    for (const gr of listOf(s.raw.groups).filter((x) => used.has(x.id))) {
      const fam = familyOf(gr);
      const nk = normName(gr.name);
      let gid = groupFamily.get(fam) || groupName.get(nk) || null;
      if (gid && groupSites.some((r) => r.group_id === gid && r.location_id === s.location_id)) gid = null;
      if (!gid) {
        gid = idGen();
        groups.push({ id: gid, name: gr.name, min: gr.min ?? 0, max: gr.max ?? 1, selection_type: gr.selection_type || 'single', sort_order: gr.sort_order ?? 0, source_location_id: s.location_id, _raw: gr });
      }
      groupFamily.set(fam, groupFamily.get(fam) || gid);
      groupName.set(nk, groupName.get(nk) || gid);
      groupKeyToCentral.set(keyOf(s.location_id, gr.id), gid);
      groupSites.push({ group_id: gid, location_id: s.location_id, venue_group_id: gr.id });
    }
  }
  // Central options point at central products (productId) where the option has an item.
  for (const g of groups) {
    g.options = listOf(g._raw.options).map((o) => {
      if (!o) return null;
      const { itemId, ...rest } = o;
      const pid = itemId ? itemKeyToCentral.get(keyOf(g.source_location_id, itemId)) : null;
      return pid ? { ...rest, productId: pid } : { ...rest };
    }).filter(Boolean);
    delete g._raw;
  }

  // ── Fill in each product from its master row and the sites ──
  const siteRaw = new Map(S.map((s) => [s.location_id, s.raw]));
  for (const p of products) {
    const { _group: g, _master: m } = p;
    const r = m.row;
    const raw = siteRaw.get(m.loc);
    const rate = r.tax_rate_id ? rateOf(raw, r.tax_rate_id) : null;
    // Default price: the most common across sites, a tie takes the master's.
    const counts = new Map();
    for (const x of g.members) {
      const pp = toPence(x.row.pricing?.base);
      if (pp === null || Number.isNaN(pp)) continue;
      counts.set(pp, (counts.get(pp) || 0) + 1);
    }
    const masterP = toPence(r.pricing?.base);
    let best = masterP, bestN = -1;
    for (const [pp, n] of counts) if (n > bestN || (n === bestN && pp === masterP)) { best = pp; bestN = n; }
    // Channel defaults only where every site agrees on a value.
    const defaultChannels = {};
    for (const k of CHANNELS) {
      const vals = g.members.map((x) => toPence(x.row.pricing?.[k]));
      defaultChannels[k] = vals.length && vals.every((v) => v != null && v === vals[0]) ? fromPence(vals[0]) : null;
    }
    Object.assign(p, {
      category_id: r.cat ? catKeyToCentral.get(keyOf(m.loc, r.cat)) || null : null,
      extra_category_ids: listOf(r.cats).map((c) => catKeyToCentral.get(keyOf(m.loc, c))).filter(Boolean),
      parent_product_id: r.parent_id ? itemKeyToCentral.get(keyOf(m.loc, r.parent_id)) || null : null,
      type: r.type || 'simple',
      name: r.name ?? r.menu_name ?? 'Item', menu_name: r.menu_name ?? null, receipt_name: r.receipt_name ?? null,
      kitchen_name: r.kitchen_name ?? null, description: r.description ?? '',
      default_price: best == null ? 0 : fromPence(best),
      default_channels: defaultChannels,
      tax_rate_name: rate ? rate.name : null, tax_rate_percent: rate ? Number(rate.rate) : null,
      allergens: listOf(r.allergens), tags: listOf(r.tags), image: r.image ?? null,
      modifier_groups: listOf(r.assigned_modifier_groups).map((a) => {
        if (!a || !a.groupId) return null;
        const gid = groupKeyToCentral.get(keyOf(m.loc, a.groupId));
        return gid ? { ...a, groupId: gid } : null;
      }).filter(Boolean),
      visibility: r.visibility ?? null, sold_alone: !!r.sold_alone, item_code: r.item_code ?? null,
      site_only_location_id: g.kind === 'one' ? m.loc : null,
      archived: false, sort_order: r.sort_order ?? 0,
      family_base: familyOf(r),
    });
    for (const x of g.members) {
      const pp = toPence(x.row.pricing?.base);
      const channel = {};
      for (const k of CHANNELS) {
        const v = toPence(x.row.pricing?.[k]);
        if (v != null && defaultChannels[k] == null) channel[k] = fromPence(v);
      }
      productSites.push({
        product_id: p.id, location_id: x.loc, venue_item_id: x.row.id, active: x.row.archived !== true,
        price: pp == null || pp === best ? null : fromPence(pp),
        channel_prices: Object.keys(channel).length ? channel : null,
        kept: {},
      });
    }
  }
  for (const p of products) { delete p._group; delete p._master; }
  return { masterSite, sites: S.map((s) => ({ location_id: s.location_id, venue_menu_id: s.venue_menu_id, name: s.name })), categories, catSites, groups, groupSites, products, productSites, review };
}

// Every managed field of every product touched: the self check's change set.
export function touchEverything(central) {
  const changes = [];
  const productFields = STAGE_FIELDS.product.filter((f) => !['site_only_location_id', 'sort_order', 'family_base'].includes(f));
  for (const p of listOf(central.products)) {
    const after = {};
    for (const f of productFields) after[f] = p[f] ?? null;
    changes.push({ target: 'product', entity_id: p.id, op: 'update', after });
  }
  for (const ps of listOf(central.productSites)) {
    changes.push({ target: 'product_site', entity_id: ps.product_id, location_id: ps.location_id, op: 'update', after: { active: ps.active, price: ps.price, channel_prices: ps.channel_prices } });
  }
  return changes;
}

/**
 * Settle the person's choices into a central menu, work out what each site keeps, and run the
 * self check.
 *   proposal   proposeImport(...)
 *   sites      the same sites array (for the raw rows)
 *   decisions  { leaveOut: [productId], rejectName: [productId], names: { productId: name },
 *                onlyOne: { productId: 'extra' | 'leave' } }
 * Returns { central, check: { ok, writes, problems: [words] }, dropped }.
 */
export function buildCentral(proposal, sites, decisions = {}, opts = {}) {
  const idGen = opts.idGen || defaultUuid;
  const leave = new Set(decisions.leaveOut || []);
  for (const o of proposal.review.onlyOne) {
    const choice = (decisions.onlyOne || {})[o.productId] || o.defaultChoice;
    if (choice === 'leave') leave.add(o.productId);
  }
  let products = proposal.products.filter((p) => !leave.has(p.id)).map((p) => ({ ...p }));
  let productSites = proposal.productSites.filter((ps) => !leave.has(ps.product_id)).map((ps) => ({ ...ps, kept: { ...(ps.kept || {}) } }));
  // A name match the person did not tick: each site's row becomes its own site only extra.
  const reject = new Set((decisions.rejectName || []).filter((id) => proposal.review.name.some((n) => n.productId === id)));
  for (const pid of reject) {
    const base = products.find((p) => p.id === pid);
    const rows = productSites.filter((ps) => ps.product_id === pid);
    if (!base || !rows.length) continue;
    products = products.filter((p) => p.id !== pid);
    productSites = productSites.filter((ps) => ps.product_id !== pid);
    for (const ps of rows) {
      const nid = idGen();
      products.push({ ...base, id: nid, site_only_location_id: ps.location_id, family_base: ps.venue_item_id.replace(/_[0-9a-f]{8}$/i, '') });
      productSites.push({ ...ps, product_id: nid, price: null, kept: {} });
    }
  }
  // Chosen central names.
  for (const [pid, name] of Object.entries(decisions.names || {})) {
    const p = products.find((x) => x.id === pid);
    if (p && name && String(name).trim()) { p.name = String(name).trim(); p.menu_name = String(name).trim(); }
  }
  // Sizes whose parent was left out lose their parent link centrally (each site keeps its own).
  const ids = new Set(products.map((p) => p.id));
  for (const p of products) if (p.parent_product_id && !ids.has(p.parent_product_id)) p.parent_product_id = null;
  // Options pointing at a product that was left out keep their item at the venue only.
  const dropProduct = (o) => { const copy = { ...o }; delete copy.productId; return copy; };
  const groups = proposal.groups.map((g) => ({ ...g, options: g.options.map((o) => (o.productId && !ids.has(o.productId) ? dropProduct(o) : o)) }));

  const central = {
    menu: { id: 'import', name: decisions.menuName || 'Group menu', description: decisions.menuDescription || '', use_name_everywhere: false },
    sites: proposal.sites, categories: proposal.categories, catSites: proposal.catSites,
    groups, groupSites: proposal.groupSites, products, productSites,
  };
  const check = settleKept(central, sites);
  return { central, check, dropped: [...leave] };
}

/**
 * Work out every kept venue value and run the self check: plan each site with everything
 * touched until it plans nothing. Mutates central.productSites (price, channel_prices, active,
 * kept). Returns { ok, writes, problems: [{ location_id, words }] }.
 */
export function settleKept(central, sites, { passes = 4 } = {}) {
  const raws = new Map(listOf(sites).map((s) => [s.location_id, s.raw]));
  const psIndex = new Map(central.productSites.map((ps) => [keyOf(ps.location_id, ps.venue_item_id), ps]));
  const rowOf = (loc, id) => listOf(raws.get(loc)?.items).find((i) => i.id === id);
  let last = null;
  for (let pass = 0; pass < passes; pass++) {
    const touched = touchedFromChanges(touchEverything(central));
    let changed = 0;
    last = [];
    for (const s of central.sites) {
      const raw = raws.get(s.location_id);
      if (!raw) continue;
      const plan = planSite({ central, touched, locationId: s.location_id, orgId: null, venue: raw });
      for (const pr of plan.problems) {
        if (!pr.productId) continue;
        const ps = central.productSites.find((x) => x.product_id === pr.productId && x.location_id === s.location_id);
        if (!ps) continue;
        const row = rowOf(s.location_id, ps.venue_item_id);
        if (!row) continue;
        const col = pr.code === 'no_tax_rate' ? 'tax_rate_id' : pr.code === 'size_parent_missing' ? 'parent_id' : null;
        if (col && !Object.prototype.hasOwnProperty.call(ps.kept, col)) { ps.kept[col] = row[col] ?? null; changed++; }
      }
      for (const l of plan.lines) {
        if (l.table !== 'items' || l.column === '(new)') { if (l.table !== 'items') last.push({ location_id: s.location_id, line: l }); continue; }
        const ps = psIndex.get(keyOf(s.location_id, l.id));
        const row = rowOf(s.location_id, l.id);
        if (!ps || !row) { last.push({ location_id: s.location_id, line: l }); continue; }
        if (l.column === 'archived') { ps.active = row.archived !== true; changed++; continue; }
        if (l.column.startsWith('pricing.')) {
          const k = l.column.slice(8);
          if (k === 'base') ps.price = row.pricing?.base ?? null;
          else ps.channel_prices = { ...(ps.channel_prices || {}), [k]: row.pricing?.[k] ?? null };
          changed++;
          continue;
        }
        if (KEPT_COLUMNS.includes(l.column)) {
          if (!sameValue(ps.kept[l.column], row[l.column]) || !Object.prototype.hasOwnProperty.call(ps.kept, l.column)) { ps.kept[l.column] = row[l.column] ?? null; changed++; }
          continue;
        }
        last.push({ location_id: s.location_id, line: l });
      }
      // Writes that are not item lines (a category or group the plan would create) are only side
      // effects of the item columns above; they go once those are kept.
    }
    if (!changed) break;
  }
  // The final proof: zero writes at every site.
  const touched = touchedFromChanges(touchEverything(central));
  const problems = [];
  let writes = 0;
  for (const s of central.sites) {
    const raw = raws.get(s.location_id);
    if (!raw) continue;
    const plan = planSite({ central, touched, locationId: s.location_id, orgId: null, venue: raw });
    const n = plan.lines.length;
    writes += n;
    for (const l of plan.lines.slice(0, 20)) problems.push({ location_id: s.location_id, words: `${l.table} ${l.id}: ${l.column} would change` });
  }
  return { ok: writes === 0, writes, problems };
}

/** The payload public.msm_import_commit takes. */
export function importPayload(central, { orgId, name, description }) {
  const sitesOf = (rows, key, id) => rows.filter((r) => r[key] === id);
  return {
    org_id: orgId,
    menu: { name: name || central.menu?.name || 'Group menu', description: description ?? central.menu?.description ?? '' },
    sites: central.sites.map((s) => ({ location_id: s.location_id, venue_menu_id: s.venue_menu_id })),
    categories: central.categories.map((c) => ({ ...c, sites: sitesOf(central.catSites, 'category_id', c.id).map((r) => ({ location_id: r.location_id, venue_category_id: r.venue_category_id })) })),
    groups: central.groups.map((g) => ({ ...g, sites: sitesOf(central.groupSites, 'group_id', g.id).map((r) => ({ location_id: r.location_id, venue_group_id: r.venue_group_id })) })),
    products: central.products.map((p) => ({ ...p, sites: sitesOf(central.productSites, 'product_id', p.id).map((r) => ({ location_id: r.location_id, venue_item_id: r.venue_item_id, active: r.active, price: r.price, channel_prices: r.channel_prices, kept: r.kept || {} })) })),
  };
}

/** The review's headline numbers, in words. */
export function reviewWords(review) {
  const r = review || {};
  const n = (a) => listOf(a).length;
  return [
    `${n(r.family)} matched by family`,
    `${n(r.name)} matched by name only (tick to link)`,
    `${n(r.onlyOne)} only at one site`,
    ...(n(r.clashes) ? [`${n(r.clashes)} clash${n(r.clashes) === 1 ? '' : 'es'} to settle by hand`] : []),
  ].join(', ');
}
