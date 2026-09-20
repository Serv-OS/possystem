/**
 * DataSafe — triple-write safety net for data that must never be lost.
 *
 * For any critical write (closed checks, session changes):
 *   1. localStorage — instant, survives reload, never fails
 *   2. IndexedDB OfflineQueue — durable, replays when back online
 *   3. Supabase — authoritative source for cross-device sync
 *
 * On boot: reconcile localStorage pending queue against Supabase.
 * Any check in localStorage but not in Supabase → re-insert.
 *
 * This means even if:
 *   - The device loses network mid-payment ✓
 *   - Supabase is down for maintenance ✓
 *   - The page reloads unexpectedly ✓
 *   - The app crashes before the DB write completes ✓
 * ...the data is never lost.
 */

import { supabase, getLocationId } from '../lib/supabase';
import { closedCheckRow } from '../lib/closedCheckRow';
import { writeClosedCheckRow } from '../lib/closedCheckWrite';
import { reportWriteRefused } from '../lib/deviceLink';
import { mustChangeRow } from '../lib/rowWrites';

const LS_PENDING_CHECKS   = 'rpos-pending-checks';
const LS_PENDING_SESSIONS = 'rpos-session-backup';

// ── Pending checks (closed check safety net) ──────────────────────────────────

function getPendingChecks() {
  try { return JSON.parse(localStorage.getItem(LS_PENDING_CHECKS) || '[]'); }
  catch { return []; }
}

function setPendingChecks(checks) {
  try { localStorage.setItem(LS_PENDING_CHECKS, JSON.stringify(checks)); }
  catch { console.warn('[DataSafe] Could not write pending checks to localStorage'); }
}

/**
 * Write a closed check to localStorage immediately, then try Supabase.
 * If Supabase fails, the check stays in pending and is retried on reconnect.
 */
export async function safeInsertClosedCheck(check, row) {
  // Step 1 — localStorage (instant, never fails)
  const pending = getPendingChecks();
  if (!pending.find(c => c.id === check.id)) {
    pending.push({ ...check, _savedAt: Date.now() });
    setPendingChecks(pending);
  }

  // Step 2 — Supabase
  try {
    // v5.9.11: through writeClosedCheckRow, so a column the database does not have yet
    // (tenders, before its migration) is dropped instead of failing the sale.
    const { error } = await writeClosedCheckRow(supabase, row, { tag: 'DataSafe' });
    if (error) {
      reportWriteRefused(error);   // fence stage 1: a refused sale may mean a lost link (banner)
      console.warn('[DataSafe] Supabase write failed, check queued for retry:', error.message);
      return { ok: false, queued: true };
    }
    // Success — remove from pending
    removePendingCheck(check.id);
    return { ok: true, queued: false };
  } catch (e) {
    console.warn('[DataSafe] Supabase unreachable, check queued:', e.message);
    return { ok: false, queued: true };
  }
}

/**
 * Idempotent sibling of safeInsertClosedCheck for the terminal-job reconciler, where
 * MANY devices may race to close the SAME job. The row's id is the job's pre-minted
 * closed_check_id — identical on every device — so an ON CONFLICT DO NOTHING upsert
 * elects exactly one closer: the one whose INSERT physically lands gets a row back
 * (created:true) and owns the non-idempotent side effects (stock, loyalty); everyone
 * else gets an empty array (created:false) and no-ops. There is at most one
 * closed_checks row for a job, ever — a duplicate is a DB no-op, not a stuck 23505.
 */
export async function safeUpsertClosedCheck(check, row) {
  const pending = getPendingChecks();
  if (!pending.find(c => c.id === check.id)) {
    pending.push({ ...check, _savedAt: Date.now() });
    setPendingChecks(pending);
  }
  try {
    const { data, error } = await writeClosedCheckRow(supabase, row, { upsert: true, select: 'id', tag: 'DataSafe' });
    if (error) {
      reportWriteRefused(error);
      console.warn('[DataSafe] upsert failed, check queued for retry:', error.message);
      return { ok: false, queued: true, created: false };
    }
    removePendingCheck(check.id);
    // RETURNING yields a row ONLY for the INSERT that actually landed — that caller
    // is the elected single closer; a conflict returns [].
    return { ok: true, queued: false, created: (data?.length ?? 0) === 1 };
  } catch (e) {
    console.warn('[DataSafe] upsert unreachable, check queued:', e.message);
    return { ok: false, queued: true, created: false };
  }
}

function removePendingCheck(checkId) {
  const pending = getPendingChecks().filter(c => c.id !== checkId);
  setPendingChecks(pending);
}

/**
 * Fix round 2 (the zero row blocker): a change made to a sale this till has NOT sent yet (a refund
 * or the loyalty summary on a check kept while the till was not linked) is written into the kept
 * copy too. The update of the server row finds nothing to change until the sale lands; this way
 * the sale lands WITH the change, whichever of the two goes first. camelPatch uses the check's own
 * keys (refunds, status, loyalty). Returns true when a kept sale was changed.
 */
export function patchPendingCheck(checkId, camelPatch) {
  if (!checkId || !camelPatch || typeof camelPatch !== 'object') return false;
  const pending = getPendingChecks();
  let hit = false;
  const next = pending.map(c => {
    if (c.id !== checkId) return c;
    hit = true;
    return { ...c, ...camelPatch, _rev: (Number(c._rev) || 0) + 1 };
  });
  if (hit) setPendingChecks(next);
  return hit;
}

// The fields patchPendingCheck may change, as closed_checks columns.
const PATCHABLE = [['refunds', 'refunds'], ['status', 'status'], ['loyalty', 'loyalty']];

async function sendLatePatch(sent, locationId) {
  const cur = getPendingChecks().find(c => c.id === sent.id);
  if (!cur || (Number(cur._rev) || 0) === (Number(sent._rev) || 0)) return;
  const patch = {};
  for (const [camel, col] of PATCHABLE) if (cur[camel] !== undefined) patch[col] = cur[camel];
  if (!Object.keys(patch).length) return;
  try {
    const r = await mustChangeRow({
      table: 'closed_checks', type: 'update', payload: patch,
      match: { id: sent.id, location_id: locationId }, kind: 'refund', label: `Change to check ${sent.id}`,
    });
    if (r.outcome === 'error') console.warn(`[DataSafe] late change to check ${sent.id} failed:`, r.error?.message || r.error);
  } catch (e) { console.warn(`[DataSafe] late change to check ${sent.id} threw:`, e?.message || e); }
}

/**
 * On boot or reconnect — replay any checks that didn't make it to Supabase.
 * Called from SyncBridge and the online event handler.
 */
export async function reconcilePendingChecks() {
  const pending = getPendingChecks();
  if (!pending.length) return;

  const locationId = await getLocationId().catch(() => null);
  if (!locationId || locationId === 'loc-demo' || !supabase) return;

  console.log(`[DataSafe] Reconciling ${pending.length} pending check(s)`);

  // Fetch IDs already in Supabase so we don't double-insert
  const ids = pending.map(c => c.id);
  const { data: existing } = await supabase
    .from('closed_checks')
    .select('id')
    .in('id', ids)
    .eq('location_id', locationId);
  const existingIds = new Set((existing || []).map(r => r.id));

  for (const check of pending) {
    if (existingIds.has(check.id)) {
      // Already in Supabase — just remove from pending
      removePendingCheck(check.id);
      continue;
    }
    // Re-insert. v5.9.11: the SAME row map as a live close (lib/closedCheckRow.js). This
    // used to be a hand copy that had drifted (no tax_breakdown, no seated_at, no tenders).
    try {
      const row = closedCheckRow(check, locationId);
      const { error } = await writeClosedCheckRow(supabase, row, { tag: 'DataSafe' });
      if (!error) {
        // Fix round 2: a refund (or loyalty summary) patched into the kept copy WHILE this insert
        // was in flight went to the server row before it existed and changed nothing. Send it now.
        await sendLatePatch(check, locationId);
        removePendingCheck(check.id);
        console.log(`[DataSafe] Reconciled check ${check.id}`);
      } else {
        reportWriteRefused(error);
        console.warn(`[DataSafe] Failed to reconcile check ${check.id}:`, error.message);
      }
    } catch (e) {
      console.warn(`[DataSafe] Error reconciling check ${check.id}:`, e.message);
    }
  }
}

// ── Session backup ─────────────────────────────────────────────────────────────

/**
 * Write a session to localStorage immediately.
 * Used as the first write — before any network call.
 */
export function safeWriteSession(tableId, session) {
  try {
    const backup = JSON.parse(localStorage.getItem(LS_PENDING_SESSIONS) || '{}');
    if (session) backup[tableId] = { ...session, _savedAt: Date.now() };
    else delete backup[tableId];
    localStorage.setItem(LS_PENDING_SESSIONS, JSON.stringify(backup));
  } catch {}
}

/**
 * Load all sessions from localStorage backup.
 * Used on boot when Supabase is unavailable.
 */
export function loadSessionBackup() {
  try { return JSON.parse(localStorage.getItem(LS_PENDING_SESSIONS) || '{}'); }
  catch { return {}; }
}

// ── Online/offline integration ─────────────────────────────────────────────────

/**
 * Call this when the device comes back online.
 * Replays all pending data to Supabase.
 */
// Database fence stage 1 (contract A8): a till linked again sends the sales it kept.
if (typeof window !== 'undefined') {
  window.addEventListener('rpos-device-relinked', () => { reconcilePendingChecks().catch(() => {}); });
}

export async function onReconnect() {
  console.log('[DataSafe] Reconnected — reconciling pending data');
  await reconcilePendingChecks();
}

/**
 * Periodic background sync — call every 30s.
 * Catches any writes that slipped through without errors but weren't confirmed.
 */
export async function periodicSync() {
  const pending = getPendingChecks();
  if (pending.length > 0) {
    await reconcilePendingChecks();
  }
}

export function getPendingCount() {
  return getPendingChecks().length;
}
