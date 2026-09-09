// supabase/functions/_shared/terminalKick.js
//
// WHO KICKS AN ADYEN CLOUD JOB, AND WHICH STRANDED JOBS THE SWEEP MAY KICK.
//
// Pure decisions only. No I/O, no Deno, no Supabase: this file is imported by
// terminal-job-create (the server-side kick at create time) and by
// adyen-terminal-charge (action 'sweep_unsent'), and it is unit-tested from
// src/lib/payments/terminalKick.test.js under plain node. Keep it that way.
//
// THE INCIDENT THIS EXISTS FOR (9 Sep 2026, live venue, first in-person live
// card). terminal-job-create minted an Adyen job in charging_unsent with
// charge_minor stamped; the till was responsible for the follow-up
// adyen-terminal-charge 'start' kick and never sent it (a Sunmi WebView on a
// stale bundle, the documented trap). The reader was never asked, the job sat
// charging_unsent with nexo_service_id null, and the only request that minute
// was the till's 'result' check 68 seconds later. Same class as 19 Aug
// (v5.6.86 / v5.6.88). The server now kicks too, and a sweep re-kicks anything
// still unsent; both go through the fn's CAS (charging_unsent -> charging), so
// a duplicate kick is harmless by construction.
//
// THE ONE THING A CLOUD KICK MUST NEVER TOUCH: a job the device itself drives
// over the LOCAL nexo bridge (MPOS running ON an Adyen Android terminal,
// prepare_local -> 127.0.0.1:8443 -> report_local, v5.6.81). For that job the
// cloud 'start' is not a duplicate but a RACE for the same CAS: whichever
// transport wins owns the tender, and a lost race leaves the local half
// answering 'in_flight' while Adyen puts the card prompt up over the cloud.
// isLocalBridgeJob() is the single place that tells such a job apart, from
// three independent signals so a stale MPOS bundle that never learned the
// local_bridge flag is still recognised:
//   1. the create request said local_bridge:true (fresh MPOS bundles),
//   2. the check draft's source is one MPOS writes ONLY on the local path
//      (every MPOS bundle since v5.6.81 sends 'mpos_adyen_local'),
//   3. the job's target terminal row and its POS device row carry the SAME
//      auth uid. One browser holds one Supabase session: on an MPOS-on-terminal
//      both devices.device_uid (claim_device) and terminal_devices.device_uid
//      (register_terminal_device) are that one uid. A cloud AMS1 row is minted
//      by adyen-terminal-admin with a random device_uid, so it can never match.

/** A stranded job must have been unsent for at least this long before the sweep kicks it. */
export const UNSENT_SWEEP_MIN_AGE_MS = 20_000;
/**
 * ...and no older than this. The ceiling is set by 'result' recovery, not by
 * the 15-minute lease: adyen-terminal-charge 'result' treats an InProgress
 * answer on a job dispatched more than 120s ago as a dead tender and sends the
 * reader an abort, and every till polls 'result' from 8s after the job goes
 * 'charging'. A re-kick of an older job would put a card prompt up that the
 * next poll tears down under the customer, and with no till polling at all it
 * would end in needs_human instead of the quiet cancel terminal_jobs_sweep
 * gives an unsent job. 100s keeps a margin inside that rule; a 1-minute cron
 * still lands at least once in the 80s window. Older rows belong to
 * terminal_jobs_sweep.
 */
export const UNSENT_SWEEP_MAX_AGE_MS = 100_000;
/** Kicks per sweep run. Each kick is one long /sync call; the runner must stay small. */
export const UNSENT_SWEEP_LIMIT = 10;
/** check_draft.source values only ever written by a device that drives its own reader. */
export const LOCAL_BRIDGE_SOURCES = Object.freeze(['mpos_adyen_local']);
/**
 * check_draft.source values whose client kicks the cloud 'start' ITSELF right
 * after create and, on a lost CAS, abandons the tender (MPOS runCloudTerminalFlow
 * v5.8.23 to v5.8.44 forgets the job handle and throws on any kickError; the
 * approved job is then not in LIVE, a retry mints a fresh id, and a second
 * prompt goes up for the same bill). The create-time server kick must not race
 * that client. The SWEEP still covers these jobs: it only fires when the
 * client's own kick never landed (still charging_unsent 20s later), so there
 * is nothing left to race.
 */
export const CLIENT_KICKED_SOURCES = Object.freeze(['mpos_cloud_terminal']);

/**
 * Does the job's client own the create-time kick outright (no server kick at
 * create / re-attach)? Only terminal-job-create asks this; the sweep does not.
 */
export function clientOwnsCreateKick(job) {
  const draft = job && typeof job === 'object' ? job.check_draft : null;
  const src = draft && typeof draft === 'object' ? draft.source : null;
  return typeof src === 'string' && CLIENT_KICKED_SOURCES.includes(src);
}

function ms(v) {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : NaN;
}

/**
 * Is this job driven by the device itself over the local nexo bridge?
 * Any ONE signal is enough: the cost of a false negative (a cloud kick racing a
 * local tender) is far higher than that of a false positive (a stranded local
 * job left to its own recovery paths).
 *
 * @param {object} p
 * @param {boolean} [p.localBridge]        the create request's local_bridge flag
 * @param {object}  [p.checkDraft]         terminal_jobs.check_draft
 * @param {string}  [p.terminalDeviceUid]  terminal_devices.device_uid of the job's target
 * @param {string}  [p.posDeviceUid]       devices.device_uid of the job's pos_device_id
 */
export function isLocalBridgeJob({ localBridge, checkDraft, terminalDeviceUid, posDeviceUid } = {}) {
  if (localBridge === true) return true;
  const src = checkDraft && typeof checkDraft === 'object' ? checkDraft.source : null;
  if (typeof src === 'string' && LOCAL_BRIDGE_SOURCES.includes(src)) return true;
  if (terminalDeviceUid && posDeviceUid && String(terminalDeviceUid) === String(posDeviceUid)) return true;
  return false;
}

/**
 * Should the SERVER kick this job's cloud 'start' right after create / re-attach?
 * Mirrors the till's own rule (terminalJobs.js: adyen && charging_unsent && !localBridge)
 * plus the fn's pre-CAS refusals that would only produce noise (no charge, simulated, training).
 *
 * @returns {{ kick: boolean, reason: string }}
 */
export function shouldServerKick(job, { localBridge, terminalDeviceUid, posDeviceUid } = {}) {
  if (!job || typeof job !== 'object') return { kick: false, reason: 'no job' };
  if (job.processor !== 'adyen') return { kick: false, reason: `processor ${job.processor ?? 'ryft'}` };
  if (job.status !== 'charging_unsent') return { kick: false, reason: `status ${job.status}` };
  if (job.charge_minor == null || !Number.isFinite(Number(job.charge_minor))) return { kick: false, reason: 'no charge_minor' };
  if (job.simulated === true) return { kick: false, reason: 'simulated' };
  if (job.training === true) return { kick: false, reason: 'training' };
  if (isLocalBridgeJob({ localBridge, checkDraft: job.check_draft, terminalDeviceUid, posDeviceUid })) {
    return { kick: false, reason: 'local bridge drives this reader' };
  }
  return { kick: true, reason: 'adyen cloud job unsent' };
}

/**
 * Which stranded jobs qualify for a sweep kick.
 *
 * @param {Array<object>} jobs            terminal_jobs rows (any status; re-checked here)
 * @param {object} opts
 * @param {Map|Record} opts.terminalsById terminal_devices rows keyed by id:
 *                                        { id, device_uid, adyen_terminal_id, status, active }
 * @param {Map|Record} [opts.devicesById] devices rows keyed by id: { id, device_uid }
 * @param {number} [opts.now]             epoch ms
 * @param {number} [opts.minAgeMs]        default UNSENT_SWEEP_MIN_AGE_MS
 * @param {number} [opts.maxAgeMs]        default UNSENT_SWEEP_MAX_AGE_MS
 * @param {number} [opts.limit]           default UNSENT_SWEEP_LIMIT
 * @returns {{ kick: string[], skipped: Array<{ id: string, reason: string }> }}
 *   kick is oldest-first and bounded by limit.
 */
export function selectUnsentSweepCandidates(jobs, {
  terminalsById, devicesById, now = Date.now(),
  minAgeMs = UNSENT_SWEEP_MIN_AGE_MS, maxAgeMs = UNSENT_SWEEP_MAX_AGE_MS, limit = UNSENT_SWEEP_LIMIT,
} = {}) {
  const termOf = (id) => (terminalsById instanceof Map ? terminalsById.get(id) : terminalsById?.[id]) ?? null;
  const devOf = (id) => (id == null ? null : (devicesById instanceof Map ? devicesById.get(id) : devicesById?.[id]) ?? null);

  const kick = [];
  const skipped = [];
  const eligible = [];
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!job?.id) continue;
    const base = shouldServerKick(job, {
      terminalDeviceUid: termOf(job.target_terminal_id)?.device_uid ?? null,
      posDeviceUid: devOf(job.pos_device_id)?.device_uid ?? null,
    });
    if (!base.kick) { skipped.push({ id: job.id, reason: base.reason }); continue; }

    const created = ms(job.created_at);
    if (!Number.isFinite(created)) { skipped.push({ id: job.id, reason: 'no created_at' }); continue; }
    const age = now - created;
    if (age < minAgeMs) { skipped.push({ id: job.id, reason: 'too young' }); continue; }
    if (age > maxAgeMs) { skipped.push({ id: job.id, reason: 'too old (DB sweeper owns it)' }); continue; }

    // BACKOFF. A 'start' that Adyen rejected outright (4xx before any card
    // interaction) CAS-reverts the row to charging_unsent and bumps updated_at;
    // so does a 'result' NotFound revert. Wait the same minimum age again after
    // that write, so a rejecting reader is asked every ~20s, not on every tick
    // of every sweeper at the venue.
    const updated = ms(job.updated_at);
    if (Number.isFinite(updated) && now - updated < minAgeMs) { skipped.push({ id: job.id, reason: 'recently touched' }); continue; }

    const term = termOf(job.target_terminal_id);
    if (!term) { skipped.push({ id: job.id, reason: 'terminal row missing' }); continue; }
    if (!term.adyen_terminal_id) { skipped.push({ id: job.id, reason: 'terminal not a cloud reader' }); continue; }
    if (term.status !== 'paired' || term.active === false) { skipped.push({ id: job.id, reason: 'terminal not paired' }); continue; }

    eligible.push({ id: job.id, created });
  }

  eligible.sort((a, b) => a.created - b.created);
  for (const e of eligible) {
    if (kick.length >= limit) { skipped.push({ id: e.id, reason: 'over limit' }); continue; }
    kick.push(e.id);
  }
  return { kick, skipped };
}
