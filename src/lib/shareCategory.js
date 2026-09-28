// src/lib/shareCategory.js: a shared product's copy sits in THAT venue's copy of its category.
//
// 27 Sep 2026, Coffee Boy: six pizzas made at Barnsley in a new category, Hot Pizzas (under
// Food, which Train Station owns), were shared at 18:00 UTC. By 18:12 Back Office showed
// "No category" for the copies at Train Station, Leeds, Preston and Headingly, while
// Huddersfield's sat in Hot Pizzas. The share itself mapped every venue: each Hot Pizzas copy
// landed 4 seconds before the first product copy. What emptied four venues was a Back Office
// session that saved each copy with no category, venue by venue, 9 to 12 minutes later.
//
// Reading the copy path for that report found three ways a copy could still be written
// without its category, or pointing at one that is not there:
//   1. A new copy took `<category master>_<venue suffix>` from arithmetic alone. Nothing
//      checked that the category copy EXISTED at that venue, so a category copy that failed
//      to land left the product pointing at nothing (Back Office: "No category").
//   2. A category that could not be translated was written as nothing, and not reported.
//   3. A copy written before its category copy landed (a failed or slow category write, or a
//      second window sharing at the same moment) stayed uncategorised for good: nothing
//      looked at it again when the category arrived.
//
// Now:
//   a. Every category id a copy gets is checked to exist at that venue. A missing one is
//      created first (from the category's master, for that venue) and checked again.
//   b. One that is still not there is written as nothing and REPORTED: never another venue's
//      id, never a dangling one.
//   c. When a category copy lands at a venue, copies there with no category whose master sits
//      in that category get it (fillCopiesWaitingFor). A product copy written without its
//      category looks once more after its own write (fillCopyIfLanded). Each side checks
//      after its own write, so whichever lands second fills the gap.
//   Both fills write only where the copy has no category: a venue's own category is never
//   replaced (Shared promises that; lib/shareCopy.js SHARED_OVERRIDABLE).
//
// The owning venue holds the bare master id, every other venue `<master>_<suffix>`: Train
// Station owns Food, so its Hot Pizzas copy's parent is `cat-1790049850590`, no suffix. That is
// right, not the fault (peerCatIdAt).
//
// Pure: the database client and the lookups are passed in, so node:test drives it with a fake.

import { peerSuffixOf } from './shareCopy.js';
import { isOptionOnlyItem } from './menuRules.js';
import { readAllRows } from './venueMenuRead.js';

/**
 * Where a category's copy lives at a venue: the bare master id at the venue that OWNS it,
 * `<master>_<suffix>` everywhere else. Addressing the owner with a suffixed id created a
 * duplicate category there (round-2 review, 23 Sep).
 */
export const peerCatIdAt = (catMasterId, catMasterLocId, peerLocId) =>
  (catMasterLocId && peerLocId === catMasterLocId) ? catMasterId : `${catMasterId}_${peerSuffixOf(peerLocId)}`;

/** The master id of a category row (itself when it is the master). */
export const categoryMasterIdOf = (row) => (row ? (row.master_id || row.id) : null);

/**
 * The ids one venue's copy of a product gets for its categories, each checked to EXIST there.
 * A category missing at that venue is created first (ensureAt) and checked again.
 *
 *   sourceIds      the source row's category ids (cat, cats, sizes' cat); empty ones ignored
 *   masterOf(id)   => Promise<the category's master row { id, location_id, scope, label } | null>
 *                     null: a category that is not placed at other venues (left unmapped)
 *   presentAt(ids) => Promise<Set of the ids that exist at the venue>. THROWS when the read
 *                     failed: a failed read is never taken as "there".
 *   ensureAt(master) => Promise  create that venue's copy of this category (may fail)
 *
 * Resolves:
 *   idFor(sourceId)   the venue's category id, only when it exists there; otherwise null
 *   wantFor(sourceId) the id it SHOULD have there (for the check after the write), or null
 *   missing           [{ sourceId, peerId, label }] not at the venue even after trying
 *   unknown           a read failed: every category counts as missing and none was created
 */
export async function resolvePeerCategories({ sourceIds, peerLocId, masterOf, presentAt, ensureAt }) {
  const ids = [...new Set((sourceIds || []).filter(Boolean).map(String))];
  const peerIdBySource = new Map();
  const masterBySource = new Map();
  let unknown = false;
  let error = null;
  for (const id of ids) {
    let m = null;
    try { m = await masterOf(id); } catch (e) { unknown = true; error = error || e; m = null; }
    if (m) masterBySource.set(id, m);
    peerIdBySource.set(id, m && m.id ? peerCatIdAt(m.id, m.location_id, peerLocId) : null);
  }
  const present = new Set();
  const wanted = [...new Set([...peerIdBySource.values()].filter(Boolean))];
  if (wanted.length) {
    try { for (const p of await presentAt(wanted)) present.add(String(p)); }
    catch (e) { unknown = true; error = error || e; }
  }
  // Create what is missing, once per category, and look again. Not after a failed read: that
  // says nothing about what is there.
  if (!unknown) {
    const tried = [];
    for (const [src, pid] of peerIdBySource) {
      if (!pid || present.has(pid) || tried.includes(pid)) continue;
      tried.push(pid);
      try { await ensureAt(masterBySource.get(src)); } catch { /* still missing: reported below */ }
    }
    if (tried.length) {
      try { for (const p of await presentAt(tried)) present.add(String(p)); }
      catch (e) { unknown = true; error = error || e; }
    }
  }
  const idFor = (src) => {
    const pid = src ? peerIdBySource.get(String(src)) : null;
    return pid && present.has(pid) ? pid : null;
  };
  const wantFor = (src) => (src ? peerIdBySource.get(String(src)) || null : null);
  const missing = [];
  for (const [src, pid] of peerIdBySource) {
    if (!pid || !present.has(pid)) missing.push({ sourceId: src, peerId: pid, label: masterBySource.get(src)?.label || null });
  }
  return { idFor, wantFor, missing, unknown, error };
}

/** One missing category in words, for the result the Back Office shows. */
export const missingCategoryWords = (m, { unknown = false } = {}) => {
  const name = m?.label ? `category '${m.label}'` : 'category';
  if (unknown) return `${name} (could not be checked there, so the copy has none yet; share again to fill it)`;
  if (!m?.peerId) return `${name} (not shared, so it has no copy there)`;
  return `${name} (not at that venue yet; the copy gets it when it arrives)`;
};

/**
 * The product side of (c). A copy was just written without a category it should have had,
 * because that category was not at the venue. Look once more; if it has landed since, put the
 * copy in it. Only where the copy still has no category.
 *
 *   cat          the category id the copy should have at that venue (wantFor), or null
 *   cats         the ids its "also in" list should have there (wantFor of each)
 *   writtenCats  what was written into cats (the ones that were there already)
 * Resolves { filled: boolean, cat?, cats?, error? }.
 */
export async function fillCopyIfLanded({ client, copyId, locationId, cat = null, cats = [], writtenCats = [], presentAt, now = () => new Date().toISOString() }) {
  const want = [...new Set([cat, ...(cats || [])].filter(Boolean))];
  if (!client || !copyId || !locationId || !want.length) return { filled: false };
  let present;
  try { present = new Set([...(await presentAt(want))].map(String)); }
  catch (e) { return { filled: false, error: e }; }
  const patch = {};
  if (cat && present.has(cat)) patch.cat = cat;
  const have = Array.isArray(writtenCats) ? writtenCats : [];
  const add = (cats || []).filter((c) => c && present.has(c) && !have.includes(c));
  if (add.length) patch.cats = [...have, ...add];
  if (!Object.keys(patch).length) return { filled: false };
  patch.updated_at = now();
  let res;
  try {
    res = await client.from('menu_items').update(patch)
      .eq('id', copyId).eq('location_id', locationId).is('cat', null).select('id');
  } catch (e) { return { filled: false, error: e }; }
  if (res?.error) return { filled: false, error: res.error };
  if (!Array.isArray(res?.data) || !res.data.length) return { filled: false };   // it has a category now
  return { filled: true, ...patch };
}

const CHUNK = 200;

/**
 * The category side of (c). A copy of category `catMasterId` has just landed at `locationId`
 * as `peerCatId`. Every product copy there that has NO category, and whose master sits in that
 * category (as its category, or in its "also in" list), gets it.
 *
 * Only copies with no category are touched, and each write is compare and set on the row's
 * updated_at and on cat still being empty: a category the venue set meanwhile is never
 * replaced. Option only sub items stay without one (they never render in a grid).
 *
 * Resolves { ok, filled: [{ id, cat?, cats? }], skipped: [{ id, error? }], error? }.
 */
export async function fillCopiesWaitingFor({ client, locationId, catMasterId, peerCatId, now = () => new Date().toISOString() }) {
  const out = { ok: true, filled: [], skipped: [] };
  if (!client || !locationId || !catMasterId || !peerCatId) return out;
  const read = await readAllRows(() => client.from('menu_items')
    .select('id, master_id, cat, cats, updated_at')
    .eq('location_id', locationId).is('cat', null).eq('archived', false).order('id'));
  if (read.error) return { ...out, ok: false, error: read.error };
  const copies = (read.rows || []).filter((r) => r.master_id && r.master_id !== r.id);
  if (!copies.length) return out;

  // The product as its owner has it.
  const masters = new Map();
  const masterIds = [...new Set(copies.map((c) => c.master_id))];
  for (let i = 0; i < masterIds.length; i += CHUNK) {
    const { data, error } = await client.from('menu_items')
      .select('id, cat, cats, type, sold_alone').in('id', masterIds.slice(i, i + CHUNK));
    if (error) return { ...out, ok: false, error };
    for (const m of data || []) masters.set(m.id, m);
  }

  // Which of the masters' categories are this category (its master, or a copy of it).
  const catIds = new Set();
  for (const m of masters.values()) {
    if (m.cat) catIds.add(m.cat);
    for (const c of (Array.isArray(m.cats) ? m.cats : [])) if (c) catIds.add(c);
  }
  const family = new Set([catMasterId]);
  const ids = [...catIds];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await client.from('menu_categories').select('id, master_id').in('id', ids.slice(i, i + CHUNK));
    if (error) return { ...out, ok: false, error };
    for (const r of data || []) if (categoryMasterIdOf(r) === catMasterId) family.add(r.id);
  }

  for (const c of copies) {
    const m = masters.get(c.master_id);
    if (!m || isOptionOnlyItem(m)) continue;
    const inCat = !!(m.cat && family.has(m.cat));
    const alsoIn = (Array.isArray(m.cats) ? m.cats : []).some((x) => family.has(x));
    if (!inCat && !alsoIn) continue;
    const have = Array.isArray(c.cats) ? c.cats : [];
    const patch = {};
    if (inCat) patch.cat = peerCatId;
    if (alsoIn && !have.includes(peerCatId)) patch.cats = [...have, peerCatId];
    if (!Object.keys(patch).length) continue;
    patch.updated_at = now();
    let res;
    try {
      let q = client.from('menu_items').update(patch).eq('id', c.id).eq('location_id', locationId).is('cat', null);
      if (c.updated_at != null) q = q.eq('updated_at', c.updated_at);
      res = await q.select('id');
    } catch (e) { out.skipped.push({ id: c.id, error: e }); continue; }
    if (res?.error) { out.skipped.push({ id: c.id, error: res.error }); continue; }
    if (!Array.isArray(res?.data) || !res.data.length) { out.skipped.push({ id: c.id }); continue; }   // changed meanwhile
    out.filled.push({ id: c.id, ...(patch.cat ? { cat: patch.cat } : {}), ...(patch.cats ? { cats: patch.cats } : {}) });
  }
  return out;
}
