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
import { getLocationProcessor } from '../lib/payments/processor';

let _timer = null;
let _adyenWarm = null;
let _locationId = null;
let _running = false;

export async function startTerminalJobReconciler() {
  if (_running) return;
  _running = true;

  _locationId = await getLocationId().catch(() => null);
  if (!_locationId || !supabase) { _running = false; return; }

  // v5.5.892: terminal_jobs are a PAX/Ryft-only mechanism — on a Stripe venue this poller
  // called the terminal-job-status edge fn every ~8s on every device for jobs that can never
  // exist. Gate on the venue processor once at start (processor changes require BO work + a
  // till restart anyway, which re-runs this).
  try {
    const proc = await getLocationProcessor(_locationId);
    // terminal_jobs now carry BOTH fleets: PAX/Ryft and Adyen (v5.6.62 — the
    // ryft-only gate left every Adyen pay-at-table check unbooked: money taken,
    // table still open, and a second charge possible).
    if (proc !== 'ryft' && proc !== 'adyen') {
      console.log('[TerminalJobReconciler] venue processor is', proc, '— terminal job reconciler not needed, staying idle');
      _running = false;
      return;
    }
  } catch { /* unknown processor — keep the reconciler running (fail open, PAX venues must close jobs) */ }

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

  // v5.6.66 — keep the Adyen fns WARM on Adyen venues. Pay at Table's
  // button-to-bill lag was two stacked cold starts; an OPTIONS ping costs
  // nothing and keeps the isolates resident. Every ~4 min, jittered.
  if (_adyenWarm) clearInterval(_adyenWarm);
  try {
    const proc = await getLocationProcessor(_locationId);
    if (proc === 'adyen') {
      const warm = () => {
        for (const fn of ['adyen-terminal-events', 'adyen-terminal-charge']) {
          fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${fn}`, { method: 'OPTIONS' }).catch(() => {});
        }
      };
      warm();
      _adyenWarm = setInterval(warm, 240000 + Math.round(Math.random() * 30000));
    }
  } catch { /* warm-up is best-effort */ }
}

export function stopTerminalJobReconciler() {
  if (_timer) clearInterval(_timer);
  if (_adyenWarm) clearInterval(_adyenWarm);
  _timer = null;
  _adyenWarm = null;
  _running = false;
}
