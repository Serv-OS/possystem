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

// Replay ONE buffered write with the original per-item error attribution (attempts →
// retry_pending → permanent after MAX_AUTO_RETRIES). Used directly for deletes and as the
// per-item fallback when a batched statement errors.
async function replayItem(supabase, item) {
  try {
    if (item.type === 'upsert') {
      const { error } = await supabase.from(item.table).upsert(item.payload, { onConflict: item.onConflict || 'id' });
      if (error) throw error;
    } else if (item.type === 'insert') {
      const { error } = await supabase.from(item.table).insert(item.payload);
      if (error) throw error;
    } else if (item.type === 'delete') {
      let q = supabase.from(item.table).delete();
      for (const [k, v] of Object.entries(item.match || {})) q = q.eq(k, v);
      const { error } = await q;
      if (error) throw error;
    } else {
      // Unknown/corrupt type: surface it in the failure queue rather than silently dbDelete-ing it
      // (which would lose the buffered write with no trace). The catch below records the attempt.
      throw new Error(`OfflineQueue: unknown item type "${item.type}"`);
    }
    await dbDelete(item.id);
  } catch (e) {
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
  }
}

export async function replayQueue(supabase) {
  if (_replaying) return;
  _replaying = true;

  try {
    const items = await dbGetAll();
    // Only replay items that aren't permanently failed or dismissed
    const candidates = items.filter(it => !it.permanentFailure && it.status !== 'dismissed');

    // STALENESS GUARD: a device dormant for a long time must NOT replay months-old STATE writes —
    // upserting them resurrects completed/deleted orders, re-seats cleared tables and reopens closed
    // tabs (the reported boot-corruption). Quarantine stale state writes instead of replaying.
    // EXCEPTION: sales records (closed_checks) are append-only + idempotent on id, so they are
    // ALWAYS replayed — we must never lose a sale taken offline, however old. Quarantined rows are
    // retained in IndexedDB (returned by getFailedItems) — not auto-replayed, not deleted.
    const now = Date.now();
    const ALWAYS_REPLAY = (it) => it.table === 'closed_checks' || it.kind === 'closed_check';
    const live = [];
    for (const it of candidates) {
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
      : `d|${it.table}`;

    const runs = [];
    for (const item of live) {
      const k = opKind(item);
      const last = runs[runs.length - 1];
      if (last && last.k === k) last.items.push(item);
      else runs.push({ k, type: item.type, table: item.table, onConflict: item.onConflict || 'id', items: [item] });
    }

    for (const run of runs) {
      if (run.type === 'delete') {
        // Deletes within a run are mutually independent (different keys) or idempotent (same key
        // twice) — safe to fire concurrently. Varied match shapes make a single batched delete unsafe.
        await Promise.allSettled(run.items.map(it => replayItem(supabase, it)));
        continue;
      }

      if (run.items.length === 1) { await replayItem(supabase, run.items[0]); continue; }

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
        if (fresh.length === 1) { await replayItem(supabase, fresh[0]); continue; }
        try {
          const { error } = await supabase.from(run.table).upsert(fresh.map(i => i.payload), { onConflict: run.onConflict });
          if (error) throw error;
          await Promise.allSettled(fresh.map(i => dbDelete(i.id)));
        } catch (e) {
          console.warn(`[OfflineQueue] batch upsert ${run.table} x${fresh.length} failed — per-item fallback:`, e?.message || e);
          await Promise.allSettled(fresh.map(i => replayItem(supabase, i)));
        }
      } else { // insert
        try {
          const { error } = await supabase.from(run.table).insert(run.items.map(i => i.payload));
          if (error) throw error;
          await Promise.allSettled(run.items.map(i => dbDelete(i.id)));
        } catch (e) {
          console.warn(`[OfflineQueue] batch insert ${run.table} x${run.items.length} failed — per-item fallback:`, e?.message || e);
          await Promise.allSettled(run.items.map(i => replayItem(supabase, i)));
        }
      }
    }
  } finally {
    _replaying = false;
  }
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

export function initOfflineQueue(supabase) {
  _supabaseRef = supabase;

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
