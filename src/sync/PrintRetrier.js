/**
 * PrintRetrier — retry scheduler for print_jobs on a master with NO native bridge
 * ==============================================================================
 *
 * v5.6.83 — SCOPE NARROWED. This used to run on EVERY master, alongside
 * PrintOrchestrator, and the two of them owned the same rows:
 *
 *   - PrintOrchestrator.reclaimStuck resets a stuck claim to 'pending' at a 30s TTL.
 *   - PrintRetrier.reapStaleClaims reset the SAME rows to 'failed' at 60s.
 *
 * Two engines writing conflicting statuses to one table is a correctness bug, not just
 * a busy network — and between them they were making ~70 round trips a minute against
 * print_jobs on a till that was printing nothing at all.
 *
 * There is now exactly ONE claim owner per device. PrintOrchestrator takes it whenever
 * it is running, and startPrintRetrier below stands down in that case. PrintRetrier is
 * NOT deleted, because PrintOrchestrator refuses to start on a device with no native
 * bridge (it would be claiming jobs it cannot print) — on a browser-only master with a
 * LAN print agent this file is still the only thing scheduling retries and handing
 * failed jobs back to the agent. Its unique behaviour was folded into
 * PrintOrchestrator so nothing is lost where the orchestrator does run.
 *
 * Runs ONLY on the designated master device (deviceConfig.isMaster === true).
 * Exactly one master per location guarantees exactly one scheduler, so there
 * are no competing retry loops.
 *
 * What it does:
 *   1. Every POLL_INTERVAL_MS, reap stale claims (workers that crashed
 *      mid-dispatch — claimed_at older than CLAIM_TIMEOUT_MS).
 *   2. Pick up print_jobs that are `failed` with attempts < MAX_ATTEMPTS
 *      and next_retry_at <= now, claim them, increment attempts.
 *   3. If this master device has a native bridge → redispatch directly via
 *      printService.dispatchJob (fast path).
 *      Otherwise → reset to `pending` so the LAN print-agent picks it up.
 *   4. On repeat failure → schedule the next retry with exponential backoff,
 *      OR after MAX_ATTEMPTS escalate to `failed_permanent`.
 *
 * Failure notifications:
 *   Each escalation to failed_permanent emits a window event
 *   `rpos-print-permanent-failure` so the StatusDrawer failure queue can
 *   surface it immediately without polling.
 *
 * Backoff schedule (per attempt number, 1-indexed):
 *   attempt 1 → 0 ms   (immediate on submit)
 *   attempt 2 → 2 s
 *   attempt 3 → 10 s
 *   attempt 4 → 30 s
 *   attempt 5 → 2 min
 *   attempt 6+ → failed_permanent
 *
 * Stability notes:
 *   - Idempotent start/stop — safe to call multiple times.
 *   - Swallows errors at every level — never crashes. Logs instead.
 *   - Claim uses WHERE status='failed' so it can't race with `done` or
 *     `failed_permanent` rows.
 *   - Writes error_message (agent-compatible) AND error (StatusDrawer-compatible)
 *     to keep both schemas happy.
 */

import { supabase, getLocationId, isMock } from '../lib/supabase';
import { printService, isNativeBridgeAvailable } from '../lib/printer';
import { printedLocallyIds, getOrchestratorStatus } from './PrintOrchestrator';

// v5.6.83: was 5s, and each tick fired THREE sequential statements — 36 round trips a
// minute on a till that prints nothing most of the day. Retries are still bounded by
// the backoff ladder (2s / 10s / 30s / 2min); a scheduled retry now lands within one
// scan of its deadline instead of instantly, which no operator can perceive on a
// printer that has already failed at least once.
const POLL_INTERVAL_MS = 20_000;
// The reaper and the exhausted-job sweep are safety nets, not the hot path — run them
// once a minute rather than on every scan.
const SWEEP_EVERY_TICKS = 3;
const FIRST_TICK_DELAY = 3_000;
const CLAIM_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS     = 5;
// Backoff per *completed* attempt — attempts 1..5 map to indexes 0..4
const BACKOFF_MS = [0, 2_000, 10_000, 30_000, 120_000];

let _pollTimer = null;
let _running   = false;
let _locationId = null;
let _tickCount = 0;

function getDeviceId() {
  try {
    const dev = JSON.parse(localStorage.getItem('rpos-device') || 'null');
    return dev?.id || 'master-unknown';
  } catch { return 'master-unknown'; }
}

export async function startPrintRetrier() {
  if (isMock || !supabase || _running) return;

  // v5.6.83: ONE claim owner per device. PrintOrchestrator is already running on any
  // device with a native bridge (the Sunmi tills), and it has taken over everything
  // unique to this file. Starting here as well is what produced conflicting statuses
  // on the same print_jobs rows. Checked at start, not per tick, because
  // startPrintOrchestrator flips its running flag synchronously before App.jsx gets
  // here — and if it bailed for any reason (no bridge, no device id) this file is the
  // fallback and must start as before.
  if (getOrchestratorStatus().running) {
    console.log('[PrintRetrier] PrintOrchestrator owns claim state on this device — standing down');
    return;
  }

  _locationId = await getLocationId().catch(() => null);
  if (!_locationId) {
    console.warn('[PrintRetrier] No locationId — not starting');
    return;
  }

  _running = true;
  console.log('[PrintRetrier] Started (master POS) — polling every', POLL_INTERVAL_MS / 1000, 's');

  // First tick after a short delay so boot isn't hammered
  setTimeout(tick, FIRST_TICK_DELAY);
  _pollTimer = setInterval(tick, POLL_INTERVAL_MS);
}

export function stopPrintRetrier() {
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = null;
  _running = false;
  _tickCount = 0;
}

async function tick() {
  if (!_running) return;

  // Every tick does the work that actually gets a ticket printed. The two sweeps are
  // eventually-consistent safety nets for rows nothing else picked up, so they run on
  // a slower cadence — that alone takes this loop from 3 statements a tick to ~1.3.
  const doSweeps = (_tickCount++ % SWEEP_EVERY_TICKS) === 0;

  try {
    if (doSweeps) await reapStaleClaims();
    await processFailedJobs();
    if (doSweeps) await escalateExhausted();
  } catch (e) {
    console.warn('[PrintRetrier] Tick error:', e.message);
  }
}

// ── 1. Reap stale claims ─────────────────────────────────────────────────────
// If a worker claimed a job but never resolved it (crashed / network cut), the
// row stays stuck in 'claimed' or 'sending'. Reset anything older than
// CLAIM_TIMEOUT_MS so it becomes eligible for retry.
async function reapStaleClaims() {
  const cutoff = new Date(Date.now() - CLAIM_TIMEOUT_MS).toISOString();
  try {
    let q = supabase.from('print_jobs')
      .update({ status: 'failed', error_message: 'Worker timeout — reclaimed', claimed_by: null, claimed_at: null })
      .eq('location_id', _locationId)
      .in('status', ['sending', 'claimed'])
      .lt('claimed_at', cutoff);
    // A job the orchestrator printed but couldn't record is left 'claimed' ON PURPOSE
    // (see markPrintedDurable). It looks exactly like a crashed worker from here, and
    // flipping it to 'failed' feeds it straight to processFailedJobs — which reprints
    // a ticket that is already on paper.
    const printed = printedLocallyIds();
    if (printed.length) q = q.not('id', 'in', `(${printed.join(',')})`);
    await q;
  } catch (e) {
    console.warn('[PrintRetrier] reapStaleClaims failed:', e.message);
  }
}

// ── 2. Process failed jobs ready for retry ───────────────────────────────────
async function processFailedJobs() {
  const now = new Date().toISOString();
  let candidates;
  try {
    const { data } = await supabase
      .from('print_jobs')
      .select('*')
      .eq('location_id', _locationId)
      .eq('status', 'failed')
      .lt('attempts', MAX_ATTEMPTS)
      .or(`next_retry_at.is.null,next_retry_at.lte.${now}`)
      .order('created_at', { ascending: true })
      .limit(10);
    candidates = data || [];
  } catch (e) {
    console.warn('[PrintRetrier] candidate query failed:', e.message);
    return;
  }

  // Never re-dispatch a job the orchestrator already put on paper — it can reach 'failed'
  // by a route this loop didn't take (another device's reaper, a pre-guard sweep).
  const printed = new Set(printedLocallyIds());

  // Scale: dispatch the candidate batch concurrently — a slow/declining printer must not block
  // every other failed ticket behind it. Each job is guarded by its own atomic 'failed'->claim,
  // so parallelism can't double-dispatch (only one device/loop wins each job).
  await Promise.allSettled(candidates.filter(job => !printed.has(job.id)).map(job => processRetry(job)));
}

async function processRetry(job) {
  const deviceId = getDeviceId();
  const nextAttempt = (job.attempts || 0) + 1;

  // Atomic claim: only succeeds if row is still in 'failed' state
  let claimed;
  try {
    const { data, error } = await supabase.from('print_jobs')
      .update({
        status:     'claimed',
        claimed_by: deviceId,
        claimed_at: new Date().toISOString(),
        attempts:   nextAttempt,
      })
      .eq('id', job.id)
      .eq('status', 'failed')
      .select()
      .single();
    if (error || !data) return;  // race loss — someone beat us to it
    claimed = data;
  } catch {
    return;
  }

  console.log(`[PrintRetrier] Retrying job ${job.id.slice(0, 8)} (attempt ${nextAttempt}/${MAX_ATTEMPTS})`);

  // Fast path: this master has a native bridge → redispatch directly
  if (isNativeBridgeAvailable() && job.printer_ip) {
    const result = await printService.dispatchJob(claimed).catch(e => ({ ok: false, error: e.message }));
    if (result.ok) {
      printService.recordPrinterHealth(job.printer_id, 'online');
      return;
    }
    await markFailedOrPermanent(claimed, nextAttempt, result.error);
    return;
  }

  // Slow path: no native bridge on master — hand off to agent by resetting to pending
  try {
    await supabase.from('print_jobs')
      .update({
        status:       'pending',
        claimed_by:   null,
        claimed_at:   null,
        next_retry_at: null,
      })
      .eq('id', job.id);
  } catch (e) {
    console.warn('[PrintRetrier] Handoff-to-agent update failed:', e.message);
  }
}

async function markFailedOrPermanent(job, attemptNumber, errorMsg) {
  const hitMax = attemptNumber >= MAX_ATTEMPTS;
  const patch = hitMax ? {
    status:        'failed_permanent',
    error_message: errorMsg,
    error:         errorMsg,
    claimed_by:    null,
    claimed_at:    null,
    next_retry_at: null,
  } : {
    status:        'failed',
    error_message: errorMsg,
    error:         errorMsg,
    claimed_by:    null,
    claimed_at:    null,
    next_retry_at: new Date(Date.now() + BACKOFF_MS[Math.min(attemptNumber, BACKOFF_MS.length - 1)]).toISOString(),
  };

  try {
    await supabase.from('print_jobs').update(patch).eq('id', job.id);
  } catch (e) {
    console.warn('[PrintRetrier] final-status update failed:', e.message);
    return;
  }

  if (hitMax) {
    printService.recordPrinterHealth(job.printer_id, 'offline', errorMsg);
    // Notify UI (StatusDrawer listens for this to refresh immediately)
    try {
      window.dispatchEvent(new CustomEvent('rpos-print-permanent-failure', { detail: { ...job, ...patch } }));
    } catch {}
    console.warn(`[PrintRetrier] Job ${job.id.slice(0, 8)} exhausted after ${MAX_ATTEMPTS} attempts — moved to failed_permanent`);
  }
}

// ── 3. Escalate any stragglers ───────────────────────────────────────────────
// Catches rows that have attempts >= MAX but somehow never got flipped to
// failed_permanent (e.g. the tick crashed mid-escalation). Net: an
// eventually-consistent safety sweep.
async function escalateExhausted() {
  try {
    await supabase.from('print_jobs')
      .update({ status: 'failed_permanent' })
      .eq('location_id', _locationId)
      .eq('status', 'failed')
      .gte('attempts', MAX_ATTEMPTS);
  } catch {}
}

// For diagnostics / admin UI
export function getPrintRetrierStatus() {
  return { running: _running, locationId: _locationId };
}
