/**
 * terminalJobs.js — the POS half of PaxPay mode 3 ("send this payment to that reader").
 *
 * Mint → persist → dispatch → poll → cancel. Nothing here computes money beyond
 * converting the POS's own already-computed £ figures into minor units exactly
 * once; the server owns charge_minor and the tip cap.
 *
 * ORDER OF OPERATIONS MATTERS (spec money-safety rule 3):
 *   The job id and check_key are minted and written to localStorage BEFORE any
 *   network call. If the dispatch response is lost, the next attempt reuses the
 *   same id, hits idx_tj_one_live_per_check, and the edge function returns the
 *   EXISTING job. A double-press, a modal remount or a page refresh therefore
 *   re-attaches to the live job instead of minting a second one.
 *
 *   Only a 23505 means "already recorded". Every other error surfaces — the two
 *   must reach opposite conclusions, or a caller ends up believing a write landed
 *   when no row exists (spec rule 14).
 *
 * Static imports only — dynamic import() silently fails in this Vite bundle.
 *
 * Spec: docs/PAXPAY_TRANSPORT_SPEC.md
 */

import { supabase, ensureAuthToken, getActiveLocationSync, isMock } from '../supabase';
import { isTrainingMode } from '../trainingMode';

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;
const LS_KEY = 'rpos-terminal-jobs';

/** Statuses in which a job is still live and must not be duplicated. */
export const LIVE_STATUSES = ['pending', 'claimed', 'tipping', 'charging_unsent', 'charging', 'unknown'];
/** Statuses the POS must treat as "stop, a human decides". */
export const BLOCKING_STATUSES = ['unknown'];

// ── local durable handle ──────────────────────────────────────────────────────
// localStorage is an offline fallback cache only (never the record) — the DB row
// is the source of truth. This exists so a reload can find its way back to a job.

function readAll() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
}
function writeAll(map) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(map)); } catch { /* quota */ }
}

export function rememberJob(handle) {
  if (!handle?.checkKey || !handle?.jobId) return;
  const all = readAll();
  all[handle.checkKey] = { ...handle, at: Date.now() };
  writeAll(all);
}
export function recallJob(checkKey) {
  if (!checkKey) return null;
  return readAll()[checkKey] || null;
}
export function forgetJob(checkKey) {
  if (!checkKey) return;
  const all = readAll();
  delete all[checkKey];
  writeAll(all);
}
/** Every job handle this device still has on file — the boot reconciler's input. */
export function allRememberedJobs() {
  return Object.values(readAll());
}

// ── identity ──────────────────────────────────────────────────────────────────

/**
 * This till's Ops `devices.id`, from the pairing record. Same source the Stripe
 * reader path uses (CheckoutModal reads `rpos-device`.id) — NOT deviceConfig,
 * which is the device *profile* and has no device id on it.
 *
 * Used to prefer a terminal bound to this till, and server-side to resolve
 * training mode from the till's profile.
 */
export function getPosDeviceId() {
  try {
    const raw = localStorage.getItem('rpos-device');
    if (!raw) return null;
    return JSON.parse(raw)?.id || null;
  } catch { return null; }
}

export function mintJobId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // Fallback for very old webviews. Still 122 random bits.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * The mutex key. One live job per payable check — keyed on the CHECK, not on the
 * button press, so a second till on the same table collides too.
 */
export function buildCheckKey({ locationId, tableId, sessionId, leg }) {
  const base = `${locationId}:${tableId ?? 'walkin'}:${sessionId ?? '-'}`;
  return leg ? `${base}:${leg}` : base;
}

/** £ → whole minor units. The single conversion point; never round twice. */
export function toMinor(gbp) {
  const n = Math.round((Number(gbp) || 0) * 100);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// ── transport ─────────────────────────────────────────────────────────────────

async function callFn(name, body) {
  const token = await ensureAuthToken();
  if (!token) throw new Error('not authenticated');
  const res = await fetch(`${FUNCTIONS_URL}/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  let j = {};
  try { j = await res.json(); } catch { /* empty body */ }
  if (!res.ok || j?.error) {
    const err = new Error(j?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = j?.code ?? null;
    throw err;
  }
  return j;
}

/** Seen in the last two minutes (the terminal heartbeats every ~60s). Same rule
 *  Back Office uses for its green dot, so the two never disagree in front of staff. */
const TERMINAL_ONLINE_MS = 2 * 60_000;
function terminalIsOnline(t) {
  if (!t?.last_seen_at) return false;
  return Date.now() - new Date(t.last_seen_at).getTime() < TERMINAL_ONLINE_MS;
}

/**
 * Is there a PAX terminal at this location we can send a payment to?
 *
 * Returns `{ terminal, reason }`. NEVER THROWS — a lookup failure must not take
 * the card button down, so an unreachable server leaves `terminal: null` and
 * every existing venue (Stripe readers, Ryft REST) behaves exactly as before.
 *
 * v5.5.838 — RESOLUTION IS NOW FORGIVING. It used to require an exact
 * bound_pos_device_id match or fall through to `data[0]`, and NOTHING ever wrote
 * bound_pos_device_id, so an unassigned terminal was effectively unreachable.
 * The order now is:
 *
 *   1. A terminal bound to THIS till wins outright, online or not — a manager
 *      assigned it on purpose and that decision outranks a heartbeat.
 *   2. Nothing bound, exactly one terminal online → use it. The common case is
 *      one machine behind one bar; making somebody assign it first is friction
 *      with no safety value.
 *   3. Nothing bound, several online → REFUSE, and say why. Picking "the most
 *      recently seen" would hand a card to whichever machine happened to beat
 *      last, which on a two-floor site means presenting a bill upstairs that was
 *      rung up downstairs. A named error beats a silent wrong guess.
 *   4. Nothing online at all but exactly one terminal exists → use it anyway.
 *      That preserves the previous behaviour for a venue whose single terminal is
 *      simply asleep; the job sits `pending` until it wakes, which is what the
 *      15-minute dispatch lease is for.
 *
 * Terminals with "Send from POS" switched off in Back Office are excluded before
 * any of that. `modes` absent (migration not yet applied) means all modes on.
 */
export async function findPaxTerminal({ posDeviceId } = {}) {
  if (isMock || !supabase) return { terminal: null, reason: null };
  const locationId = getActiveLocationSync();
  if (!locationId || locationId === 'loc-demo') return { terminal: null, reason: null };
  try {
    await ensureAuthToken();
    // Through an RPC, not a direct select: a POS till runs on an ANONYMOUS
    // session, so terminal_devices' SELECT policy (device_uid = auth.uid(), or
    // user_locations for a BO user) matches nothing for it and a direct read
    // comes back empty. The RPC fences on the till's own devices row instead of
    // widening a policy on a payments table.
    const { data, error } = await supabase.rpc('terminal_targets_for_pos', {
      p_location_id: locationId,
    });
    if (error || !data?.length) return { terminal: null, reason: null };

    const candidates = data.filter(d => d?.modes?.pos_dispatch !== false);
    if (!candidates.length) return { terminal: null, reason: null };

    // 1. bound to this till
    const bound = posDeviceId
      ? candidates.find(d => d.bound_pos_device_id === posDeviceId)
      : null;
    if (bound) return { terminal: bound, reason: null };

    // 2 / 3. nothing bound — online terminals decide
    const online = candidates.filter(terminalIsOnline);
    if (online.length === 1) return { terminal: online[0], reason: null };
    if (online.length > 1) {
      return {
        terminal: null,
        reason: `${online.length} card terminals at this venue and none is assigned to this till. `
              + 'Assign one in Back Office → Card readers → PAX card terminals → Settings.',
      };
    }

    // 4. none online
    if (candidates.length === 1) return { terminal: candidates[0], reason: null };
    return {
      terminal: null,
      reason: `${candidates.length} card terminals at this venue, none online and none assigned to this till. `
            + 'Assign one in Back Office → Card readers → PAX card terminals → Settings.',
    };
  } catch {
    return { terminal: null, reason: null };
  }
}

/**
 * Create (or re-attach to) the job for this check.
 *
 * @param {object} p
 * @param {string} p.checkKey
 * @param {string} p.targetTerminalId
 * @param {number} p.tipBasisMinor   the BILL — tip % applies to this
 * @param {number} p.dueMinor        what the CARD must take, pre-tip
 * @param {boolean} p.suppressTip    this ONE sale takes no tip (bar tab / takeaway)
 * @param {string} p.closedCheckId   pre-minted, so the check can close without the POS
 * @param {object} p.checkDraft      everything recordClosedCheck needs EXCEPT the tip
 * @returns {{job: object, existing: boolean}}
 */
export async function dispatchTerminalJob(p) {
  // TRAINING MODE — the hard stop. A job row would dispatch a REAL charge to a
  // REAL terminal, and the server-side close path bypasses the client-side
  // training gates entirely. Never reach the network from a training till.
  if (isTrainingMode()) {
    const e = new Error('training mode — no payment is sent to a card terminal');
    e.training = true;
    throw e;
  }

  const locationId = getActiveLocationSync();
  if (!locationId || locationId === 'loc-demo') throw new Error('no location resolved');
  if (!p?.targetTerminalId) throw new Error('no terminal to send to');
  if (!(p.dueMinor > 0)) throw new Error('nothing for the card to take');

  // Mint + persist BEFORE the network call, and reuse any id we already minted
  // for this check — that is what makes a retry idempotent.
  const prior = recallJob(p.checkKey);
  const jobId = prior?.jobId || mintJobId();
  const closedCheckId = prior?.closedCheckId || p.closedCheckId;
  rememberJob({ checkKey: p.checkKey, jobId, closedCheckId, locationId, at: Date.now() });

  const j = await callFn('terminal-job-create', {
    job_id: jobId,
    check_key: p.checkKey,
    target_terminal_id: p.targetTerminalId,
    location_id: locationId,          // cross-checked server-side, never trusted
    pos_device_id: p.posDeviceId ?? null,
    tip_basis_minor: p.tipBasisMinor,
    due_minor: p.dueMinor,
    currency: p.currency || 'GBP',
    // v5.5.841 — THE POS NO LONGER SENDS A TIP CONFIG AT ALL.
    //
    // It used to build one from location_reader_settings and send it as the
    // frozen config. That produced `{"enabled":true,"percentages":null,…}`, and
    // TipConfig.fromJobJson on the terminal reads only `percentBands` /
    // `tip_percentages` — so the terminal received "tipping on, no bands" and
    // showed no tip options. Indistinguishable, to anyone watching, from tipping
    // being switched off.
    //
    // The bands now come from terminal_devices.tip_config, resolved inside
    // terminal-job-create. That is the value Back Office writes and the operator
    // can see, and it is the same column terminal_start_table_payment freezes —
    // so Table Pay and POS dispatch cannot drift apart. ONE source of truth.
    //
    // The only tip fact the till still owns is whether THIS sale takes a tip at
    // all (a bar tab / takeaway / collection never does). That travels as a
    // suppression flag, not as a config: it can only make the job less tippable.
    suppress_tip: !!p.suppressTip,
    closed_check_id: closedCheckId,
    check_draft: p.checkDraft ?? {},
  });

  rememberJob({ checkKey: p.checkKey, jobId, closedCheckId, locationId, at: Date.now() });
  return { job: j.job, existing: !!j.existing };
}

/** Read one job. Goes through the edge function, not RLS — see terminal-job-status. */
export async function fetchJob(jobId) {
  const j = await callFn('terminal-job-status', { job_id: jobId });
  return j.jobs?.[0] ?? null;
}

/** Read several — the boot reconciler's path. */
export async function fetchJobs(jobIds) {
  if (!jobIds?.length) return [];
  const j = await callFn('terminal-job-status', { job_ids: jobIds });
  return j.jobs ?? [];
}

/**
 * Poll a job until it settles. Resolves with the final row.
 *
 * A poll error is NOT a payment failure — the card may well be being charged. We
 * keep polling and let the caller's own timeout decide, because inferring failure
 * from a network blip is how a charged sale gets recorded as declined.
 */
export async function pollTerminalJob(jobId, { onUpdate, intervalMs = 2000, timeoutMs = 5 * 60_000, signal } = {}) {
  const started = Date.now();
  let last = null;
  for (;;) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    try {
      const job = await fetchJob(jobId);
      if (job) {
        last = job;
        onUpdate?.(job);
        if (!LIVE_STATUSES.includes(job.status)) return job;
        // 'unknown' is live-but-terminal: it never resolves itself and must never
        // be retried. Hand it straight back so the POS can block on it.
        if (BLOCKING_STATUSES.includes(job.status)) return job;
      }
    } catch (e) {
      // swallow — see the note above; the timeout below is the real bound
      if (import.meta.env.DEV) console.warn('[terminalJobs] poll error', e?.message || e);
    }
    if (Date.now() - started > timeoutMs) {
      return last ?? { id: jobId, status: 'unknown', needs_human: true };
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

/**
 * Cancel a job. The SERVER decides whether that is allowed — it refuses once
 * charged_at is set. Returns { ok, reason?, status }.
 *
 * The POS must not tell staff "cancelled" until it has observed that status
 * coming back (spec rule 15).
 */
export async function cancelTerminalJob(jobId) {
  if (!supabase) return { ok: false, reason: 'offline' };
  try {
    const { data, error } = await supabase.rpc('terminal_job_cancel', { p_job_id: jobId });
    if (error) return { ok: false, reason: error.message };
    return data ?? { ok: false };
  } catch (e) {
    return { ok: false, reason: e?.message || 'cancel failed' };
  }
}
