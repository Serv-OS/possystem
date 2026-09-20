// src/lib/rowWrites.js: the live wiring of lib/rowWriteFence.js (database fence stage 1, fix
// round 2, the zero row blocker).
//
// Every update and delete of bar_tabs, active_sessions, order_queue, closed_checks, kds_tickets
// and print_jobs that must change a row goes through mustChangeRow (one row) or mustChangeRows
// (many rows by key). They count the rows the database really changed; when none changed they ask
// the server whether this device is still linked, and keep the write (OfflineQueue, sent again
// once the device is linked again) instead of counting it as done. See lib/rowWriteFence.js for
// the rule and the outcomes.
//
// Static imports only (ADR-008).
import { supabase } from './supabase';
import { confirmLinkAfterZeroRows, getLinkEpoch, checkDeviceLink } from './deviceLink';
import { parkWrite, parkedRowKeys, queueWrite } from '../sync/OfflineQueue';
import { runMustChangeWrite, runMustChangeMany } from './rowWriteFence';

function liveDeps() {
  return {
    client: supabase,
    confirmLink: confirmLinkAfterZeroRows,
    linkEpoch: getLinkEpoch,
    park: parkWrite,
    parkedRowKeys,
    queueBehind: (item) => queueWrite(item),
    // The banner already shows (the link check marked the device lost). The re-link with the
    // device secret runs now; its relinked event releases the parked write.
    afterPark: () => { checkDeviceLink(); },
  };
}

/**
 * One update or delete that must change a row. Resolves the outcome of runMustChangeWrite:
 * 'applied' | 'gone' | 'parked' | 'queued' | 'unlinked' | 'error' (with error), or 'skipped' when
 * there is no database (mock mode). Never throws.
 */
export async function mustChangeRow(write) {
  if (!supabase) return { outcome: 'skipped' };
  try { return await runMustChangeWrite(write, liveDeps()); }
  catch (e) { return { outcome: 'error', error: e }; }
}

/** Many rows by key (`in`): each key is applied, gone, or kept on its own. Never throws. */
export async function mustChangeRows(batch) {
  if (!supabase) return { outcome: 'skipped', changed: [], gone: [], parked: [], queued: [] };
  try { return await runMustChangeMany(batch, liveDeps()); }
  catch (e) { return { outcome: 'error', error: e, changed: [], gone: [], parked: [], queued: [] }; }
}

/** The { error } shape older callers read: an error only when the database refused the write. */
export const writeErrorOf = (r) => (r && r.outcome === 'error' ? (r.error || new Error('write failed')) : null);
