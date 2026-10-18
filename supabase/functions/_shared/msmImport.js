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
//   3. Only at one site: brought in as a product on at that one site, or Leave out (stays the
//      venue's own, not managed).
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
//
// ROUND 2: OPTION GROUPS AND VAT BY ORDER TYPE (design 1.9 and 5.3, and the design review)
//   * One central group per family (id less its venue suffix), then per normalised name. The
//     groups an option asks next ("Then ask") come in too, as groups of their own.
//   * Options are the UNION across sites, each one a row: matched by its sub item's central
//     product AND its normalised name, then by the product alone, then by the name alone.
//   * An option's default price is the most common across sites; a site with another price keeps
//     its own; a site where the group is but the option is not has it OFF (an explicit row).
//   * A site's own name, its own sub item link (or none) and its own "Then ask" are KEPT
//     (msm_modifier_option_sites.kept), so the first price change never rewrites them.
//   * Group rules (name, min, max, choice kind): the most common becomes the group's; a site that
//     differs keeps its own (msm_modifier_group_sites.kept).
//   * VAT by order type: the most common rate per key becomes the group's; a site that differs
//     keeps its own key (a rate, an explicit null, or "no key"); its other keys are kept as they are.
//   * The self check still says zero writes at every site, groups and VAT included.

import { familyOf, normName, toPence, fromPence, CHANNELS, KEPT_COLUMNS, STAGE_FIELDS, sameValue, samePrice, has, NO_PRICE } from './msmModel.js';
import { planSite, touchedFromChanges } from './msmPlan.js';
import { importTaxByType, sizeKeptTax } from './msmTax.js';

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

// The venue products the chosen venue menu sells (17 Oct review: a venue's second menu, such as
// catering, must never be pulled into the group menu). A product is in when one of its categories
// is in the menu, or when it has no category the venue still holds (a product taken out of its
// category by hand stays the site's to manage, as before). Then the sizes of those products, and
// the sub items their modifier groups offer (a sub item used only as an option still matches).
function itemsInMenu(raw, inMenu) {
  const items = listOf(raw.items);
  const catIds = new Set(listOf(raw.categories).map((c) => c.id));
  const keep = new Set();
  for (const i of items) {
    if (!i) continue;
    const known = [i.cat, ...listOf(i.cats)].filter((c) => c && catIds.has(c));
    if (!known.length || known.some((c) => inMenu.has(c))) keep.add(i.id);
  }
  const used = new Set();
  for (const i of items) if (i && keep.has(i.id)) for (const a of listOf(i.assigned_modifier_groups)) if (a && a.groupId) used.add(a.groupId);
  for (const g of listOf(raw.groups)) if (g && used.has(g.id)) for (const o of listOf(g.options)) if (o && o.itemId) keep.add(o.itemId);
  for (let grew = true, n = 0; grew && n < 10; n++) {
    grew = false;
    for (const i of items) if (i && !keep.has(i.id) && i.parent_id && keep.has(i.parent_id)) { keep.add(i.id); grew = true; }
  }
  return keep;
}

const rateOf = (raw, id) => listOf(raw.taxRates).find((r) => r.id === id) || null;

// ── Option groups (round 2) ─────────────────────────────────────────────────

// The most common value of `vals` (by key), a tie taken by `prefer`.
function mostCommon(vals, keyOf2 = (v) => JSON.stringify(v ?? null), prefer = undefined) {
  const counts = new Map();
  for (const v of vals) { const k = keyOf2(v); const c = counts.get(k) || { v, n: 0 }; c.n++; counts.set(k, c); }
  const pk = prefer === undefined ? null : keyOf2(prefer);
  let best = null;
  for (const [k, c] of counts) if (!best || c.n > best.n || (c.n === best.n && k === pk)) best = { ...c, k };
  return best ? best.v : undefined;
}

/**
 * The option groups of the chosen venue menus as central groups with option ROWS.
 *   sites            [{ location_id, raw }]
 *   siteOrder        the same, the site holding most masters first (its option order wins)
 *   keepBySite       Map(loc -> Set(venue item ids in the menu))
 *   itemKeyToCentral Map(`loc|venueItemId` -> central product id)
 *   existing         { groupKey: Map(`loc|venueGroupId` -> central group id), groups: [central
 *                    groups] }   for the one time refresh: groups already in the group menu keep
 *                    their ids and their rules
 * Returns { groups, groupSites, groupKeyToCentral, options, entries } where entries are the
 * per site facts finalizeOptionSites turns into option site rows once the products are settled.
 */
export function importGroups({ sites, siteOrder, keepBySite, itemKeyToCentral, idGen, masterSite = null, existing = null }) {
  const S = listOf(siteOrder || sites);
  const groups = [];
  const groupSites = [];
  const groupKeyToCentral = new Map();
  const groupFamily = new Map();
  const groupName = new Map();
  const members = new Map();             // central id -> [{ loc, row }]
  const known = new Map(listOf(existing?.groups).map((g) => [g.id, g]));
  // The groups each site uses: on the menu's products, then every group an option asks next.
  const usedBySite = new Map();
  for (const st of S) {
    const raw = st.raw;
    const keep = keepBySite.get(st.location_id) || new Set();
    const byId = new Map(listOf(raw.groups).filter(Boolean).map((g) => [g.id, g]));
    const used = new Set();
    for (const i of listOf(raw.items)) if (i && keep.has(i.id)) for (const a of listOf(i.assigned_modifier_groups)) { const id = typeof a === 'string' ? a : a?.groupId; if (id && byId.has(id)) used.add(id); }
    if (existing) for (const [k] of existing.groupKey) { const [l, vid] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)]; if (l === st.location_id && byId.has(vid)) used.add(vid); }
    for (let grew = true, n = 0; grew && n < 10; n++) {
      grew = false;
      for (const id of [...used]) for (const o of listOf(byId.get(id)?.options)) if (o && o.subGroupId && byId.has(o.subGroupId) && !used.has(o.subGroupId)) { used.add(o.subGroupId); grew = true; }
    }
    usedBySite.set(st.location_id, { used, byId });
  }
  for (const st of S) {
    const { used, byId } = usedBySite.get(st.location_id);
    const ordered = [...used].map((id) => byId.get(id)).sort((a, b) => (Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0)) || String(a.id).localeCompare(String(b.id)));
    for (const gr of ordered) {
      const fam = familyOf(gr);
      const nk = normName(gr.name);
      let gid = existing?.groupKey.get(keyOf(st.location_id, gr.id)) || null;
      if (!gid) {
        gid = groupFamily.get(fam) || groupName.get(nk) || null;
        if (gid && (groupSites.some((r) => r.group_id === gid && r.location_id === st.location_id)
          || listOf(existing?.groupKey ? [...existing.groupKey.entries()] : []).some(([k, v]) => v === gid && k.startsWith(`${st.location_id}|`)))) gid = null;
      }
      if (!gid) gid = idGen();
      if (!groups.some((g) => g.id === gid)) {
        const k = known.get(gid);
        groups.push({
          id: gid, name: k?.name ?? gr.name, min: k?.min ?? gr.min ?? 0, max: k?.max ?? gr.max ?? 1, selection_type: k?.selection_type || gr.selection_type || 'single',
          sort_order: k?.sort_order ?? gr.sort_order ?? 0, source_location_id: k?.source_location_id ?? st.location_id, family_base: k?.family_base ?? fam,
          archived: false, options: [], _fixed: !!k,
        });
      }
      groupFamily.set(fam, groupFamily.get(fam) || gid);
      groupName.set(nk, groupName.get(nk) || gid);
      groupKeyToCentral.set(keyOf(st.location_id, gr.id), gid);
      if (!groupSites.some((r) => r.group_id === gid && r.location_id === st.location_id)) groupSites.push({ group_id: gid, location_id: st.location_id, venue_group_id: gr.id, kept: {} });
      if (!members.has(gid)) members.set(gid, []);
      members.get(gid).push({ loc: st.location_id, row: gr });
    }
  }
  // Group rules: the most common at the sites (a group already in the group menu keeps its own);
  // a site that differs keeps its own value.
  for (const g of groups) {
    const ms = members.get(g.id) || [];
    const master = ms.find((m) => m.loc === masterSite) || ms[0];
    if (!g._fixed) {
      g.name = mostCommon(ms.map((m) => m.row.name ?? 'Options'), undefined, master?.row.name) ?? g.name;
      g.min = Number(mostCommon(ms.map((m) => Number(m.row.min ?? 0)), undefined, Number(master?.row.min ?? 0)) ?? 0);
      g.max = Number(mostCommon(ms.map((m) => Number(m.row.max ?? 1)), undefined, Number(master?.row.max ?? 1)) ?? 1);
      g.selection_type = mostCommon(ms.map((m) => m.row.selection_type || 'single'), undefined, master?.row.selection_type || 'single') || 'single';
    }
    delete g._fixed;
    for (const m of ms) {
      const gs = groupSites.find((r) => r.group_id === g.id && r.location_id === m.loc);
      const kept = {};
      if ((m.row.name ?? 'Options') !== g.name) kept.name = m.row.name ?? null;
      if (Number(m.row.min ?? 0) !== Number(g.min)) kept.min = Number(m.row.min ?? 0);
      if (Number(m.row.max ?? 1) !== Number(g.max)) kept.max = Number(m.row.max ?? 1);
      if ((m.row.selection_type || 'single') !== g.selection_type) kept.selection_type = m.row.selection_type || 'single';
      gs.kept = kept;
    }
  }
  // Options: the union across sites, one row each.
  const options = [];
  const entries = [];                    // { optionId, loc, entry, productId, subGroupId (central) }
  for (const g of groups) {
    const ms = [...(members.get(g.id) || [])].sort((a, b) => (a.loc === masterSite ? -1 : b.loc === masterSite ? 1 : 0));
    const mine = [];
    let order = 0;
    for (const m of ms) {
      const taken = new Set();
      for (const e of listOf(m.row.options)) {
        if (!e || typeof e !== 'object') continue;
        const productId = e.itemId ? itemKeyToCentral.get(keyOf(m.loc, e.itemId)) || null : null;
        const nk = normName(e.name);
        const free = mine.filter((o) => !taken.has(o.id));
        const hit = (productId && free.find((o) => o.product_id === productId && normName(o.name) === nk))
          || (productId && free.find((o) => o.product_id === productId))
          || free.find((o) => normName(o.name) === nk && (!o.product_id || !productId || o.product_id === productId))
          || null;
        const subCentral = e.subGroupId ? groupKeyToCentral.get(keyOf(m.loc, e.subGroupId)) || null : null;
        let o = hit;
        if (!o) {
          o = { id: idGen(), group_id: g.id, name: e.name ?? 'Option', price: Number(e.price ?? 0), product_id: productId, sub_group_id: subCentral, sort_order: order++, archived: false };
          mine.push(o);
          options.push(o);
        }
        taken.add(o.id);
        entries.push({ optionId: o.id, groupId: g.id, loc: m.loc, entry: e, productId, subGroupId: subCentral });
      }
    }
    // The default price: the most common across the sites that have it (the master's on a tie).
    for (const o of mine) {
      const es = entries.filter((x) => x.optionId === o.id);
      const masterE = es.find((x) => x.loc === masterSite) || es[0];
      const best = mostCommon(es.map((x) => toPence(x.entry.price ?? 0)), (v) => String(v), toPence(masterE?.entry.price ?? 0));
      o.price = best == null || Number.isNaN(best) ? 0 : fromPence(best);
    }
  }
  return { groups, groupSites, groupKeyToCentral, options, entries };
}

/**
 * The option site rows, once the products are settled (a product left out takes its options' sub
 * item link with it): every site where the group is gets a row for every option, on with the
 * site's own price where it differs, or off; and what the site keeps (its own name, sub item link,
 * "Then ask").
 */
export function finalizeOptionSites(central, entries) {
  const ids = new Set(listOf(central.products).map((p) => p.id));
  for (const o of listOf(central.options)) if (o.product_id && !ids.has(o.product_id)) o.product_id = null;
  const venueItemOf = new Map(listOf(central.productSites).map((ps) => [keyOf(ps.location_id, ps.product_id), ps.venue_item_id]));
  const venueGroupOf = new Map(listOf(central.groupSites).map((gs) => [keyOf(gs.location_id, gs.group_id), gs.venue_group_id]));
  const out = [];
  for (const o of listOf(central.options)) {
    const sitesOfGroup = listOf(central.groupSites).filter((gs) => gs.group_id === o.group_id).map((gs) => gs.location_id);
    for (const loc of sitesOfGroup) {
      const x = listOf(entries).find((e) => e.optionId === o.id && e.loc === loc);
      if (!x) { out.push({ option_id: o.id, location_id: loc, venue_option_id: null, active: false, price: null, kept: {} }); continue; }
      const e = x.entry;
      // An entry with no id cannot be matched by publish: it stays the site's own (never doubled).
      if (e.id == null || e.id === '') { out.push({ option_id: o.id, location_id: loc, venue_option_id: null, active: false, price: null, kept: {} }); continue; }
      const kept = {};
      if ((e.name ?? 'Option') !== (o.name ?? 'Option')) kept.name = e.name ?? null;
      const wantItem = o.product_id ? venueItemOf.get(keyOf(loc, o.product_id)) || null : null;
      if ((e.itemId || null) !== wantItem) kept.item_link = e.itemId || false;
      const wantSub = o.sub_group_id ? venueGroupOf.get(keyOf(loc, o.sub_group_id)) || null : null;
      if ((e.subGroupId || null) !== wantSub) kept.sub_group = e.subGroupId || false;
      out.push({
        option_id: o.id, location_id: loc, venue_option_id: e.id ?? null, active: true,
        price: samePrice(e.price ?? 0, o.price) ? null : Number(e.price ?? 0), kept,
      });
    }
  }
  return out;
}

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
  const inMenuBySite = new Map(S.map((s) => [s.location_id, categoriesInMenu(s.raw, s.venue_menu_id)]));
  const keepBySite = new Map(S.map((s) => [s.location_id, itemsInMenu(s.raw, inMenuBySite.get(s.location_id))]));
  const inMenuItem = (loc, row) => {
    const cats = inMenuBySite.get(loc) || new Set();
    return [row.cat, ...listOf(row.cats)].some((c) => c && cats.has(c));
  };
  for (const s of siteOrder) {
    const inMenu = inMenuBySite.get(s.location_id);
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
  for (const s of S) {
    const keep = keepBySite.get(s.location_id);
    for (const row of listOf(s.raw.items)) if (row && keep.has(row.id) && !String(row.id).startsWith('demo-')) all.push({ loc: s.location_id, row });
  }
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
      // Per site, the copy actually on sale is matched: on and in the menu, else on, else the first.
      // The rest are left as the venue's own.
      const pick = (loc, ms) => ms.find((m) => m.row.archived !== true && inMenuItem(loc, m.row)) || ms.find((m) => m.row.archived !== true) || ms[0];
      for (const [loc, ms] of byLoc) if (ms.length > 1) clashes.push({ location_id: loc, name: pick(loc, ms).row.name, ids: ms.map((m) => m.row.id), family: fam, matchedId: pick(loc, ms).row.id });
      const firsts = [...byLoc.entries()].map(([loc, ms]) => pick(loc, ms));
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
      for (const [loc, ms] of byLoc) if (ms.length > 1) clashes.push({ location_id: loc, name: ms[0].row.name, ids: ms.map((m) => m.row.id), matchedId: null });
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

  // ── Option groups: those the products use (and the groups their options ask next) ──
  const ig = importGroups({ sites: S, siteOrder, keepBySite, itemKeyToCentral, idGen, masterSite });
  const { groups, groupSites, groupKeyToCentral } = ig;

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
      // Peter, 17 Oct 2026 (UI issue 6): no "site only extra". A product at one site is a normal
      // product, switched on at that site and nowhere else (no row elsewhere: nothing written there).
      site_only_location_id: null,
      archived: false, sort_order: r.sort_order ?? 0,
      family_base: familyOf(r),
      tax_by_type: null,
    });
    // VAT by order type (sizes follow their product's, worked out below).
    const tax = r.parent_id ? { taxByType: null, kept: new Map() } : importTaxByType(g.members, (loc) => siteRaw.get(loc)?.taxRates || [], m.loc);
    p.tax_by_type = tax.taxByType;
    p._taxKept = tax.kept;
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
        kept: p._taxKept.has(x.loc) ? { tax_overrides: p._taxKept.get(x.loc) } : {},
      });
    }
  }
  // A size follows its product's row at its site (17 Oct recheck: publish writes the product's
  // four keys to every size, as Menu Manager cascades them), so a size keeps only the keys that
  // differ from its product's row there.
  for (const p of products) {
    if (!p.parent_product_id) continue;
    for (const x of p._group.members) {
      const parentRow = x.row.parent_id ? listOf(siteRaw.get(x.loc)?.items).find((i) => i && i.id === x.row.parent_id) : null;
      const kept = sizeKeptTax(x.row, parentRow);
      if (!kept) continue;
      const ps = productSites.find((r) => r.product_id === p.id && r.location_id === x.loc);
      if (ps) ps.kept = { ...ps.kept, tax_overrides: kept };
    }
  }
  for (const p of products) { delete p._group; delete p._master; delete p._taxKept; }
  return {
    masterSite, sites: S.map((s) => ({ location_id: s.location_id, venue_menu_id: s.venue_menu_id, name: s.name })),
    categories, catSites, groups, groupSites, options: ig.options, optionSites: [], optionEntries: ig.entries,
    products, productSites, review,
  };
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
  // Round 2: every group rule and every option, at every site (order is never touched: an order
  // that differs between sites causes no writes).
  for (const g of listOf(central.groups)) {
    if (g.archived) continue;
    changes.push({ target: 'modifier_group', entity_id: g.id, op: 'update', after: { name: g.name, min: g.min, max: g.max, selection_type: g.selection_type } });
  }
  for (const o of listOf(central.options)) {
    changes.push({ target: 'modifier_option', entity_id: o.id, op: 'update', after: { name: o.name, price: o.price, product_id: o.product_id ?? null, sub_group_id: o.sub_group_id ?? null } });
  }
  for (const os of listOf(central.optionSites)) {
    changes.push({ target: 'modifier_option_site', entity_id: os.option_id, location_id: os.location_id, op: 'update', after: { active: os.active, price: os.price } });
  }
  return changes;
}

// What the one time refresh brings in, touched everywhere (its self check).
export function touchRefresh(central) {
  const all = touchEverything(central);
  const out = all.filter((c) => c.target === 'modifier_group' || c.target === 'modifier_option' || c.target === 'modifier_option_site');
  for (const p of listOf(central.products)) out.push({ target: 'product', entity_id: p.id, op: 'update', after: { tax_by_type: p.tax_by_type ?? null } });
  return out;
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
  // A name match the person did not tick: each site's row becomes its own product, on at that site.
  const reject = new Set((decisions.rejectName || []).filter((id) => proposal.review.name.some((n) => n.productId === id)));
  for (const pid of reject) {
    const base = products.find((p) => p.id === pid);
    const rows = productSites.filter((ps) => ps.product_id === pid);
    if (!base || !rows.length) continue;
    products = products.filter((p) => p.id !== pid);
    productSites = productSites.filter((ps) => ps.product_id !== pid);
    for (const ps of rows) {
      const nid = idGen();
      products.push({ ...base, id: nid, site_only_location_id: null, family_base: ps.venue_item_id.replace(/_[0-9a-f]{8}$/i, '') });
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
  // Options pointing at a product that was left out keep their item at the venue only (the site
  // keeps its own link, finalizeOptionSites).
  const groups = proposal.groups.map((g) => ({ ...g, options: [] }));
  const options = listOf(proposal.options).map((o) => ({ ...o }));

  const central = {
    menu: { id: 'import', name: decisions.menuName || 'Group menu', description: decisions.menuDescription || '', use_name_everywhere: false, refreshed_at: 'import' },
    sites: proposal.sites, categories: proposal.categories, catSites: proposal.catSites,
    groups, groupSites: proposal.groupSites.map((gs) => ({ ...gs, kept: { ...(gs.kept || {}) } })), options, optionSites: [],
    products, productSites,
  };
  central.optionSites = finalizeOptionSites(central, proposal.optionEntries || []);
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
          // 17 Oct recheck: a row with no Standard price (pricing.base null, or none at all) is a
          // fact the import KEEPS: the site keeps "no price" (kept no_price), so publish never
          // writes one there until someone sets a price for it at that site. Nothing is left out.
          if (k === 'base' && row.pricing?.base == null) {
            if (ps.kept[NO_PRICE] !== true || ps.price != null) { ps.kept[NO_PRICE] = true; ps.price = null; changed++; }
            else last.push({ location_id: s.location_id, line: l });
            continue;
          }
          if (k === 'base') ps.price = row.pricing?.base ?? null;
          else ps.channel_prices = { ...(ps.channel_prices || {}), [k]: row.pricing?.[k] ?? null };
          changed++;
          continue;
        }
        if (l.column.startsWith('tax_overrides.')) {
          const k = l.column.slice(14);
          const cur = row.tax_overrides && typeof row.tax_overrides === 'object' ? row.tax_overrides : {};
          ps.kept.tax_overrides = { ...(ps.kept.tax_overrides || {}), [k]: has(cur, k) ? cur[k] : false };
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
    for (const l of plan.lines.slice(0, 20)) {
      if (l.table === 'groups') {
        problems.push({ location_id: s.location_id, words: `Option group ${l.id} at ${s.name || 'a site'}: ${l.column.replace(/[()]/g, '')} would change. Import again; if it stays, tell ServOS.` });
      } else {
        problems.push({ location_id: s.location_id, words: `${l.table} ${l.id}: ${l.column} would change` });
      }
    }
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
    groups: central.groups.map((g) => ({ ...g, options: [], sites: sitesOf(central.groupSites, 'group_id', g.id).map((r) => ({ location_id: r.location_id, venue_group_id: r.venue_group_id, kept: r.kept || {} })) })),
    options: listOf(central.options).map((o) => ({ ...o, sites: sitesOf(listOf(central.optionSites), 'option_id', o.id).map((r) => ({ location_id: r.location_id, venue_option_id: r.venue_option_id, active: r.active, price: r.price, kept: r.kept || {} })) })),
    products: central.products.map((p) => ({ ...p, sites: sitesOf(central.productSites, 'product_id', p.id).map((r) => ({ location_id: r.location_id, venue_item_id: r.venue_item_id, active: r.active, price: r.price, channel_prices: r.channel_prices, kept: r.kept || {} })) })),
  };
}

/**
 * THE ONE TIME REFRESH (design 1.9): a group menu imported before round 2 holds its option groups
 * as a jsonb list. This brings them in as rows (union across sites, default prices, each site's
 * own prices, names, links and "Then ask", the groups those ask next), the group rules each site
 * keeps, and VAT by order type for every product, WITHOUT changing anything at any site: the same
 * self check proves zero writes, or nothing is saved.
 *   central  readCentral(...) (the live group menu)
 *   sites    [{ location_id, name, raw }]  readVenueRaw for every site of the menu
 * Returns { ok, payload, check, counts, words }. payload is what public.msm_import_groups takes.
 */
export function refreshGroupsPayload(central, sites, opts = {}) {
  const idGen = opts.idGen || defaultUuid;
  const raws = new Map(listOf(sites).map((x) => [x.location_id, x.raw]));
  const S = listOf(central?.sites).map((st) => ({ location_id: st.location_id, name: listOf(sites).find((x) => x.location_id === st.location_id)?.name || st.location_id, raw: raws.get(st.location_id) })).filter((x) => x.raw);
  if (S.length !== listOf(central?.sites).length) return { ok: false, words: 'Could not read every site. Nothing was changed. Try again.' };
  const itemKeyToCentral = new Map(listOf(central.productSites).map((ps) => [keyOf(ps.location_id, ps.venue_item_id), ps.product_id]));
  const keepBySite = new Map(S.map((x) => [x.location_id, new Set(listOf(central.productSites).filter((ps) => ps.location_id === x.location_id).map((ps) => ps.venue_item_id))]));
  const groupKey = new Map(listOf(central.groupSites).map((gs) => [keyOf(gs.location_id, gs.venue_group_id), gs.group_id]));
  const masterSite = (() => { const counts = new Map(); for (const g of listOf(central.groups)) if (g.source_location_id) counts.set(g.source_location_id, (counts.get(g.source_location_id) || 0) + 1); return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || S[0]?.location_id || null; })();
  const siteOrder = [...S].sort((a, b) => (a.location_id === masterSite ? -1 : b.location_id === masterSite ? 1 : 0));
  const ig = importGroups({ sites: S, siteOrder, keepBySite, itemKeyToCentral, idGen, masterSite, existing: { groupKey, groups: listOf(central.groups) } });
  // Groups already in the group menu that no site uses now stay as they are (no sites, no options).
  const groups = [...ig.groups];
  for (const g of listOf(central.groups)) if (!groups.some((x) => x.id === g.id)) groups.push({ ...g, options: [] });
  // VAT by order type for every product.
  const products = listOf(central.products).map((p) => ({ ...p }));
  const productSites = listOf(central.productSites).map((ps) => ({ ...ps, kept: { ...(ps.kept || {}) } }));
  const rowOf = (loc, id) => listOf(raws.get(loc)?.items).find((i) => i.id === id) || null;
  const ratesOf = (loc) => raws.get(loc)?.taxRates || [];
  for (const p of products) {
    if (p.parent_product_id) continue;
    const members = productSites.filter((ps) => ps.product_id === p.id).map((ps) => ({ loc: ps.location_id, row: rowOf(ps.location_id, ps.venue_item_id) })).filter((m) => m.row);
    const t = importTaxByType(members, ratesOf, masterSite);
    p.tax_by_type = t.taxByType;
    for (const ps of productSites) if (ps.product_id === p.id) { delete ps.kept.tax_overrides; if (t.kept.has(ps.location_id)) ps.kept.tax_overrides = t.kept.get(ps.location_id); }
  }
  // A size follows its product's row at its site (17 Oct recheck): it keeps only what differs.
  for (const p of products) {
    if (!p.parent_product_id) continue;
    p.tax_by_type = null;
    const parentPs = (loc) => productSites.find((ps) => ps.product_id === p.parent_product_id && ps.location_id === loc);
    for (const ps of productSites) {
      if (ps.product_id !== p.id) continue;
      delete ps.kept.tax_overrides;
      const row = rowOf(ps.location_id, ps.venue_item_id);
      if (!row) continue;
      const pps = parentPs(ps.location_id);
      const parentRow = (pps && rowOf(ps.location_id, pps.venue_item_id)) || (row.parent_id ? rowOf(ps.location_id, row.parent_id) : null);
      const kept = sizeKeptTax(row, parentRow);
      if (kept) ps.kept.tax_overrides = kept;
    }
  }
  const next = { ...central, menu: { ...(central.menu || {}), refreshed_at: 'refresh' }, groups, groupSites: ig.groupSites, options: ig.options, optionSites: [], products, productSites };
  next.optionSites = finalizeOptionSites(next, ig.entries);
  // The proof: zero writes at every site with everything THE REFRESH brings in touched (every
  // group rule, option and option site, and every product's VAT by order type). Anything else the
  // group menu and a site already disagree on (an old failed publish, a product removed by hand)
  // is not the refresh's to judge and never blocks it.
  const touched = touchedFromChanges(touchRefresh(next));
  const problems = [];
  let writes = 0;
  for (const st of S) {
    const plan = planSite({ central: next, touched, locationId: st.location_id, orgId: null, venue: st.raw });
    writes += plan.lines.length;
    for (const l of plan.lines.slice(0, 10)) problems.push({ location_id: st.location_id, words: `${st.name}: ${l.table === 'groups' ? 'an option group' : 'a product'} would change (${String(l.column).replace(/[()]/g, '')}).` });
  }
  const counts = { groups: groups.length, newGroups: ig.groups.filter((g) => !listOf(central.groups).some((x) => x.id === g.id)).length, options: ig.options.length };
  if (writes) return { ok: false, check: { ok: false, writes, problems }, counts, words: `The refresh would change ${writes} thing${writes === 1 ? '' : 's'} at the sites, so nothing was saved. ${problems[0]?.words || ''}`.trim() };
  const sitesOf = (rows, key, id) => rows.filter((r) => r[key] === id);
  const payload = {
    menu_id: central.menu?.id,
    groups: groups.map((g) => ({
      id: g.id, name: g.name, min: g.min, max: g.max, selection_type: g.selection_type, sort_order: g.sort_order ?? 0,
      family_base: g.family_base ?? null, source_location_id: g.source_location_id ?? null,
      sites: sitesOf(next.groupSites, 'group_id', g.id).map((r) => ({ location_id: r.location_id, venue_group_id: r.venue_group_id, kept: r.kept || {} })),
    })),
    options: next.options.map((o) => ({ ...o, sites: sitesOf(next.optionSites, 'option_id', o.id).map((r) => ({ location_id: r.location_id, venue_option_id: r.venue_option_id, active: r.active, price: r.price, kept: r.kept || {} })) })),
    products: products.map((p) => ({ id: p.id, tax_by_type: p.tax_by_type || null, sites: sitesOf(productSites, 'product_id', p.id).map((r) => ({ location_id: r.location_id, kept: r.kept || {} })) })),
  };
  return { ok: true, payload, check: { ok: true, writes: 0, problems: [] }, counts, words: `${counts.groups} option group${counts.groups === 1 ? '' : 's'} and ${counts.options} option${counts.options === 1 ? '' : 's'} brought in. Nothing changes at any site.` };
}

/** The review's headline numbers, in words. */
export function reviewWords(review) {
  const r = review || {};
  const n = (a) => listOf(a).length;
  return [
    `${n(r.family)} already shared between sites`,
    `${n(r.name)} with the same name at several sites (tick the ones that are the same)`,
    `${n(r.onlyOne)} only at one site`,
    ...(n(r.clashes) ? [`${n(r.clashes)} clash${n(r.clashes) === 1 ? '' : 'es'} to settle by hand`] : []),
  ].join(', ');
}
