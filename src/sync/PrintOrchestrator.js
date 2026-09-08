/**
 * PrintOrchestrator — v4.3.0
 * ===========================
 * The single dispatcher for all print jobs. Sits between:
 *   routePrintJob (writes jobs to print_jobs table)
 *   printService  (actually dispatches bytes to hardware)
 *
 * Responsibilities:
 *   1. Subscribe to print_jobs INSERTs via realtime for instant pickup
 *   2. Poll print_jobs on a SLOW backstop interval (master: 20s, child: 30s) for
 *      anything realtime missed — child polls act as failover if master goes
 *      offline. Scheduled retries do not wait for it; recordFailure arms a
 *      one-shot timer for the exact backoff deadline.
 *   3. Atomically CLAIM jobs via optimistic UPDATE (claimed_by IS NULL)
 *   4. Dispatch via printService and update status on success/failure
 *   5. Reclaim stuck claims (claim_expires_at passed without a status change)
 *   6. On failure, schedule the next retry according to RETRY_SCHEDULE
 *   7. After MAX_ATTEMPTS, mark failed_permanent (goes to StatusDrawer
 *      "Action required" list, needs operator retry/dismiss)
 *
 * v5.6.83 — this is now the SINGLE owner of claim state on any device with a native
 * bridge. PrintRetrier used to run beside it on the master and write CONFLICTING
 * statuses to the same rows (it reset stuck claims to 'failed' at 60s while this file
 * reset them to 'pending' at 30s). PrintRetrier now stands down whenever this
 * orchestrator is running, and its unique behaviour lives here: the null
 * next_retry_at case in the poll filter, the exhausted-job sweep in reclaimStuck, the
 * printed-locally exclusion on the reaper, and the rpos-print-permanent-failure event.
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
// v5.6.83 — POLL RATES. These were 2s (master) / 15s (child), which on an idle till is
// ~34 round trips a minute against a table that is empty most of the day. The poll is
// NOT how a print gets picked up: the realtime INSERT subscription below does that in
// ~50-150ms, and MPOS submissions come in faster still on the broadcast fast path. The
// poll is the backstop for a realtime event that never arrived. Retry timing is NOT on
// the poll either — recordFailure now arms a one-shot timer for the exact moment the
// backoff expires (scheduleRetryTick), so a failed kitchen ticket retries on schedule
// whatever the poll is set to.
const MASTER_POLL_MS    = 20_000;        // master backstop scan
const CHILD_POLL_MS     = 30_000;        // child backstop scan (failover only)
const RECLAIM_MS        = 60_000;        // stuck-claim sweep + exhausted-job sweep
const CHILD_DELAY_MS    = 10_000;        // child only claims jobs older than 10s
                                          // (gives master first shot, avoids thrash)
const BATCH_SIZE        = 10;            // max jobs to claim per scan

// ─── State ───────────────────────────────────────────────────────────────────
let _pollTimer      = null;
let _reclaimTimer   = null;
let _idempotencyCleanupTimer = null;
let _channel        = null;
let _fastChannel    = null;
let _deviceId       = null;
let _locationId     = null;
let _isMaster       = false;
let _running        = false;
let _inflight       = new Set();       // jobIds currently being dispatched on THIS device
// One-shot timers armed by recordFailure so a scheduled retry fires at its backoff
// deadline instead of waiting for the next backstop poll. Tracked so stop() clears them.
const _retryTimers  = new Set();
// FAST PATH dedup: idempotency_key → timestamp of broadcast print. When the
// postgres INSERT realtime arrives ~500ms after our broadcast print, we look
// up the key here and skip dispatch — the upsert path will mark the row done.
const _broadcastHandled = new Map();
const _BROADCAST_DEDUP_TTL_MS = 5 * 60_000;
// LAST-RESORT REPRINT GUARD: jobId → { warnedAt } for jobs this device put on paper
// but could not record as printed in the database (every write rejected). Never
// re-dispatched here, so a kitchen ticket can't come back round a second time while
// the writes are failing. Only cleared when the park write finally lands (the row is
// then failed_permanent, which nothing reclaims) or when an operator deliberately
// asks for the job again — forgetting one otherwise is what prints food twice.
const _printedLocally = new Map();

// PrintRetrier can still be the active engine on a master with NO native bridge (this
// orchestrator refuses to start there), and it re-dispatches on its own schedule, so
// the guard above only holds if it can see it too. Also read by reclaimStuck here.
export function printedLocallyIds() {
  return [..._printedLocally.keys()];
}

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
      // FAST PATH: if we already printed this via the broadcast channel
      // (master only), skip the dispatch. The broadcast handler upserts the
      // row to status='printed' as soon as paper is out — but the postgres
      // realtime fanout often races ahead of that update, so we also do a
      // local in-memory check here.
      if (job.idempotency_key && _broadcastHandled.has(job.idempotency_key)) {
        markPrintedDurable(job.id);
        return;
      }
      // Master picks up immediately; child waits slightly before attempting
      const delay = _isMaster ? 0 : CHILD_DELAY_MS;
      setTimeout(() => claimAndDispatch(job.id), delay);
    })
    .subscribe();

  // FAST PATH — Supabase Realtime BROADCAST channel. MPOS sends a broadcast
  // with the bytes when it submits a print, and master prints immediately on
  // receipt — no postgres write in the hot path, no realtime fanout from
  // logical replication. End-to-end latency is ~50-150ms each way, vs
  // 500-1500ms for postgres+realtime.
  //
  // Master only: child devices ignore broadcasts to avoid double-print.
  // The postgres INSERT path is the durable backup for two cases:
  //   1. Master is offline — postgres row still exists, picked up on reboot
  //   2. Broadcast was missed — realtime INSERT arrives later as fallback
  if (_isMaster) {
    _fastChannel = supabase
      .channel(`print-fast:${locationId}`, { config: { broadcast: { self: false } } })
      .on('broadcast', { event: 'print' }, ({ payload }) => {
        handleFastBroadcast(payload).catch((e) =>
          console.warn('[PrintOrchestrator] broadcast print error:', e?.message || e));
      })
      .subscribe();
  }

  // Periodic poll — catches anything realtime missed, plus handles retries
  const pollInterval = _isMaster ? MASTER_POLL_MS : CHILD_POLL_MS;
  _pollTimer = setInterval(tick, pollInterval);

  // Reclaim stuck jobs + sweep exhausted ones — regardless of role
  _reclaimTimer = setInterval(reclaimStuck, RECLAIM_MS);

  // Prune the broadcast-handled dedup map every minute so it can't grow
  // unbounded. Entries older than 5 minutes are safe to drop — by then any
  // postgres INSERT realtime event for that key has long since arrived.
  _idempotencyCleanupTimer = setInterval(() => {
    const cutoff = Date.now() - _BROADCAST_DEDUP_TTL_MS;
    for (const [k, ts] of _broadcastHandled) {
      if (ts < cutoff) _broadcastHandled.delete(k);
    }
  }, 60_000);

  // Immediate first tick — drain anything left from previous session
  setTimeout(tick, 500);
}

// ─── FAST PATH: handle an incoming broadcast print event ─────────────────────
// Called on master only. Prints bytes directly without waiting for the
// durable postgres row. Then upserts the row to status='printed' so the audit
// trail still ends up correct.
async function handleFastBroadcast(payload) {
  if (!_running || !_isMaster) return;
  if (!payload || !payload.idempotency_key) return;
  const key = payload.idempotency_key;
  // Dedup: ignore if we already handled this broadcast (duplicate fanout)
  if (_broadcastHandled.has(key)) return;
  _broadcastHandled.set(key, Date.now());

  try {
    const bytes = base64ToBytes(payload.payload_b64 || '');
    if (!bytes?.length) throw new Error('Empty payload');
    const printer = findPrinter(payload.printer_id) || {
      address: payload.printer_ip,
      port: payload.printer_port || 9100,
      name: payload.printer_id,
    };
    const ip = printer.address || payload.printer_ip;
    if (!ip) throw new Error('No printer IP');

    const result = await printService._dispatchBytesDirect(
      bytes, ip, printer.port || payload.printer_port || 9100
    );
    if (!result?.ok) throw new Error(result?.error || 'Native bridge failed');

    // Upsert the audit row to status='printed'. ON CONFLICT (idempotency_key)
    // means whether MPOS's INSERT lands first or this upsert lands first,
    // the row ends up correct: status='printed', no double dispatch.
    // NOTE the error handling: PostgREST RESOLVES with { data, error } when the
    // database rejects a write — it does not reject — so the old second .then()
    // callback never ran. The error lives in the resolved value; read it there.
    // Still fire-and-forget, and deliberately NOT awaited inside this try: a throw
    // here would hit the catch below, which drops the dedup key and hands the job
    // to the durable path — printing a ticket that is already on paper.
    // If the upsert is lost, the row stays 'pending' and MPOS's own INSERT arrives
    // on the realtime channel, where the dedup map routes it to markPrintedDurable.
    supabase.from('print_jobs').upsert({
      location_id:     payload.location_id,
      printer_id:      payload.printer_id,
      printer_ip:      payload.printer_ip,
      printer_port:    payload.printer_port,
      job_type:        payload.job_type || 'receipt',
      payload:         payload.payload_b64,
      status:          'printed',
      idempotency_key: key,
      processed_at:    new Date().toISOString(),
      attempts:        1,
      metadata:        payload.metadata || null,
    }, { onConflict: 'idempotency_key' }).then(
      ({ error }) => { if (error) console.warn('[PrintOrchestrator] broadcast upsert failed (job is on paper):', error.message || error); },
      (e) => console.warn('[PrintOrchestrator] broadcast upsert threw (job is on paper):', e?.message || e),
    );
    printService.recordPrinterHealth(payload.printer_id, 'online').catch(() => {});
  } catch (e) {
    // Broadcast print failed — drop the dedup entry so the postgres-INSERT
    // path can retry. The phone's durable insert is still in flight; once
    // that row lands we'll claim and dispatch it normally.
    _broadcastHandled.delete(key);
    console.warn('[PrintOrchestrator] fast broadcast dispatch failed, falling back to durable path:', e?.message || e);
    if (payload.printer_id) {
      printService.recordPrinterHealth(payload.printer_id, 'offline', e?.message).catch(() => {});
    }
  }
}

// ─── print_jobs bookkeeping ──────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One print_jobs write, with the two failure modes this file used to be blind to:
 *   1. PostgREST RESOLVES with { data, error } when the database rejects a write —
 *      it does NOT reject. Every `.then(ok, err)` and `.catch()` around these
 *      updates was dead code for RLS and constraint failures.
 *   2. A policy that matches zero rows is a plain success with an empty body, so
 *      even a correct `if (error)` check passes. Ask for the id back and treat
 *      nothing coming back as a failure.
 * (The claim update already relies on select-after-update, so SELECT is available
 * on this table wherever UPDATE is.)
 */
async function updateJobRow(jobId, patch) {
  if (!supabase) return { error: new Error('no supabase client') };
  try {
    const { data, error } = await supabase.from('print_jobs').update(patch).eq('id', jobId).select('id, idempotency_key');
    if (error) return { error };
    if (!data || data.length === 0) return { error: new Error(`matched 0 rows for job ${jobId} — RLS blocked it or the row is gone`) };
    return { error: null, row: data[0] };
  } catch (e) {
    return { error: e instanceof Error ? e : new Error(String(e)) };
  }
}

// Mark a row as printed (also used when the broadcast fast path already printed it).
const markRowPrinted = (jobId) => updateJobRow(jobId, {
  status: 'printed',
  processed_at: new Date().toISOString(),
  claimed_by: null,
  claim_expires_at: null,
  error_message: null,
});

// Park a job that IS on paper outside the reclaimable statuses. failed_permanent is in
// neither reclaimStuck's ('claimed','sending') filter, nor the poll's ('pending','failed'),
// nor PrintRetrier's — so nothing anywhere reprints it. (The exhausted-job sweep only
// ever writes failed_permanent, so it cannot bring one back either.)
const parkPrinted = (jobId) => updateJobRow(jobId, {
  status: 'failed_permanent',
  processed_at: new Date().toISOString(),
  claimed_by: null,
  claim_expires_at: null,
  error_message: 'PRINTED but not recorded — the ticket IS on paper. Dismiss this; Retry would print it a second time.',
});

const PARK_RETRY_MS = 30_000;

// Keep trying to park until the write lands. Until it does, _printedLocally is the only
// thing stopping a reprint, and it covers just this page — a reload or a child device
// would print the ticket again. Once the row is parked the guard is no longer needed.
function scheduleParkRetry(jobId) {
  setTimeout(async () => {
    if (!_printedLocally.has(jobId)) return;   // operator already overrode it
    const { error } = await parkPrinted(jobId);
    if (!error) {
      _printedLocally.delete(jobId);
      return;
    }
    if (_running) scheduleParkRetry(jobId);
  }, PARK_RETRY_MS);
}

/**
 * Durably record that a job is ON PAPER — the one write in this file that must not
 * be lost quietly.
 *
 * WHY: a job left in 'claimed' past claim_expires_at is exactly what reclaimStuck
 * resets to 'pending', and the next poll prints it again. A lost mark-printed is
 * therefore a DUPLICATE KITCHEN TICKET, not a cosmetic status glitch. So:
 *   1. mark it printed
 *   2. one retry after a beat — rides out a transient blip, well inside the 30s claim
 *   3. park it as failed_permanent with an explicit message. That status is in
 *      neither reclaimStuck's ('claimed','sending') filter nor the poll's
 *      ('pending','failed') filter, so nothing reprints it, and the operator sees it
 *      in Action Required and dismisses it
 *   4. if even that write is refused, remember the id locally so THIS device never
 *      re-dispatches it, and log loudly
 * Fire-and-forget by design: paper is already out, so no caller waits on this.
 */
async function markPrintedDurable(jobId) {
  let { error } = await markRowPrinted(jobId);
  if (!error) return;
  console.warn('[PrintOrchestrator] mark-printed failed (job is on paper), retrying:', error.message || error);

  await sleep(750);
  ({ error } = await markRowPrinted(jobId));
  if (!error) return;

  // Out of retries. Park the job OUTSIDE the reclaimable statuses — a ticket sitting
  // in Action Required is recoverable, a second identical food order is not.
  const { error: parkErr } = await parkPrinted(jobId);
  if (parkErr) {
    _printedLocally.set(jobId, { warnedAt: Date.now() });
    console.error('[PrintOrchestrator] job printed but NOT recorded and could not be parked — guarding it locally and retrying:', jobId, parkErr.message || parkErr);
    scheduleParkRetry(jobId);
  }
}

// (base64ToBytes + findPrinter helpers defined further down — reused here)

export function stopPrintOrchestrator() {
  if (!_running) return;
  _running = false;
  clearInterval(_pollTimer);
  clearInterval(_reclaimTimer);
  clearInterval(_idempotencyCleanupTimer);
  if (_channel && supabase) supabase.removeChannel(_channel);
  if (_fastChannel && supabase) supabase.removeChannel(_fastChannel);
  _pollTimer = _reclaimTimer = _idempotencyCleanupTimer = _channel = _fastChannel = null;
  for (const t of _retryTimers) clearTimeout(t);
  _retryTimers.clear();
  _inflight.clear();
  _broadcastHandled.clear();
}

// Arm a scan for the exact moment a scheduled retry becomes due. The backoff ladder is
// 2s / 10s / 30s / 2min, all shorter than the backstop poll, so without this a failed
// kitchen ticket would sit until the next scan. The small margin lets the row's
// next_retry_at pass before the query filters on it.
function scheduleRetryTick(delayMs) {
  if (!_running) return;
  const t = setTimeout(() => { _retryTimers.delete(t); tick(); }, Math.max(0, delayMs) + 500);
  _retryTimers.add(t);
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

    // Find eligible jobs: pending OR (failed AND due), not claimed.
    //
    // v5.6.83: "due" now includes next_retry_at IS NULL. This orchestrator only ever
    // writes a failed row WITH a next_retry_at, but it is not the only writer — the LAN
    // print agent and PrintRetrier's reaper both park rows as 'failed' with the column
    // left null, and those tickets used to fall through this filter and never retry
    // here at all. PrintRetrier was quietly covering that; it no longer runs alongside
    // us (see startPrintRetrier), so this engine has to cover it.
    const { data, error } = await supabase
      .from('print_jobs')
      .select('id, status, attempts, next_retry_at, created_at')
      .eq('location_id', _locationId)
      .in('status', ['pending', 'failed'])
      .is('claimed_by', null)
      .or(`status.eq.pending,and(status.eq.failed,next_retry_at.lte.${nowIso}),and(status.eq.failed,next_retry_at.is.null)`)
      .lte('created_at', cutoffIso)
      .order('created_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (error) { console.warn('[PrintOrchestrator] poll rejected:', error.message || error); return; }
    if (!data) return;

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
  // Already on paper from this device, with the bookkeeping refused — see
  // markPrintedDurable. The poll retries this every couple of seconds, so say so
  // once a minute rather than on every pass.
  const printed = _printedLocally.get(jobId);
  if (printed) {
    if (Date.now() - printed.warnedAt > 60_000) {
      printed.warnedAt = Date.now();
      console.warn('[PrintOrchestrator] NOT re-dispatching a job this device already printed:', jobId);
    }
    return;
  }
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

    // The poll only has an id to go on, so it can't consult the broadcast dedup map
    // before claiming — check now that we have the row. Without this, a fast-path
    // print whose 'printed' write was lost comes back round as a second ticket.
    // (handleFastBroadcast removes the key when ITS print failed, so anything still
    // in the map is genuinely on paper.)
    if (claimed.idempotency_key && _broadcastHandled.has(claimed.idempotency_key)) {
      markPrintedDurable(claimed.id);
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
    // Still fire-and-forget for latency, but markPrintedDurable now actually sees a
    // rejected write (PostgREST resolves with { error }, it never rejected here) and
    // guarantees the row ends up somewhere reclaimStuck won't turn back into a
    // second copy of this ticket.
    markPrintedDurable(job.id);
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
    // Exhausted — goes to Action Required queue. This write is the ONLY thing that
    // ends the retry loop, and its rejection used to be discarded: the row stayed
    // 'claimed', reclaimStuck put it back to 'pending', and the job cycled forever
    // instead of surfacing to an operator. Nothing printed, so a retry here is safe.
    const patch = {
      status:            'failed_permanent',
      attempts:          nextAttempt,
      error_message:     errMsg,
      claimed_by:        null,
      claim_expires_at:  null,
      processed_at:      new Date().toISOString(),
    };
    let { error } = await updateJobRow(job.id, patch);
    if (error) {
      await sleep(750);
      ({ error } = await updateJobRow(job.id, patch));
    }
    if (error) console.error('[PrintOrchestrator] could not mark job failed_permanent — it will keep retrying:', job.id, error.message || error);
    else announcePermanentFailure(job, patch);
    return { error };
  }

  // Schedule next retry
  const delayMs = RETRY_SCHEDULE_MS[nextAttempt] ?? RETRY_SCHEDULE_MS[RETRY_SCHEDULE_MS.length - 1];
  const nextRetryAt = new Date(Date.now() + delayMs).toISOString();

  const { error } = await updateJobRow(job.id, {
    status:            'failed',
    attempts:          nextAttempt,
    error_message:     errMsg,
    next_retry_at:     nextRetryAt,
    claimed_by:        null,
    claim_expires_at:  null,
  });
  // A lost retry-schedule write leaves the row 'claimed' — reclaimStuck picks it up
  // on the next sweep, so the job isn't stranded, but the attempt count and the
  // operator's error message are gone. Worth saying out loud rather than swallowing.
  if (error) console.warn('[PrintOrchestrator] could not record print failure:', job.id, error.message || error);
  // v5.6.83: come back for this exact job when its backoff expires, rather than
  // whenever the backstop poll next happens to run.
  else scheduleRetryTick(delayMs);
  return { error };
}

// v5.6.83: folded in from PrintRetrier, which used to be the only thing that emitted
// this. Documented contract for the StatusDrawer failure queue (nothing subscribes to
// it in the app today, but a dead engine must not take a published event with it).
function announcePermanentFailure(job, patch) {
  try {
    window.dispatchEvent(new CustomEvent('rpos-print-permanent-failure', { detail: { ...job, ...patch } }));
  } catch { /* non-DOM context */ }
}

// ─── Reclaim stuck jobs ──────────────────────────────────────────────────────
// A job stuck in 'claimed' or 'sending' past claim_expires_at means the
// claiming device crashed mid-dispatch. We reset it so another device picks up.
async function reclaimStuck() {
  if (!_running || !supabase) return;

  try {
    const nowIso = new Date().toISOString();
    // 0 rows is the normal case here (nothing stuck), so there's nothing to detect —
    // but a rejected reclaim means genuinely stuck jobs never come back, so log it.
    let q = supabase.from('print_jobs')
      .update({
        status: 'pending',
        claimed_by: null,
        claim_expires_at: null,
      })
      .eq('location_id', _locationId)
      .in('status', ['claimed', 'sending'])
      .lt('claim_expires_at', nowIso);
    // v5.6.83, carried over from PrintRetrier's reaper: a job this device printed but
    // could not record is deliberately left 'claimed' (see markPrintedDurable). From
    // here it is indistinguishable from a crashed worker, and putting it back to
    // 'pending' hands a ticket that is already on paper to the next scan.
    const printed = printedLocallyIds();
    if (printed.length) q = q.not('id', 'in', `(${printed.join(',')})`);
    const { error } = await q;
    if (error) console.warn('[PrintOrchestrator] reclaim failed:', error.message || error);
  } catch (e) {
    console.warn('[PrintOrchestrator] reclaim threw:', e?.message || e);
  }

  // v5.6.83, folded in from PrintRetrier.escalateExhausted: catch rows that used up
  // their attempts but never got flipped (the escalating write was lost, or another
  // device/the LAN agent bumped attempts without escalating). Without this sweep an
  // exhausted ticket cycles forever instead of surfacing in Action Required.
  try {
    const { error } = await supabase.from('print_jobs')
      .update({ status: 'failed_permanent' })
      .eq('location_id', _locationId)
      .eq('status', 'failed')
      .gte('attempts', MAX_ATTEMPTS);
    if (error) console.warn('[PrintOrchestrator] exhausted-job sweep failed:', error.message || error);
  } catch (e) {
    console.warn('[PrintOrchestrator] exhausted-job sweep threw:', e?.message || e);
  }
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
// A deliberate Retry/Reroute must clear every reason this device would otherwise
// skip the dispatch, or the operator's reprint silently does nothing.
function clearReprintGuards(jobId, row) {
  _printedLocally.delete(jobId);
  if (row?.idempotency_key) _broadcastHandled.delete(row.idempotency_key);
}

export async function operatorRetryJob(jobId) {
  if (!supabase) return { ok: false, error: 'offline' };
  const { error, row } = await updateJobRow(jobId, {
    status:        'pending',
    attempts:      0,
    next_retry_at: null,
    error_message: null,
    claimed_by:    null,
    claim_expires_at: null,
    dismissed_at:  null,
  });
  if (error) return { ok: false, error: error.message };
  // An operator asking for this job again overrides BOTH dedup guards — they can see
  // the ticket (or its absence) and we can't. Miss the broadcast one and the retry is
  // claimed, marked printed by claimAndDispatch and never dispatched.
  clearReprintGuards(jobId, row);
  return { ok: true };
}

export async function operatorDismissJob(jobId) {
  if (!supabase) return { ok: false, error: 'offline' };
  const { error } = await updateJobRow(jobId, {
    status:       'dismissed',
    dismissed_at: new Date().toISOString(),
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function operatorRerouteJob(jobId, newPrinterId) {
  if (!supabase) return { ok: false, error: 'offline' };
  const printer = findPrinter(newPrinterId);
  const { error, row } = await updateJobRow(jobId, {
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
  });
  if (error) return { ok: false, error: error.message };
  clearReprintGuards(jobId, row);   // deliberate operator action, same as Retry
  return { ok: true };
}
