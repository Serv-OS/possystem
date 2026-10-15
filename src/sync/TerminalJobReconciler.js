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
 * Since v5.5.862 it is also the durable close for Mode 3 (pos_send_to_terminal): the till's
 * checkout screen books those itself, but a closed screen, a crash or a reload left them
 * approved forever (RECONCILABLE_SOURCES in lib/payments/terminalJobs.js).
 *
 * 28 Sep 2026: WHICH device books, and when, is lib/payments/terminalJobCloser.js. The till
 * that sent the job books it (after its own checkout screen, which books the full record);
 * another till waits 30 s, a kitchen screen or a Back Office tab 90 s, a host stand never.
 * Before this every device booked at once, and at Coffee Boy Leeds a kitchen screen booked
 * half the reader sales under a ref from its own lease.
 */

import { getLocationId, supabase, getDeviceMode } from '../lib/supabase';
import { useStore } from '../store';
import { fetchApprovedTablePayJobs, getPosDeviceId } from '../lib/payments/terminalJobs';
import { getLocationProcessor } from '../lib/payments/processor';
import { closerRole, closeWaitMs, isDue, createSightings, isWatchedHere, adoptBookedSale } from '../lib/payments/terminalJobCloser';
import { moneyMinor } from '../lib/currency';

let _timer = null;
let _adyenWarm = null;
let _locationId = null;
let _running = false;
// When THIS device first saw each approved job (its own clock, see terminalJobCloser).
const _sightings = createSightings();

// Monotonic where the webview has it, so a clock correction cannot shorten a wait.
const clockNow = () => (typeof performance !== 'undefined' && typeof performance.now === 'function')
  ? performance.now() : Date.now();

// Read every tick: the device profile (deviceConfig) can land after the reconciler starts.
function thisCloser() {
  let pairedType = null;
  try { pairedType = JSON.parse(localStorage.getItem('rpos-device') || 'null')?.type || null; } catch { /* unpaired */ }
  return {
    role: closerRole({ mode: getDeviceMode(), pairedType, deviceConfig: useStore.getState().deviceConfig }),
    myDeviceId: getPosDeviceId(),
  };
}

export async function startTerminalJobReconciler() {
  if (_running) return;
  // A host stand (Tables Ready, Table Bookings) never books a sale: it cannot write closed_checks
  // and cannot read terminal jobs, so it only ever logged a refusal every 8 s.
  if (closerRole({ mode: getDeviceMode() }) === 'host') return;
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
      _sightings.keepOnly(jobs.map(j => j.id));
      const me = thisCloser();
      const now = clockNow();
      // Sequential, not parallel: calmer on the DB, and closes are independent.
      for (const job of jobs) {
        const firstSeen = _sightings.see(job.id, now);
        // 30 Sep 2026: watched by job id (the card screen) OR by check id (the checkout, from the
        // moment it presses Card, before the job row exists). Closes the 0.1 s race that booked
        // 48 sales in the background while the checkout was about to finish them.
        const watchedHere = isWatchedHere(job.id, job.closed_check_id);
        const wait = closeWaitMs(job, { ...me, watchedHere });
        if (!isDue(wait, firstSeen, now)) continue;   // the till that sent it books it first
        const booked = await useStore.getState().closeApprovedTerminalJob(job);
        // 30 Sep 2026: this till booked its OWN unwatched send to terminal job, so the checkout was
        // closed during the tender (Huddersfield R5737). If the cart on screen is that very order,
        // clear it, and say so where staff cannot miss it, so it is never rung again.
        try {
          const st = useStore.getState();
          const walkInRef = st.walkInOrder?.ref || null;
          const adopt = adoptBookedSale({ job, booked, myDeviceId: me.myDeviceId, watchedHere, walkInRef, fmt: moneyMinor });
          if (adopt.banner) {
            if (adopt.clearWalkIn) st.clearWalkIn?.();
            st.showCardAdoptedBanner?.({ text: adopt.banner, jobId: job.id, ref: booked?.ref || null, at: Date.now() });
          }
        } catch (e) { console.warn('[TerminalJobReconciler] adopt:', e?.message || e); }
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
