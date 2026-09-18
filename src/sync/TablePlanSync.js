// TablePlanSync: keeps every till's table DEFINITIONS in line with the saved plan (floor_tables)
// between boots. Rules live in lib/tablePlan.js; this is only the wiring.
//
// Why it exists (v5.9.4, Peter 18 Sep 2026: "if you rename, delete them etc, on refresh they come
// back and names go back"): a till used to learn a rename or a delete only from a Push to POS or a
// reboot, and the push it held was usually older than the plan. Now a till re-reads the plan
//   - when a Push to POS arrives (window event 'rpos-config-push', dispatched by realtime.js),
//   - when it comes back online, or back to the foreground,
//   - every few minutes (the self-heal cycle every till-consumed config must ride),
// and applies it at APPLY TIME (the store is read after every network wait, never a snapshot
// taken before it). A read only changes definitions: sessions are never touched, a table holding
// an open order is kept reachable (planRemoved), and a failed or empty read changes nothing but
// tombstones. Boot reads are SyncBridge's (it also has the sessions); this never runs before the
// boot has stamped _dataLocationId.

import { useStore } from '../store';
import { isMock, getActiveLocationSync } from '../lib/supabase';
import { fetchFloorPlanVersioned, fetchTableTombstones } from '../lib/db';
import { isSessionClosed } from './sessionClosure';
import {
  applyPlanRead, applyTombstones, normaliseFloorRow, loadPlanState, savePlanState,
  mergeTombs, tombstonesFromRows, pruneClosedRemoved, nextSeq,
} from '../lib/tablePlan';

const REFRESH_MS = 3 * 60 * 1000;
let _inFlight = null;
let _started = false;
let _timer = null;
let _debounce = null;

/**
 * Read the plan and apply it to the store. Returns { applied, changed } (never throws).
 *   mode 'full'        retire tables the read lacks (unless an order is open on them)
 *   mode 'upsertOnly'  add and update only (useSupabaseInit, which has no sessions to check)
 */
export async function refreshTablePlan({ locationId = null, mode = 'full', reason = '', backOffice = false } = {}) {
  if (isMock) return { applied: false, changed: false, sections: null };
  const loc = locationId || getActiveLocationSync();
  if (!loc || loc === 'loc-demo') return { applied: false, changed: false, sections: null };
  if (_inFlight) return _inFlight;
  _inFlight = (async () => {
    try {
      const readSeq = nextSeq();   // taken BEFORE the request: anything observed later is newer
      const [fp, tr] = await Promise.all([
        fetchFloorPlanVersioned(loc).catch(e => ({ data: null, error: e })),
        fetchTableTombstones(loc).catch(e => ({ data: null, error: e })),
      ]);
      // Apply time: everything below reads the store now, after the waits.
      // A till never applies another location's plan. Back Office (loading the location it just
      // switched to) keeps only this location's tables as the local side.
      const dataLoc = useStore.getState()._dataLocationId;
      if (!backOffice && dataLoc && dataLoc !== loc) return { applied: false, changed: false, sections: null };
      const state = loadPlanState(loc);
      const tombs = mergeTombs(state.tombs, tombstonesFromRows(tr?.data, readSeq), { cleared: state.cleared });
      const rows = Array.isArray(fp?.data?.tables) ? fp.data.tables.map(t => normaliseFloorRow(t, { locationId: loc, readSeq })) : null;
      const all = useStore.getState().tables || [];
      const cur = backOffice ? all.filter(t => !t.locationId || t.locationId === loc) : all;
      const read = applyPlanRead({ local: cur, rows, srvReadAt: fp?.data?.srvReadAt || 0, readSeq, tombs, isClosed: isSessionClosed, mode });
      let next;
      if (read) {
        next = mode === 'full' ? pruneClosedRemoved(read.tables, isSessionClosed) : read.tables;
        savePlanState(loc, { plan: mode === 'full' ? read.plan : null, tombs, cleared: read.cleared, labels: read.labels });
        if (read.dropped.length) console.log('[TablePlanSync]', reason, 'removed', read.dropped.join(', '), '(deleted from the plan)');
        if (read.keptOpen.length) console.warn('[TablePlanSync]', reason, 'kept', read.keptOpen.join(', '), 'reachable: gone from the plan but an order is open on it');
      } else {
        savePlanState(loc, { tombs });
        next = applyTombstones(cur, tombs, { isClosed: isSessionClosed }).tables;
      }
      const changed = next !== all && (next.length !== all.length || next.some((t, i) => t !== all[i]));
      if (changed) useStore.setState({ tables: next });
      return { applied: !!read, changed, sections: fp?.data?.sections || null };
    } catch (e) {
      console.warn('[TablePlanSync] refresh failed:', e?.message || e);
      return { applied: false, changed: false, sections: null };
    } finally {
      _inFlight = null;
    }
  })();
  return _inFlight;
}

// Coalesce bursts (a push arrives, the app comes online and visible at once).
export function requestTablePlanRefresh(reason = 'request', delayMs = 800) {
  if (isMock) return;
  clearTimeout(_debounce);
  _debounce = setTimeout(() => {
    if (!useStore.getState()._dataLocationId) return;   // boot not done: SyncBridge's read decides
    refreshTablePlan({ reason });
  }, delayMs);
}

export function startTablePlanSync() {
  if (isMock || _started || typeof window === 'undefined') return;
  _started = true;
  window.addEventListener('rpos-config-push', () => requestTablePlanRefresh('push'));
  window.addEventListener('online', () => requestTablePlanRefresh('online', 1500));
  try {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') requestTablePlanRefresh('visible', 1500);
    });
  } catch { /* no document */ }
  clearInterval(_timer);
  _timer = setInterval(() => requestTablePlanRefresh('interval', 0), REFRESH_MS);
}
