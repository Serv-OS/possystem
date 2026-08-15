/**
 * SessionReconciler — polls Supabase active_sessions every 10s
 * and reconciles with the local store.
 * 
 * This is the reliable fallback for cross-device sync.
 * Supabase Realtime DELETE events are unreliable — this guarantees
 * that a table closed on any device clears within 10 seconds on all others.
 */

import { supabase, getLocationId } from '../lib/supabase';
import { useStore } from '../store';
import { reassertSession } from './SessionSync';
import { isSessionClosed } from './sessionClosure';

// v5.5.639: a table held occupied locally but missing from the DB poll is re-published only if its
// session is genuinely LIVE — has items, is the active table, or was seated within the business day.
// This stops the self-heal from resurrecting a legitimately-closed or long-stale (asleep-device)
// session. Mirrors the "keep" guards in realtime.js's DELETE handler.
const SELF_HEAL_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12h — never auto-revive a session older than a day

let _timer = null;
let _locationId = null;
let _running = false;
// v5.5.892: per-table cache of the last-fetched DB session, keyed by updated_at — lets the 10s
// poll fetch heavy session jsonb blobs ONLY for rows that actually changed (see reconcile()).
const _dbCache = new Map(); // table_id → { session, updatedAtStr }

export async function startSessionReconciler() {
  if (_running) return;
  _running = true;

  _locationId = await getLocationId().catch(() => null);
  if (!_locationId || !supabase) { _running = false; return; }

  const reconcile = async () => {
    try {
      // v5.5.892: two-phase DELTA poll. Phase 1 fetches ONLY (table_id, updated_at) — tiny.
      // The heavy session jsonb blobs are fetched in phase 2 solely for rows whose updated_at
      // moved since the last poll, then cached. Downstream logic reads the cache, so the ghost
      // sweep + recency arbitration see exactly the data they always did — this device just
      // stops re-downloading every open check on every device every 10 seconds.
      const { data: heads, error } = await supabase
        .from('active_sessions')
        .select('table_id, updated_at')
        .eq('location_id', _locationId);

      if (error || !heads) return;

      const presentIds = new Set();
      const changedIds = [];
      for (const h of heads) {
        if (!h.table_id) continue;
        presentIds.add(h.table_id);
        const c = _dbCache.get(h.table_id);
        if (!c || c.updatedAtStr !== (h.updated_at || '')) changedIds.push(h.table_id);
      }
      for (const id of [..._dbCache.keys()]) { if (!presentIds.has(id)) _dbCache.delete(id); }
      if (changedIds.length) {
        const { data: blobs, error: bErr } = await supabase
          .from('active_sessions')
          .select('table_id, session, updated_at')
          .eq('location_id', _locationId)
          .in('table_id', changedIds);
        if (bErr) return; // next poll retries; the cache still holds the last coherent view
        for (const row of (blobs || [])) {
          _dbCache.set(row.table_id, { session: row.session, updatedAtStr: row.updated_at || '' });
        }
      }

      const store = useStore.getState();
      const tables = store.tables || [];

      // Build map of what Supabase says is open (session + updated_at) — from the cache.
      // A row for an already-cashed-off occupation is a GHOST — another device
      // re-published it after the close before it learned the table was paid. Exclude
      // it from "open" (so it is never re-added to the floor) and delete it, so the
      // shared table + the PAX terminal's open-tables list stop showing it too.
      const supabaseOpen = new Map();
      const ghostRows = [];
      for (const [tid, c] of _dbCache) {
        if (!c.session) continue;
        if (isSessionClosed(tid, c.session)) { ghostRows.push(tid); continue; }
        supabaseOpen.set(tid, {
          session: c.session,
          updatedAt: c.updatedAtStr ? new Date(c.updatedAtStr).getTime() : 0,
        });
      }
      if (ghostRows.length && supabase) {
        ghostRows.forEach(id => _dbCache.delete(id)); // don't re-issue the delete every poll
        console.warn(`[SessionReconciler] deleting ${ghostRows.length} cashed-off ghost row(s):`, ghostRows.join(', '));
        Promise.resolve(supabase.from('active_sessions').delete().eq('location_id', _locationId).in('table_id', ghostRows))
          .catch(e => console.warn('[SessionReconciler] ghost delete threw —', e?.message || e));
      }

      let changed = false;
      const now = Date.now();
      const GRACE_MS = 30_000; // 30s grace period for new sessions before we trust Supabase
      const healIds = []; // v5.5.639: tables to re-publish to the DB (occupied locally, missing remotely)

      const newTables = tables.map(t => {
        const inSupabase = supabaseOpen.has(t.id);
        const inStore = !!t.session;
        const isActive = t.id === store.activeTableId;
        const isNew = t.session?.seatedAt && (now - t.session.seatedAt) < GRACE_MS;

        // v4.5.4 KILL SWITCH: this wipe branch was the source of all "table vanished"
        // bugs over 25-26 Apr 2026. The reconciler assumed Supabase active_sessions is the
        // source of truth — but writes to that table fail/lag often enough that this branch
        // catastrophically wipes in-progress orders every 10 seconds. Disabled until we have
        // a guaranteed-success write path. Sessions are only cleared via explicit clearTable.
        if (false && inStore && !inSupabase && !isActive && !isNew) {
          // Table is open in store but NOT in Supabase — another device closed it
          changed = true;
          return { ...t, session: null, status: 'available' };
        }

        // ── v5.6.73 LEVEL-TRIGGERED CLEAR — the backstop that never existed ──
        // Two comments in this codebase promise "SessionReconciler stays the
        // backstop" for a cashed-off table (closeApprovedTerminalJob and
        // 20260803_terminal_pos_close_session.sql). It never was: the only
        // clearing branch has been `if (false && ...)` since v4.5.4, and the
        // active_sessions realtime DELETE handlers bail on the first line
        // because the delete old-image carries no table_id without REPLICA
        // IDENTITY FULL. So a table paid on the card reader stayed on the floor
        // of every till that did not personally book the check — live 15 Aug:
        // T3 paid £99.57, check in history, session row gone, table still there.
        //
        // This is NOT the v4.5.4 wipe. That one cleared on ABSENCE of a DB row,
        // which fails constantly (lagged writes, offline tills) and is exactly
        // how it destroyed live orders. This clears only on POSITIVE PROOF:
        // isSessionClosed means a closed_check exists for THIS table with THIS
        // occupation's write-once seatedAt. Same key the reconciler already
        // trusts to refuse resurrection two branches down — if it is safe to
        // refuse healing on, it is safe to clear on.
        if (inStore && isSessionClosed(t.id, t.session)) {
          changed = true;
          return { ...t, session: null, status: 'available', childIds: [] };
        }

        // v5.5.639 SELF-HEAL: the inverse of the (rightly) dead wipe branch. The table is occupied
        // on THIS device but its active_sessions row is gone (stale OfflineQueue delete replay,
        // cross-device delete sweep, or any out-of-band removal). Instead of wiping local (data
        // loss), re-publish OUR live session so the shared source of truth reconverges — the
        // waitlist host stand and every other device then see the table as occupied again. This is
        // the durable cross-device repair that makes "tables MUST never be lost" actually hold.
        // Gate on a genuinely-live session so a legitimately-closed/empty/stale one is never revived.
        if (inStore && !inSupabase) {
          const sess = t.session;
          const live = !!sess && (
            (sess.items?.length > 0) || isActive ||
            (sess.seatedAt && (now - sess.seatedAt) < SELF_HEAL_MAX_AGE_MS)
          );
          // Never self-heal an occupation that has already been cashed off — the row
          // is missing BECAUSE it was closed, not because of a stale sweep. reassert
          // itself refuses too, but skipping here avoids the needless flush churn.
          if (live && !isSessionClosed(t.id, sess)) healIds.push(t.id);
        }

        if (!inStore && inSupabase) {
          // Table is open in Supabase but NOT in store — another device opened it
          changed = true;
          const entry = supabaseOpen.get(t.id);
          return { ...t, session: entry.session, status: 'occupied' };
        }

        if (inStore && inSupabase && !isActive) {
          // v5.5.283: take the Supabase version when sessions differ, to propagate a remote
          // device's voids / removals / discounts (where the DB legitimately has FEWER items).
          // v5.5.871: but arbitrate by WRITE RECENCY, not blindly. The old blind take-DB wiped a
          // just-SENT single item: local held 1 sent item, the DB still held the empty seat-time
          // row, JSON differed → it overwrote local with empty. Now: a genuine remote edit carries
          // a NEWER session.lastUpdated (stamped on every mutation) and still wins; a STALER DB row
          // (older stamp) can no longer beat a newer local edit — we KEEP local and re-publish
          // (healIds) so active_sessions reconverges to our newer session instead of losing the item.
          const entry = supabaseOpen.get(t.id);
          const supabaseSession = entry.session;
          const localJSON = JSON.stringify(t.session);
          const supabaseJSON = JSON.stringify(supabaseSession);
          if (localJSON !== supabaseJSON) {
            const localStamp = t.session?.lastUpdated || t.session?.seatedAt || 0;
            const dbStamp    = supabaseSession?.lastUpdated || entry.updatedAt || 0;
            if (dbStamp >= localStamp) {
              // DB is newer-or-equal (real remote change, or legacy un-stamped tie) → take it.
              changed = true;
              return { ...t, session: supabaseSession, status: 'occupied' };
            }
            // Local is strictly newer than the DB row → never wipe it. Keep local and re-publish
            // so the shared row catches up (reassert carries the closed-check tombstone guard, so
            // this can never resurrect a cashed-off table).
            if (!isSessionClosed(t.id, t.session)) healIds.push(t.id);
          }
        }

        return t;
      });

      if (changed) {
        useStore.setState({ tables: newTables });

        // Sync session backup
        const backup = {};
        newTables.filter(t => t.session).forEach(t => { backup[t.id] = t.session; });
        try { localStorage.setItem('rpos-session-backup', JSON.stringify(backup)); } catch {}
      }

      // v5.5.639: re-publish any locally-occupied table whose DB row vanished. reassertSession drops
      // the SessionSync _lastSent latch and schedules a flush, so flushSessions re-upserts the row
      // (the debounce coalesces multiple heals into one batched write). Does NOT touch local tables.
      if (healIds.length) {
        console.warn(`[SessionReconciler] self-heal: re-publishing ${healIds.length} occupied table(s) missing from active_sessions:`, healIds.join(', '));
        healIds.forEach(id => reassertSession(id));
      }
    } catch {}
  };

  // First reconcile immediately
  await reconcile();

  // Then every 10 seconds
  _timer = setInterval(reconcile, 10_000 + Math.round((Math.random() - 0.5) * 4000)); // ±2s jitter — avoid fleet lock-step
}

export function stopSessionReconciler() {
  clearInterval(_timer);
  _timer = null;
  _running = false;
}
