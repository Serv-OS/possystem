// supabase/functions/_shared/msmDiff.js
//
// MULTI SITE MENU (17 Oct 2026, v5.11.75): staging, the publish preview, drift and undo. Pure,
// tested (src/lib/msm/msmDiff.test.js). The screen and the server use the same functions.
//
//   applyChanges(central, changes)    central state with a set applied (mirrors the database's
//                                     public.msm_start_version), for the preview and "View as"
//   mergeStaged(existing, change)     one row per target, entity and site: editing a cell twice
//                                     keeps one row and the FIRST before; setting it back to where
//                                     it started removes the row
//   previewSet(...)                   per site: counts, every line in words, the health check and
//                                     the "changed at the venue" warnings
//   siteDrift(...)                    what a venue changed by hand since the last publish (managed
//                                     fields only, kept values respected)
//   undoChanges(version, central)     a new change set that puts a version's central changes back
//                                     (a create is undone by turning the product off, never a
//                                     delete), with "changed since" warnings

import { STAGE_FIELDS, SITE_TARGETS, has, sameValue, checkChange, money2, newOptionId, channelFallback, pctText, NO_PRICE, keptWithoutNoPrice } from './msmModel.js';
import { planSite, touchedFromChanges, countsWords, lineWords, groupOptionRows } from './msmPlan.js';
import { checkSite, checkCentral } from './msmHealth.js';
import { touchEverything } from './msmImport.js';

const listOf = (v) => (Array.isArray(v) ? v : []);
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const changeKey = (c) => `${c.target}|${c.entity_id}|${c.location_id || ''}`;

// ── Applying a set to central state (pure copy of msm_start_version) ────────

/**
 * Central state with `changes` applied in order. Never mutates its input.
 *   central   { menu, sites, categories, catSites, groups, groupSites, products, productSites }
 * Returns { central, before } where before holds, per change, the central values it replaced.
 */
export function applyChanges(central, changes) {
  const C = clone(central || {});
  C.sites = listOf(C.sites); C.categories = listOf(C.categories); C.products = listOf(C.products); C.productSites = listOf(C.productSites);
  C.groups = listOf(C.groups); C.groupSites = listOf(C.groupSites); C.options = listOf(C.options); C.optionSites = listOf(C.optionSites);
  const before = [];
  for (const ch of listOf(changes)) {
    if (!checkChange(ch).ok) continue;
    const after = ch.after || {};
    const pick = (row) => Object.fromEntries(Object.keys(after).map((k) => [k, row ? clone(row[k]) ?? null : null]));
    if (ch.target === 'menu') {
      before.push({ ...ch, before: pick(C.menu) });
      C.menu = { ...(C.menu || {}), ...after };
    } else if (ch.target === 'menu_site') {
      if (!C.sites.some((s) => s.location_id === ch.location_id)) {
        C.sites.push({ location_id: ch.location_id, venue_menu_id: after.venue_menu_id || null });
        before.push({ ...ch, before: null });
      }
    } else if (ENTITY_LIST[ch.target]) {
      const list = C[ENTITY_LIST[ch.target]];
      const row = list.find((r) => r.id === ch.entity_id);
      if (ch.op === 'create') {
        if (!row) { list.push({ id: ch.entity_id, archived: false, ...(ch.target === 'modifier_group' ? { options: [] } : {}), ...clone(after) }); before.push({ ...ch, before: null }); }
      } else if (row) {
        before.push({ ...ch, before: ch.op === 'remove' ? { archived: !!row.archived } : pick(row) });
        if (ch.op === 'remove') row.archived = true;
        else Object.assign(row, clone(after));
      }
    } else if (SITE_LIST[ch.target]) {
      const [listName, key, blank] = SITE_LIST[ch.target];
      const list = C[listName];
      const row = list.find((r) => r[key] === ch.entity_id && r.location_id === ch.location_id);
      if (ch.op === 'create' && !row) {
        list.push({ [key]: ch.entity_id, location_id: ch.location_id, ...clone(blank), ...clone(after) });
        before.push({ ...ch, before: null });
      } else if (row) {
        before.push({ ...ch, before: pick(row) });
        Object.assign(row, clone(after));
      }
    }
  }
  return { central: C, before };
}

// Where each target lives in central state.
const ENTITY_LIST = { category: 'categories', product: 'products', modifier_group: 'groups', modifier_option: 'options' };
const SITE_LIST = {
  product_site: ['productSites', 'product_id', { active: true, price: null, channel_prices: null, kept: {} }],
  modifier_group_site: ['groupSites', 'group_id', { venue_group_id: null, kept: {} }],
  // No option site row means off; a staged create without "active" means on (as the database).
  modifier_option_site: ['optionSites', 'option_id', { venue_option_id: null, active: true, price: null, kept: {} }],
};

/** Central state BEFORE a set, from the state after it and applyChanges' `before`. */
export function unapply(centralAfter, before) {
  const C = clone(centralAfter);
  for (const b of [...listOf(before)].reverse()) {
    if (b.target === 'menu' && b.before) Object.assign(C.menu, b.before);
    else if (ENTITY_LIST[b.target]) {
      const list = listOf(C[ENTITY_LIST[b.target]]);
      if (!b.before) { const i = list.findIndex((r) => r.id === b.entity_id); if (i >= 0) list.splice(i, 1); }
      else { const row = list.find((r) => r.id === b.entity_id); if (row) Object.assign(row, b.before); }
    } else if (SITE_LIST[b.target]) {
      const [listName, key] = SITE_LIST[b.target];
      const list = listOf(C[listName]);
      const i = list.findIndex((r) => r[key] === b.entity_id && r.location_id === b.location_id);
      if (!b.before) { if (i >= 0) list.splice(i, 1); }
      else if (i >= 0) Object.assign(list[i], b.before);
    } else if (b.target === 'menu_site' && !b.before) {
      C.sites = C.sites.filter((s) => s.location_id !== b.location_id);
    }
  }
  return C;
}

// ── Staging: one row per target, entity and site ────────────────────────────

/**
 * Merge a new edit into the draft's existing row for the same target, entity and site.
 *   existing   the row already staged (or null)
 *   change     { target, entity_id, location_id, op, after, before }  before = the central
 *              value of each field in `after` right now
 * Returns { action: 'insert' | 'update' | 'delete' | 'none', row }.
 */
export function mergeStaged(existing, change) {
  const ok = checkChange(change);
  if (!ok.ok) return { action: 'none', row: null, words: ok.words };
  // A product turned on at a site where it never was, then off again before publishing
  // (msmEdit.siteActiveOne marks it dropCreate): the draft's create comes out, nothing is left.
  if (change.dropCreate) {
    if (existing && existing.op === 'create') return { action: 'delete', row: existing };
    if (!existing) return { action: 'none', row: null };
  }
  if (!existing) {
    if (change.op === 'update' && Object.keys(change.after || {}).every((k) => sameValue(change.after[k], change.before?.[k]))) return { action: 'none', row: null };
    return { action: 'insert', row: { ...change, after: clone(change.after || {}), before: clone(change.before || {}) } };
  }
  const op = existing.op === 'create' ? 'create' : change.op === 'remove' ? 'remove' : existing.op;
  const after = { ...clone(existing.after || {}), ...clone(change.after || {}) };
  const before = { ...clone(change.before || {}), ...clone(existing.before || {}) };   // the FIRST before wins
  if (op === 'update') {
    for (const k of Object.keys(after)) if (has(before, k) && sameValue(after[k], before[k])) delete after[k];
    if (!Object.keys(after).length) return { action: 'delete', row: existing };
  }
  return { action: 'update', row: { ...existing, op, after, before } };
}

// ── The publish preview ─────────────────────────────────────────────────────

/**
 * The preview for a set across every site it reaches.
 *   central      central state BEFORE the set (what is live)
 *   changes      the set's msm_changes rows
 *   venues       Map or object: locationId -> raw venue (readVenueRaw shape)
 *   opts         { orgId, siteNames: { loc: name }, names: { id: name } }
 * Returns { sites: [{ location_id, name, plan, health, counts, words, lines, drift }], central: { blocking, warnings }, ok, total }.
 */
export function previewSet(central, changes, venues, opts = {}) {
  const { central: after, before } = applyChanges(central, changes);
  const touched = touchedFromChanges(changes);
  const get = (loc) => (venues instanceof Map ? venues.get(loc) : venues?.[loc]);
  const reach = sitesReached(after, changes);
  const names = { ...namesOf(after), ...(opts.names || {}) };
  const out = [];
  for (const loc of reach) {
    const raw = get(loc);
    if (!raw) { out.push({ location_id: loc, name: opts.siteNames?.[loc] || loc, missing: true, words: 'Could not read this site' }); continue; }
    const plan = planSite({ central: after, touched, locationId: loc, orgId: opts.orgId || null, venue: raw });
    // This site's own names too (its categories, VAT rates, products and groups by their venue
    // ids), so a line never shows an id: "Latte: moves to Cold drinks" (17 Oct verification).
    const here = { ...venueNamesOf(raw), ...names };
    const drift = driftForPlan(unapply(after, before), touched, loc, raw, opts.orgId, here, plan);
    const health = checkSite(plan, { drift });
    out.push({
      location_id: loc, name: opts.siteNames?.[loc] || loc, plan, health, drift, counts: plan.counts,
      words: countsWords(plan.counts) || 'Nothing changes here',
      lines: plan.lines.map((l) => ({ ...l, words: lineWords(l, here) })),
    });
  }
  const c = checkCentral(after, touched);
  const ok = !c.blocking.length && out.every((s) => s.missing || s.health?.ok);
  const total = out.reduce((n, s) => n + (s.plan?.lines?.length || 0), 0);
  return { sites: out, central: c, ok, total, after };
}

/** The sites a set reaches: every site for a central change, else the sites it names. */
export function sitesReached(central, changes) {
  const all = listOf(central?.sites).map((s) => s.location_id);
  const named = new Set();
  let everywhere = false;
  for (const c of listOf(changes)) {
    if (SITE_TARGETS.includes(c.target)) named.add(c.location_id);
    else everywhere = true;
  }
  return everywhere ? all : all.filter((l) => named.has(l));
}

/** A site's own names by venue id: categories, products, option groups and VAT rates. */
export function venueNamesOf(raw) {
  const n = {};
  for (const c of listOf(raw?.categories)) if (c?.id) n[c.id] = c.label || 'a category';
  for (const i of listOf(raw?.items)) if (i?.id) n[i.id] = i.menu_name || i.name || 'a product';
  for (const g of listOf(raw?.groups)) if (g?.id) n[g.id] = g.name || 'an option group';
  for (const r of listOf(raw?.taxRates)) if (r?.id) n[r.id] = `${r.name || 'VAT'} (${pctText(r.rate)})`;
  return n;
}

function namesOf(central) {
  const n = {};
  for (const p of listOf(central?.products)) n[p.id] = p.menu_name || p.name;
  for (const c of listOf(central?.categories)) n[c.id] = c.label;
  for (const ps of listOf(central?.productSites)) n[ps.venue_item_id] = n[ps.product_id];
  for (const g of listOf(central?.groups)) n[g.id] = g.name;
  for (const gs of listOf(central?.groupSites)) n[gs.venue_group_id] = n[gs.group_id];
  for (const o of listOf(central?.options)) n[o.id] = o.name;
  return n;
}

// "Changed at the venue since staged": the columns where the venue no longer holds what central
// held before this set (planning the BEFORE state would have to write them).
function driftForPlan(centralBefore, touched, loc, raw, orgId, names, planAfter) {
  if (!centralBefore) return [];
  const pb = planSite({ central: centralBefore, touched, locationId: loc, orgId, venue: raw });
  const after = new Map(planAfter.lines.map((l) => [`${l.id}|${l.column}`, l]));
  const out = [];
  for (const l of pb.lines) {
    if (l.column === '(new)' || l.table !== 'items') continue;
    const a = after.get(`${l.id}|${l.column}`);
    if (!a) continue;
    out.push({ productId: l.productId, column: l.column, words: driftPlanWords(names[l.productId] || 'A product', l, a) });
  }
  return out;
}
const fmt = (v) => (v == null ? 'nothing' : typeof v === 'number' ? v.toFixed(2) : typeof v === 'object' ? 'something else' : String(v));

// "Changed at the venue since it was last published" in words: never true or false, never an id
// (17 Oct verification: "Flapjack was set to true at the venue ... Publishing sets false").
const DRIFT_WORDS = { cat: 'category', cats: 'extra categories', tax_rate_id: 'VAT rate', parent_id: 'size of', image: 'photo', allergens: 'allergens', tags: 'dietary tags', assigned_modifier_groups: 'option groups', sold_alone: 'sold on its own', type: 'kind of product', name: 'name', menu_name: 'name on the till', receipt_name: 'receipt name', kitchen_name: 'kitchen ticket name', description: 'description', item_code: 'item code', visibility: 'where it shows' };
function driftPlanWords(who, l, a) {
  if (l.column === 'archived') return `${who} was turned ${l.before ? 'off' : 'on'} at the venue after it was last published. Publishing turns it ${a.after ? 'off' : 'back on'}.`;
  if (l.column.startsWith('pricing.')) return `${who} was set to ${fmt(l.before)} at the venue after it was last published. Publishing sets ${fmt(a.after)}.`;
  const word = DRIFT_WORDS[l.column] || (l.column.startsWith('tax_overrides.') ? 'VAT by order type' : 'a setting');
  return `${who}: its ${word} was changed at the venue after it was last published. Publishing puts the group's back.`;
}

// ── Drift: what a venue changed by hand ─────────────────────────────────────

/**
 * Managed fields where a venue's rows differ from central plus kept (design 1.8). Kept values are
 * compared against the kept value, never central.
 * Returns [{ productId, venueItemId, column, venue, group, words }].
 */
export function siteDrift(central, locationId, raw, names = {}) {
  const touched = touchedFromChanges(touchEverything(central));
  const plan = planSite({ central, touched, locationId, orgId: null, venue: raw });
  const n = { ...namesOf(central), ...names };
  const out = plan.lines.filter((l) => l.table === 'items' && l.column !== '(new)').map((l) => ({
    productId: l.productId, venueItemId: l.id, column: l.column, venue: l.before, group: l.after,
    words: `${n[l.productId] || l.id}: ${l.column.replace('pricing.', '').replace(/_/g, ' ')} is ${fmt(l.before)} at the venue, the group says ${fmt(l.after)}`,
  }));
  // Option groups (round 2): a group rule or an option changed at the site.
  for (const l of plan.lines.filter((x) => x.table === 'groups' && x.column !== '(new)')) {
    const g = n[l.groupId] || 'An option group';
    let words;
    if (l.column === 'option') words = `${g}: ${l.before?.name || 'an option'} is ${money2(l.before?.price)} at the venue, the group says ${money2(l.after?.price)}${l.before?.name !== l.after?.name ? ` (named ${l.after?.name})` : ''}`;
    else if (l.column === '(option added)') words = `${g}: ${l.after?.name || 'an option'} is not on at the venue, the group has it on`;
    else if (l.column === '(option off)') words = `${g}: ${l.before?.name || 'an option'} is on at the venue, the group has it off`;
    else if (l.column === '(option order)') continue;
    else words = `${g}: ${l.column.replace(/_/g, ' ')} is ${fmt(l.before)} at the venue, the group says ${fmt(l.after)}`;
    out.push({ kind: 'group', groupId: l.groupId, optionId: l.optionId || null, venueGroupId: l.id, column: l.column, venue: l.before, group: l.after, words });
  }
  // Options the group menu does not know, inside its own groups at this site.
  const groupsHere = new Map(listOf(raw?.groups).map((g) => [g.id, g]));
  for (const gs of listOf(central?.groupSites).filter((r) => r.location_id === locationId)) {
    const vg = groupsHere.get(gs.venue_group_id);
    const g = listOf(central?.groups).find((x) => x.id === gs.group_id);
    if (!vg || !g || g.archived) continue;
    const { rows, legacy } = groupOptionRows(g, central?.options);
    if (legacy) continue;
    const knownIds = new Set(listOf(central?.optionSites).filter((os) => os.location_id === locationId && rows.some((o) => o.id === os.option_id) && os.venue_option_id).map((os) => os.venue_option_id));
    for (const o of rows) knownIds.add(newOptionId(o.id));
    for (const e of listOf(vg.options)) {
      if (!e || knownIds.has(e.id)) continue;
      out.push({
        kind: 'unknown_option', groupId: g.id, venueGroupId: vg.id, entry: e, column: '(unknown option)', venue: e, group: null,
        words: `${g.name} at this site has an option the group menu does not know: ${e.name || 'an option'} ${money2(e.price ?? 0)}`,
      });
    }
  }
  // A KEPT value is compared with what the site keeps, never with the group (review blocker 3).
  const items = new Map(listOf(raw?.items).map((i) => [i.id, i]));
  for (const ps of listOf(central?.productSites).filter((r) => r.location_id === locationId)) {
    const row = items.get(ps.venue_item_id);
    if (!row || !ps.kept || typeof ps.kept !== 'object') continue;
    for (const [col, keptValue] of Object.entries(ps.kept)) {
      // No price kept (17 Oct recheck): drift only when the venue has a Standard price now.
      if (col === NO_PRICE) {
        const base = row.pricing && typeof row.pricing === 'object' ? row.pricing.base : null;
        if (base == null || ps.price != null) continue;
        out.push({
          productId: ps.product_id, venueItemId: ps.venue_item_id, column: 'pricing.base', venue: base, group: null, kept: true,
          words: `${n[ps.product_id] || ps.venue_item_id}: has a price of ${fmt(base)} at the venue now, the group menu has no price for it there`,
        });
        continue;
      }
      // VAT by order type is kept per key (a rate id, null, or false for "no key here"): compared key
      // by key, never as a whole object (the site's other keys are only there for information).
      if (col === 'tax_overrides' && keptValue && typeof keptValue === 'object') {
        const cur = row.tax_overrides && typeof row.tax_overrides === 'object' ? row.tax_overrides : {};
        for (const [k, kv] of Object.entries(keptValue)) {
          const now = has(cur, k) ? cur[k] : false;
          if (sameValue(now, kv) && (now === null) === (kv === null)) continue;
          out.push({
            productId: ps.product_id, venueItemId: ps.venue_item_id, column: `tax_overrides.${k}`, venue: has(cur, k) ? cur[k] : undefined, group: kv, kept: true,
            words: `${n[ps.product_id] || ps.venue_item_id}: VAT for ${k} was changed at the venue, it was keeping its own`,
          });
        }
        continue;
      }
      if (sameValue(row[col], keptValue)) continue;
      out.push({
        productId: ps.product_id, venueItemId: ps.venue_item_id, column: col, venue: row[col] ?? null, group: keptValue, kept: true,
        words: `${n[ps.product_id] || ps.venue_item_id}: ${col.replace(/_/g, ' ')} is ${fmt(row[col])} at the venue, it was keeping ${fmt(keptValue)}`,
      });
    }
  }
  return out;
}

/**
 * "Keep the venue's" for drift lines: the changes that store the venue's values in central
 * (price as a site override, active as the site flag, other columns as kept).
 */
export function keepVenueChanges(central, locationId, driftLines) {
  const byProduct = new Map();
  const groupOut = new Map();             // key -> change
  const bump = (key, base) => { if (!groupOut.has(key)) groupOut.set(key, base); return groupOut.get(key); };
  for (const d of listOf(driftLines)) {
    if (d.kind === 'unknown_option') continue;      // "Bring it into the group" or "Leave it" (bringOptionIn)
    if (d.kind === 'group') {
      if (d.optionId) {
        const os = listOf(central.optionSites).find((r) => r.option_id === d.optionId && r.location_id === locationId);
        if (!os) continue;
        const c = bump(`o|${d.optionId}`, { target: 'modifier_option_site', entity_id: d.optionId, location_id: locationId, op: 'update', after: {}, before: {} });
        if (d.column === '(option added)') { c.after.active = false; c.before.active = os.active; }
        else if (d.column === '(option off)') { c.after.active = true; c.before.active = os.active; }
        else if (d.column === 'option') {
          const o = listOf(central.options).find((x) => x.id === d.optionId);
          if (d.venue?.price !== d.group?.price) { c.after.price = samePriceNum(d.venue?.price, o?.price) ? null : Number(d.venue?.price ?? 0); c.before.price = os.price ?? null; }
          if (d.venue?.name !== d.group?.name) { c.after.kept = { ...(c.after.kept || os.kept || {}), name: d.venue?.name ?? null }; c.before.kept = os.kept || {}; }
        }
      } else if (['name', 'min', 'max', 'selection_type'].includes(d.column)) {
        const gs = listOf(central.groupSites).find((r) => r.group_id === d.groupId && r.location_id === locationId);
        if (!gs) continue;
        const c = bump(`g|${d.groupId}`, { target: 'modifier_group_site', entity_id: d.groupId, location_id: locationId, op: 'update', after: {}, before: {} });
        c.after.kept = { ...(c.after.kept || gs.kept || {}), [d.column]: d.venue ?? null };
        c.before.kept = gs.kept || {};
      }
      continue;
    }
    const ps = listOf(central.productSites).find((r) => r.product_id === d.productId && r.location_id === locationId);
    if (!ps) continue;
    const cur = byProduct.get(d.productId) || { after: {}, before: {}, ps };
    if (d.column === 'pricing.base') {
      // 17 Oct recheck: a site with no Standard price keeps "no price" (never "follow the group",
      // which would publish the group's price, the opposite of Keep); a price the venue set on a
      // row that had none is kept as its own and "no price" goes.
      const base = cur.after.kept || ps.kept || {};
      if (d.venue == null) { cur.after.price = null; cur.after.kept = { ...base, [NO_PRICE]: true }; }
      else { cur.after.price = d.venue; if (has(base, NO_PRICE)) cur.after.kept = keptWithoutNoPrice(base); }
      cur.before.price = ps.price;
      if (has(cur.after, 'kept')) cur.before.kept = ps.kept || {};
    }
    else if (d.column.startsWith('pricing.')) {
      const k = d.column.slice(8);
      // The site cleared its own price for this order type (venue null) while the group sets one:
      // "follow" (null) would publish the group's price, the opposite of Keep. Keep what the site
      // really charges there today instead: its Standard price (takeaway first for drive thru),
      // from a Standard price drift line in the same list, else the central value it matches.
      let value = d.venue;
      const p = listOf(central.products).find((x) => x.id === d.productId);
      const groupSets = p && p.default_channels && p.default_channels[k] != null;
      if (value == null && groupSets) {
        const baseLine = listOf(driftLines).find((x) => x && x.productId === d.productId && x.column === 'pricing.base');
        const takeLine = listOf(driftLines).find((x) => x && x.productId === d.productId && x.column === 'pricing.takeaway');
        const base = baseLine ? baseLine.venue : (ps.price ?? p.default_price);
        const own = { ...(ps.channel_prices || {}), [k]: null };
        if (takeLine) own.takeaway = takeLine.venue;
        const pNo = { ...p, default_channels: { ...(p.default_channels || {}), [k]: null } };
        if (k === 'driveThru' && takeLine && takeLine.venue == null) pNo.default_channels.takeaway = null;
        value = channelFallback(pNo, { price: base, channel_prices: own }, k);
      }
      cur.after.channel_prices = { ...(cur.after.channel_prices || ps.channel_prices || {}), [k]: value };
      cur.before.channel_prices = ps.channel_prices;
    } else if (d.column === 'archived') { cur.after.active = d.venue !== true; cur.before.active = ps.active; }
    else if (d.column.startsWith('tax_overrides.')) {
      // One order type key kept as the site has it: a rate id, null, or false for "no key".
      const k = d.column.slice(14);
      const base = cur.after.kept || ps.kept || {};
      const t = { ...(base.tax_overrides && typeof base.tax_overrides === 'object' ? base.tax_overrides : {}), [k]: d.venue === undefined ? false : d.venue };
      cur.after.kept = { ...base, tax_overrides: t };
      cur.before.kept = ps.kept || {};
    } else {
      cur.after.kept = { ...(cur.after.kept || ps.kept || {}), [d.column]: d.venue };
      cur.before.kept = ps.kept || {};
    }
    byProduct.set(d.productId, cur);
  }
  return [
    ...[...byProduct.entries()].map(([pid, c]) => ({ target: 'product_site', entity_id: pid, location_id: locationId, op: 'update', after: c.after, before: c.before })),
    ...[...groupOut.values()].filter((c) => Object.keys(c.after).length),
  ];
}
const samePriceNum = (a, b) => Math.round(Number(a ?? 0) * 100) === Math.round(Number(b ?? 0) * 100);

/**
 * "Bring it into the group" for an option a site added to a group the group menu manages: a new
 * option (the site's name and price as the default), on at that site with the SAME venue id (so
 * nothing changes there), off at every other site where the group is (an explicit row each).
 *   central   central state (live or the draft applied)
 *   drift     a siteDrift line of kind 'unknown_option'
 *   optionId  the new option's id (a uuid the screen makes)
 */
export function bringOptionIn(central, locationId, drift, optionId) {
  const g = listOf(central?.groups).find((x) => x.id === drift?.groupId);
  if (!g || !drift?.entry) return [];
  const e = drift.entry;
  const rows = groupOptionRows(g, central?.options).rows;
  const productId = e.itemId ? listOf(central?.productSites).find((ps) => ps.location_id === locationId && ps.venue_item_id === e.itemId)?.product_id || null : null;
  const changes = [{
    target: 'modifier_option', entity_id: optionId, location_id: null, op: 'create',
    after: { group_id: g.id, name: e.name ?? 'Option', price: Number(e.price ?? 0), product_id: productId, sub_group_id: null, sort_order: rows.length },
  }];
  for (const gs of listOf(central?.groupSites).filter((r) => r.group_id === g.id)) {
    const here = gs.location_id === locationId;
    changes.push({
      target: 'modifier_option_site', entity_id: optionId, location_id: gs.location_id, op: 'create',
      after: here ? { venue_option_id: e.id, active: true, price: null, kept: e.itemId && !productId ? { item_link: e.itemId } : {} } : { active: false, price: null },
    });
  }
  return changes;
}

// ── Undo ────────────────────────────────────────────────────────────────────

/**
 * The changes that undo a version (design 4b; review nit: a create is undone by turning it off).
 *   version   { changes: [{ target, entity_id, location_id, op, before, after }] }  (msm_versions.changes)
 *   central   central state now (for the "changed since" warnings)
 * Returns { changes, warnings: [words], skipped: [words] }.
 */
export function undoChanges(version, central, names = {}) {
  const out = [];
  const warnings = [];
  const skipped = [];
  const n = { ...namesOf(central), ...names };
  for (const c of listOf(version?.changes)) {
    if (c.target === 'menu_site') { skipped.push(`Adding a site cannot be undone here (${n[c.location_id] || c.location_id}).`); continue; }
    if (c.target === 'modifier_group_site' && c.op === 'create') { skipped.push(`Linking an option group to a site cannot be undone here (${n[c.location_id] || 'one site'}).`); continue; }
    if (c.op === 'create') {
      if (c.target === 'product_site') out.push({ target: 'product_site', entity_id: c.entity_id, location_id: c.location_id, op: 'update', after: { active: false } });
      else if (c.target === 'category') out.push({ target: 'category', entity_id: c.entity_id, location_id: null, op: 'update', after: { archived: true } });
      else if (c.target === 'product') out.push({ target: 'product', entity_id: c.entity_id, location_id: null, op: 'update', after: { archived: true } });
      // An option added is turned off at every site (its venue id stays for ever); a new group is removed.
      else if (c.target === 'modifier_option') out.push({ target: 'modifier_option', entity_id: c.entity_id, location_id: null, op: 'update', after: { archived: true } });
      else if (c.target === 'modifier_option_site') out.push({ target: 'modifier_option_site', entity_id: c.entity_id, location_id: c.location_id, op: 'update', after: { active: false } });
      else if (c.target === 'modifier_group') out.push({ target: 'modifier_group', entity_id: c.entity_id, location_id: null, op: 'update', after: { archived: true } });
      continue;
    }
    const prev = c.before || {};
    const allowed = STAGE_FIELDS[c.target] || [];
    const after = {};
    for (const k of Object.keys(prev)) if (allowed.includes(k) && !['venue_item_id', 'venue_group_id', 'venue_option_id', 'group_id'].includes(k)) after[k] = prev[k];
    if (c.op === 'remove') after.archived = prev.archived ?? false;
    if (!Object.keys(after).length) continue;
    // Changed since that version?
    const nowRow = currentRow(central, c);
    for (const k of Object.keys(after)) {
      const was = c.after ? c.after[k] : undefined;
      if (nowRow && was !== undefined && !sameValue(nowRow[k], was)) {
        warnings.push(undoWarnWords(`${n[c.entity_id] || 'A product'}${c.location_id ? ` at ${n[c.location_id] || 'one site'}` : ''}`, k, nowRow[k], after[k]));
      }
    }
    out.push({ target: c.target, entity_id: c.entity_id, location_id: c.location_id || null, op: 'update', after });
  }
  const turnedOff = out.filter((c) => c.target === 'product_site' && c.after.active === false && listOf(version?.changes).some((v) => v.op === 'create' && v.target === 'product_site' && v.entity_id === c.entity_id)).length;
  if (turnedOff) warnings.push(`Undo turns off ${turnedOff} new product${turnedOff === 1 ? '' : 's'} at their sites (nothing is deleted).`);
  return { changes: out, warnings, skipped };
}

// "Changed since that version" in words (17 Oct verification: never "sold alone is true now; undo
// sets it to true", never a column name or an id). Prices and on or off say both values.
const UNDO_WORDS = { default_price: 'group price', price: 'price', name: 'name', menu_name: 'name on the till', receipt_name: 'receipt name', kitchen_name: 'kitchen ticket name', description: 'description', category_id: 'category', extra_category_ids: 'extra categories', tax_rate_name: 'VAT', tax_rate_percent: 'VAT', tax_by_type: 'VAT by order type', modifier_groups: 'option groups', allergens: 'allergens', tags: 'dietary tags', image: 'photo', sold_alone: 'sold on its own', type: 'kind of product', parent_product_id: 'size of', default_channels: 'order type prices', channel_prices: 'order type prices', kept: 'own settings', label: 'name', min: 'rule', max: 'rule', selection_type: 'kind of choice', sort_order: 'place' };
function undoWarnWords(who, k, now, back) {
  if (k === 'active') return `${who} is turned ${now === false ? 'off' : 'on'} now; undo turns it ${back === false ? 'off' : 'on'}.`;
  if (k === 'archived') return `${who} is ${now ? 'removed' : 'on the menu'} now; undo ${back ? 'removes it' : 'brings it back'}.`;
  if (['default_price', 'price'].includes(k) && (typeof now === 'number' || now == null) && (typeof back === 'number' || back == null)) {
    return `${who} ${UNDO_WORDS[k]} is ${now == null ? 'the group price' : money2(now)} now; undo sets it to ${back == null ? 'the group price' : money2(back)}.`;
  }
  return `${who}: its ${UNDO_WORDS[k] || 'setting'} was changed since; undo puts back the one before.`;
}

function currentRow(central, c) {
  if (c.target === 'menu') return central?.menu || null;
  if (ENTITY_LIST[c.target]) return listOf(central?.[ENTITY_LIST[c.target]]).find((r) => r.id === c.entity_id) || null;
  if (SITE_LIST[c.target]) {
    const [listName, key] = SITE_LIST[c.target];
    return listOf(central?.[listName]).find((r) => r[key] === c.entity_id && r.location_id === c.location_id) || null;
  }
  return null;
}

export { changeKey };
