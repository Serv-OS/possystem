/**
 * PrintOrchestrator — v4.3.0
 * ===========================
 * The single dispatcher for all print jobs. Sits between:
 *   routePrintJob (writes jobs to print_jobs table)
 *   printService  (actually dispatches bytes to hardware)
 *
 * Responsibilities:
 *   1. Subscribe to print_jobs INSERTs via realtime for instant pickup
 *   2. Poll print_jobs on an interval (master: 2s, child: 15s — child polls
 *      act as failover if master goes offline)
 *   3. Atomically CLAIM jobs via optimistic UPDATE (claimed_by IS NULL)
 *   4. Dispatch via printService and update status on success/failure
 *   5. Reclaim stuck claims (claim_expires_at passed without a status change)
 *   6. On failure, schedule the next retry according to RETRY_SCHEDULE
 *   7. After MAX_ATTEMPTS, mark failed_permanent (goes to StatusDrawer
 *      "Action required" list, needs operator retry/dismiss)
 *
 * Failover: any device can claim. Master has priority by polling faster.
 * Children only trickle in if master hasn't picked the job up quickly.
 * When master returns, it simply polls first and reclaims control.
 *
 * Idempotency: routePrintJob generates an idempotency_key. UPSERT on that key
 * means double-submissions (network retries, double taps, reconnects) never
 * cause a duplicate ticket.
 */

import { supabase } from '../lib/supabase';
import { printService } from '../lib/printer';

// Detect native bridge (Android/iOS TCP socket injection) — same check used by printService
function hasNativeBridge() {
  return typeof window !== 'undefined' && !!window.RposPrinter;
}

// ─── Tuning ──────────────────────────────────────────────────────────────────
// Backoff schedule: delay before attempting retry N (ms since last attempt)
// Attempt 1: immediate (0), Attempt 2: 2s, Attempt 3: 10s, Attempt 4: 30s, Attempt 5: 120s
const RETRY_SCHEDULE_MS = [0, 2_000, 10_000, 30_000, 120_000];
const MAX_ATTEMPTS      = RETRY_SCHEDULE_MS.length;      // 5

const CLAIM_TTL_MS      = 30_000;        // claim expires after 30s — then reclaimable
const MASTER_POLL_MS    = 2_000;         // master scans every 2s
const CHILD_POLL_MS     = 15_000;        // child scans every 15s (failover only)
const CHILD_DELAY_MS    = 10_000;        // child only claims jobs older than 10s
                                          // (gives master first shot, avoids thrash)
const BATCH_SIZE        = 10;            // max jobs to claim per scan

// ─── State ───────────────────────────────────────────────────────────────────
let _pollTimer      = null;
let _reclaimTimer   = null;
let _channel        = null;
let _deviceId       = null;
let _locationId     = null;
let _isMaster       = false;
let _running        = false;
let _inflight       = new Set();       // jobIds currently being dispatched on THIS device

// ─── Public API ──────────────────────────────────────────────────────────────
export async function startPrintOrchestrator({ deviceId, locationId, isMaster }) {
  if (_running) return;
  if (!supabase || !deviceId || !locationId) return;

  // Orchestrator requires a native bridge — otherwise the print agent is the
  // only dispatcher and we'd claim jobs we can't fulfil. Browser-only devices
  // simply let the agent handle everything (agent also respects the retry
  // schedule and claim semantics added in v4.3).
  if (!hasNativeBridge()) {
    console.log('[PrintOrchestrator] No native bridge on this device — deferring to print agent');
    return;
  }

  _deviceId   = deviceId;
  _locationId = locationId;
  _isMaster   = !!isMaster;
  _running    = true;

  console.log(`[PrintOrchestrator] Starting — role=${_isMaster ? 'MASTER' : 'child'} device=${_deviceId.slice(0,8)} bridge=native`);

  // Subscribe to realtime INSERTs on print_jobs → instant pickup
  _channel = supabase
    .channel(`print-orchestrator-${deviceId}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'print_jobs',
      filter: `location_id=eq.${locationId}`,
    }, (payload) => {
      const job = payload.new;
      if (!job || job.status !== 'pending') return;
      // Master picks up immediately; child waits slightly before attempting
      const delay = _isMaster ? 0 : CHILD_DELAY_MS;
      setTimeout(() => claimAndDispatch(job.id), delay);
    })
    .subscribe();

  // Periodic poll — catches anything realtime missed, plus handles retries
  const pollInterval = _isMaster ? MASTER_POLL_MS : CHILD_POLL_MS;
  _pollTimer = setInterval(tick, pollInterval);

  // Reclaim stuck jobs — every 15s regardless of role
  _reclaimTimer = setInterval(reclaimStuck, 15_000);

  // Immediate first tick — drain anything left from previous session
  setTimeout(tick, 500);
}

export function stopPrintOrchestrator() {
  if (!_running) return;
  _running = false;
  clearInterval(_pollTimer);
  clearInterval(_reclaimTimer);
  if (_channel && supabase) supabase.removeChannel(_channel);
  _pollTimer = _reclaimTimer = _channel = null;
  _inflight.clear();
}

export function getOrchestratorStatus() {
  return {
    running:    _running,
    role:       _isMaster ? 'master' : 'child',
    deviceId:   _deviceId,
    locationId: _locationId,
    inflight:   [..._inflight],
  };
}

// ─── Core poll tick ──────────────────────────────────────────────────────────
async function tick() {
  if (!_running || !supabase) return;

  try {
    // Children only pick up jobs that are getting stale — gives master first shot
    const cutoffIso = _isMaster
      ? new Date().toISOString()
      : new Date(Date.now() - CHILD_DELAY_MS).toISOString();

    const nowIso = new Date().toISOString();

    // Find eligible jobs: pending OR (failed AND next_retry_at passed), not claimed
    const { data, error } = await supabase
      .from('print_jobs')
      .select('id, status, attempts, next_retry_at, created_at')
      .eq('location_id', _locationId)
      .in('status', ['pending', 'failed'])
      .is('claimed_by', null)
      .or(`status.eq.pending,and(status.eq.failed,next_retry_at.lte.${nowIso})`)
      .lte('created_at', cutoffIso)
      .order('created_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (error || !data) return;

    for (const job of data) {
      if (_inflight.has(job.id)) continue;
      claimAndDispatch(job.id);
    }
  } catch (e) {
    console.warn('[PrintOrchestrator] poll error:', e.message);
  }
}

// ─── Claim + dispatch one job ────────────────────────────────────────────────
async function claimAndDispatch(jobId) {
  if (!_running || _inflight.has(jobId)) return;
  _inflight.add(jobId);

  try {
    // Atomic claim: update WHERE claimed_by IS NULL — returns row only if WE won
    const claimExpires = new Date(Date.now() + CLAIM_TTL_MS).toISOString();
    const { data: claimed, error: claimErr } = await supabase
      .from('print_jobs')
      .update({
        claimed_by:        _deviceId,
        claimed_at:        new Date().toISOString(),
        claim_expires_at:  claimExpires,
        status:            'claimed',
      })
      .eq('id', jobId)
      .is('claimed_by', null)
      .in('status', ['pending', 'failed'])
      .select()
      .single();

    if (claimErr || !claimed) {
      // Someone else claimed it first — no problem
      return;
    }

    await dispatchJob(claimed);
  } catch (e) {
    console.warn(`[PrintOrchestrator] dispatch error for ${jobId}:`, e.message);
  } finally {
    _inflight.delete(jobId);
  }
}

// ─── Dispatch the bytes ──────────────────────────────────────────────────────
async function dispatchJob(job) {
  // SPEED: skip the pre-dispatch `status: 'sending'` update — `claimed` already
  // protects the row from re-pickup (the poll filter is status IN
  // ('pending','failed'), and claim_expires_at acts as a TTL safety net via
  // reclaimStuck). Saves a Supabase round-trip (~300-700ms) on every print
  // before paper comes out, which is the most user-visible latency.

  let ok = false;
  let errMsg = null;

  try {
    const bytes = base64ToBytes(job.payload);

    // Find the printer from local registry (kept in sync via Push-to-POS)
    const printer = findPrinter(job.printer_id);
    if (!printer) throw new Error(`Printer ${job.printer_id} not found in registry`);
    if (!printer.address && !job.printer_ip) throw new Error('Printer has no IP address');

    // Prefer native bridge (Android/iOS) when available — direct TCP, fastest
    // Otherwise fall back to raw TCP via nothing-in-browser (→ needs print agent)
    // PrintService knows how to pick. We pass bytes + printer target.
    const result = await printService._dispatchBytesDirect(
      bytes,
      printer.address || job.printer_ip,
      job.printer_port || 9100
    );

    if (result?.ok) {
      ok = true;
    } else {
      errMsg = result?.error || 'Print failed (no ok=true)';
    }
  } catch (e) {
    errMsg = e.message || 'Print failed';
  }

  // SPEED: fire-and-forget the post-print bookkeeping. Paper is already out
  // (or already failed) — the success/failure UPDATE on print_jobs and the
  // health-tracking update have no bearing on perceived latency. Releasing
  // the dispatch loop now lets the next queued job start ~500ms sooner,
  // which compounds visibly during a service rush.
  if (ok) {
    supabase.from('print_jobs').update({
      status:       'printed',
      processed_at: new Date().toISOString(),
      claimed_by:   null,
      claim_expires_at: null,
      error_message: null,
    }).eq('id', job.id).then(() => {}, (e) => {
      console.warn('[PrintOrchestrator] mark-printed failed (job already on paper):', e?.message || e);
    });
    printService.recordPrinterHealth(job.printer_id, 'online').catch(() => {});
  } else {
    // Failures still need to be awaited — recordFailure schedules retry, and
    // we don't want the next tick to fire until the row is back to pending.
    await recordFailure(job, errMsg);
    printService.recordPrinterHealth(job.printer_id, 'offline', errMsg).catch(() => {});
  }
}

// ─── Record failure + schedule retry or mark permanent ───────────────────────
async function recordFailure(job, errMsg) {
  const nextAttempt = (job.attempts || 0) + 1;
  const max = job.max_attempts || MAX_ATTEMPTS;

  if (nextAttempt >= max) {
    // Exhausted — goes to Action Required queue
    await supabase.from('print_jobs').update({
      status:            'failed_permanent',
      attempts:          nextAttempt,
      error_message:     errMsg,
      claimed_by:        null,
      claim_expires_at:  null,
      processed_at:      new Date().toISOString(),
    }).eq('id', job.id);
    return;
  }

  // Schedule next retry
  const delayMs = RETRY_SCHEDULE_MS[nextAttempt] ?? RETRY_SCHEDULE_MS[RETRY_SCHEDULE_MS.length - 1];
  const nextRetryAt = new Date(Date.now() + delayMs).toISOString();

  await supabase.from('print_jobs').update({
    status:            'failed',
    attempts:          nextAttempt,
    error_message:     errMsg,
    next_retry_at:     nextRetryAt,
    claimed_by:        null,
    claim_expires_at:  null,
  }).eq('id', job.id);
}

// ─── Reclaim stuck jobs ──────────────────────────────────────────────────────
// A job stuck in 'claimed' or 'sending' past claim_expires_at means the
// claiming device crashed mid-dispatch. We reset it so another device picks up.
async function reclaimStuck() {
  if (!_running || !supabase) return;

  try {
    const nowIso = new Date().toISOString();
    await supabase.from('print_jobs')
      .update({
        status: 'pending',
        claimed_by: null,
        claim_expires_at: null,
      })
      .eq('location_id', _locationId)
      .in('status', ['claimed', 'sending'])
      .lt('claim_expires_at', nowIso);
  } catch {}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function findPrinter(printerId) {
  try {
    const list = JSON.parse(localStorage.getItem('rpos-printers') || '[]');
    return list.find(p => p.id === printerId) || null;
  } catch { return null; }
}

// ─── Operator actions (called from StatusDrawer) ─────────────────────────────
export async function operatorRetryJob(jobId) {
  if (!supabase) return { ok: false, error: 'offline' };
  const { error } = await supabase.from('print_jobs').update({
    status:        'pending',
    attempts:      0,
    next_retry_at: null,
    error_message: null,
    claimed_by:    null,
    claim_expires_at: null,
    dismissed_at:  null,
  }).eq('id', jobId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function operatorDismissJob(jobId) {
  if (!supabase) return { ok: false, error: 'offline' };
  const { error } = await supabase.from('print_jobs').update({
    status:       'dismissed',
    dismissed_at: new Date().toISOString(),
  }).eq('id', jobId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function operatorRerouteJob(jobId, newPrinterId) {
  if (!supabase) return { ok: false, error: 'offline' };
  const printer = findPrinter(newPrinterId);
  const { error } = await supabase.from('print_jobs').update({
    printer_id:        newPrinterId,
    printer_ip:        printer?.address || null,
    printer_port:      printer?.port || 9100,
    status:            'pending',
    attempts:          0,
    next_retry_at:     null,
    error_message:     null,
    claimed_by:        null,
    claim_expires_at:  null,
    dismissed_at:      null,
  }).eq('id', jobId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
