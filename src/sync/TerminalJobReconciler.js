/**
 * TerminalJobReconciler — closes tables that were PAID ON THE PAX terminal.
 *
 * A terminal Table-Pay (source='pax_table_pay') charges the card but never closes the
 * table — the terminal has no way to run the POS's close (stock, loyalty, receipt, tax,
 * floor-clear). This is the POS half the server always expected: every ~8s it asks the
 * fenced terminal-job-status edge fn for this venue's APPROVED Table-Pay jobs (the POS
 * has no direct SELECT on terminal_jobs by design) and hands each to
 * closeApprovedTerminalJob, which elects a single closer via the job's pre-minted
 * closed_check_id and writes the check + clears the table exactly once across all devices.
 *
 * Mode 3 (pos_send_to_terminal) is deliberately NOT handled here — the till already
 * closes it. The source filter in fetchApprovedTablePayJobs keeps the two disjoint.
 */

import { getLocationId, supabase } from '../lib/supabase';
import { useStore } from '../store';
import { fetchApprovedTablePayJobs } from '../lib/payments/terminalJobs';

let _timer = null;
let _locationId = null;
let _running = false;

export async function startTerminalJobReconciler() {
  if (_running) return;
  _running = true;

  _locationId = await getLocationId().catch(() => null);
  if (!_locationId || !supabase) { _running = false; return; }

  const tick = async () => {
    // An offline till cannot be the closer; the job stays approved and any online
    // device (or this one, on reconnect) closes it. No point calling out while down.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    try {
      const jobs = await fetchApprovedTablePayJobs(_locationId);
      // Sequential, not parallel: calmer on the DB, and closes are independent.
      for (const job of jobs) {
        await useStore.getState().closeApprovedTerminalJob(job);
      }
    } catch (e) {
      console.warn('[TerminalJobReconciler]', e?.message || e);
    }
  };

  await tick();                                   // close promptly on boot
  // ±1.5s jitter so a fleet of tills doesn't hit the edge fn in lock-step.
  _timer = setInterval(tick, 8000 + Math.round((Math.random() - 0.5) * 3000));
}

export function stopTerminalJobReconciler() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  _running = false;
}
