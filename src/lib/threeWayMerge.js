// src/lib/threeWayMerge.js: put ONE window's change onto what the database holds NOW.
//
// 27 Sep 2026 (Peter: "I archived choc babychino but its still on the menu board"): a Back
// Office window writes back whatever it loaded, so a screen left open puts back values another
// window saved since. For the settings that are saved whole (a modifier group's options, the
// print routing, the venue's pos_settings, the Quick Screen list) the save now reads the row
// again and applies only what THIS window changed:
//   base   what this window loaded (or last saved)
//   mine   what this window wants now
//   fresh  what the database holds at save time
// Anything this window did not change keeps the database's value. Pure.

import { sameValue } from './menuItemWrite.js';

/**
 * An object merged key by key (pos_settings, print routing by centre id).
 * A key this window changed or added takes this window's value; a key it removed is removed;
 * every other key keeps the database's value, including keys added elsewhere.
 */
export function mergeKeys(base, mine, fresh) {
  const out = { ...(fresh && typeof fresh === 'object' ? fresh : {}) };
  const keys = new Set([...Object.keys(base || {}), ...Object.keys(mine || {})]);
  for (const k of keys) {
    const b = base ? base[k] : undefined;
    const m = mine ? mine[k] : undefined;
    if (sameValue(b, m)) continue;   // not changed here: the database's value stands
    if (m === undefined) delete out[k];
    else out[k] = m;
  }
  return out;
}

/**
 * Lists of objects with an `id` (modifier options, print centres), merged by id.
 *   added here      kept      removed here    removed      changed here   this window's copy
 *   added there     kept      removed there   removed (unless this window changed it)
 * Order: this window's order when it reordered, else the database's; additions go last.
 */
export function mergeById(base, mine, fresh) {
  const B = new Map((base || []).filter((x) => x && x.id != null).map((x) => [x.id, x]));
  const M = new Map((mine || []).filter((x) => x && x.id != null).map((x) => [x.id, x]));
  const F = new Map((fresh || []).filter((x) => x && x.id != null).map((x) => [x.id, x]));
  const pickFor = (id) => {
    const inB = B.has(id), inM = M.has(id), inF = F.has(id);
    if (inM && !inB) return M.get(id);                       // added here
    if (!inM && inB) return null;                            // removed here
    if (inM && inB) {
      if (!sameValue(M.get(id), B.get(id))) return M.get(id); // changed here
      return inF ? F.get(id) : null;                          // untouched here: the database's
    }
    return inF ? F.get(id) : null;                            // added there
  };
  const commonInOrder = (list) => (list || []).map((x) => x?.id).filter((id) => B.has(id) && M.has(id));
  const reordered = !sameValue(commonInOrder(mine), commonInOrder(base));
  const order = [];
  const seen = new Set();
  const push = (id) => { if (id == null || seen.has(id)) return; seen.add(id); order.push(id); };
  if (reordered) { (mine || []).forEach((x) => push(x?.id)); (fresh || []).forEach((x) => push(x?.id)); }
  else { (fresh || []).forEach((x) => push(x?.id)); (mine || []).forEach((x) => push(x?.id)); }
  const out = [];
  for (const id of order) { const v = pickFor(id); if (v) out.push(v); }
  // Entries without an id (legacy) cannot be matched: this window's copy of them stands.
  for (const x of mine || []) if (x && x.id == null) out.push(x);
  return out;
}

/**
 * Instruction groups (27 Sep 2026). They have no table: each Push to POS carries the whole list,
 * and a window left open used to push its own list and undo groups another window had added
 * and pushed since. The latest push's list (`fresh`) takes THIS window's changes since `base`
 * (the list it last received from a push, or last pushed itself). With no base known, nothing
 * this window lacks is treated as removed: the lists are joined, never shortened. `fresh` that
 * is not a list (no push yet) is read as empty.
 */
export function mergeInstructionGroups(base, mine, fresh) {
  const F = Array.isArray(fresh) ? fresh : [];
  const M = Array.isArray(mine) ? mine : [];
  return mergeById(Array.isArray(base) ? base : [], M, F);
}

/**
 * A whole list saved as one value (the Quick Screen ids): no merge is safe for an ordered
 * grid, so it is compare and set by value.
 *   'noop'      the database already holds what this window wants
 *   'write'     the database still holds what this window loaded
 *   'conflict'  somebody else changed it since: refuse, show theirs
 */
export function decideWholeSave(base, mine, fresh) {
  if (sameValue(fresh, mine)) return 'noop';
  if (sameValue(fresh, base)) return 'write';
  return 'conflict';
}
