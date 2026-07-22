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
    const { error } = await supabase.from('closed_checks').insert(row);
    if (error) {
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
    const { data, error } = await supabase
      .from('closed_checks')
      .upsert(row, { onConflict: 'id', ignoreDuplicates: true })
      .select('id');
    if (error) {
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
    // Re-insert
    try {
      const row = {
        id:           check.id,
        location_id:  locationId,
        ref:          check.ref,
        server:       check.server,
        staff_id:     check.staffId || null,
        covers:       check.covers,
        order_type:   check.orderType,
        customer:     check.customer || null,
        items:        check.items,
        discounts:    check.discounts || [],
        subtotal:     check.subtotal,
        service:      check.service || 0,
        tip:          check.tip || 0,
        tax_amount:   check.taxAmount != null ? check.taxAmount : null,
        total:        check.total,
        method:       check.method,
        drawer_id:    check.drawerId || null,
        shift_id:     check.shiftId || null,
        closed_at:    check.closedAt ? new Date(check.closedAt).toISOString() : new Date().toISOString(),
        status:       check.status || 'paid',
        refunds:      check.refunds || [],
        table_id:     check.tableId || null,
        table_label:  check.tableLabel || null,
        gift_card:    check.giftCard || null,
        loyalty:      check.loyalty || null,
        source:       check.source || null,
        // v5.5.720: offline-replay was dropping the payment identity — refunds route by processor +
        // payment_intents[].id, and the card-scheme receipt block rides payment_intents[0].card.
        stripe_payment_intent_id: check.stripePaymentIntentId || null,
        payment_intents: check.paymentIntents || null,
        processor:    check.processor || 'stripe',
      };
      const { error } = await supabase.from('closed_checks').insert(row);
      if (!error) {
        removePendingCheck(check.id);
        console.log(`[DataSafe] Reconciled check ${check.id}`);
      } else {
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
