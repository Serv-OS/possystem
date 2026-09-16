/**
 * queueReconcile.js: the one rule that keeps every till's open orders and bar tabs the same
 * (v5.8.86). Pure, no imports, so node:test can load it (queueReconcile.test.js).
 *
 * THE PROBLEM IT FIXES (Peter, 16 Sep 2026: Sunmi shows 35 open orders, iPad shows 18)
 *   Each till keeps its own saved copy of the order list (localStorage) and only applied
 *   changes as they arrived. A till that missed a delete (asleep, offline, a dropped realtime
 *   event) kept that order for ever, and after a restart it uploaded its whole saved list back
 *   to the server, so orders another till had cleared came back. Tables had a reconciler
 *   (SessionReconciler); orders and bar tabs had none.
 *
 * THE RULE
 *   Every row carries `_sync` once the server has confirmed it: { hash, at } where hash is the
 *   row as sent to the server and at is the server's updated_at. A row without `_sync`, or whose
 *   current hash differs from `_sync.hash`, has a change the server has not confirmed (pending).
 *
 *   for each row on this till and on the server:
 *     pending          keep ours (the flush is about to send it)
 *     not pending      take the server's copy when it changed since we last synced
 *   for each row on this till only:
 *     training row     leave it (never published, never dropped)
 *     done row         leave it (collected or closed; the flush deletes it server side)
 *     pending          keep it AND publish it: an order taken offline is never lost
 *     synced, missing  the server removed it (another till collected or cleared it): drop it
 *   for each row on the server only:
 *     adopt it, unless this till just removed it and the delete is still being sent
 *
 *   No drops when the server read was capped (remote.length >= cap) or failed: a row absent
 *   from a partial read is not proof of anything.
 *
 *   Two refinements after review (16 Sep 2026):
 *   - A row that carries a stamp but is missing from an uncapped read was removed by the server
 *     even if this till edited it since (the edit is moot: the order was finished elsewhere). Only
 *     a row with NO stamp (never confirmed) is published.
 *   - A pending row whose content the server already holds exactly (canonical hash equal) takes
 *     the server's stamp instead of staying pending for ever (a lost confirmation heals itself).
 *
 *   Hashes are canonical (object keys sorted at every level, see canonicalJson) so the row built
 *   here and the same row echoed back through jsonb hash the same.
 */

/** JSON with object keys sorted at every level, so key order never changes a hash. */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

/**
 * A short digest (16 hex chars, two independent 32 bit hashes) of a string. The sync stamp
 * and the echo latch hold this instead of the whole canonical row, so a persisted order is
 * not stored twice.
 */
export function digest(str) {
  const s = String(str ?? '');
  let h1 = 0x811c9dc5, h2 = 5381;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = (Math.imul(h2, 33) ^ c) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    if (typeof v.toJSON === 'function') return sortKeys(v.toJSON());
    const out = {};
    for (const k of Object.keys(v).sort()) {
      const x = v[k];
      if (x === undefined || typeof x === 'function') continue;
      out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

/** A row's sync stamp after the server confirmed it. hash = the row as sent, at = server updated_at (ms). */
export function syncStamp(hash, at) {
  return { hash: String(hash ?? ''), at: Number(at) || 0 };
}

/** True when the row has a change the server has not confirmed. */
export function isPending(row, hashOf) {
  if (!row) return false;
  if (!row._sync || typeof row._sync.hash !== 'string') return true;
  return row._sync.hash !== hashOf(row);
}

/**
 * Reconcile one list.
 *   local      rows on this till
 *   remote     rows the server has (already mapped to the local shape, with `_sync` set)
 *   keyOf      row -> key (ref for orders, id for tabs)
 *   hashOf     row -> the string the flush would send (the sync hash)
 *   isDone     row -> true for a finished row (collected order, closed tab)
 *   isTraining row -> true for a training row (never published)
 *   skipAdopt  keys this till removed and is still deleting server side
 *   capped     true when the remote read hit its row cap (then nothing is dropped)
 *   unconfirmedIsStale  row -> true for an unstamped row that is an old copy rather than an order
 *              in flight (older than a few minutes with no buffered offline write). Such a row is
 *              dropped when the server lacks it and replaced by the server's copy when it has it,
 *              instead of being published over the top.
 *   canDrop    row -> false for a stamped row that must not be dropped by THIS pass because it was
 *              confirmed after the server read began (its absence from that read proves nothing).
 *   keepIfPending  row -> true when a stamped row with UNSENT local changes that the server no
 *              longer lists must be kept and flagged (_orphan) rather than dropped: a bar tab
 *              given a round on this till while another till closed it carries money that must
 *              not vanish. Orders (a status bump on an order collected elsewhere) are dropped.
 *   hold       row -> true for an unstamped row the server lacks that must be neither published
 *              nor dropped by THIS pass (the evidence that would decide it could not be read).
 * Returns { next, publish, dropped, adopted, updated, healed, orphaned, changed }.
 */
export function reconcileList({ local = [], remote = [], keyOf, hashOf, isDone = () => false, isTraining = () => false, skipAdopt = new Set(), capped = false, unconfirmedIsStale = () => false, canDrop = () => true, keepIfPending = () => false, hold = () => false } = {}) {
  const remoteByKey = new Map();
  for (const r of remote) { const k = keyOf(r); if (k != null) remoteByKey.set(String(k), r); }
  const localKeys = new Set();
  const next = [];
  const publish = [];
  const dropped = [];
  const updated = [];
  const healed = [];
  const orphaned = [];
  let changed = false;

  for (const raw of local) {
    const k = keyOf(raw);
    if (k == null) { next.push(raw); continue; }
    const key = String(k);
    localKeys.add(key);
    const server = remoteByKey.get(key);
    if (isTraining(raw)) { next.push(raw); continue; }
    // A row the server lists again is no longer an orphan.
    let row = raw;
    if (server && raw._orphan) { row = { ...raw }; delete row._orphan; changed = true; }
    const pending = isPending(row, hashOf);

    if (server) {
      const serverAt = Number(server._sync?.at) || 0;
      const serverHash = server._sync?.hash ?? hashOf(server);
      if (pending) {
        // The server already holds exactly what we would send: take its stamp (a lost
        // confirmation heals). An old unstamped copy (saved by an older build, never sent)
        // must not be sent over the server's newer state: take the server's copy. Otherwise
        // ours wins, the flush is about to send it.
        if (server !== row && hashOf(row) === serverHash) {
          next.push({ ...row, _sync: syncStamp(serverHash, serverAt) });
          healed.push(key);
          changed = true;
        } else if (server !== row && !row._sync && unconfirmedIsStale(row)) {
          next.push({ ...row, ...server, _sync: syncStamp(serverHash, serverAt) });
          updated.push(key);
          changed = true;
        } else {
          next.push(row);
        }
        continue;
      }
      // Confirmed on both sides: the server's copy wins when it moved since we last synced.
      const ourAt = Number(row._sync?.at) || 0;
      if (serverHash !== row._sync.hash || serverAt > ourAt) {
        const merged = { ...row, ...server, _sync: syncStamp(serverHash, serverAt) };
        next.push(merged);
        updated.push(key);
        changed = true;
      } else {
        next.push(row);
      }
      continue;
    }

    // On this till only.
    if (isDone(row)) { next.push(row); continue; }
    if (capped) { next.push(row); continue; }   // a capped read proves nothing
    if (!row._sync) {
      if (hold(row)) { next.push(row); continue; }   // undecidable this pass: kept as is
      if (!unconfirmedIsStale(row)) { next.push(row); publish.push(key); continue; }
      dropped.push(key);   // an old copy that was never sent: the server does not have it
      changed = true;
      continue;
    }
    // Stamped (the server had it) and now missing from a full read: the server removed it,
    // whether or not this till edited it since. Unless the stamp arrived after that read
    // began, then the read proves nothing about it and the next pass judges it.
    if (!canDrop(row)) { next.push(row); continue; }
    if (pending && keepIfPending(row)) {
      if (!row._orphan) { next.push({ ...row, _orphan: true }); changed = true; } else next.push(row);
      orphaned.push(key);
      continue;
    }
    dropped.push(key);
    changed = true;
  }

  const adopted = [];
  for (const [key, server] of remoteByKey) {
    if (localKeys.has(key) || skipAdopt.has(key)) continue;
    next.push(server);
    adopted.push(key);
    changed = true;
  }

  return { next, publish, dropped, adopted, updated, healed, orphaned, changed };
}

/**
 * Should a buffered offline write (an order_queue or bar_tabs upsert) still be replayed?
 * Only a POSITIVE record stops it: this till deleted the row, or the reconcile found the server
 * had removed it, AFTER the write was buffered (isFinished(kind, key, bufferedAt)). Absence
 * from the store is not enough: bar tabs are not restored from disk after a restart, and a
 * closed tab or collected order still has to reach the server. A write buffered after the row
 * came back (re-adopted, re-created) is kept.
 */
export function keepBufferedWrite(item, isFinished) {
  if (!item || (item.type !== 'upsert' && item.type !== 'update')) return true;
  if (item.table !== 'order_queue' && item.table !== 'bar_tabs') return true;
  const key = item.table === 'order_queue' ? item.payload?.ref : item.payload?.id;
  if (key == null) return true;
  return !isFinished(item.table === 'order_queue' ? 'queue' : 'tab', String(key), Number(item.ts) || 0);
}

/** The keys of rows the server has confirmed (used to decide what a read may drop). */
export function stampedKeys(rows, keyOf) {
  const out = new Set();
  for (const r of rows || []) { const k = keyOf(r); if (k != null && r?._sync?.hash) out.add(String(k)); }
  return out;
}

/**
 * The keys whose server copy must be fetched in full: new keys, and keys whose server
 * updated_at moved past the local stamp. heads: [{ key, at }] from a light read.
 */
export function changedKeys(local, heads, keyOf) {
  const stampByKey = new Map();
  for (const row of local) { const k = keyOf(row); if (k != null) stampByKey.set(String(k), Number(row._sync?.at) || 0); }
  const out = [];
  for (const h of heads) {
    if (h == null || h.key == null) continue;
    const at = Number(h.at) || 0;
    const have = stampByKey.get(String(h.key));
    if (have === undefined || at > have) out.push(String(h.key));
  }
  return out;
}
