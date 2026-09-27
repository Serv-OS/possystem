// src/lib/menuWriters.js: the Back Office's three menu writers (items, categories, menus),
// wired to a store. The store passes its own get and set, so node:test can run two of these
// against one fake database and replay the 27 Sep 2026 incident (menuWriters.test.js).
//
// Peter, 27 Sep 2026: "I archived choc babychino but its still on the menu board". Each writer:
//   * sends only the columns the edit changed (lib/menuItemWrite.js),
//   * compares and sets on the row's updated_at (lib/menuRowWrite.js writeRowChecked),
//   * queues writes to one row in order and folds edits that wait (createRowQueue),
//   * on success keeps the row's new updated_at as srvAt (and takes in other columns another
//     window changed, when the re-read showed some),
//   * on a refusal gives the screen the database row and tells the person in plain words,
//   * reports every outcome to saveHealth (the red bar), so nothing fails silently,
//   * gives every database call a time limit (MENU_WAIT_MS): a write that never answers is a
//     failed save, and the queue behind it moves on,
//   * remembers each row whose FIRST save (the insert) failed in this window: Push to POS offers
//     exactly those, insert only, and a reload keeps them on screen (failedCreateIds).
// Pure: no Supabase import, no store import.

import {
  columnsForEdit, columnsForCategoryPatch, columnsForMenuPatch,
  menuItemRow, categoryRow, menuRow, pickColumns, keysForColumns, sameValue,
  ITEM_COLUMNS, CATEGORY_COLUMNS, MENU_COLUMNS,
} from './menuItemWrite.js';
import { writeRowChecked, insertRowOnce, createRowQueue, writeWithin, MENU_WAIT_MS } from './menuRowWrite.js';
import { mapMenuItemRow, mapCategoryRow, mapMenuRow, srvAtOf } from './rowMapping.js';
import { isMissingItemCodeColumn, isDuplicateItemCodeError } from './itemCode.js';
import { isMissingImageColumn } from './categoryPhoto.js';

/** The words for a refused edit (the design, 27 Sep 2026). */
export const changedElsewhereMessage = (label) =>
  `${label || 'This item'} was changed in another window since this page loaded. Your change was NOT saved; the latest is showing now. Make it again if it is still needed.`;
export const goneMessage = (label) =>
  `${label || 'This item'} was NOT saved: it is not in this venue's menu in the database any more (deleted, or its first save failed). Reload to see the latest.`;

// v5.8.100: never lose a menu save over the item code. Either the column is not there yet
// (the migration is run by hand) or another product at this venue holds that code: save the
// rest without it.
export const itemCodeRetry = (error, cols) => {
  if (!cols || !('item_code' in cols)) return null;
  if (!isMissingItemCodeColumn(error) && !isDuplicateItemCodeError(error)) return null;
  const retry = { ...cols };
  delete retry.item_code;
  return { cols: retry, note: isDuplicateItemCodeError(error) ? 'item-code-duplicate' : 'item-code-missing-column' };
};

// v5.8.65: the image column is missing (the migration rolled back while this tab holds photo
// URLs): save the category without the photo instead of losing the edit.
export const categoryImageRetry = (error, cols) => {
  if (!cols || !cols.image || !isMissingImageColumn(error)) return null;
  const retry = { ...cols };
  delete retry.image;
  return { cols: retry, note: 'image-column-missing' };
};

const isParentKeyError = (error) => /parent_id_fkey|menu_id_fkey/.test(String(error?.message || ''));

// v5.9.22 (Huddersfield, 21 Sep 2026): a category whose menu row is not in the database is
// refused outright (23503 on menu_categories_menu_id_fkey). When Push to POS saves a category
// that was never saved, it keeps the CATEGORY and drops only the link: a category with no
// menu still shows on every surface, a lost one shows on none.
export const isMissingMenuRow = (error) =>
  String(error?.code || '') === '23503' && /menu_id|menu_categories_menu_id_fkey/i.test(String(error?.message || ''));
export const categoryMenuLinkRetry = (error, cols) => {
  if (!cols || !cols.menu_id || !isMissingMenuRow(error)) return null;
  const retry = { ...cols };
  delete retry.menu_id;
  console.warn('[menuWriters] category', cols.id || '', 'names a menu that is not saved (', cols.menu_id, '): saving it without the menu link');
  return { cols: retry, note: 'menu-link-dropped' };
};
// 27 Sep 2026: a sub category whose parent category is not in the database (deleted in another
// window) is refused on menu_categories_parent_id_fkey (23503) every time, so Push to POS, which
// offers it again, stopped on it for good. Its insert keeps the CATEGORY and drops only the
// parent: it is saved at the top level, and Push to POS says so (the result's parentDropped).
// A parent this window still means to create (its own first save failed here) is never dropped
// over: that error stands, so Push to POS names both and saves them in order next time
// (createMenuWriters, the category insert).
export const isMissingParentRow = (error) =>
  String(error?.code || '') === '23503' && /parent_id/i.test(`${error?.message || ''} ${error?.details || ''}`);
export const categoryParentRetry = (error, cols) => {
  if (!cols || !cols.parent_id || !isMissingParentRow(error)) return null;
  const retry = { ...cols };
  delete retry.parent_id;
  console.warn('[menuWriters] category', cols.id || '', 'names a parent category that is not in the database (', cols.parent_id, '): saving it at the top level');
  return { cols: retry, note: 'parent-dropped' };
};
/** The words for sub categories Push to POS saved at the top level (store saveUnsavedMenuRows toTopLevel). */
export function toTopLevelWords(names) {
  const list = (names || []).filter(Boolean);
  if (!list.length) return '';
  const eg = list.slice(0, 3).map((n) => `"${n}"`).join(', ') + (list.length > 3 ? ` and ${list.length - 3} more` : '');
  return list.length === 1
    ? `${eg} was saved as a TOP LEVEL category: the category it sat under is not in the database any more (deleted in another window). Move it under another category if it belongs there.`
    : `${eg} were saved as TOP LEVEL categories: the categories they sat under are not in the database any more (deleted in another window). Move them under another category if they belong there.`;
}
/** A category INSERT (never an edit): no photo column, no such menu, or no such parent category, still saves the rest. */
export const categoryInsertRetry = (error, cols) => categoryImageRetry(error, cols) || categoryMenuLinkRetry(error, cols) || categoryParentRetry(error, cols);

const TABLES = {
  items: {
    table: 'menu_items', entity: 'item', spec: ITEM_COLUMNS,
    mapRow: mapMenuItemRow,
    colsOf: (r) => menuItemRow(r),
    freshCols: (db) => menuItemRow(mapMenuItemRow(db)),
    retryWithout: itemCodeRetry,
    labelOf: (r) => r?.menuName || r?.menu_name || r?.name || 'This product',
  },
  categories: {
    table: 'menu_categories', entity: 'category', spec: CATEGORY_COLUMNS,
    mapRow: mapCategoryRow,
    colsOf: (r) => categoryRow(r),
    freshCols: (db) => categoryRow(mapCategoryRow(db)),
    retryWithout: categoryImageRetry,
    labelOf: (r) => r?.label || r?.name || 'This category',
  },
  menus: {
    table: 'menus', entity: 'menu', spec: MENU_COLUMNS,
    mapRow: mapMenuRow,
    colsOf: (r) => menuRow(r),
    freshCols: (db) => menuRow(mapMenuRow(db)),
    retryWithout: null,
    labelOf: (r) => r?.name || 'This menu',
  },
};

// Merge a database row into a store row, leaving alone every key an edit still waiting in
// the queue will write (the person's newer value must stay on screen).
function mergeInto(row, mapped, skip) {
  const out = { ...(row || {}) };
  for (const [k, v] of Object.entries(mapped || {})) if (!skip.has(k)) out[k] = v;
  out.srvAt = mapped?.srvAt ?? out.srvAt ?? null;
  if (mapped?.updated_at !== undefined) out.updated_at = mapped.updated_at;
  return out;
}

/**
 * deps:
 *   getClient()             the Supabase client (null in mock mode: every write is a no-op)
 *   resolveLocation()       Promise of this Back Office's venue id
 *   getRow(kind, id)        the store row ('items' | 'categories' | 'menus')
 *   updateRow(kind, id, fn) replace the store row with fn(row)
 *   reportSave(entity, err) lib/saveHealth.js
 *   toast(msg, type)        the store's showToast
 *   chain(fn)               the categories and menus serial chain (runInMenuWriteQueue)
 *   onSaved(kind, loc)      after a successful save (kiosk translations follow the English)
 *   wait(ms)                a timer (tests pass a fast one)
 *   timeoutMs               each database call's time limit (MENU_WAIT_MS; tests pass a short one)
 */
export function createMenuWriters(deps) {
  const {
    getClient, resolveLocation, getRow, updateRow,
    reportSave = () => {}, toast = () => {}, chain = null, onSaved = null,
    wait = (ms) => new Promise((r) => setTimeout(r, ms)),
    timeoutMs = MENU_WAIT_MS,
  } = deps;

  // This tab's write clock: a number that goes up every time a row's save lands (or its
  // refusal puts the database row on screen). A read notes the clock when it starts; a row
  // that landed after that keeps this tab's copy when the read is applied, because the read
  // cannot have seen it. A counter, never a time: no device clock is compared anywhere.
  let clock = 0;

  const make = (kind) => {
    const t = TABLES[kind];
    let queue = null;
    const landed = new Map();   // id → clock value when its last save landed
    const markLanded = (id) => { clock += 1; landed.set(id, clock); };
    // 27 Sep 2026: rows made in this window whose FIRST save (the insert) failed. Push to POS
    // offers these and only these (lib/venueMenuRead.js unsavedMenuRows): a row that is on screen
    // but not in the database for any other reason was deleted in another window, and must stay
    // deleted. Cleared when an insert lands ('created') or finds the row there ('exists'), when
    // the row is deleted here (forgetCreate), and when a read shows the database has it.
    const failedCreates = new Set();

    const run = async (job, id) => {
      const client = getClient();
      if (!client) return { ok: true, outcome: 'noop' };
      let loc = null;
      try { loc = await resolveLocation(); } catch { loc = null; }
      if (job.kind === 'create') {
        if (!loc || loc === 'loc-demo') return { ok: false, outcome: 'error', error: new Error('No location') };
        // 27 Sep 2026 (review round 3): a row made at one venue is never inserted at another
        // (the person switched venue while its first save waited in the queue).
        if (job.locationId && job.locationId !== loc) {
          return { ok: false, outcome: 'error', error: new Error(`refusing to create ${t.table} ${id}: it was made at venue ${job.locationId}, this Back Office is now on ${loc}`) };
        }
        // The row is built when the write RUNS (a category photo set meanwhile is included).
        // 27 Sep 2026: every database call has a time limit (writeWithin, MENU_WAIT_MS). A hung
        // insert used to hold this row's queue, and for categories and menus the whole serial
        // chain, so every later save and every Push to POS waited on it for good.
        const retry = job.retryWithout || t.retryWithout;
        // 27 Sep 2026: the parent category is never dropped on the first try (it may be landing
        // a beat later, v5.5.952 below), nor while it is a category this window still means to
        // create (its own first save failed here).
        const keepParent = (e, c) => (isMissingParentRow(e) ? null : (retry ? retry(e, c) : null));
        let sentParent = null;
        const once = (retryWithout) => {
          const row = typeof job.row === 'function' ? job.row() : job.row;
          sentParent = row?.parent_id || null;
          return writeWithin(insertRowOnce({ client, table: t.table, row: { ...row, id, location_id: loc }, retryWithout }),
            `saving new ${t.table} ${id}`, timeoutMs);
        };
        let r = await once(kind === 'categories' ? keepParent : retry);
        // v5.5.952: a sub category whose parent (or its menu) is still landing, or landed from
        // another tab a beat later: wait and try once more before going loud.
        if (r.outcome === 'error' && kind === 'categories' && isParentKeyError(r.error)) {
          await wait(900);
          r = await once(sentParent && failedCreates.has(sentParent) ? keepParent : retry);
        }
        // Saved without the parent it was sent with (categoryParentRetry): at the top level.
        const parentDropped = kind === 'categories' && r.outcome === 'created' && !!sentParent && !r.row?.parent_id;
        return { ...r, locationId: loc, ...(parentDropped ? { parentDropped: true } : {}) };
      }
      const row = getRow(kind, id);
      const rowLoc = row?.location_id ?? row?.locationId ?? null;
      if (rowLoc && loc && rowLoc !== loc) {
        return { ok: false, outcome: 'error', error: new Error(`refusing to write ${t.table} ${id}: it belongs to venue ${rowLoc}, this Back Office is on ${loc}`) };
      }
      // A write that is out of time is a failed save (never a hung queue). If it lands later the
      // compare and set makes that safe: this window's next edit of the row re reads it first.
      const once = () => writeWithin(writeRowChecked({
        client, table: t.table, id, locationId: loc,
        // A form's edit carries the token it opened with (edit opts.opened); else the row's now.
        srvAt: job.srvAt !== undefined ? job.srvAt : srvAtOf(getRow(kind, id)),
        cols: job.cols, base: job.base, soft: job.soft,
        freshCols: t.freshCols, retryWithout: t.retryWithout,
      }), `saving ${t.table} ${id}`, timeoutMs);
      let r = await once();
      if (r.outcome === 'error' && kind === 'categories' && isParentKeyError(r.error)) { await wait(900); r = await once(); }
      return { ...r, locationId: loc };
    };

    const onResult = (id, job, result, { queuedKeys, queuedCols, dropped }) => {
      const label = job.label || t.labelOf(getRow(kind, id));
      const o = result?.outcome;
      if (job.kind === 'create') {
        if (o === 'created' || o === 'exists') failedCreates.delete(id);
        else if (o === 'error') failedCreates.add(id);
      }
      if (['applied', 'created', 'merged'].includes(o)) {
        try { onSaved?.(kind, result.locationId || null); } catch { /* a nicety */ }
      }
      if (['applied', 'created', 'merged', 'already', 'conflict'].includes(o)) markLanded(id);
      if (o === 'applied' || o === 'created') {
        const at = result.row?.updated_at ?? null;
        // A category saved at the top level (its parent is not in the database) shows there.
        const top = (r) => (result.parentDropped ? { parentId: null, ...('parent_id' in r ? { parent_id: null } : {}) } : {});
        updateRow(kind, id, (r) => (r ? { ...r, ...top(r), srvAt: at, updated_at: at } : r));
        reportSave(t.entity, null);
      } else if (o === 'merged' || o === 'already') {
        // Another window changed OTHER columns: show them, except where an edit of ours is
        // still waiting to be written (its newer value stays on screen).
        const skip = new Set(queuedKeys || []);
        for (const c of queuedCols || []) {
          skip.add(c);
          for (const k of keysForColumns(t.spec, [c])) skip.add(k);
          for (const k of t.spec[c]?.from || []) skip.add(k);
        }
        updateRow(kind, id, (r) => (r ? mergeInto(r, t.mapRow(result.row), skip) : r));
        reportSave(t.entity, null);
      } else if (o === 'conflict') {
        updateRow(kind, id, (r) => mergeInto(r, t.mapRow(result.fresh), new Set()));
        reportSave(t.entity, new Error(`${label}: changed in another window since this page loaded, so this change was not saved`));
        if (!job.quiet) toast(changedElsewhereMessage(label), 'error');
      } else if (o === 'gone') {
        reportSave(t.entity, result.error);
        if (!job.quiet) toast(goneMessage(label), 'error');
      } else if (o === 'exists') {
        reportSave(t.entity, result.error);
      } else if (o === 'error') {
        reportSave(t.entity, result.error);
      }
      if (dropped?.length) console.warn(`[menuWriters] ${dropped.length} later edit(s) to ${t.table} ${id} dropped after a refusal`);
    };

    queue = createRowQueue({ run, onResult, chain: kind === 'items' ? null : chain });

    return {
      /**
       * Save an edit. prev = the row before it, next = the row after it (the store's rows).
       * opts.quiet: no per row toast (a bulk action shows one summary instead).
       * Resolves the write's result ({ ok, outcome, ... }).
       */
      edit(id, patch, prev, next, opts = {}) {
        if (!next || !prev) return Promise.resolve({ ok: false, outcome: 'noop' });
        let cols; let soft = new Set();
        if (kind === 'items') ({ cols, soft } = columnsForEdit(patch, next, prev));
        else if (kind === 'categories') cols = columnsForCategoryPatch(patch, next, opts.liveRow || null);
        else cols = columnsForMenuPatch(patch, next);
        if (!cols || !Object.keys(cols).length) return Promise.resolve({ ok: true, outcome: 'noop' });
        // 27 Sep 2026: an edit made in a FORM (the category editor) is checked against the row
        // as the form opened with it (opts.opened): its values are the base, and its updated_at
        // the compare and set token. A reload while the form was open refreshes the store row
        // but not the form, so comparing with the store row would let the form's stale values
        // through. A token older than the store's costs one re-read at most, never a false
        // refusal: only the columns this edit writes are compared.
        const opened = opts.opened && typeof opts.opened === 'object' ? opts.opened : null;
        const base = pickColumns(t.colsOf(opened || prev), Object.keys(cols));
        return queue.update(id, {
          cols, base, soft, keys: Object.keys(patch || {}), label: t.labelOf(next), quiet: !!opts.quiet,
          ...(opened ? { srvAt: srvAtOf(opened) } : {}),
        });
      },
      /**
       * Save a NEW row (insert only, never overwrites). `row` is the full column map, or a
       * function returning it when the write runs. opts.locationId: the venue the row was made
       * at; the insert is refused if the Back Office is on another venue when it runs.
       */
      create(id, row, opts = {}) {
        return queue.create(id, {
          row, label: opts.label || null, quiet: !!opts.quiet, retryWithout: opts.retryWithout || null,
          locationId: opts.locationId || null,
        });
      },
      /** Run fn in this row's order (the narrow archive write). */
      task: (id, fn) => queue.task(id, fn),
      /** A write made outside the queue landed (the archive): note it on the clock. */
      markLanded,
      /** Ids whose save landed after clock value `since`. */
      landedSince: (since) => new Set([...landed].filter(([, at]) => at > since).map(([id]) => id)),
      /** Ids of rows made in this window whose first save (the insert) failed. */
      failedCreateIds: () => new Set(failedCreates),
      /** The row was deleted here, or a read shows the database has it: nothing to offer. */
      forgetCreate: (id) => { failedCreates.delete(id); },
      isPending: (id) => queue.isPending(id),
      pendingIds: () => queue.pendingIds(),
      whenIdle: () => queue.whenIdle(),
    };
  };

  return { items: make('items'), categories: make('categories'), menus: make('menus'), mark: () => clock };
}

// ── What follows from an item edit (27 Sep 2026, review round 3) ─────────────────────────────
// An edit of a product can change more than its own row: its sizes take its category, tax and
// allergens (the variant cascade), a parent's type flips when a size moves, and a rename is
// copied into modifier group options. These used to be saved at the same moment as the product,
// so a product save refused as "changed in another window" still changed its sizes and groups.
// Now they follow only once the product's own save has LANDED.

/**
 * Did the product's own save land, so what follows from it may be saved? applied and merged
 * saved it; already means the database holds it; noop means there was nothing to write (the
 * product already had the value, or the demo has no database), so a size still out of step is
 * brought into line. conflict, gone, error and dropped did not land.
 */
export const itemSaveLanded = (result) => ['applied', 'merged', 'already', 'noop'].includes(result?.outcome);

/**
 * Run an item edit's writes: the product's own first, the rest only once it landed.
 *   writes            [{ id, patch, main? }]: the one marked main is the product's own
 *   editRow(w)        starts one write and returns its promise
 *   onLanded(result)  after the rest have started (the store saves the renamed groups here)
 *   onSkipped(result) the product's save did not land: nothing else was written
 * Returns the product's own save, which is what updateMenuItem resolves.
 */
export function runItemEditWrites(writes, { editRow, onLanded = null, onSkipped = null }) {
  const list = Array.isArray(writes) ? writes : [];
  const main = list.find((w) => w.main);
  const rest = list.filter((w) => !w.main);
  if (!main) {
    for (const w of rest) editRow(w);
    return Promise.resolve({ ok: false, outcome: 'noop' });
  }
  const mainSave = Promise.resolve(editRow(main));
  mainSave.then((r) => {
    if (!itemSaveLanded(r)) { onSkipped?.(r); return; }
    for (const w of rest) editRow(w);
    onLanded?.(r);
  }, (e) => { onSkipped?.({ ok: false, outcome: 'error', error: e }); }).catch((e) => {
    console.warn('[menuWriters] after an item save:', e?.message || e);
  });
  return mainSave;
}

/**
 * The screen after an item save that did not land: each field the edit's OTHER writes changed
 * (a size's cascaded category, a parent's flipped type) goes back to what it was before the
 * edit, but only while it still shows this edit's value (anything changed since stays).
 *   rows    the list now;  writes: the edit's other writes ({ id, patch })
 *   before, after: the list just before and just after the edit
 */
export function putBackFollowers(rows, writes, before, after) {
  const keysOf = new Map((writes || []).map((w) => [w.id, Object.keys(w.patch || {})]));
  if (!keysOf.size) return rows;
  const was = new Map((before || []).map((r) => [r?.id, r]));
  const became = new Map((after || []).map((r) => [r?.id, r]));
  return (rows || []).map((r) => {
    const keys = r ? keysOf.get(r.id) : null;
    const b = keys ? was.get(r.id) : null;
    const a = keys ? became.get(r.id) : null;
    if (!keys || !b || !a) return r;
    let out = r;
    for (const k of keys) {
      if (sameValue(r[k], a[k]) && !sameValue(r[k], b[k])) {
        if (out === r) out = { ...r };
        out[k] = b[k];
      }
    }
    return out;
  });
}
