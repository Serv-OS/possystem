// src/lib/modifierGroupWrite.js: saving a modifier group without putting back another
// window's changes.
//
// 27 Sep 2026 (Peter: "I archived choc babychino but its still on the menu board"): every
// group save wrote the WHOLE options array (names and prices) from this window's memory, so
// a window left open undid option changes saved in another one. modifier_groups has no
// updated_at until 20260927_OPS_menu_rows_server_time.sql runs, so a save now:
//   1. reads the group again,
//   2. keeps every field and option this window did not change at the database's value
//      (options merged by id, lib/threeWayMerge.js),
//   3. writes the result, compare and set on updated_at once the column exists (one retry),
//      and checks a row really changed,
//   4. hands the merged group back so the screen shows what was saved.
// A group deleted in another window is never brought back by a save.
// Pure: the client is passed in.

import { mergeById } from './threeWayMerge.js';
import { sameValue } from './menuItemWrite.js';
import { mapModifierGroupRow } from './rowMapping.js';
import { insertRowOnce, writeWithin } from './menuRowWrite.js';

const FIELDS = ['name', 'min', 'max', 'selectionType', 'sortOrder'];

/** One window's edit of a group laid onto the database's copy. */
export function mergeModifierGroup(base, mine, fresh) {
  const out = { ...(fresh || {}), id: mine?.id ?? fresh?.id };
  for (const f of FIELDS) {
    out[f] = sameValue(mine?.[f], base?.[f]) ? fresh?.[f] : mine?.[f];
  }
  out.options = mergeById(base?.options || [], mine?.options || [], fresh?.options || []);
  return out;
}

/** The modifier_groups columns of a group (no id, no location, no updated_at). */
export const modifierGroupRow = (g) => ({
  name:           g.name,
  min:            g.min ?? 0,
  max:            g.max ?? 1,
  selection_type: g.selectionType ?? g.selection_type ?? 'single',
  options:        g.options || [],
  sort_order:     g.sortOrder ?? g.sort_order ?? 0,
});

/**
 * Save `mine` (this window's group) given `base` (the group before this window's edit).
 * Resolves { ok, outcome, group?, error? }: saved | gone | conflict | error.
 * 27 Sep 2026: the store calls it through writeWithin (lib/menuRowWrite.js, MENU_WAIT_MS), so a
 * save that never answers is a failed save and the group's queue moves on.
 */
export async function saveModifierGroupChecked({ client, locationId, base, mine }) {
  if (!client) return { ok: false, outcome: 'error', error: new Error('No database') };
  if (!locationId || locationId === 'loc-demo') return { ok: false, outcome: 'error', error: new Error('No location') };
  if (!mine?.id) return { ok: false, outcome: 'error', error: new Error('No group id') };
  for (let attempt = 0; attempt < 2; attempt++) {
    let read;
    try { read = await client.from('modifier_groups').select('*').eq('id', mine.id).eq('location_id', locationId).maybeSingle(); }
    catch (e) { return { ok: false, outcome: 'error', error: e }; }
    if (read?.error) return { ok: false, outcome: 'error', error: read.error };
    if (!read?.data) return { ok: false, outcome: 'gone', error: new Error(`modifier group ${mine.id} is not at this venue any more (deleted in another window?)`) };
    const fresh = mapModifierGroupRow(read.data);
    const merged = mergeModifierGroup(base, mine, fresh);
    const hasStamp = Object.prototype.hasOwnProperty.call(read.data, 'updated_at');
    let q = client.from('modifier_groups').update(modifierGroupRow(merged)).eq('id', mine.id).eq('location_id', locationId);
    if (hasStamp && read.data.updated_at != null) q = q.eq('updated_at', read.data.updated_at);
    let res;
    try { res = await q.select('*'); } catch (e) { return { ok: false, outcome: 'error', error: e }; }
    if (res?.error) return { ok: false, outcome: 'error', error: res.error };
    if (Array.isArray(res?.data) && res.data.length) return { ok: true, outcome: 'saved', group: mapModifierGroupRow(res.data[0]) };
    // Nothing changed. Without a stamp there is nothing to race on: the database refused it.
    const refused = { ok: false, outcome: 'error', error: new Error('Modifier group update matched 0 rows: row level security refused it') };
    if (!hasStamp || read.data.updated_at == null) return refused;
    // With one: did the group move between the read and the write (go round once more), or
    // is it as it was (then the database refused it)?
    let again;
    try { again = await client.from('modifier_groups').select('updated_at').eq('id', mine.id).eq('location_id', locationId).maybeSingle(); }
    catch (e) { return { ok: false, outcome: 'error', error: e }; }
    if (again?.error) return { ok: false, outcome: 'error', error: again.error };
    if (!again?.data) return { ok: false, outcome: 'gone', error: new Error(`modifier group ${mine.id} is not at this venue any more (deleted in another window?)`) };
    if (String(again.data.updated_at) === String(read.data.updated_at)) return refused;
  }
  return { ok: false, outcome: 'conflict', error: new Error('the group kept changing in another window while this one saved') };
}

// Before 20260927_OPS_menu_rows_server_time.sql modifier_groups has no updated_at column, and
// PostgREST refuses a row that names one: the stamp insertRowOnce adds is dropped, the rest saved.
export const groupStampRetry = (error, cols) => {
  if (!cols || !('updated_at' in cols) || !/updated_at/.test(String(error?.message || ''))) return null;
  const retry = { ...cols };
  delete retry.updated_at;
  return { cols: retry, note: 'no-updated-at-column' };
};

/**
 * Save a group whose FIRST save failed, INSERT ONLY (27 Sep 2026, review round 3: Push to POS
 * lists it first, lib/venueMenuRead.js unsavedMenuRows). An existing id is never overwritten,
 * and a group made at another venue is never saved here. Resolves insertRowOnce's
 * { ok, outcome: created | exists | error, row?, error? }. 27 Sep 2026: with a time limit
 * (writeWithin, MENU_WAIT_MS): out of time is a failed save, never a hung Push to POS.
 */
export async function insertModifierGroupOnce({ client, locationId, group, ms }) {
  if (!client) return { ok: false, outcome: 'error', error: new Error('No database') };
  if (!locationId || locationId === 'loc-demo') return { ok: false, outcome: 'error', error: new Error('No location') };
  if (!group?.id) return { ok: false, outcome: 'error', error: new Error('No group id') };
  const made = group.location_id ?? group.locationId ?? null;
  if (made && made !== locationId) {
    return { ok: false, outcome: 'error', error: new Error(`refusing to save modifier group ${group.id}: it was made at venue ${made}, this Back Office is on ${locationId}`) };
  }
  return writeWithin(insertRowOnce({
    client, table: 'modifier_groups',
    row: { id: group.id, location_id: locationId, ...modifierGroupRow(group) },
    retryWithout: groupStampRetry,
  }), `saving new modifier group ${group.id}`, ms);
}

/**
 * Saves for one key go one at a time; while one runs, further requests fold into ONE next
 * save (the OLDEST base, the LATEST group). `run(key, { base, mine })` performs it.
 */
export function createLatestQueue(run) {
  const st = new Map();   // key → { pumping, next }
  let idle = [];
  const pump = async (key) => {
    const s = st.get(key);
    s.pumping = true;
    while (s.next) {
      const job = s.next;
      s.next = null;
      let r;
      try { r = await run(key, job); } catch (e) { r = { ok: false, outcome: 'error', error: e }; }
      job.waiters.forEach((w) => w(r));
    }
    st.delete(key);
    if (!st.size) { const w = idle; idle = []; w.forEach((fn) => fn()); }
  };
  return {
    request(key, { base, mine }) {
      return new Promise((resolve) => {
        let s = st.get(key);
        if (!s) { s = { pumping: false, next: null }; st.set(key, s); }
        if (s.next) { s.next.mine = mine; s.next.waiters.push(resolve); }
        else s.next = { base, mine, waiters: [resolve] };
        if (!s.pumping) pump(key);
      });
    },
    hasQueued: (key) => !!st.get(key)?.next,
    isPending: (key) => st.has(key),
    pendingKeys: () => new Set(st.keys()),
    whenIdle: () => (st.size ? new Promise((r) => idle.push(r)) : Promise.resolve()),
  };
}
