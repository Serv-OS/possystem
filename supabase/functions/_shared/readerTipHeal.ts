// supabase/functions/_shared/readerTipHeal.ts
//
// The I/O half of "a tip added on the card machine is never lost" (v5.11.16).
// The decisions are pure and tested in _shared/readerTip.js and
// _shared/closedCheckTip.js; this file only reads, writes and logs.
//
// Used by adyen-terminal-charge (settle, 'result' recovery, the every minute
// sweep inside sweep_unsent), adyen-webhook (the AUTHORISATION trigger) and
// adyen-terminal-events (async PaymentResponse settle).
//
// TWO DATABASES. `ops` is the Ops project (terminal_jobs, closed_checks,
// activity_events): the one that blipped in the incident. `platform` is the
// Platform project (adyen_payments = Adyen's own record, adyen_webhook_events =
// our durable log, keyed on event_key PRIMARY KEY so fixed keys are exactly once).
//
// RACES (every ordering converges; see docs in the v5.11.16 changelog entry):
//   * every job write is a compare-and-set on the state it expects, and a lost
//     reply is read back before it is called lost;
//   * the closed check correction is convergent (delta = job tip minus tender
//     tip) and guarded on the check's tip and total; the tender it corrects
//     carries tip_added_at, so a later pass knows the heal changed that sale;
//   * every activity row (alert or heal) has an id derived from its key
//     (activityIdFor), so it is written exactly once whoever writes it, however
//     often, and a lost reply is harmless;
//   * a person is told BEFORE the job's note leaves 'pending' (the note is what
//     the sweep revisits), so nothing is left unsaid behind a moved note;
//   * a person who already acknowledged the job is never overridden (the heal
//     requires needs_human = true).

// deno-lint-ignore-file no-explicit-any

import {
  TIP_WRITE_RETRY_DELAYS_MS, HEAL_WAIT_ALERT_AFTER_MS, QUIET_REFUSALS,
  tipWriteOutcome, isDefinitiveDbRefusal, planTipHeal, parseAmountMismatch,
  healNote, healNoteState, healActivity, mismatchAlert,
  activityIdFor, alertKey, healActivityKey, tipEvidenceKey, verifiedAuthorisation,
} from './readerTip.js';
import { planCheckTipCorrection, findFinalLeg } from './closedCheckTip.js';
import { applyTipToClosedCheck } from './tip_capture.ts';

const SETTLED = ['approved', 'declined', 'cancelled', 'expired', 'reconciled'];

/** The settle could not be recorded yet. The job stays in flight; recovery settles it later. */
export class SettleDeferred extends Error {
  code = 'SETTLE_DEFERRED';
  constructor(message: string) {
    super(message);
    this.name = 'SettleDeferred';
  }
}

export function isSettleDeferred(e: unknown): boolean {
  return e instanceof SettleDeferred || (e as any)?.code === 'SETTLE_DEFERRED';
}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const msg = (e: unknown) => String((e as any)?.message ?? e ?? 'unknown');

/**
 * Record an on-reader tip on an in-flight job, and PROVE it: up to three
 * attempts, each followed by a read back when no row came back.
 *   'recorded'          tip and charge are on the job
 *   'settled_elsewhere' another path settled the job meanwhile
 *   'conflict'          the job is in some other state (settle anyway, the RPC parks it)
 *   'unrecorded'        the database never confirmed it: DO NOT SETTLE
 */
export async function recordTipWithRetry(ops: any, p: {
  jobId: string; tipMinor: number; authorizedMinor: number; chargeMinor: number;
}): Promise<'recorded' | 'settled_elsewhere' | 'conflict' | 'unrecorded'> {
  for (const delay of TIP_WRITE_RETRY_DELAYS_MS) {
    await sleep(delay);
    try {
      const { data, error } = await ops.from('terminal_jobs')
        .update({ tip_minor: p.tipMinor, charge_minor: p.authorizedMinor, updated_at: new Date().toISOString() })
        .eq('id', p.jobId).is('tip_minor', null).eq('charge_minor', p.chargeMinor)
        .in('status', ['charging', 'unknown'])
        .select('id');
      if (!error && Array.isArray(data) && data.length === 1) return 'recorded';
      if (error) {
        console.error(`[readerTipHeal] tip write on job ${p.jobId} failed: ${error.message}`);
        if (isDefinitiveDbRefusal(error)) return 'conflict';
      }
    } catch (e) {
      console.error(`[readerTipHeal] tip write on job ${p.jobId} threw: ${msg(e)}`);
    }
    let readBack: any = null;
    try {
      const { data, error } = await ops.from('terminal_jobs')
        .select('tip_minor, charge_minor, status').eq('id', p.jobId).maybeSingle();
      readBack = error ? null : data;
    } catch { readBack = null; }
    const out = tipWriteOutcome(readBack, p);
    if (out !== 'retry') return out;
  }
  return 'unrecorded';
}

/**
 * terminal_job_settle_from_processor with the same three attempts. The RPC is
 * idempotent for settled rows, so a retry is safe; a settled status read back
 * after an error is taken as its answer (the call landed, its reply did not).
 * A refusal retrying cannot change throws a plain Error (a 500, as before);
 * a database that never answered throws SettleDeferred.
 */
export async function settleRpcWithRetry(ops: any, args: Record<string, unknown>): Promise<any> {
  let last = 'no answer';
  for (const delay of TIP_WRITE_RETRY_DELAYS_MS) {
    await sleep(delay);
    try {
      const { data, error } = await ops.rpc('terminal_job_settle_from_processor', args);
      if (!error) return data;
      last = error.message;
      if (isDefinitiveDbRefusal(error)) throw Object.assign(new Error(`settle rpc: ${error.message}`), { definitive: true });
    } catch (e) {
      if ((e as any)?.definitive) throw e;
      last = msg(e);
    }
    try {
      const { data: j, error } = await ops.from('terminal_jobs')
        .select('status, needs_human').eq('id', args.p_job_id).maybeSingle();
      if (!error && j && SETTLED.includes(j.status)) {
        return { ok: true, idempotent: true, status: j.status, needs_human: j.needs_human, read_back: true };
      }
    } catch { /* try again */ }
  }
  throw new SettleDeferred(`settle rpc did not answer: ${last}`);
}

/**
 * Durable log row in platform adyen_webhook_events. true only when THIS call
 * inserted it (a fixed key is an exactly once marker). Never throws.
 */
export async function logDurable(platform: any, key: string, raw: Record<string, unknown>): Promise<boolean> {
  try {
    const { error } = await platform.from('adyen_webhook_events').insert({ event_key: key, raw });
    return !error;
  } catch {
    return false;
  }
}

/** Adyen's own rows for a job (merchant_reference 'tj-<id>'). A failed read is reported, never "no rows". */
export async function ledgerRowsForJob(platform: any, jobId: string): Promise<{ rows: any[]; error: string | null }> {
  try {
    const { data, error } = await platform.from('adyen_payments')
      .select('psp_reference, success, amount_minor, amount_refunded_minor, currency, last_event_code, card, raw, created_at, merchant_account, live')
      .eq('merchant_reference', `tj-${jobId}`)
      .order('created_at', { ascending: false })
      .limit(3);
    if (error) return { rows: [], error: error.message };
    return { rows: Array.isArray(data) ? data : [], error: null };
  } catch (e) {
    return { rows: [], error: msg(e) };
  }
}

/**
 * PROVENANCE for an automated settle from the ledger: was the AUTHORISATION
 * behind this row HMAC verified (Ops adyen_events, see verifiedAuthorisation)?
 * true or false, or null when adyen_events could not be read (decides nothing).
 */
export async function ledgerRowVerified(ops: any, row: any, jobId: string): Promise<boolean | null> {
  if (!row?.psp_reference) return false;
  try {
    const { data, error } = await ops.from('adyen_events')
      .select('event_code, psp_reference, merchant_reference, success, hmac_valid, live')
      .eq('psp_reference', String(row.psp_reference)).eq('event_code', 'AUTHORISATION')
      .limit(5);
    if (error) return null;
    return verifiedAuthorisation(Array.isArray(data) ? data : [], row, jobId);
  } catch {
    return null;
  }
}

/** The reader's own figures a deferred settle stored (tipEvidenceKey), or null. Never throws. */
export async function readTipEvidence(platform: any, jobId: string): Promise<any | null> {
  try {
    const { data, error } = await platform.from('adyen_webhook_events')
      .select('raw').eq('event_key', tipEvidenceKey(jobId)).maybeSingle();
    return error ? null : (data?.raw ?? null);
  } catch {
    return null;
  }
}

const JOB_COLS = 'id, processor, simulated, training, status, needs_human, last_error, tip_minor, charge_minor, due_minor, '
  + 'tip_basis_minor, reported_minor, currency, tip_config, capture_mode, payment_session_id, transaction_id, '
  + 'closed_check_id, location_id, check_key, check_draft, settled_at, updated_at';

async function readJob(ops: any, jobId: string): Promise<any | null> {
  try {
    const { data, error } = await ops.from('terminal_jobs').select(JOB_COLS).eq('id', jobId).maybeSingle();
    return error ? null : data;
  } catch { return null; }
}

async function checkRef(ops: any, job: any): Promise<string | null> {
  if (!job?.closed_check_id) return null;
  try {
    const { data } = await ops.from('closed_checks').select('ref')
      .eq('id', job.closed_check_id).eq('location_id', job.location_id).maybeSingle();
    return data?.ref ?? null;
  } catch { return null; }
}

/**
 * Insert ONE activity row, exactly once per key: its id is activityIdFor(key),
 * so a retry after a lost reply, a second writer or the next sweep pass meets
 * the primary key instead of writing a copy.
 *   'inserted'  this call wrote it
 *   'exists'    it was already there (written before, maybe by this very call
 *               on an attempt whose reply was lost)
 *   'failed'    it could not be written: the caller keeps its state so the
 *               next pass tries again
 */
export async function insertActivity(ops: any, job: any, a: { title: string; body: string; severity: string }, key: string): Promise<'inserted' | 'exists' | 'failed'> {
  if (!job?.id || !job?.location_id) return 'failed';
  const id = await activityIdFor(key);
  for (const delay of TIP_WRITE_RETRY_DELAYS_MS) {
    await sleep(delay);
    try {
      const { error } = await ops.from('activity_events').insert({
        id, location_id: job.location_id, kind: 'system', severity: a.severity,
        title: a.title, body: a.body, ref_type: 'terminal_job', ref_id: job.id,
      });
      if (!error) return 'inserted';
      if (String(error.code ?? '') === '23505') return 'exists';
      if (isDefinitiveDbRefusal(error)) {
        console.error(`[readerTipHeal] activity row ${key} refused: ${error.message}`);
        return 'failed';
      }
    } catch { /* try again */ }
  }
  return 'failed';
}

/**
 * Put Adyen's figure in reported_minor so Back Office shows both amounts
 * (UnresolvedPayments.jsx shows the difference only when it is set). Only on a
 * job still parked and only while empty. The figure is our own RPC's park text
 * or the processor's reply, never the caller's.
 */
export async function ensureReportedMinor(ops: any, jobId: string, reportedMinor: number | null | undefined): Promise<void> {
  if (reportedMinor == null || !Number.isFinite(Number(reportedMinor))) return;
  try {
    await ops.from('terminal_jobs')
      .update({ reported_minor: Number(reportedMinor), updated_at: new Date().toISOString() })
      .eq('id', jobId).eq('status', 'approved').eq('needs_human', true).is('reported_minor', null);
  } catch { /* advisory */ }
}

/**
 * Raise ONE activity alert per job and SUBJECT (alertKey: the payment, the
 * wait for Adyen, the sale, a reversal, a late confirmation are separate, so
 * one never swallows another). The activity row itself is the exactly once
 * fact (insertActivity), so there is no gate to go stale: an alert that could
 * not be written is simply written by the next pass. A copy of each new alert
 * goes to the platform log for the audit trail (best effort).
 *   'inserted' | 'exists' | 'failed'  (see insertActivity)
 */
export async function alertOnce(ops: any, platform: any, job: any, kind: string, facts: {
  reason?: string; reportedMinor?: number | null; chargeMinor?: number | null; tipMinor?: number | null;
}): Promise<'inserted' | 'exists' | 'failed'> {
  if (!job?.id || !job?.location_id) return 'failed';
  const key = alertKey(job.id, kind);
  const ref = await checkRef(ops, job);
  const a = mismatchAlert({ kind, reason: facts.reason, ref, reportedMinor: facts.reportedMinor ?? null, chargeMinor: facts.chargeMinor ?? null, tipMinor: facts.tipMinor ?? null, currency: job.currency });
  const r = await insertActivity(ops, job, a, key);
  if (r === 'inserted') {
    await logDurable(platform, key, { kind, reason: facts.reason ?? null, job: job.id, reported: facts.reportedMinor ?? null, charge: facts.chargeMinor ?? null, tip: facts.tipMinor ?? null });
  } else if (r === 'failed') {
    console.error(`[readerTipHeal] alert ${key} could not be written; the next pass tries again`);
  }
  return r;
}

/**
 * After a settle that PARKED an approved job with a different amount: store
 * both figures and the reader's evidence, then try the heal (it covers the
 * case where Adyen's webhook landed before the settle). Best effort, never throws.
 */
export async function reportParkedMismatch(ops: any, platform: any, jobId: string, settled: any, p: {
  success: boolean; authorizedMinor: number | null | undefined; chargeMinor: number; source: string; evidence?: unknown;
}): Promise<void> {
  try {
    if (!(settled?.ok === true && settled?.idempotent !== true && settled?.status === 'approved' && settled?.needs_human === true)) return;
    if (!p.success || p.authorizedMinor == null || p.authorizedMinor === p.chargeMinor) return;
    await ensureReportedMinor(ops, jobId, p.authorizedMinor);
    await logDurable(platform, `amount-mismatch:${jobId}`, {
      source: p.source, chargeMinor: p.chargeMinor, authorizedMinor: p.authorizedMinor, evidence: p.evidence ?? null,
    });
    await healReaderTip(ops, platform, jobId, { trigger: 'settle' });
  } catch (e) {
    console.error(`[readerTipHeal] reportParkedMismatch on job ${jobId}: ${msg(e)}`);
  }
}

/**
 * SELF-CORRECT: heal a job parked with an amount mismatch whose difference is a
 * tip the reader was asked for, confirmed against Adyen's own AUTHORISATION.
 * Never throws. Returns what happened:
 *   not_parked | wait | refuse | healed | error
 */
export async function healReaderTip(ops: any, platform: any, jobId: string, o: { trigger: 'settle' | 'webhook' | 'sweep'; now?: number }): Promise<{ outcome: string; reason?: string }> {
  try {
    const job = await readJob(ops, jobId);
    if (!job) return { outcome: 'error', reason: 'job_unreadable' };
    const first = planTipHeal(job, []);
    if (first.outcome === 'not_parked') return first;
    const parsed = parseAmountMismatch(job.last_error);
    const facts = { reportedMinor: parsed?.processorMinor ?? job.reported_minor ?? null, chargeMinor: job.charge_minor ?? null };

    // The guards before the ledger (not an amount mismatch, tip already set,
    // charge changed) cannot change with Adyen's record: no need to read it.
    let rows: any[] = [];
    if (first.outcome !== 'refuse') {
      const got = await ledgerRowsForJob(platform, jobId);
      if (got.error) return { outcome: 'wait', reason: 'ledger_unreadable' };
      rows = got.rows;
    }
    const plan = first.outcome === 'refuse' ? first : planTipHeal(job, rows);

    if (plan.outcome === 'refuse') {
      const reason = plan.reason ?? 'unknown';
      if (!QUIET_REFUSALS.includes(reason)) {
        await ensureReportedMinor(ops, jobId, facts.reportedMinor);
        await alertOnce(ops, platform, job, reason === 'ambiguous_ledger' ? 'ambiguous' : 'refuse', { ...facts, reason });
      }
      if (o.trigger !== 'sweep') console.log(`[readerTipHeal] job ${jobId} not healed (${o.trigger}): ${reason}`);
      return plan;
    }
    if (plan.outcome === 'wait') {
      await ensureReportedMinor(ops, jobId, facts.reportedMinor);
      const now = o.now ?? Date.now();
      const settledAt = Date.parse(job.settled_at ?? job.updated_at ?? '') || now;
      if (o.trigger === 'sweep' && now - settledAt > HEAL_WAIT_ALERT_AFTER_MS) {
        await alertOnce(ops, platform, job, 'wait', { ...facts, reason: 'no_ledger_row' });
      }
      return plan;
    }
    if (plan.outcome !== 'heal') return plan;

    const tip = Number(plan.tipMinor);
    const amount = Number(plan.amountMinor);
    const oldCharge = Number(job.charge_minor);
    const note = healNote({ tipMinor: tip, psp: String(plan.psp), amountMinor: amount, billMinor: oldCharge, sale: { state: 'pending' } });

    // The job write: compare-and-set on EXACTLY the parked state planned from.
    let done: 'won' | 'refused' | 'changed' | 'unanswered' = 'unanswered';
    for (const delay of TIP_WRITE_RETRY_DELAYS_MS) {
      await sleep(delay);
      try {
        const { data, error } = await ops.from('terminal_jobs')
          .update({
            tip_minor: tip, charge_minor: amount, reported_minor: amount,
            needs_human: false, last_error: note, updated_at: new Date().toISOString(),
          })
          .eq('id', jobId).eq('status', 'approved').eq('needs_human', true)
          .is('tip_minor', null).eq('charge_minor', oldCharge)
          .select('id');
        if (!error && Array.isArray(data) && data.length === 1) { done = 'won'; break; }
        if (error && isDefinitiveDbRefusal(error)) { done = 'refused'; console.error(`[readerTipHeal] heal write on job ${jobId} refused: ${error.message}`); break; }
      } catch (e) { console.error(`[readerTipHeal] heal write on job ${jobId} threw: ${msg(e)}`); }
      const rb = await readJob(ops, jobId);
      if (rb) {
        // Landed (ours with a lost reply, or another healer's): same result, carry on.
        if (Number(rb.tip_minor) === tip && Number(rb.charge_minor) === amount && rb.tip_minor != null) { done = 'won'; break; }
        // Anything else that is not the parked state we planned from: a person
        // or another path decided. Never override it.
        const stillParked = rb.status === 'approved' && rb.needs_human === true && rb.tip_minor == null && Number(rb.charge_minor) === oldCharge;
        if (!stillParked) { done = 'changed'; break; }
      }
    }
    if (done === 'changed') return { outcome: 'refuse', reason: 'changed_meanwhile' };
    if (done === 'refused') {
      await alertOnce(ops, platform, job, 'refuse', { ...facts, reason: 'write_refused' });
      return { outcome: 'refuse', reason: 'write_refused' };
    }
    if (done === 'unanswered') return { outcome: 'wait', reason: 'job_write_unanswered' };

    const row = pickRow(rows, plan.psp);
    await logDurable(platform, `tip-heal:${jobId}`, {
      trigger: o.trigger,
      before: { status: job.status, needs_human: job.needs_human, tip_minor: job.tip_minor, charge_minor: oldCharge, reported_minor: job.reported_minor ?? null, last_error: job.last_error },
      after: { needs_human: false, tip_minor: tip, charge_minor: amount, reported_minor: amount, last_error: note },
      ledger: { psp: plan.psp, amount, currency: plan.currency, event: row?.last_event_code ?? null },
    });
    console.log(`[readerTipHeal] job ${jobId} healed (${o.trigger}): tip ${tip}, charge ${oldCharge} to ${amount}`);
    const healed = { ...job, tip_minor: tip, charge_minor: amount, reported_minor: amount, needs_human: false, last_error: note };
    const sale = await correctHealedSale(ops, platform, healed, { trigger: o.trigger });
    return { outcome: 'healed', reason: sale.state };
  } catch (e) {
    console.error(`[readerTipHeal] healReaderTip on job ${jobId}: ${msg(e)}`);
    return { outcome: 'error', reason: msg(e) };
  }
}

function pickRow(rows: any[], psp: unknown): any {
  return (rows || []).find((r) => String(r?.psp_reference) === String(psp)) ?? null;
}

const toMinor = (v: unknown) => Math.round((Number(v) || 0) * 100);

const CHECK_COLS = 'id, ref, tip, total, tenders, payment_intents, status, voided, refunds';

/** One closed check in the job's venue: the row, null when there is none, undefined when it could not be read. */
async function readCheck(ops: any, checkId: string | null | undefined, locationId: string): Promise<any | null | undefined> {
  if (!checkId) return null;
  try {
    const { data, error } = await ops.from('closed_checks').select(CHECK_COLS)
      .eq('id', checkId).eq('location_id', locationId).maybeSingle();
    return error ? undefined : (data ?? null);
  } catch {
    return undefined;
  }
}

/** The legs on a partial job's check_key (its table occupation), or null when unreadable. */
async function legsOnCheckKey(ops: any, job: any): Promise<any[] | null> {
  if (!job?.check_key) return [];
  try {
    const { data, error } = await ops.from('terminal_jobs')
      .select('id, status, location_id, closed_check_id, check_draft')
      .eq('check_key', job.check_key).eq('location_id', job.location_id)
      .limit(25);
    return error ? null : (Array.isArray(data) ? data : []);
  } catch {
    return null;
  }
}

/** The delta the heal's own first correction of this sale applied (its durable intent), or null. */
async function healedDelta(platform: any, jobId: string): Promise<number | null> {
  try {
    const { data, error } = await platform.from('adyen_webhook_events')
      .select('raw').eq('event_key', `tip-heal-check:${jobId}`).maybeSingle();
    const d = Number(data?.raw?.delta_minor);
    return !error && Number.isInteger(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}

/**
 * Move the job's note from exactly `job.last_error` to `newNote`, with the same
 * three attempts, reading the job back after any attempt that did not confirm:
 * the note already being `newNote` is success (ours with a lost reply, or the
 * identical outcome from another pass); any OTHER note means another pass
 * decided first.
 */
async function moveNote(ops: any, job: any, newNote: string): Promise<boolean> {
  for (const delay of TIP_WRITE_RETRY_DELAYS_MS) {
    await sleep(delay);
    try {
      const { data, error } = await ops.from('terminal_jobs')
        .update({ last_error: newNote, updated_at: new Date().toISOString() })
        .eq('id', job.id).eq('last_error', job.last_error)
        .select('id');
      if (!error && Array.isArray(data) && data.length === 1) return true;
      if (error && isDefinitiveDbRefusal(error)) return false;
    } catch { /* read it back */ }
    const rb = await readJob(ops, job.id);
    if (rb) {
      if (rb.last_error === newNote) return true;
      if (rb.last_error !== job.last_error) return false;
    }
  }
  return false;
}

/**
 * Correct the booked sale of a healed job (tip, total, the card tender's tip)
 * through applyTipToClosedCheck, the one server side tip writer. For a PARTIAL
 * pay-at-table leg the sale is the FINAL leg's check (findFinalLeg); until the
 * final leg has booked it stays pending. Then tell the venue (exactly once, by
 * id), mark the job reconciled when the sale is right, and only THEN move the
 * job's note off 'pending' (the note is what brings the sweep back). Never throws.
 */
export async function correctHealedSale(ops: any, platform: any, job: any, o: { trigger: string }): Promise<{ state: string; reason?: string }> {
  try {
    if (healNoteState(job?.last_error) !== 'pending') return { state: healNoteState(job?.last_error) ?? 'none' };
    const draft = job.check_draft && typeof job.check_draft === 'object' ? job.check_draft : {};

    // Which sale holds this payment: the job's own, or the final leg's.
    let checkId: string | null = job.closed_check_id ?? null;
    let legRefusal: string | null = null;
    if (draft.partial === true) {
      const legs = await legsOnCheckKey(ops, job);
      if (legs == null) return { state: 'pending', reason: 'legs_unreadable' };
      const f: any = findFinalLeg(job, legs);
      if (f.action === 'wait') return { state: 'pending', reason: f.reason };
      if (f.action === 'refuse') legRefusal = f.reason;
      else checkId = f.finalJob.closed_check_id;
    }
    let check: any = null;
    if (!legRefusal) {
      check = await readCheck(ops, checkId, job.location_id);
      if (check === undefined) return { state: 'pending', reason: 'check_unreadable' };
    }
    let plan: any = legRefusal ? { action: 'refuse', reason: legRefusal } : planCheckTipCorrection(check, job);
    if (plan.action === 'wait') return { state: 'pending', reason: plan.reason };

    const markAt = new Date().toISOString();
    let corrected = false;
    let fromM = 0;
    let toM = 0;
    if (plan.action === 'apply') {
      // The durable intent FIRST, exactly once: the first attempt's figures are
      // the true "before", whatever happens to this write's reply.
      await logDurable(platform, `tip-heal-check:${job.id}`, {
        trigger: o.trigger, check: check.id, ref: check.ref ?? null, action: 'apply',
        before: { tip: check.tip, total: check.total, tender: plan.tenderIndex != null ? check.tenders?.[plan.tenderIndex] ?? null : null },
        delta_minor: plan.deltaMinor,
        at: markAt,
      });
      const ok = await applyTipToClosedCheck(ops, {
        closedCheckId: check.id,
        captureId: null,
        psp: job.transaction_id ?? null,
        tipMinor: plan.deltaMinor,
        tenderRef: { transactionId: job.transaction_id ?? null, psp: job.payment_session_id ?? null },
        expect: plan.expect,
        locationId: job.location_id,
        markAt,
      });
      if (ok) {
        corrected = true;
        fromM = toMinor(check.total);
        toM = fromM + plan.deltaMinor;
      } else {
        // A write can land while its reply is lost: look again before calling it lost.
        const again = await readCheck(ops, check.id, job.location_id);
        const re: any = again ? planCheckTipCorrection(again, job) : null;
        if (!(re?.action === 'noop' && re.healedBefore)) return { state: 'pending', reason: 'check_write_lost' };
        check = again;
        plan = re;
      }
    }
    if (plan.action === 'noop') {
      toM = toMinor(check.total);
      if (plan.healedBefore) {
        // The heal itself put this tip on the sale (its tip_added_at marker),
        // on this pass or on one whose reply was lost: the sale WAS corrected
        // after booking, so the venue still gets the "run it again" advice.
        corrected = true;
        const delta = (await healedDelta(platform, job.id)) ?? Number(job.tip_minor);
        fromM = toM - delta;
      } else {
        fromM = toM;
      }
    }

    const ref = check?.ref ?? null;
    const sale: Record<string, unknown> = plan.action === 'refuse'
      ? { state: 'not_corrected', ref, reason: plan.reason }
      : { state: corrected ? 'corrected' : 'right', ref, fromMinor: fromM, toMinor: toM };

    // Tell a person FIRST. The note leaving 'pending' is what stops the sweep
    // coming back, so it moves only once the venue has been told.
    if (plan.action === 'refuse') {
      const told = await alertOnce(ops, platform, job, 'sale_not_corrected', {
        reason: plan.reason, tipMinor: Number(job.tip_minor),
        reportedMinor: Number(job.charge_minor), chargeMinor: Number(job.due_minor),
      });
      if (told === 'failed') return { state: 'pending', reason: 'alert_unwritten' };
    } else {
      // Service role mirror of terminal_pos_mark_reconciled: approved -> reconciled, never while parked.
      try {
        await ops.from('terminal_jobs')
          .update({ status: 'reconciled', updated_at: new Date().toISOString() })
          .eq('id', job.id).eq('status', 'approved').eq('needs_human', false);
      } catch { /* the till's reconciler marks it too */ }
      const told = await insertActivity(ops, job, healActivity({
        ref, tipMinor: Number(job.tip_minor), fromMinor: fromM, toMinor: toM, currency: job.currency, corrected,
      }), healActivityKey(job.id));
      if (told === 'failed') return { state: 'pending', reason: 'activity_unwritten' };
    }

    const newNote = healNote({
      tipMinor: Number(job.tip_minor), psp: String(job.payment_session_id ?? ''),
      amountMinor: Number(job.charge_minor), billMinor: Number(job.due_minor), sale,
    });
    if (!(await moveNote(ops, job, newNote))) return { state: 'lost_race' };
    if (plan.action === 'refuse') return { state: 'not_corrected', reason: plan.reason };
    return { state: corrected ? 'corrected' : 'right' };
  } catch (e) {
    console.error(`[readerTipHeal] correctHealedSale on job ${job?.id}: ${msg(e)}`);
    return { state: 'error', reason: msg(e) };
  }
}
