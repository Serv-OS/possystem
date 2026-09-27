// src/lib/menuRowWrite.js: compare and set for Back Office menu writes.
//
// 27 Sep 2026, Peter: "I archived choc babychino but its still on the menu board". Two Back
// Office windows were open on Coffee Boy Leeds. The second had read the menu at 13:52; at
// 13:59 it wrote its memory of every product back over the database, including
// archived=false for the product the first window had archived at 13:56, and the tax rates
// the first window had just set. Nothing checked whether the rows had changed since.
//
// The floor plan has worked this way since v5.9.4 (lib/tablePlanDb.saveTableChecked), and this
// is the same rule for menu_items, menu_categories and menus:
//   1. Each row in memory carries `srvAt`, the updated_at the database gave it when this tab
//      read or last wrote it (lib/rowMapping.js).
//   2. A write sends ONLY the columns the person changed (lib/menuItemWrite.js) with
//      `where id = .. and location_id = .. and updated_at = srvAt`, and asks for the row back.
//   3. One row back: saved; its new updated_at is the next srvAt.
//   4. No row back: read the row again.
//        gone                             not saved, said plainly (deleted, or another venue)
//        a changed column was also changed there (not what we saw, not what we want):
//                                         REFUSED. The screen takes the database row and the
//                                         person is told to make the change again if needed.
//        only OTHER columns changed there the edit is sent once more on the new updated_at.
//                                         Safe, because it carries only what the person
//                                         changed, so it cannot put back anything else.
//        everything already as wanted     nothing to write
//        same updated_at, no change       the database refused it (row level security)
//   A row with no srvAt (loaded from an old push, or by old code) is read first, then (4).
//
// Until 20260927_OPS_menu_rows_server_time.sql runs, the token is the updated_at each writer
// stamps itself (every menu writer stamps one). After it, a trigger stamps every write from
// the database clock, so a hand edit in the SQL editor moves the token too.
//
// Pure: the Supabase client is passed in, so node:test drives it with a fake.

import { columnConflicts, pickColumns, sameValue } from './menuItemWrite.js';
import { srvTimeOf } from './rowMapping.js';

export const now = () => new Date().toISOString();

const sameTime = (a, b) => {
  if (a == null || b == null) return false;
  if (String(a) === String(b)) return true;
  const x = srvTimeOf(a), y = srvTimeOf(b);
  return Number.isFinite(x) && Number.isFinite(y) && x === y;
};

/**
 * Write `cols` to one row, compare and set on updated_at. Never throws.
 *   client        Supabase client (or a fake)
 *   table         'menu_items' | 'menu_categories' | 'menus'
 *   id, locationId
 *   srvAt         the updated_at this tab last read for the row (null: read it first)
 *   cols          the columns to write (snake_case), only what the person changed
 *   base          the same columns as this tab saw them before the edit
 *   soft          column names written only as a safety net: if somebody else changed one,
 *                 it is left out of the write instead of refusing the edit
 *   freshCols     (dbRow) => column map, built the same way as base, so they compare
 *   retryWithout  (error, cols) => ({ cols, note }) | null: a column the database cannot
 *                 take (item_code before its migration, a missing photo column) is dropped
 *                 and the rest saved
 *   stamp         () => ISO time the writer stamps on updated_at (the trigger overrides it)
 * Resolves { ok, outcome, row?, fresh?, changed?, dropped?, note?, error? }:
 *   applied   saved on the first try                      row = the row after the write
 *   merged    saved after a re-read (other columns had changed, or srvAt was unknown)
 *   already   the database already held every value       row = the re-read row
 *   noop      nothing to write
 *   conflict  refused: `changed` was changed elsewhere    fresh = the database row
 *   gone      no such row at this venue
 *   error     the database refused or failed              error
 */
export async function writeRowChecked({
  client, table, id, locationId, srvAt = null, cols, base = {}, soft = null,
  freshCols = (r) => r, retryWithout = null, stamp = now,
}) {
  if (!client) return { ok: false, outcome: 'error', error: new Error('No database') };
  if (!locationId || locationId === 'loc-demo') return { ok: false, outcome: 'error', error: new Error('No location') };
  if (!id) return { ok: false, outcome: 'error', error: new Error('No row id') };
  let work = { ...(cols || {}) };
  if (!Object.keys(work).length) return { ok: true, outcome: 'noop' };
  const softCols = soft instanceof Set ? soft : new Set(soft || []);
  let token = srvAt || null;   // after a re-read it can be null: a row that never had a stamp
  let reread = !token;         // a row with no srvAt is read before anything is written
  let retried = false;
  let note = null;
  const dropped = [];
  for (let guard = 0; guard < 6; guard++) {
    if (!reread) {
      let res;
      try {
        let q = client.from(table).update({ ...work, updated_at: stamp() })
          .eq('id', id).eq('location_id', locationId);
        q = token == null ? q.is('updated_at', null) : q.eq('updated_at', token);
        res = await q.select('*');
      } catch (e) { return { ok: false, outcome: 'error', error: e }; }
      if (res?.error) {
        const alt = retryWithout ? retryWithout(res.error, work) : null;
        if (alt && alt.cols && Object.keys(alt.cols).length < Object.keys(work).length) {
          work = alt.cols; note = alt.note || note;
          if (!Object.keys(work).length) return { ok: true, outcome: 'noop', note };
          continue;
        }
        return { ok: false, outcome: 'error', error: res.error };
      }
      if (Array.isArray(res?.data) && res.data.length) {
        return { ok: true, outcome: retried ? 'merged' : 'applied', row: res.data[0], note, dropped };
      }
    }
    // No row came back (or the token was unknown): find out why.
    let probe;
    try {
      probe = await client.from(table).select('*').eq('id', id).eq('location_id', locationId).maybeSingle();
    } catch (e) { return { ok: false, outcome: 'error', error: e }; }
    if (probe?.error) return { ok: false, outcome: 'error', error: probe.error };
    if (!probe?.data) {
      return { ok: false, outcome: 'gone', error: new Error(`${table} ${id} is not at this venue any more (deleted, or it belongs to another venue)`) };
    }
    const dbRow = probe.data;
    const untouched = token == null ? dbRow.updated_at == null : sameTime(dbRow.updated_at, token);
    if (!reread && untouched) {
      // Nobody changed it, yet the update matched nothing: the database said no.
      return { ok: false, outcome: 'error', refused: true, error: new Error(`${table} update matched 0 rows: row level security refused it`) };
    }
    const fresh = freshCols(dbRow);
    const { changed, pending } = columnConflicts({ cols: work, base, fresh });
    const hard = changed.filter((c) => !softCols.has(c));
    if (hard.length) return { ok: false, outcome: 'conflict', fresh: dbRow, changed: hard };
    for (const c of changed) { dropped.push(c); delete work[c]; }   // soft: their value stands
    if (!pending.length) return { ok: true, outcome: 'already', row: dbRow, note, dropped };
    if (retried) {
      // The row changed again between the re-read and the second try. Say so, never loop.
      return { ok: false, outcome: 'conflict', fresh: dbRow, changed: [], raced: true };
    }
    retried = true;
    reread = false;
    token = dbRow.updated_at;
    work = pickColumns(work, Object.keys(work));
  }
  return { ok: false, outcome: 'error', error: new Error(`${table} ${id}: gave up after repeated retries`) };
}

/**
 * Insert a row that must not exist yet (a creation). Never overwrites: ON CONFLICT DO NOTHING,
 * and "nothing came back" is reported as `exists`. Resolves { ok, outcome, row?, error? }:
 *   created | exists | error
 */
export async function insertRowOnce({ client, table, row, retryWithout = null, stamp = now }) {
  if (!client) return { ok: false, outcome: 'error', error: new Error('No database') };
  // Stamped, so the first edit has a compare and set token (the trigger overrides it).
  let work = { ...row, updated_at: stamp() };
  let note = null;
  for (let guard = 0; guard < 4; guard++) {
    let res;
    try {
      res = await client.from(table).upsert(work, { onConflict: 'id', ignoreDuplicates: true }).select('*');
    } catch (e) { return { ok: false, outcome: 'error', error: e }; }
    if (res?.error) {
      const alt = retryWithout ? retryWithout(res.error, work) : null;
      if (alt && alt.cols && Object.keys(alt.cols).length < Object.keys(work).length) { work = alt.cols; note = alt.note || note; continue; }
      return { ok: false, outcome: 'error', error: res.error };
    }
    if (Array.isArray(res?.data) && res.data.length) return { ok: true, outcome: 'created', row: res.data[0], note };
    return { ok: false, outcome: 'exists', error: new Error(`${table} ${row?.id} already exists; it was not overwritten`) };
  }
  return { ok: false, outcome: 'error', error: new Error(`${table} ${row?.id}: gave up after repeated retries`) };
}

/**
 * Delete one row of this venue and say whether it went (27 Sep 2026: every menu write checks
 * it changed a row; a delete the database refused used to read exactly like one that worked,
 * and the menu or category came back on the next refresh). Resolves { ok, outcome, error? }:
 *   deleted   the row is gone
 *   absent    there was no such row at this venue (nothing to delete)
 *   error     not deleted (`refused` when row level security said no)
 */
export async function deleteRowChecked({ client, table, id, locationId }) {
  if (!client) return { ok: false, outcome: 'error', error: new Error('No database') };
  if (!locationId || locationId === 'loc-demo') return { ok: false, outcome: 'error', error: new Error('No location') };
  if (!id) return { ok: false, outcome: 'error', error: new Error('No row id') };
  let res;
  try { res = await client.from(table).delete().eq('id', id).eq('location_id', locationId).select('id'); }
  catch (e) { return { ok: false, outcome: 'error', error: e }; }
  if (res?.error) return { ok: false, outcome: 'error', error: res.error };
  if (Array.isArray(res?.data) && res.data.length) return { ok: true, outcome: 'deleted' };
  // Nothing came back: was it never there, or did the database refuse?
  let probe;
  try { probe = await client.from(table).select('id').eq('id', id).eq('location_id', locationId).maybeSingle(); }
  catch (e) { return { ok: false, outcome: 'error', error: e }; }
  if (probe?.error) return { ok: false, outcome: 'error', error: probe.error };
  if (probe?.data) return { ok: false, outcome: 'error', refused: true, error: new Error(`${table} delete matched 0 rows: row level security refused it`) };
  return { ok: true, outcome: 'absent' };
}

/**
 * The sharing columns of one row (scope, org_id, master_id), written and CHECKED (27 Sep 2026).
 * Sharing a product or category, or making it Local again, used to update by id alone and never
 * look at what came back, so a write the database refused (row level security, or a row at
 * another venue) read exactly like one that worked. Now the write is scoped to the row's venue,
 * asks for the row back, and when none comes back reads the row: already holding `want` (the
 * owner venue already shares it, and a Back Office at another venue may not write there) is
 * fine; anything else is a failure, said as one. Resolves { ok, outcome, error? }:
 *   applied | already | gone | error
 */
export async function updateScopeChecked({ client, table, id, locationId, patch, want = null }) {
  if (!client) return { ok: false, outcome: 'error', error: new Error('No database') };
  if (!locationId || locationId === 'loc-demo') return { ok: false, outcome: 'error', error: new Error('No location') };
  if (!id) return { ok: false, outcome: 'error', error: new Error('No row id') };
  let res;
  try { res = await client.from(table).update(patch).eq('id', id).eq('location_id', locationId).select('id'); }
  catch (e) { return { ok: false, outcome: 'error', error: e }; }
  if (res?.error) return { ok: false, outcome: 'error', error: res.error };
  if (Array.isArray(res?.data) && res.data.length) return { ok: true, outcome: 'applied' };
  const cols = Object.keys(want || patch || {}).filter((c) => c !== 'updated_at');
  let probe;
  try { probe = await client.from(table).select(['id', ...cols].join(', ')).eq('id', id).eq('location_id', locationId).maybeSingle(); }
  catch (e) { return { ok: false, outcome: 'error', error: e }; }
  if (probe?.error) return { ok: false, outcome: 'error', error: probe.error };
  if (!probe?.data) return { ok: false, outcome: 'gone', error: new Error(`${table} ${id} is not at this venue any more (deleted, or it belongs to another venue)`) };
  const target = want || patch;
  const holds = cols.every((c) => sameValue(probe.data[c], target[c]));
  if (holds) return { ok: true, outcome: 'already' };
  return { ok: false, outcome: 'error', refused: true, error: new Error(`${table} ${id}: the sharing change matched 0 rows (row level security refused it)`) };
}

// ── The queue in front of the database ─────────────────────────────────────────
//
// Writes to ONE row go out one at a time, in order, each on the updated_at the previous one
// returned (a price typed as 1, 12, 12.5 is three writes, and the second must not race the
// first). An edit made while the row's previous write is in flight is folded into the next
// queued write for that row (the latest value of each column, the OLDEST base: what this tab
// saw before any of them). When a write is refused, the edits queued behind it for that row
// are dropped too: they were made on top of the refused value.
//
// `pendingIds()` and `whenIdle()` are what Push to POS waits on and what a reload uses to
// leave a row alone while this tab still has an edit on its way.
//
// cfg:
//   run(job, id) => Promise<result>  performs one update or create job (writeRowChecked or
//                                 insertRowOnce) with the row's srvAt as it is WHEN it starts
//   onResult(id, job, result, { queuedKeys, queuedCols, dropped })  applies the outcome to the
//                                 store (queued* = what edits still waiting for this row touch)
//   chain(fn) => Promise          optional: run each job inside an outer serial chain (the
//                                 categories and menus chain keeps parent before child)
export function createRowQueue({ run, onResult, chain = null }) {
  const rows = new Map();   // id → { queue: Job[], running: Job|null }
  let idleWaiters = [];

  const settleIdle = () => {
    if (rows.size) return;
    const w = idleWaiters; idleWaiters = [];
    w.forEach((fn) => fn());
  };

  const queuedKeysFor = (st) => {
    const keys = new Set();
    for (const j of st.queue) for (const k of j.keys || []) keys.add(k);
    return keys;
  };
  const queuedColsFor = (st) => {
    const cols = new Set();
    for (const j of st.queue) for (const c of Object.keys(j.cols || {})) cols.add(c);
    return cols;
  };

  const drain = async (id) => {
    const st = rows.get(id);
    while (st.queue.length) {
      const job = st.queue.shift();
      st.running = job;
      let result;
      const exec = () => (job.kind === 'task' ? job.fn() : run(job, id));
      try {
        result = await (chain ? chain(exec) : exec());
      } catch (e) { result = { ok: false, outcome: 'error', error: e }; }
      if (!result || typeof result !== 'object') result = { ok: !!result, outcome: result ? 'applied' : 'error' };
      st.running = null;
      const refused = result.outcome === 'conflict' || result.outcome === 'gone';
      const dropped = refused ? st.queue.splice(0) : [];
      if (job.kind !== 'task') {
        try { onResult?.(id, job, result, { queuedKeys: queuedKeysFor(st), queuedCols: queuedColsFor(st), dropped }); }
        catch (e) { console.warn('[menuRowWrite] applying a result failed:', e?.message || e); }
      }
      for (const fn of job.waiters) fn(result);
      for (const d of dropped) for (const fn of d.waiters) fn({ ok: false, outcome: 'dropped', after: result.outcome });
    }
    rows.delete(id);
    settleIdle();
  };

  const asSet = (s) => (s instanceof Set ? s : new Set(s || []));

  const enqueue = (id, job) => new Promise((resolve) => {
    let st = rows.get(id);
    const fresh = !st;
    if (!st) { st = { queue: [], running: null }; rows.set(id, st); }
    const last = st.queue[st.queue.length - 1];
    const jobSoft = asSet(job.soft);
    // An edit that carries its own compare and set token (a form's, checked against what the
    // form opened with) is never folded: folding would check it against the other edit's.
    if (job.kind === 'update' && last && last.kind === 'update' && job.srvAt === undefined && last.srvAt === undefined) {
      // Fold into the queued write: the latest value of each column, the OLDEST base (what
      // this tab saw before any of these edits). A column is soft only while every edit that
      // carries it is a safety net write.
      for (const [c, v] of Object.entries(job.cols || {})) {
        const had = c in last.cols;
        last.cols[c] = v;
        if (!jobSoft.has(c)) last.soft.delete(c);
        else if (!had) last.soft.add(c);
        if (!(c in last.base) && job.base && c in job.base) last.base[c] = job.base[c];
      }
      for (const k of job.keys || []) last.keys.add(k);
      if (job.label) last.label = job.label;
      last.quiet = !!(last.quiet && job.quiet);
      last.waiters.push(resolve);
      return;
    }
    st.queue.push({
      ...job,
      cols: { ...(job.cols || {}) },
      base: { ...(job.base || {}) },
      soft: jobSoft,
      keys: new Set(job.keys || []),
      waiters: [resolve],
    });
    if (fresh) drain(id);
  });

  return {
    /**
     * An edit to an existing row. Resolves with the write's result. srvAt (optional): the
     * compare and set token to use instead of the row's current one (a form's edit).
     */
    update: (id, { cols, base, soft, keys, label, quiet = false, srvAt }) => {
      if (!cols || !Object.keys(cols).length) return Promise.resolve({ ok: true, outcome: 'noop' });
      return enqueue(id, { kind: 'update', cols, base, soft, keys, label, quiet, ...(srvAt !== undefined ? { srvAt } : {}) });
    },
    /** A creation (insert only). Edits made before it lands queue behind it. */
    create: (id, payload) => enqueue(id, { kind: 'create', ...payload }),
    /** Anything else that must run in this row's order (the narrow archive write). */
    task: (id, fn, payload = {}) => enqueue(id, { kind: 'task', fn, ...payload }),
    isPending: (id) => rows.has(id),
    pendingIds: () => new Set(rows.keys()),
    whenIdle: () => (rows.size ? new Promise((r) => idleWaiters.push(r)) : Promise.resolve()),
  };
}
