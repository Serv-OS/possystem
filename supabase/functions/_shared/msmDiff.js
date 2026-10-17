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

import { STAGE_FIELDS, has, sameValue, checkChange } from './msmModel.js';
import { planSite, touchedFromChanges, countsWords, lineWords } from './msmPlan.js';
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
    } else if (ch.target === 'category' || ch.target === 'product') {
      const list = ch.target === 'category' ? C.categories : C.products;
      const row = list.find((r) => r.id === ch.entity_id);
      if (ch.op === 'create') {
        if (!row) { list.push({ id: ch.entity_id, archived: false, ...after }); before.push({ ...ch, before: null }); }
      } else if (row) {
        before.push({ ...ch, before: ch.op === 'remove' ? { archived: !!row.archived } : pick(row) });
        if (ch.op === 'remove') row.archived = true;
        else Object.assign(row, clone(after));
      }
    } else if (ch.target === 'product_site') {
      const row = C.productSites.find((r) => r.product_id === ch.entity_id && r.location_id === ch.location_id);
      if (ch.op === 'create' && !row) {
        C.productSites.push({ product_id: ch.entity_id, location_id: ch.location_id, active: true, price: null, channel_prices: null, kept: {}, ...clone(after) });
        before.push({ ...ch, before: null });
      } else if (row) {
        before.push({ ...ch, before: pick(row) });
        Object.assign(row, clone(after));
      }
    }
  }
  return { central: C, before };
}

/** Central state BEFORE a set, from the state after it and applyChanges' `before`. */
export function unapply(centralAfter, before) {
  const C = clone(centralAfter);
  for (const b of [...listOf(before)].reverse()) {
    if (b.target === 'menu' && b.before) Object.assign(C.menu, b.before);
    else if (b.target === 'category' || b.target === 'product') {
      const list = b.target === 'category' ? C.categories : C.products;
      if (!b.before) { const i = list.findIndex((r) => r.id === b.entity_id); if (i >= 0) list.splice(i, 1); }
      else { const row = list.find((r) => r.id === b.entity_id); if (row) Object.assign(row, b.before); }
    } else if (b.target === 'product_site') {
      const i = C.productSites.findIndex((r) => r.product_id === b.entity_id && r.location_id === b.location_id);
      if (!b.before) { if (i >= 0) C.productSites.splice(i, 1); }
      else if (i >= 0) Object.assign(C.productSites[i], b.before);
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
    const drift = driftForPlan(unapply(after, before), touched, loc, raw, opts.orgId, names, plan);
    const health = checkSite(plan, { drift });
    out.push({
      location_id: loc, name: opts.siteNames?.[loc] || loc, plan, health, drift, counts: plan.counts,
      words: countsWords(plan.counts) || 'Nothing changes here',
      lines: plan.lines.map((l) => ({ ...l, words: lineWords(l, names) })),
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
    if (c.target === 'menu_site' || c.target === 'product_site') named.add(c.location_id);
    else everywhere = true;
  }
  return everywhere ? all : all.filter((l) => named.has(l));
}

function namesOf(central) {
  const n = {};
  for (const p of listOf(central?.products)) n[p.id] = p.menu_name || p.name;
  for (const c of listOf(central?.categories)) n[c.id] = c.label;
  for (const ps of listOf(central?.productSites)) n[ps.venue_item_id] = n[ps.product_id];
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
    out.push({
      productId: l.productId, column: l.column,
      words: `${names[l.productId] || l.id} was set to ${fmt(l.before)} at the venue after it was last published. Publishing sets ${fmt(a.after)}.`,
    });
  }
  return out;
}
const fmt = (v) => (v == null ? 'nothing' : typeof v === 'number' ? v.toFixed(2) : typeof v === 'object' ? 'something else' : String(v));

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
  // A KEPT value is compared with what the site keeps, never with the group (review blocker 3).
  const items = new Map(listOf(raw?.items).map((i) => [i.id, i]));
  for (const ps of listOf(central?.productSites).filter((r) => r.location_id === locationId)) {
    const row = items.get(ps.venue_item_id);
    if (!row || !ps.kept || typeof ps.kept !== 'object') continue;
    for (const [col, keptValue] of Object.entries(ps.kept)) {
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
  for (const d of listOf(driftLines)) {
    const ps = listOf(central.productSites).find((r) => r.product_id === d.productId && r.location_id === locationId);
    if (!ps) continue;
    const cur = byProduct.get(d.productId) || { after: {}, before: {}, ps };
    if (d.column === 'pricing.base') { cur.after.price = d.venue; cur.before.price = ps.price; }
    else if (d.column.startsWith('pricing.')) {
      const k = d.column.slice(8);
      cur.after.channel_prices = { ...(cur.after.channel_prices || ps.channel_prices || {}), [k]: d.venue };
      cur.before.channel_prices = ps.channel_prices;
    } else if (d.column === 'archived') { cur.after.active = d.venue !== true; cur.before.active = ps.active; }
    else {
      cur.after.kept = { ...(cur.after.kept || ps.kept || {}), [d.column]: d.venue };
      cur.before.kept = ps.kept || {};
    }
    byProduct.set(d.productId, cur);
  }
  return [...byProduct.entries()].map(([pid, c]) => ({ target: 'product_site', entity_id: pid, location_id: locationId, op: 'update', after: c.after, before: c.before }));
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
    if (c.op === 'create') {
      if (c.target === 'product_site') out.push({ target: 'product_site', entity_id: c.entity_id, location_id: c.location_id, op: 'update', after: { active: false } });
      else if (c.target === 'category') out.push({ target: 'category', entity_id: c.entity_id, location_id: null, op: 'update', after: { archived: true } });
      else if (c.target === 'product') out.push({ target: 'product', entity_id: c.entity_id, location_id: null, op: 'update', after: { archived: true } });
      continue;
    }
    const prev = c.before || {};
    const allowed = STAGE_FIELDS[c.target] || [];
    const after = {};
    for (const k of Object.keys(prev)) if (allowed.includes(k) && k !== 'venue_item_id') after[k] = prev[k];
    if (c.op === 'remove') after.archived = prev.archived ?? false;
    if (!Object.keys(after).length) continue;
    // Changed since that version?
    const nowRow = currentRow(central, c);
    for (const k of Object.keys(after)) {
      const was = c.after ? c.after[k] : undefined;
      if (nowRow && was !== undefined && !sameValue(nowRow[k], was)) {
        warnings.push(`${n[c.entity_id] || 'A product'}${c.location_id ? ` at ${n[c.location_id] || 'one site'}` : ''} ${k.replace(/_/g, ' ')} is ${fmt(nowRow[k])} now; undo sets it to ${fmt(after[k])}.`);
      }
    }
    out.push({ target: c.target, entity_id: c.entity_id, location_id: c.location_id || null, op: 'update', after });
  }
  const turnedOff = out.filter((c) => c.target === 'product_site' && c.after.active === false && listOf(version?.changes).some((v) => v.op === 'create' && v.target === 'product_site' && v.entity_id === c.entity_id)).length;
  if (turnedOff) warnings.push(`Undo turns off ${turnedOff} new product${turnedOff === 1 ? '' : 's'} at their sites (nothing is deleted).`);
  return { changes: out, warnings, skipped };
}

function currentRow(central, c) {
  if (c.target === 'menu') return central?.menu || null;
  if (c.target === 'category') return listOf(central?.categories).find((r) => r.id === c.entity_id) || null;
  if (c.target === 'product') return listOf(central?.products).find((r) => r.id === c.entity_id) || null;
  if (c.target === 'product_site') return listOf(central?.productSites).find((r) => r.product_id === c.entity_id && r.location_id === c.location_id) || null;
  return null;
}

export { changeKey };
