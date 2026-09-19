/**
 * QueueReconciler: keeps this till's open orders (orderQueue) and bar tabs (tabs) the same as
 * the server's, the way SessionReconciler does for tables (v5.8.86).
 *
 * Every 15 s (jittered), on coming back online and when the app is brought back to the
 * front, it reads the light heads (key, updated_at) of the server's open rows, fetches the
 * full rows only for keys that are new or moved, and applies lib/queueReconcile.js:
 * a row the server removed is dropped here, a row never confirmed by the server is kept and
 * published, the server's copy wins when it changed, nothing is dropped on a capped read.
 *
 * Before this the two lists only ever grew: a till that missed a delete kept the order for
 * ever and re-uploaded it after a restart (Sunmi 35 open orders, iPad 18, 16 Sep 2026).
 *
 * Shape rules (from two rounds of review of the first cut):
 * - The store is read AFTER every network wait and the result is applied in the same
 *   synchronous step, so an order taken during the wait is never overwritten by a stale list.
 * - Only rows already confirmed when the heads read began may be dropped by that read: a row
 *   confirmed during the pass is not in the read, and that proves nothing about it.
 * - One pass at a time, shared: a caller that needs a fresh check (the offline replay) awaits
 *   the pass that is already running, or reuses one that just finished.
 * - The first pass waits for the boot read, so the boot rule runs before anything is published.
 * - An old unstamped row with no buffered offline write is an old copy, not an order in
 *   flight: it is dropped when the server lacks it, never sent over the server's copy.
 */
import { supabase, getLocationId } from '../lib/supabase';
import { useStore } from '../store';
import { isTrainingMode } from '../lib/trainingMode';
import { setReplayGuard, bufferedUpsertKeys } from './OfflineQueue';
import { isDeviceLinkUncertain } from '../lib/deviceLink';
import { trustSharedRead } from '../lib/deviceFence';
import { reconcileList, changedKeys, keepBufferedWrite as keepRule, stampedKeys } from '../lib/queueReconcile';
import {
  queueHash, tabHash, queueFromRow, tabFromRow, QUEUE_ROW_CAP, openQueueQuery, openTabQuery,
  clearedKeys, markQueueDropped, markTabDropped, publishQueueRows, publishTabRows,
  latchQueueRows, latchTabRows, isFinishedAfter, noteAdopted, primeQueueSync, whenQueueBootSettled,
  staleUnconfirmedRule, holdUnknownRule, markQueuesJudged, finishedRefsOnServer, payloadHash,
} from './QueueSync';

const PERIOD_MS = 15_000;
const KEY_CHUNK = 100;           // keys per phase 2 read (they travel on the URL)
const BEFORE_REPLAY_MS = 20_000; // how long the offline replay waits for a fresh pass
const REUSE_PASS_MS = 5_000;     // a pass that just finished counts as fresh for the replay
const EMPTY_STREAK = 3;          // empty reads in a row before "the server has nothing" is believed
const READ_TIMEOUT_MS = 15_000;  // a head read that never settles counts as failed, not as a pass in flight for ever
let _timer = null;
let _running = false;
let _startSeq = 0;
let _started = null;             // resolves when startQueueReconciler has a location (or gave up)
let _locationId = null;
let _pass = null;                // the pass in flight, shared by every caller
let _lastPass = null;            // { at, ok } of the last completed pass
let _emptyQ = 0;                 // consecutive empty reads while holding confirmed rows
let _emptyT = 0;
let _pendingChecks = [];         // closed check tests started by this pass (awaited before it resolves)

const isQueueDone = (o) => o?.status === 'collected';
const isTabDone = (t) => t?.status === 'closed';
const isTraining = (o) => o?.training === true;

/** One pass. Resolves true when both lists were checked against a complete server read. */
function reconcileOnce() {
  if (_pass) return _pass;
  _pass = runPass()
    .then((ok) => { _lastPass = { at: Date.now(), ok }; return ok; })
    .finally(() => { _pass = null; });
  return _pass;
}

async function runPass() {
  if (!supabase || !_locationId) return false;
  if (isTrainingMode()) return false;   // a training till never trades rows with the live server
  await whenQueueBootSettled();
  try {
    // What this read may drop: rows confirmed BEFORE it began. Snapshot first.
    const st = useStore.getState();
    const droppableQ = stampedKeys(st.orderQueue, o => o.ref);
    const droppableT = stampedKeys(st.tabs, t => t.id);
    // Phase 1: light heads, plus the keys with a buffered offline write. A failed read changes nothing.
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('head read timed out')), READ_TIMEOUT_MS); });
    let heads;
    try {
      heads = await Promise.race([Promise.all([
        openQueueQuery(_locationId, 'ref, updated_at').limit(QUEUE_ROW_CAP),
        openTabQuery(_locationId, 'id, updated_at').limit(QUEUE_ROW_CAP),
        bufferedUpsertKeys('order_queue'),
        bufferedUpsertKeys('bar_tabs'),
      ]), timeout]);
    } finally { clearTimeout(timer); }
    const [qHeads, tHeads, bufQ, bufT] = heads;
    let ok = true;
    let partial = !bufQ || !bufT;   // the buffered writes could not be read: nothing is judged finally
    // Database fence stage 1 (contract A9): while this till may have lost its link (the server
    // said so, or a write was just refused), an EMPTY read is unknown, not "the server has
    // nothing": after file 2 row level security hides every row from an unlinked till. That
    // list is skipped this pass (nothing dropped, nothing published, the empty streak untouched).
    const linkUnsure = isDeviceLinkUncertain();
    const qTrusted = !qHeads.error && Array.isArray(qHeads.data) && trustSharedRead({ linkUncertain: linkUnsure, rowCount: qHeads.data.length });
    const tTrusted = !tHeads.error && Array.isArray(tHeads.data) && trustSharedRead({ linkUncertain: linkUnsure, rowCount: tHeads.data.length });
    if (qTrusted) {
      // A read that returns nothing while this till holds confirmed rows is not believed until
      // it repeats: a device whose session was lost reads as empty under the tenant fence.
      _emptyQ = (qHeads.data.length === 0 && droppableQ.size > 0) ? _emptyQ + 1 : 0;
      const inconclusive = _emptyQ > 0 && _emptyQ < EMPTY_STREAK;
      partial = partial || inconclusive || qHeads.data.length >= QUEUE_ROW_CAP;
      ok = (await reconcileQueue(qHeads.data, droppableQ, bufQ, inconclusive)) && ok;
    } else ok = false;
    if (tTrusted) {
      _emptyT = (tHeads.data.length === 0 && droppableT.size > 0) ? _emptyT + 1 : 0;
      const inconclusive = _emptyT > 0 && _emptyT < EMPTY_STREAK;
      partial = partial || inconclusive || tHeads.data.length >= QUEUE_ROW_CAP;
      ok = (await reconcileTabs(tHeads.data, droppableT, bufT, inconclusive)) && ok;
    } else ok = false;
    // The closed check tests started by this pass must land before the offline replay reads
    // the store, or a buffered write for an order paid elsewhere would replay first.
    const checks = _pendingChecks; _pendingChecks = [];
    await Promise.allSettled(checks);
    if (ok && !partial) markQueuesJudged();
    return ok;
  } catch (e) {
    console.warn('[QueueReconciler] skipped:', e?.message || e);
    return false;
  }
}

const headAt = (h) => (h.updated_at ? new Date(h.updated_at).getTime() : 0);

async function reconcileQueue(heads, droppable, buffered, inconclusive) {
  const keyOf = (o) => o.ref;
  const remoteHeads = heads.filter(h => h && h.ref).map(h => ({ key: h.ref, at: headAt(h) }));
  // The list before the wait only decides WHAT to fetch. Phase 2: full rows for what moved.
  const need = changedKeys(useStore.getState().orderQueue || [], remoteHeads, keyOf);
  const fresh = new Map();
  for (let i = 0; i < need.length; i += KEY_CHUNK) {
    const { data, error } = await openQueueQuery(_locationId).in('ref', need.slice(i, i + KEY_CHUNK)).limit(QUEUE_ROW_CAP);
    if (error) return false;
    for (const row of (data || [])) fresh.set(row.ref, queueFromRow(row));
  }
  applyQueueReconcile(fresh, remoteHeads, inconclusive || heads.length >= QUEUE_ROW_CAP, droppable, buffered);
  return true;
}

// Synchronous: reads the store now and writes it in the same step, so nothing can change
// in between (an order sent during the phase 2 wait is in `local` and survives).
function applyQueueReconcile(fresh, remoteHeads, capped, droppable, buffered) {
  const local = useStore.getState().orderQueue || [];
  const localByRef = new Map(local.map(o => [o.ref, o]));
  const remote = [];
  for (const h of remoteHeads) {
    if (fresh.has(h.key)) remote.push(fresh.get(h.key));
    else if (localByRef.has(h.key)) remote.push(localByRef.get(h.key));   // unchanged head: our copy is the server's
    // a head that moved but did not come back in phase 2 was deleted in between: absent
  }
  const r = reconcileList({
    local, remote, keyOf: o => o.ref, hashOf: queueHash, isDone: isQueueDone, isTraining,
    skipAdopt: clearedKeys('queue'), capped,
    unconfirmedIsStale: staleUnconfirmedRule('queue', buffered),
    canDrop: o => droppable.has(String(o.ref)),
    hold: holdUnknownRule('queue', buffered),
  });
  apply('orderQueue', 'queue', r, markQueueDropped, publishQueueRows, latchQueueRows);
}

async function reconcileTabs(heads, droppable, buffered, inconclusive) {
  const keyOf = (t) => t.id;
  const remoteHeads = heads.filter(h => h && h.id).map(h => ({ key: h.id, at: headAt(h) }));
  const need = changedKeys(useStore.getState().tabs || [], remoteHeads, keyOf);
  const fresh = new Map();
  for (let i = 0; i < need.length; i += KEY_CHUNK) {
    const { data, error } = await openTabQuery(_locationId).in('id', need.slice(i, i + KEY_CHUNK)).limit(QUEUE_ROW_CAP);
    if (error) return false;
    for (const row of (data || [])) fresh.set(row.id, tabFromRow(row));
  }
  applyTabReconcile(fresh, remoteHeads, inconclusive || heads.length >= QUEUE_ROW_CAP, droppable, buffered);
  return true;
}

function applyTabReconcile(fresh, remoteHeads, capped, droppable, buffered) {
  const local = useStore.getState().tabs || [];
  const wasOrphan = new Set(local.filter(t => t?._orphan).map(t => String(t.id)));
  const localById = new Map(local.map(t => [t.id, t]));
  const remote = [];
  for (const h of remoteHeads) {
    if (fresh.has(h.key)) remote.push(fresh.get(h.key));
    else if (localById.has(h.key)) remote.push(localById.get(h.key));
  }
  const r = reconcileList({
    local, remote, keyOf: t => t.id, hashOf: tabHash, isDone: isTabDone, isTraining: () => false,
    skipAdopt: clearedKeys('tab'), capped,
    unconfirmedIsStale: staleUnconfirmedRule('tab', buffered),
    canDrop: t => droppable.has(String(t.id)),
    keepIfPending: () => true,   // a tab with unsent rounds is money: kept and flagged, never dropped
    hold: holdUnknownRule('tab', buffered),
  });
  apply('tabs', 'tab', r, markTabDropped, publishTabRows, latchTabRows, wasOrphan);
}

function apply(stateKey, kind, r, markDropped, publishRows, latchRows, wasOrphan = new Set()) {
  if (r.dropped.length) {
    console.warn(`[QueueReconciler] ${stateKey}: ${r.dropped.length} row(s) the server no longer has removed here:`, r.dropped.join(', '));
    r.dropped.forEach(markDropped);
  }
  if (r.adopted.length) {
    console.log(`[QueueReconciler] ${stateKey}: adopted ${r.adopted.length} row(s) from the server`);
    r.adopted.forEach(k => noteAdopted(kind, k));   // it is back: writes buffered from now on replay again
  }
  const newlyOrphaned = (r.orphaned || []).filter(k => !wasOrphan.has(String(k)));
  if (newlyOrphaned.length) {
    // Closed or cleared on another till while this one holds unsent changes (rounds on a bar
    // tab): kept here and flagged _orphan so staff can settle it; never silently discarded.
    console.warn(`[QueueReconciler] ${stateKey}: ${newlyOrphaned.length} row(s) closed elsewhere with unsent changes here, kept and flagged:`, newlyOrphaned.join(', '));
    try { window.dispatchEvent(new CustomEvent('rpos-queue-orphaned', { detail: { kind, keys: newlyOrphaned } })); } catch {}
  }
  // Adopted, updated and healed rows ARE the server's copy: latch them before the store change
  // wakes the flush, or it would upsert them straight back (and re-create one another till
  // just collected). Pending rows are skipped by the latch and published below.
  latchRows(r.next);
  if (r.changed) useStore.setState({ [stateKey]: r.next });
  if (newlyOrphaned.length) {
    try { useStore.getState().showToast?.(`${newlyOrphaned.length} bar tab(s) closed on another till still have unsent changes here. Check before charging.`, 'warning'); } catch {}
  }
  if (r.publish.length) _pendingChecks.push(publishAfterCheck(stateKey, kind, r.publish, publishRows, markDropped));
}

// A row this till never got confirmed may still have landed (its first upsert reached the
// server, the confirmation and the echo were lost) and been collected since. Re-creating it
// would bring back a paid order, so orders are checked against closed checks first.
async function publishAfterCheck(stateKey, kind, keys, publishRows, markDropped) {
  let finished = new Set();
  if (kind === 'queue') {
    const byRef = new Map((useStore.getState().orderQueue || []).map(o => [String(o?.ref), o]));
    // An entry this till paid and deliberately kept on the queue (the keep paid orders setting)
    // has its own closed check: that is not "collected elsewhere", so it is not checked.
    const isPaidHere = (o) => !!(o && (o.paid === true || o.customer?.paid === true));
    const toCheck = keys.filter(k => !isPaidHere(byRef.get(String(k))));
    const f = toCheck.length ? await finishedRefsOnServer(toCheck.map(k => ({ ref: k, createdAt: byRef.get(String(k))?.createdAt }))) : new Set();
    if (f === null) return;   // could not check: try again next pass, nothing is sent blind
    finished = f;
  }
  const toPublish = keys.filter(k => !finished.has(String(k)));
  const done = keys.filter(k => finished.has(String(k)));
  if (done.length) {
    console.warn(`[QueueReconciler] ${stateKey}: ${done.length} row(s) already paid off elsewhere, not re-created:`, done.join(', '));
    const cur = useStore.getState()[stateKey] || [];
    const doneSet = new Set(done.map(String));
    done.forEach(markDropped);
    useStore.setState({ [stateKey]: cur.filter(row => !doneSet.has(String(row?.ref ?? row?.id))) });
  }
  if (toPublish.length) {
    console.warn(`[QueueReconciler] ${stateKey}: publishing ${toPublish.length} row(s) the server never confirmed:`, toPublish.join(', '));
    publishRows(toPublish);
  }
}

function onOnline() { reconcileOnce(); }
function onVisible() { if (document.visibilityState === 'visible') reconcileOnce(); }

/**
 * Replay guard for OfflineQueue. `before` waits for the reconciler to be ready, then for a
 * fresh pass (bounded; a pass that finished a moment ago is reused), and says whether the
 * pass completed. `keep` replays a buffered order_queue or bar_tabs upsert unless this till
 * deleted or dropped that row after the write was buffered.
 */
async function beforeReplay() {
  await _started;
  if (_lastPass && _lastPass.ok && !_pass && Date.now() - _lastPass.at < REUSE_PASS_MS) return true;   // only a successful pass is reused
  let timer;
  const timeout = new Promise(res => { timer = setTimeout(() => res(false), BEFORE_REPLAY_MS); });
  try { return (await Promise.race([reconcileOnce(), timeout])) === true; }
  finally { clearTimeout(timer); }
}
export function keepBufferedWrite(item) {
  // A buffered copy of a payload the server has already confirmed (the live write landed, the
  // durable duplicate is still on disk) is redundant, and replaying it after another till
  // removed the row would re-create it.
  if (item && (item.type === 'upsert' || item.type === 'update') && (item.table === 'order_queue' || item.table === 'bar_tabs')) {
    const st = useStore.getState();
    const cur = item.table === 'order_queue'
      ? (st.orderQueue || []).find(o => o?.ref === item.payload?.ref)
      : (st.tabs || []).find(t => t?.id === item.payload?.id);
    if (cur?._sync?.hash && payloadHash(item.payload) === cur._sync.hash) return false;
  }
  return keepRule(item, (kind, key, ts) => isFinishedAfter(kind, key, ts));
}

export function startQueueReconciler() {
  if (_running) return _started;
  _running = true;
  const seq = ++_startSeq;
  // Registered before any wait so a replay scheduled during boot already waits for us.
  setReplayGuard({ before: beforeReplay, keep: keepBufferedWrite });
  _started = (async () => {
    const loc = await getLocationId().catch(() => null);
    if (seq !== _startSeq || !_running) return;   // stopped (or restarted) while resolving
    if (!loc || !supabase) {
      // No venue here (a signed out Back Office): no reconciler, and no guard either, or
      // every buffered order write would wait for a pass that never comes.
      setReplayGuard(null);
      _running = false;
      return;
    }
    _locationId = loc;
    primeQueueSync(loc);   // location set and latches seeded before the first hash
    _timer = setInterval(reconcileOnce, PERIOD_MS + Math.round((Math.random() - 0.5) * 4000));   // jitter: no fleet lock step
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    reconcileOnce();
  })();
  return _started;
}

export function stopQueueReconciler() {
  _startSeq++;
  setReplayGuard(null);
  clearInterval(_timer);
  _timer = null;
  _running = false;
  _locationId = null;
  try { window.removeEventListener('online', onOnline); document.removeEventListener('visibilitychange', onVisible); } catch {}
}

/** For a manual re-check (Status drawer, tests). */
export function reconcileQueuesNow() { return reconcileOnce(); }
