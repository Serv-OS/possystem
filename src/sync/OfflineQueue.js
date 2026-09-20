/**
 * OfflineQueue — buffers Supabase writes when offline, replays when back online.
 * Uses IndexedDB for durable storage so data survives page reloads.
 * Wraps the session sync flush so no order data is ever lost.
 *
 * v4.3.0: tracks per-item failure state. Items that fail replay N times (5 by
 * default) are marked `permanentFailure=true` and stop being retried
 * automatically — they surface in the Failure Queue UI for manual retry/dismiss.
 */

import { REPLAY_MAX_AGE_MS } from './staleness';
import { missingColumnOf } from '../lib/closedCheckWrite';
import { isParkedPermissionItem, releaseParkedItem, isPermissionError, shouldReleaseParkedOnLink } from '../lib/deviceFence';
import { getLastDeviceLinkOutcome } from '../lib/supabase';
// Fix round 2 (the zero row blocker): a replayed update or delete that changes 0 rows is judged
// against the device link (lib/rowWriteFence.js), never counted as sent on its own.
import {
  replayMustChangeItem, heldBehindParked, parkedAgain, rowKeyOf, waitingRowKeys, replayBlocksRow,
  isLateSafeParkedDelete, PARKED_LINK, OCCUPATION_KEY, ZERO_ROWS_UNKNOWN,
} from '../lib/rowWriteFence';
import { confirmLinkAfterZeroRows, getLinkEpoch, checkDeviceLink } from '../lib/deviceLink';

const DB_NAME = 'rpos-offline';
const STORE_NAME = 'queue';
const DB_VERSION = 2;  // bumped for failure-tracking fields
const MAX_AUTO_RETRIES = 5;

let _db = null;
let _isOnline = navigator.onLine;
let _flushTimer = null;

// ── IndexedDB setup ───────────────────────────────────────────────────────────
function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('by_table', 'table_id');
        store.createIndex('by_status', 'status');
      } else {
        // v1 → v2: existing stores won't have 'by_status' index; add it
        const tx = e.target.transaction;
        const store = tx.objectStore(STORE_NAME);
        if (!store.indexNames.contains('by_status')) {
          store.createIndex('by_status', 'status');
        }
      }
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

async function dbAdd(item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).add(item);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(item);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dbClear() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ── Queue a write ─────────────────────────────────────────────────────────────
export async function queueWrite(op) {
  // op: { type: 'upsert' | 'delete' | 'insert', table: string, payload: object, match?: object, kind?: string, label?: string }
  //   kind: optional category tag ('kds_send', 'closed_check', 'print_job') for failure UI grouping
  //   label: optional human-readable description for the failure UI (e.g. "Kitchen ticket for T5")
  await dbPut({
    ...op,
    ts: Date.now(),
    status: 'pending',
    attempts: 0,
  });
  if (_isOnline) scheduleFlush();
}

// ── Replay queue when back online ─────────────────────────────────────────────
let _replaying = false;

// v5.8.86: a replay guard, registered by QueueReconciler. `before` runs once at the start of a
// replay (it re-checks the server, so a row another till cleared while this one was offline is
// dropped here first); `keep(item)` then decides per buffered STATE write whether it still
// describes a row this till holds. Without it a buffered order_queue upsert replayed after a
// reconnect re-created an order every other till had already cleared.
let _guard = null;
export function setReplayGuard(guard) { _guard = guard && typeof guard === 'object' ? guard : null; }

/**
 * Keys (ref for order_queue, id for bar_tabs) with a buffered state write in IndexedDB: proof
 * the row was sent from this till and is still in flight or was refused (a refused or stale
 * quarantined write still counts: the row is not an old copy, it is unconfirmed). Only a
 * dismissed item is no evidence. Returns null when the store cannot be read in time, so the
 * caller judges nothing on that pass instead of treating "unknown" as "nothing buffered".
 */
export async function bufferedUpsertKeys(table) {
  const out = new Set();
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('IndexedDB read timed out')), 5000); });
  try {
    const items = await Promise.race([dbGetAll(), timeout]);
    for (const it of items) {
      if ((it?.type !== 'upsert' && it?.type !== 'update') || it.table !== table || it.status === 'dismissed') continue;
      const k = table === 'order_queue' ? it.payload?.ref : it.payload?.id;
      if (k != null) out.add(String(k));
    }
  } catch (e) { console.warn('[OfflineQueue] bufferedUpsertKeys:', e?.message || e); return null; }
  finally { clearTimeout(timer); }
  return out;
}

// Fix round 2: what a replayed update or delete needs to judge 0 rows (the device link check,
// which starts after the write answered, and the link epoch).
const zeroRowDeps = (supabase) => ({ client: supabase, confirmLink: confirmLinkAfterZeroRows, linkEpoch: getLinkEpoch });

/**
 * Fix round 2: keys (ref for order_queue, id for bar_tabs) with a DELETE this till still has to
 * send: waiting, retrying, or parked while the till was not linked. The reconciler never adopts
 * such a row back from the server (it would put an order or tab this till finished back on
 * screen, open, until the delete lands: the "charged again" risk). A delete that failed for good,
 * went stale or was dismissed does not count. Returns an empty set when the store cannot be read
 * (adoption then works as it always did).
 */
export async function bufferedDeleteKeys(table) {
  const out = new Set();
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('IndexedDB read timed out')), 5000); });
  try {
    const items = await Promise.race([dbGetAll(), timeout]);
    for (const it of items) {
      if (it?.type !== 'delete' || it.table !== table) continue;
      if (it.status !== 'pending' && it.status !== 'retry_pending' && it.status !== PARKED_LINK) continue;
      if (it.permanentFailure) continue;
      const k = table === 'order_queue' ? it.match?.ref : it.match?.id;
      if (k != null) out.add(String(k));
    }
  } catch (e) { console.warn('[OfflineQueue] bufferedDeleteKeys:', e?.message || e); }
  finally { clearTimeout(timer); }
  return out;
}

// Replay ONE buffered write with the original per-item error attribution (attempts →
// retry_pending → permanent after MAX_AUTO_RETRIES). Used directly for deletes and as the
// per-item fallback when a batched statement errors.
// Fix round 2: resolves what happened, so a later write of the same row waits when this one did
// not land: 'done' (sent, or nothing left to change while linked), 'parked' (kept until the
// device is linked again), 'failed' (refused or not sent: retried later, or failed for good).
async function replayItem(supabase, item) {
  try {
    if (item.type === 'upsert') {
      let payload = item.payload;
      let { error } = await supabase.from(item.table).upsert(payload, { onConflict: item.onConflict || 'id' });
      // v5.9.11: a buffered SALE (MPOS close recovery) must not be refused forever because
      // the database lacks a newer optional column (tenders before its migration). Drop the
      // column PostgREST names and send the rest, as every closed_checks writer now does.
      for (let n = 0; error && item.table === 'closed_checks' && n < 4; n++) {
        const col = missingColumnOf(error);
        if (!col || !(col in payload) || col === 'id' || col === 'location_id') break;
        payload = { ...payload }; delete payload[col];
        ({ error } = await supabase.from(item.table).upsert(payload, { onConflict: item.onConflict || 'id' }));
      }
      if (error) throw error;
    } else if (item.type === 'insert') {
      const { error } = await supabase.from(item.table).insert(item.payload);
      if (error) throw error;
    } else if (item.type === 'update' || item.type === 'delete') {
      // v5.8.86: an update is a change to a row the server already confirmed. An update of a
      // row the server has since removed touches nothing, so it can never re-create it; a bar
      // tab update carries notMatch status closed, so it never re-opens a closed tab.
      // Fix round 2 (the zero row blocker): row level security hides a row from a device that
      // lost its link, and the update or delete then changes 0 rows WITHOUT an error. So the
      // rows changed are counted (lib/rowWriteFence.js): none changed while the device is
      // linked means the row is gone (done, as before); none changed while it is NOT linked
      // keeps the write here, parked, until it is linked again (never counted as sent).
      const r = await replayMustChangeItem(item, zeroRowDeps(supabase));
      if (r.outcome === 'error') throw r.error;
      if (r.outcome === 'park') {
        const parked = parkedAgain(item);
        await dbPut(parked);
        console.warn(`[OfflineQueue] ${item.type} ${item.table} changed 0 rows while this device is not linked: kept until it is linked again`);
        if (r.epoch !== undefined && getLinkEpoch() !== r.epoch) {
          // A link answer landed while it was being stored: the relink release may have run
          // without it, so it goes back to pending now.
          await dbPut(releaseParkedItem(parked));
          scheduleFlush();
        } else {
          checkDeviceLink();   // the re-link with the device secret; its relinked event releases the write
        }
        return 'parked';
      }
      if (r.outcome === 'retry_later') {
        const e = new Error(ZERO_ROWS_UNKNOWN);
        e.code = '42501';
        throw e;   // a refused attempt: retried with the next replay, released on relink
      }
    } else {
      // Unknown/corrupt type: surface it in the failure queue rather than silently dbDelete-ing it
      // (which would lose the buffered write with no trace). The catch below records the attempt.
      throw new Error(`OfflineQueue: unknown item type "${item.type}"`);
    }
    await dbDelete(item.id);
    return 'done';
  } catch (e) {
    // Database fence stage 1 (contract A7): a refused write may mean this till lost its link.
    // Tell the app (lib/deviceLink.js checks the link and shows the banner); the write itself
    // stays parked here and is released on rpos-device-relinked (below).
    if (isPermissionError(e)) {
      try { window.dispatchEvent(new CustomEvent('rpos-write-refused', { detail: { code: e?.code || null, message: e?.message || '' } })); } catch { /* no window */ }
    }
    const attempts = (item.attempts || 0) + 1;
    const patch = { ...item, attempts, lastError: e.message, lastFailedAt: Date.now(), firstFailedAt: item.firstFailedAt || Date.now() };
    if (attempts >= MAX_AUTO_RETRIES) {
      patch.permanentFailure = true;
      patch.status = 'failed_permanent';
      console.warn(`[OfflineQueue] Item ${item.id} (${item.kind || item.table}) permanently failed after ${attempts} attempts:`, e.message);
      window.dispatchEvent(new CustomEvent('rpos-queue-permanent-failure', { detail: patch }));
    } else {
      patch.status = 'retry_pending';
      console.warn(`[OfflineQueue] Item ${item.id} failed (attempt ${attempts}/${MAX_AUTO_RETRIES}):`, e.message);
    }
    await dbPut(patch);
    return 'failed';
  }
}

// Fix round 2: a replay asked for while one is running (parked writes just released on relink)
// runs once more when it ends, instead of waiting for the next queued write or reconnect.
let _replayAgain = false;

export async function replayQueue(supabase) {
  if (_replaying) { _replayAgain = true; return; }
  _replaying = true;
  _replayAgain = false;

  try {
    // The guard re-checks the server first. If that could not complete (offline again, a hung
    // read, the reconciler not ready) the order and bar tab STATE writes stay queued for the
    // next replay, in order; everything else (sales, tickets) replays as before.
    let reconciled = true;
    if (_guard?.before) {
      try { reconciled = (await _guard.before()) !== false; }
      catch (e) { reconciled = false; console.warn('[OfflineQueue] replay guard before() failed:', e?.message || e); }
    }
    const isStateWrite = (it) => it.table === 'order_queue' || it.table === 'bar_tabs';
    const items = await dbGetAll();
    // Only replay items that aren't permanently failed or dismissed.
    // Fix round 2: nor a write parked while this device was not linked ('parked_link': it waits
    // for rpos-device-relinked), nor a later write of the same row (it waits behind the parked
    // one, so the row ends as its last write says).
    const heldBehind = heldBehindParked(items);
    const candidates = items.filter(it => !it.permanentFailure && it.status !== 'dismissed'
      && it.status !== PARKED_LINK && !heldBehind.has(it.id));

    // STALENESS GUARD: a device dormant for a long time must NOT replay months-old STATE writes —
    // upserting them resurrects completed/deleted orders, re-seats cleared tables and reopens closed
    // tabs (the reported boot-corruption). Quarantine stale state writes instead of replaying.
    // EXCEPTION: sales records (closed_checks) are append-only + idempotent on id, so they are
    // ALWAYS replayed — we must never lose a sale taken offline, however old. Quarantined rows are
    // retained in IndexedDB (returned by getFailedItems) — not auto-replayed, not deleted.
    const now = Date.now();
    // Fix round 2: plus a delete kept while this device was not linked that can only remove its own
    // row (a bar tab by id, a table by its occupation): it goes whenever the device is linked again
    // (lib/rowWriteFence.js isLateSafeParkedDelete).
    const ALWAYS_REPLAY = (it) => it.table === 'closed_checks' || it.kind === 'closed_check' || isLateSafeParkedDelete(it);
    // v5.5.639: an active_sessions DELETE is a STATE mutation, not append-only. A stale one replayed
    // on reconnect/boot blind-deletes whatever now occupies (location,table) — the queued match
    // carries no session identity, so it wipes a table that was RE-SEATED since (root cause of the
    // recurring "tables lost on the waitlist"). The live delete fires instantly while online, so a
    // queued session-delete still pending after a short window failed to send and is no longer safe to
    // apply blind. Quarantine it fast; a ts-less one counts as stale. The self-heal reconciler
    // re-publishes the rare table that genuinely still needed clearing.
    const SESSION_DELETE_MAX_AGE_MS = 2 * 60 * 1000;
    // Fix round 2: a session delete that carries its OCCUPATION (session->>seatedAt, write once
    // per occupation) can only ever remove that occupation, never a table seated again since, so
    // it replays like any other state write (12 h limit below). That is what lets a table closed
    // on a till that lost its link leave the floor once the till is paired again.
    const isSessionDelete = (it) => it.type === 'delete' && it.table === 'active_sessions' && !(it.match && it.match[OCCUPATION_KEY]);
    const live = [];
    for (const it of candidates) {
      if (_guard && !reconciled && isStateWrite(it)) continue;   // left queued, order preserved
      if (_guard?.keep && (it.type === 'upsert' || it.type === 'update') && isStateWrite(it)) {
        let keep = true;
        try { keep = _guard.keep(it) !== false; } catch { keep = true; }
        if (!keep) {
          // This till deleted the row, or the server had already removed it: replaying the write
          // would bring it back on every till. Drop the buffered write; nothing is lost.
          try { await dbDelete(it.id); } catch {}
          console.warn(`[OfflineQueue] dropped buffered ${it.table} upsert for a row this till finished with:`, it.payload?.ref || it.payload?.id);
          continue;
        }
      }
      if (isSessionDelete(it)) {
        const dage = it.ts ? now - it.ts : Infinity;   // ts-less session-delete → treat as stale
        if (dage > SESSION_DELETE_MAX_AGE_MS) {
          const patch = { ...it, permanentFailure: true, status: 'failed_stale',
            lastError: `Not replayed: stale active_sessions delete (~${Math.round(dage / 1000)}s old) — would risk wiping a re-seated table`,
            lastFailedAt: now, firstFailedAt: it.firstFailedAt || now };
          await dbPut(patch);
          console.warn(`[OfflineQueue] Quarantined stale active_sessions delete for table ${it.match?.table_id} (~${Math.round(dage / 1000)}s old)`);
          window.dispatchEvent(new CustomEvent('rpos-queue-permanent-failure', { detail: patch }));
          continue;
        }
        live.push(it);
        continue;
      }
      const age = it.ts ? now - it.ts : 0;   // missing ts (legacy item) → treat as fresh, never quarantine
      if (age > REPLAY_MAX_AGE_MS && !ALWAYS_REPLAY(it)) {
        const hrs = Math.round(age / 3_600_000);
        const patch = { ...it, permanentFailure: true, status: 'failed_stale',
          lastError: `Not replayed: buffered ~${hrs}h ago (older than the ${Math.round(REPLAY_MAX_AGE_MS / 3_600_000)}h limit) — retained for review`,
          lastFailedAt: now, firstFailedAt: it.firstFailedAt || now };
        await dbPut(patch);
        console.warn(`[OfflineQueue] Quarantined stale ${it.kind || it.table} item ${it.id} (~${hrs}h old) — not replayed (would resurrect stale state)`);
        window.dispatchEvent(new CustomEvent('rpos-queue-permanent-failure', { detail: patch }));
        continue;
      }
      live.push(it);
    }
    if (!live.length) { _replaying = false; return; }

    console.log(`[OfflineQueue] Replaying ${live.length} queued write(s)`);

    // Scale: a reconnect after a busy/offline period can buffer hundreds of writes. The old loop did
    // one serial round-trip per row (45-120s, blocking everything behind one global lock). We now
    // batch them — but ORDER MUST BE PRESERVED: a queued upsert(T5) then delete(T5) (open-then-close
    // a table offline) must end deleted, and a delete(T5) then upsert(T5) (close-then-reseat) must
    // end seated. So we batch maximal CONSECUTIVE runs of the same (type, table, conflict-key) and
    // run the runs SEQUENTIALLY in queue order. dbGetAll() returns in autoIncrement (chronological)
    // order, so array order == queue order. This collapses the dominant per-row cost into per-run
    // batches while guaranteeing the same end state as the old serial replay.
    // Two-tier safety: a batch error falls back to per-item replay (replayItem), preserving the exact
    // attempt / permanent-failure attribution.
    const opKind = (it) =>
      it.type === 'upsert' ? `u|${it.table}|${it.onConflict || 'id'}`
      : it.type === 'insert' ? `i|${it.table}`
      : it.type === 'update' ? `x|${it.table}`
      : `d|${it.table}`;

    const runs = [];
    for (const item of live) {
      const k = opKind(item);
      const last = runs[runs.length - 1];
      if (last && last.k === k) last.items.push(item);
      else runs.push({ k, type: item.type, table: item.table, onConflict: item.onConflict || 'id', items: [item] });
    }

    // Fix round 2: once a write of a row does not land in this pass (kept for the link, kept to
    // try again, refused), every later write of that row waits for the next pass, in order, so
    // the row ends as its LAST write says (lib/rowWriteFence.js replayBlocksRow).
    const blockedRows = new Set();
    const isBlocked = (it) => { const k = rowKeyOf(it); return !!k && blockedRows.has(k); };
    const noteOutcome = (it, outcome) => { const k = rowKeyOf(it); if (k && replayBlocksRow(outcome)) blockedRows.add(k); };

    for (const run of runs) {
      const items = run.items.filter(it => !isBlocked(it));
      if (!items.length) continue;
      if (run.type === 'update') {
        // Updates replay one by one in queue order (two updates of one row must land in order).
        for (const it of items) {
          if (isBlocked(it)) continue;
          noteOutcome(it, await replayItem(supabase, it));
        }
        continue;
      }
      if (run.type === 'delete') {
        // Deletes within a run are mutually independent (different keys) or idempotent (same key
        // twice) — safe to fire concurrently. Varied match shapes make a single batched delete unsafe.
        const outs = await Promise.all(items.map(it => replayItem(supabase, it).catch(() => 'failed')));
        items.forEach((it, i) => noteOutcome(it, outs[i]));
        continue;
      }
      run.items = items;

      if (run.items.length === 1) { noteOutcome(run.items[0], await replayItem(supabase, run.items[0])); continue; }

      if (run.type === 'upsert') {
        // Collapse to the freshest write per conflict-key within this consecutive run (a row changed
        // N times back-to-back = N queued rows; only the last matters, and a duplicate key in one
        // upsert statement would otherwise error). Drop the superseded queue entries.
        const byKey = new Map();
        for (const it of run.items) {
          // Only collapse two writes when EVERY conflict-key component is present and non-null. A
          // naive join would map {L1, table_id:null} and {L1} both to "L1|" and merge DISTINCT rows,
          // silently dbDelete-ing one from the durable queue (it would never reach the server) — data
          // loss. Any row with a missing/null component gets a unique key (its queue id) so it is
          // always sent on its own; well-formed same-key rows still collapse to the freshest.
          const parts = run.onConflict.split(',').map(c => it.payload?.[c.trim()]);
          const kv = parts.some(v => v === undefined || v === null) ? `\u0000id:${it.id}` : parts.join("\u0000");
          const prev = byKey.get(kv);
          if (prev) { try { await dbDelete(prev.id); } catch { /* superseded duplicate */ } }
          byKey.set(kv, it);
        }
        const fresh = [...byKey.values()];
        if (fresh.length === 1) { noteOutcome(fresh[0], await replayItem(supabase, fresh[0])); continue; }
        try {
          const { error } = await supabase.from(run.table).upsert(fresh.map(i => i.payload), { onConflict: run.onConflict });
          if (error) throw error;
          await Promise.allSettled(fresh.map(i => dbDelete(i.id)));
        } catch (e) {
          console.warn(`[OfflineQueue] batch upsert ${run.table} x${fresh.length} failed — per-item fallback:`, e?.message || e);
          const outs = await Promise.all(fresh.map(i => replayItem(supabase, i).catch(() => 'failed')));
          fresh.forEach((it, i) => noteOutcome(it, outs[i]));
        }
      } else { // insert
        try {
          const { error } = await supabase.from(run.table).insert(run.items.map(i => i.payload));
          if (error) throw error;
          await Promise.allSettled(run.items.map(i => dbDelete(i.id)));
        } catch (e) {
          console.warn(`[OfflineQueue] batch insert ${run.table} x${run.items.length} failed — per-item fallback:`, e?.message || e);
          const outs = await Promise.all(run.items.map(i => replayItem(supabase, i).catch(() => 'failed')));
          run.items.forEach((it, i) => noteOutcome(it, outs[i]));
        }
      }
    }
  } finally {
    _replaying = false;
    if (_replayAgain) {
      _replayAgain = false;
      setTimeout(() => { replayQueue(supabase); }, 0);
    }
  }
}

/**
 * Fix round 2: keep an update or delete that changed 0 rows while this device was not linked
 * (lib/rowWriteFence.js parkedWriteItem). Stored as is: 'parked_link' waits for the link,
 * 'retry_pending' goes again with the next replay. If a link answer landed while it was being
 * stored, the relink event may already have released the parked writes without it, so it is
 * released now.
 */
export async function parkWrite(item) {
  const id = await dbPut(item);
  if (item && item.status === PARKED_LINK && getLinkEpoch() !== item.linkEpoch) {
    try { await dbPut(releaseParkedItem({ ...item, id })); } catch { /* stays parked until the next relink */ }
    if (_isOnline) scheduleFlush();
  } else if (item && item.status === 'retry_pending' && _isOnline) {
    // "Could not check the link": try again soon even on a quiet till.
    setTimeout(() => { if (_supabaseRef) replayQueue(_supabaseRef); }, 15_000);
  }
  return id;
}

/**
 * Row keys (lib/rowWriteFence.js rowKeyOf) with a write parked for the link, or a 0 row write still
 * waiting to go again (lib/rowWriteFence.js waitingRowKeys). A later write of the same row is
 * queued behind it instead of being sent. null when the queue cannot be read in time (the caller
 * then writes as it always did).
 */
export async function parkedRowKeys() {
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('IndexedDB read timed out')), 3000); });
  try {
    const items = await Promise.race([dbGetAll(), timeout]);
    return waitingRowKeys(items);
  } catch (e) {
    console.warn('[OfflineQueue] parkedRowKeys:', e?.message || e);
    return null;
  } finally { clearTimeout(timer); }
}

// ── Failure management ────────────────────────────────────────────────────────
export async function getFailedItems() {
  const items = await dbGetAll();
  return items.filter(it => it.permanentFailure || (it.status === 'retry_pending' && it.attempts >= MAX_AUTO_RETRIES));
}

export async function retryItem(id) {
  const item = await dbGet(id);
  if (!item) return false;
  await dbPut({
    ...item,
    ts: Date.now(),   // refresh age so a user-initiated retry isn't immediately re-quarantined by the staleness guard
    status: 'pending',
    permanentFailure: false,
    attempts: 0,
    lastError: null,
    lastFailedAt: null,
  });
  if (_isOnline && _supabaseRef) scheduleFlush();
  return true;
}

export async function dismissItem(id) {
  return dbDelete(id);
}

// ── Online/offline listeners ──────────────────────────────────────────────────
let _supabaseRef = null;

function scheduleFlush() {
  clearTimeout(_flushTimer);
  _flushTimer = setTimeout(() => {
    if (_supabaseRef) replayQueue(_supabaseRef);
  }, 1000);
}

/**
 * Database fence stage 1 (contract A8): writes the server refused while this till had lost its
 * link (42501, "row-level security", "permission denied") were parked after 5 tries. When the
 * till is linked again they are released (attempts and status reset, buffered time kept) and
 * replayed through every existing guard: before(), keep(), the staleness quarantine and the
 * reconciler rules all still apply. Kitchen tickets and print jobs written during a lapse
 * arrive. A stale quarantine and a dismissed item are never released here.
 */
export async function releaseParkedPermissionWrites() {
  let released = 0;
  try {
    const items = await dbGetAll();
    for (const it of items) {
      if (!isParkedPermissionItem(it)) continue;
      await dbPut(releaseParkedItem(it));
      released += 1;
    }
  } catch (e) { console.warn('[OfflineQueue] could not release parked writes:', e?.message || e); }
  if (released) console.log(`[OfflineQueue] till linked again: ${released} parked write(s) released for replay`);
  return released;
}

// Contract A12 (fix round): the boot link after a pairing answers 'linked', so parked writes are
// released on the FIRST 'rpos-device-linked' of the page as well (shouldReleaseParkedOnLink).
let _releasedOnLinkThisPage = false;

async function releaseOnLink(supabase, { event, outcome }) {
  if (!shouldReleaseParkedOnLink({ event, outcome, releasedOnLinkThisPage: _releasedOnLinkThisPage })) return;
  if (event === 'rpos-device-linked' || outcome === 'linked') _releasedOnLinkThisPage = true;
  await releaseParkedPermissionWrites();
  if (_isOnline) replayQueue(supabase);
}

export function initOfflineQueue(supabase) {
  _supabaseRef = supabase;

  window.addEventListener('rpos-device-relinked', async () => {
    await releaseOnLink(supabase, { event: 'rpos-device-relinked' });
  });
  window.addEventListener('rpos-device-linked', async () => {
    await releaseOnLink(supabase, { event: 'rpos-device-linked' });
  });
  // The boot link may have answered before this queue started (it runs from useSupabaseInit,
  // this from SyncBridge): act on that answer instead of waiting for an event already gone.
  const bootLink = getLastDeviceLinkOutcome();
  if (bootLink === 'linked' || bootLink === 'relinked') {
    setTimeout(() => { releaseOnLink(supabase, { outcome: bootLink }).catch(() => {}); }, 0);
  }

  window.addEventListener('online', () => {
    _isOnline = true;
    console.log('[OfflineQueue] Back online — replaying queued writes');
    replayQueue(supabase);
    // Notify UI
    window.dispatchEvent(new CustomEvent('rpos-online'));
  });

  window.addEventListener('offline', () => {
    _isOnline = false;
    console.log('[OfflineQueue] Gone offline — writes will be queued');
    window.dispatchEvent(new CustomEvent('rpos-offline'));
  });

  // Replay any pending items from previous session on startup
  if (_isOnline) {
    setTimeout(() => replayQueue(supabase), 3000);
  }
}

export function isOnline() { return _isOnline; }
export function getQueueSize() { return dbGetAll().then(items => items.length); }
