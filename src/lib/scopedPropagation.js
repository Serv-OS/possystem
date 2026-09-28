// src/lib/scopedPropagation.js: when a Shared or Global product's edit follows to its copies.
//
// 27 Sep 2026, Peter: "I archived choc babychino but its still on the menu board". An edit to a
// Shared or Global product is copied to every other venue (23 Sep 2026, db.propagateScopedEdit).
// It used to be scheduled the moment the edit was made, whatever became of the save, and 750 ms
// later it copied the product as THIS TAB REMEMBERED IT. So a change this window was told "was
// NOT saved" (changed in another window) still reached every copy, and a window loaded before
// another window's archive copied archived=false to every venue (Global carries archived).
//
// Now:
//   1. Only a save the database accepted schedules a copy (savedForPropagation): applied,
//      merged (sent again after a re-read) or already (the database already held it). A
//      refusal, a missing row, an error or a dropped edit copies nothing.
//   2. The copy is made from the product as the DATABASE holds it when the copy runs (readRow),
//      never from this tab's memory: what reaches the other venues is what this venue saved,
//      another window's archive or rename included.
//   3. Unchanged from 23 Sep: per product, a trailing wait coalesces a burst of edits, and one
//      copy runs at a time (a dirty flag runs it once more when edits land meanwhile).
//
// Pure: the database read and the copy are passed in, so node:test drives it with a fake.
// Timers are ARROW WRAPPERS, never `{ setTimeout, clearTimeout }` (v5.8.59: a browser throws
// "Illegal invocation" when a timer is called as a method of a plain object).

/** The save outcomes that mean the database holds the edit (lib/menuRowWrite.js). */
export const PROPAGATING_OUTCOMES = Object.freeze(['applied', 'merged', 'already']);

/** Did this save land, so its product may be copied to the other venues? */
export const savedForPropagation = (result) =>
  !!(result && result.ok === true && PROPAGATING_OUTCOMES.includes(result.outcome));

const DEFAULT_TIMERS = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

/**
 * deps:
 *   readRow(id)        => Promise<{ row, error }>  the product as the database holds it NOW
 *   propagate(row, keys) => Promise<result>         db.propagateScopedEdit
 *   onResult(row, result)                            report failures and unmapped fields
 *   onError(error)                                   a read or a copy that threw or failed
 *   delay              ms to wait after the last edit (750 in the app)
 *   timers             { setTimeout, clearTimeout } as arrow wrappers (tests pass their own)
 */
export function createScopedPropagator({
  readRow, propagate, onResult = () => {}, onError = () => {}, delay = 750, timers = DEFAULT_TIMERS,
}) {
  const setT = (timers && timers.setTimeout) || DEFAULT_TIMERS.setTimeout;
  const clearT = (timers && timers.clearTimeout) || DEFAULT_TIMERS.clearTimeout;
  const waiting = new Map();   // id → timer
  const keysById = new Map();  // id → Set of changed keys not yet copied
  const busy = new Map();      // id → { dirty, keys }
  const saved = new Map();     // id → the row the last accepted save returned (pagehide only)
  let idleWaiters = [];

  const settle = () => {
    if (waiting.size || busy.size) return;
    const w = idleWaiters; idleWaiters = [];
    w.forEach((fn) => fn());
  };

  const run = async (id) => {
    waiting.delete(id);
    const pending = keysById.get(id) || new Set();
    keysById.delete(id);
    const already = busy.get(id);
    if (already) { already.dirty = true; for (const k of pending) already.keys.add(k); return; }
    const state = { dirty: false, keys: pending };
    busy.set(id, state);
    try {
      do {
        state.dirty = false;
        const keys = state.keys; state.keys = new Set();
        let read;
        try { read = await readRow(id); } catch (e) { read = { row: null, error: e }; }
        if (read?.error) { onError(read.error); break; }
        const row = read?.row || null;
        if (!row) break;   // gone from this venue: nothing to copy
        const r = await propagate(row, keys.size ? [...keys] : null);
        onResult(row, r);
      } while (state.dirty);
    } catch (e) { onError(e); }
    finally {
      busy.delete(id);
      saved.delete(id);
      settle();
    }
  };

  return {
    /**
     * Copy this product to its other venues shortly, from the database. Call ONLY once its
     * save has landed (savedForPropagation). savedRow: the row that save returned, used only
     * if the page is closed before the copy runs.
     */
    schedule(id, keys, savedRow = null) {
      if (!id) return;
      const pending = keysById.get(id) || new Set();
      for (const k of keys || []) pending.add(k);
      keysById.set(id, pending);
      if (savedRow && typeof savedRow === 'object') saved.set(id, savedRow);
      if (waiting.has(id)) clearT(waiting.get(id));
      waiting.set(id, setT(() => { run(id); }, delay));
    },
    /**
     * The page is closing: copy every product still waiting NOW (best effort, as before).
     * A product whose save returned its row is copied from that row (no time to read it
     * again); one without (the archive asks only for its id) is read and copied at once.
     */
    flush(fire) {
      for (const id of [...waiting.keys()]) {
        clearT(waiting.get(id));
        const row = saved.get(id);
        if (row && typeof fire === 'function') {
          waiting.delete(id);
          const keys = [...(keysById.get(id) || [])];
          keysById.delete(id);
          saved.delete(id);
          try { fire(row, keys); } catch { /* the page is going */ }
        } else {
          run(id);
        }
      }
      settle();
    },
    isPending: (id) => waiting.has(id) || busy.has(id),
    /** Resolves when no copy is waiting or running (tests). */
    whenIdle: () => ((waiting.size || busy.size) ? new Promise((r) => idleWaiters.push(r)) : Promise.resolve()),
  };
}
