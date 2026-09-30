// supabase/functions/adyen-terminal-charge
//
// The Adyen in-person charge path for terminal_jobs (processor='adyen') —
// the sibling of terminal-job-charge (Ryft/PAX), sharing its money-safety
// contract but speaking nexo 3.0 to Adyen hardware. ADYEN_INTEGRATION_PLAN.md
// Phase 3 core, built key-independent in Phase 0.
//
// THREE TRANSPORTS, ONE CONTRACT (server computes, device transports, server settles):
//   'start'         cloud Terminal API /sync → AMS1-style terminals the TILL drives.
//                   One long HTTP call returns the final PaymentResponse.
//   'prepare_local' our app ON an Adyen Android terminal (S1E2L / S1E4 Pro MPOS)
//                   asks for the server-built nexo PaymentRequest, posts it to
//                   localhost:8443/nexo itself, then calls…
//   'report_local'  …with the terminal's PaymentResponse. The device's claim is
//                   ADVISORY: we parse, sanity-check the amount, and settle via
//                   the single settle-writer RPC. (Tap to Pay on iPhone/Android
//                   uses this same pair — the POS Mobile SDK consumes the exact
//                   nexo PaymentRequest that prepare_local returns.)
//   'result'        recovery: job settled → say so; else TransactionStatusRequest
//                   over cloud using the PERSISTED nexo_service_id.
//   'sweep_unsent'  (9 Sep 2026) re-kick 'start' for cloud jobs stranded in
//                   charging_unsent. SERVICE ROLE ONLY (pg_cron, every minute,
//                   every venue). See the action block for the exact rule.
//
// MONEY-SAFETY (inherited verbatim from terminal-job-charge):
//   • CAS write-ahead: UPDATE … SET status='charging' WHERE status='charging_unsent'
//     BEFORE any network call — exactly one initiator ever reaches the terminal.
//   • The amount is THE DB'S (terminal_jobs.charge_minor, tj_charge_identity-proven),
//     never the caller's.
//   • Timeout / unknown outcome → row STAYS 'charging'; recovery owns it: 'result'
//     (Adyen's own ledger first, then the reader's TransactionStatus), and the
//     every minute reader tip sweep inside 'sweep_unsent' (runReaderTipSweep),
//     which settles a stranded job from Adyen's ledger. adyen-webhook does NOT
//     settle jobs; since v5.11.16 it only triggers the tip heal on AUTHORISATION.
//   • A tip added on the reader is NEVER settled away (v5.11.16, R3618): the tip
//     write is retried and verified, and if it cannot be recorded the settle is
//     deferred (SettleDeferred, 200 state 'processing') for recovery to settle
//     WITH the tip. A job still parked with an amount mismatch is healed against
//     Adyen's record (_shared/readerTipHeal.ts), or raised to a manager.
//   • Settlement ONLY via terminal_job_settle_from_processor.
//   • Simulated/training jobs refused.
//
// AUTH FENCE: Adyen jobs are driven by the POS DEVICE (there is no on-terminal
// pairing session like PaxPay for cloud mode) — caller must be a paired device
// at the job's location (devices.device_uid = auth.uid()), or the service role.
// For prepare_local/report_local the caller IS the on-terminal app; v5.6.81 also
// accepts it as THE JOB'S OWN TARGET TERMINAL (terminal_devices.device_uid =
// auth.uid() AND id = job.target_terminal_id, paired + active) — see the fence
// block for why that is narrower, not wider, than the device branch.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  terminalEndpoint, adyenFetch, checkoutBase,
  buildPaymentRequest, buildTransactionStatusRequest, buildAbortRequest,
  parsePaymentResponse, newServiceId,
  adyenConfig, adyenEnvForLocation, adyenNotConfiguredMessage, effectiveMerchantAccount, managementBase, lemBase, balancePlatformBase, type AdyenConfig,
} from '../_shared/adyen.ts';
import { insertCaptureRow } from '../_shared/tip_capture.ts';
import {
  pickLedgerRow, planLedgerSettle, amountEvidence, ledgerApproval, ledgerAuthAmount, tipEvidenceKey, ledgerShowsApproval,
  readerTipFromEvidence, lateConfirmationFacts,
  STRANDED_MIN_DISPATCH_AGE_MS, STRANDED_MAX_DISPATCH_AGE_MS, STRANDED_MIN_LEDGER_AGE_MS, STRANDED_PARK_AFTER_MS,
  HEAL_MAX_AGE_MS, PENDING_CHECK_MAX_AGE_MS, AMOUNT_MISMATCH_LIKE, PENDING_NOTE_LIKE,
} from '../_shared/readerTip.js';
import {
  SettleDeferred, isSettleDeferred, recordTipWithRetry, settleRpcWithRetry, logDurable,
  ledgerRowsForJob, reportParkedMismatch, healReaderTip, correctHealedSale, alertOnce,
  ledgerRowVerified, readTipEvidence,
} from '../_shared/readerTipHeal.ts';
import {
  selectUnsentSweepCandidates, UNSENT_SWEEP_MIN_AGE_MS, UNSENT_SWEEP_MAX_AGE_MS, UNSENT_SWEEP_LIMIT,
} from '../_shared/terminalKick.js';
import { secondStepRefusal } from '../_shared/second-step.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const SETTLED = ['approved', 'declined', 'cancelled', 'expired', 'reconciled'];
const settledState = (s: string) => (s === 'reconciled' ? 'approved' : s === 'expired' ? 'cancelled' : s);


// ── Ask ADYEN what happened, not the terminal ────────────────────────────────
// v5.7.84. The terminal is the WRONG thing to ask when a payment is stuck,
// because the usual reason it is stuck is that the terminal is off, flat or off
// the network. Adyen still knows: every authorisation and refusal reaches
// adyen_payments through the webhook, keyed on the merchant reference we set.
//
// So: no row for this job, and the job is old enough that a webhook would have
// landed, means the payment never happened. That is a PROOF of nothing charged,
// which is what lets us clear the till instead of parking the check for a
// manager in the middle of service.
//
// The age floor matters. Webhooks are usually seconds but not instantly, and
// concluding "nothing charged" from a webhook that simply has not arrived yet
// is how you release a check that a customer really did pay for.
const LEDGER_GRACE_MS = 90_000;

// v5.11.16: every row for the job (pickLedgerRow: the one success, else the
// newest refusal; two successes is a possible double charge and decides
// nothing here, the sweep raises it, but it is flagged `ambiguous` so no
// caller ever reads it as "never charged"). A FAILED READ decides nothing
// either: it used to read as "no row", which after 90 s cancelled a job as
// "nothing charged" during a Platform blip.
async function askAdyenLedger(job: any): Promise<
  { verdict: 'charged'; row: any } | { verdict: 'nothing' } | { verdict: 'too_soon'; ambiguous?: boolean }
> {
  const { rows, error } = await ledgerRowsForJob(platformAdmin, job.id);
  if (error) return { verdict: 'too_soon' };
  const pick = pickLedgerRow(rows);
  if (pick.ambiguous) return { verdict: 'too_soon', ambiguous: true };
  if (pick.row) return { verdict: 'charged', row: pick.row };
  const ageMs = Date.now() - new Date(job.created_at).getTime();
  return ageMs < LEDGER_GRACE_MS ? { verdict: 'too_soon' } : { verdict: 'nothing' };
}

function settledBody(job: any) {
  const state = settledState(job.status);
  return {
    ok: true, state, status: state, job_status: job.status,
    transaction_id: job.transaction_id ?? null, auth_code: job.auth_code ?? null,
    card: job.card ?? null, decline_reason: job.decline_reason ?? null,
    payment_session_id: job.payment_session_id ?? null,
  };
}

// v5.7.5 TIP ON RECEIPT: attach the job's capture-window row to a settled
// response so the till can stamp captureId + capture:'pending' onto the
// closed check's payment leg without another round trip. Advisory only.
async function withCapture(bodyObj: Record<string, unknown>, job: { id: string; capture_mode?: string | null }) {
  if (job?.capture_mode !== 'manual') return bodyObj;
  try {
    const { data } = await opsAdmin.from('terminal_captures')
      .select('id, psp_reference, status, deadline_at, auth_minor, tip_minor, final_minor, simulated')
      .eq('job_id', job.id).maybeSingle();
    if (data) return { ...bodyObj, capture: data };
  } catch { /* advisory */ }
  return bodyObj;
}

// nexo card block → the snake_case receipt shape terminal_job_settle_from_processor
// stores and the POS/receipts already render (same keys the Ryft path writes).
function settleCard(p: ReturnType<typeof parsePaymentResponse>) {
  const c = p.card;
  if (!c.brand && !c.last4 && !c.authCode) return null;
  return {
    brand: c.brand, last4: c.last4, auth_code: c.authCode,
    read_method: c.readMethod, aid: c.aid, application_name: c.applicationName,
    cvm: c.cvm, account_type: null,
  };
}

// Settle a job from a parsed PaymentResponse — the ONE downstream for every
// transport. Declines settle 'declined'; Success settles 'approved'. A Partial
// result is settled DECLINED for now: partial approval on a till flow needs the
// staff-alert UX (plan Phase 3) before we can safely leave a remainder unpaid.
//
// REVIEW HARDENING (v968): the authorised-amount fallback to chargeMinor exists
// ONLY for trusted server-side sources (a sync/status/webhook response that came
// from Adyen). A DEVICE-supplied response must carry a real AmountsResp — the
// fallback would let a forged Success blob with no amounts vacuously pass the
// RPC's mismatch check.
const TRUSTED_AMOUNT_SOURCES = new Set(['charge_sync', 'status_recovery', 'event_notification']);
async function settleFromResponse(jobId: string, p: ReturnType<typeof parsePaymentResponse>, source: string, chargeMinor: number, merchantAccount?: string | null) {
  const success = p.result === 'Success';
  if (p.result === 'Partial') {
    console.log(`adyen-terminal-charge: PARTIAL approval on job ${jobId} (${p.authorizedMinor}/${chargeMinor}) — settling declined until partial UX exists`);
  }
  if (success && p.authorizedMinor == null && !TRUSTED_AMOUNT_SOURCES.has(source)) {
    throw new Error('device report has no AuthorizedAmount — refusing to settle approved');
  }
  const effectiveAuthorized = p.authorizedMinor;
  if (success && p.authorizedMinor != null && p.authorizedMinor !== chargeMinor) {
    // Tip added ON the terminal (AskGratuity). Credit it ONLY when the
    // processor's own TipAmount explains the difference EXACTLY — then the
    // job's money is recomputed (charge = due + tip, the tj_charge_identity
    // shape) BEFORE settle so the RPC's mismatch guard agrees. Any other
    // difference still parks for a manager (v5.6.54 — live £1 gratuity parked
    // as 'amount mismatch: processor 5799 vs server 5699').
    const tip = p.tipMinor ?? 0;
    if (tip > 0 && chargeMinor + tip === p.authorizedMinor) {
      // v5.11.16 (R3618): the ONE write that records the tip is retried and
      // VERIFIED by reading the job back. A known tip is never settled away:
      // if the database never confirms it, nothing is settled and recovery
      // ('result', the sweep) settles later WITH the tip.
      const rec = await recordTipWithRetry(opsAdmin, { jobId, tipMinor: tip, authorizedMinor: p.authorizedMinor, chargeMinor });
      if (rec === 'unrecorded') {
        // The reader's own figures, under a fixed key recovery reads back
        // (settleFromLedger): an exact TipAmount is then recorded without the
        // heal's cap, even when no till is watching.
        await logDurable(platformAdmin, tipEvidenceKey(jobId), {
          source, chargeMinor, tipMinor: tip, authorizedMinor: p.authorizedMinor, evidence: amountEvidence(p), at: new Date().toISOString(),
        });
        console.error(`adyen-terminal-charge: on-reader tip ${tip} on job ${jobId} could not be recorded, settle DEFERRED to recovery`);
        throw new SettleDeferred(`tip ${tip} on job ${jobId} could not be recorded yet`);
      }
      console.log(`adyen-terminal-charge: on-reader tip ${tip} on job ${jobId} (${chargeMinor} + tip = ${p.authorizedMinor}): ${rec}`);
    } else {
      console.log(`adyen-terminal-charge: authorised ${p.authorizedMinor} != charge ${chargeMinor} on job ${jobId} and TipAmount ${tip} does not explain it — parking via RPC guard`);
    }
  }
  // Retried like the tip write; a database that never answers is SettleDeferred.
  const settled = await settleRpcWithRetry(opsAdmin, {
    p_job_id: jobId,
    p_outcome: success ? 'approved' : 'declined',
    p_payment_session_id: p.pspReference,          // pspReference rides the session column
    p_transaction_id: p.poiTransactionId ?? p.pspReference,
    p_auth_code: p.card.authCode,
    p_card: settleCard(p),
    p_decline_reason: success ? null : (p.refusalReason ?? p.errorCondition ?? 'declined'),
    p_source: source,
    p_session_amount_minor: effectiveAuthorized ?? (success ? chargeMinor : null),
  });
  await afterSettle(jobId, settled, { success, psp: p.pspReference, merchantAccount, authorizedMinor: effectiveAuthorized, chargeMinor });
  // v5.11.16 ALERT + SELF-CORRECT: a settle that PARKED the job with a
  // different amount stores both figures (Back Office shows them) and the
  // reader's evidence, then tries the heal (covers Adyen's webhook landing
  // before this settle). Best effort, never blocks.
  await reportParkedMismatch(opsAdmin, platformAdmin, jobId, settled, {
    success, authorizedMinor: p.authorizedMinor, chargeMinor, source, evidence: amountEvidence(p),
  });
}

// What every approved settle does next, shared by settleFromResponse and
// settleFromLedger (moved verbatim from settleFromResponse in v5.11.16).
async function afterSettle(jobId: string, settled: any, ctx: {
  success: boolean; psp: string | null; merchantAccount?: string | null; authorizedMinor: number | null; chargeMinor: number;
}) {
  // v5.7.5 TIP ON RECEIPT: an approved manual-capture auth opens its capture
  // window here. insertCaptureRow is idempotent on psp_reference, so replays
  // and the webhook AUTHORISATION backstop can never mint a second row. The
  // insert is best-effort (never blocks the settle); a lost row is re-ensured
  // by adyen-webhook when the AUTHORISATION notification lands.
  try {
    if (ctx.success && ctx.psp) {
      const { data: jrow } = await opsAdmin.from('terminal_jobs')
        .select('capture_mode, closed_check_id, location_id, currency, simulated, charge_minor')
        .eq('id', jobId).maybeSingle();
      if (jrow?.capture_mode === 'manual') {
        await insertCaptureRow(opsAdmin, {
          jobId,
          closedCheckId: jrow.closed_check_id ?? null,
          locationId: jrow.location_id,
          psp: ctx.psp,
          merchantAccount: ctx.merchantAccount ?? null,
          currency: jrow.currency ?? null,
          authMinor: ctx.authorizedMinor
            ?? (jrow.charge_minor != null ? Number(jrow.charge_minor) : ctx.chargeMinor),
          simulated: jrow.simulated === true,
        });
      }
    }
  } catch (e) { console.error('adyen-terminal-charge: capture row insert', (e as Error).message); }
  // Split-leg toast (kept in lockstep with adyen-terminal-events): a PARTIAL
  // pay-at-table leg never books a check, so this activity_events row is the
  // only thing the floor sees. Gated on the RPC's non-idempotent approved
  // transition — exactly-once across the sync/async settle race. Best-effort.
  try {
    if ((settled as any)?.ok === true && (settled as any)?.idempotent !== true
        && (settled as any)?.status === 'approved') {
      const { data: j } = await opsAdmin.from('terminal_jobs')
        .select('location_id, due_minor, check_draft').eq('id', jobId).maybeSingle();
      const d = (j?.check_draft ?? {}) as Record<string, unknown>;
      if (j && d.source === 'adyen_pay_at_table' && d.partial === true) {
        // Publish paid-so-far onto the live session FIRST — that column is what
        // every till and the reader read to know what is still owed.
        await opsAdmin.rpc('terminal_sync_table_paid', { p_job_id: jobId })
          .then(() => {}, (e: Error) => console.error('adyen-terminal-charge: sync paid', e?.message));
        const left = Number(d.remainingAfterMinor) || 0;
        await opsAdmin.from('activity_events').insert({
          location_id: j.location_id, kind: 'system', severity: 'action',
          title: `Part payment — ${d.tableLabel ?? d.tableId ?? 'table'}`,
          body: `£${((Number(j.due_minor) || 0) / 100).toFixed(2)} taken on the card reader. £${(left / 100).toFixed(2)} left to pay — take the rest with Pay at table.`,
          ref_type: 'terminal_job', ref_id: jobId,
        });
      }
    }
  } catch { /* toast is advisory — never block a settle */ }
}

// ── Settle from ADYEN'S OWN RECORD (v5.11.16) ────────────────────────────────
// The recovery path 'result' always meant to have: when the AUTHORISATION (or
// refusal) is already in platform adyen_payments, settle from it. Until
// v5.11.16 both call sites handed settleCard (the one argument card mapper)
// three arguments, which threw before anything settled, so no approved job was
// ever recovered this way. planLedgerSettle (_shared/readerTip.js) decides:
//   decline       Adyen refused it
//   approve       the amount is the charge; or the reader's own TipAmount (the
//                 evidence a deferred settle stored) explains it exactly; or the
//                 difference is a tip the reader was asked for within the heal
//                 bound (recorded FIRST, verified; unrecorded = SettleDeferred,
//                 never settled away)
//   approve_park  (allowPark) settle at Adyen's amount; the RPC parks it and
//                 the heal / alert path takes over
//   skip          leave it for the reader's own TransactionStatus or a person:
//                 includes a payment Adyen approved and then saw refunded,
//                 cancelled or changed ('reversed', 'event_code'), which is
//                 NEVER booked as a paid sale
// Only a row whose AUTHORISATION arrived HMAC verified decides anything here
// (ledgerRowVerified): the ledger is written by our webhook, and an unsigned
// item must never settle a job by itself.
// The psp rides both the session and the transaction column: refunds resolve
// by either (adyen-modify).
async function settleFromLedger(job: any, row: any, opts: { allowPark: boolean; source?: string }): Promise<{ result: 'settled' } | { result: 'skip'; reason: string }> {
  let plan = planLedgerSettle(job, row, { allowPark: opts.allowPark });
  if (plan.reason === 'unexplained_amount') {
    // A settle that deferred on this job stored the reader's own TipAmount.
    const ev = await readTipEvidence(platformAdmin, job.id);
    const readerTipMinor = ev ? readerTipFromEvidence(ev, { amountMinor: ledgerAuthAmount(row), chargeMinor: job.charge_minor }) : null;
    if (readerTipMinor != null) plan = planLedgerSettle(job, row, { allowPark: opts.allowPark, readerTipMinor });
  }
  if (plan.action === 'skip') {
    console.log(`adyen-terminal-charge: ledger settle skipped for job ${job.id}: ${plan.reason}`);
    return { result: 'skip', reason: plan.reason ?? 'skip' };
  }
  const verified = await ledgerRowVerified(opsAdmin, row, job.id);
  if (verified !== true) {
    console.error(`adyen-terminal-charge: ledger row ${row?.psp_reference} for job ${job.id} not settled: its AUTHORISATION is ${verified === null ? 'unreadable' : 'not HMAC verified'}`);
    return { result: 'skip', reason: verified === null ? 'unverified_unreadable' : 'unverified' };
  }
  const chargeMinor = Number(job.charge_minor);
  const psp = plan.psp ?? null;
  if (plan.action === 'approve' && plan.tipMinor != null && plan.amountMinor != null) {
    const rec = await recordTipWithRetry(opsAdmin, { jobId: job.id, tipMinor: plan.tipMinor, authorizedMinor: plan.amountMinor, chargeMinor });
    if (rec === 'unrecorded') {
      // Not the reader evidence key: this tip was derived from the ledger.
      await logDurable(platformAdmin, `tip-unrecorded-ledger:${job.id}:${Date.now()}`, {
        source: opts.source ?? 'adyen_ledger', chargeMinor, tipMinor: plan.tipMinor, authorizedMinor: plan.amountMinor, psp,
      });
      throw new SettleDeferred(`tip ${plan.tipMinor} on job ${job.id} could not be recorded yet`);
    }
    console.log(`adyen-terminal-charge: ledger tip ${plan.tipMinor} on job ${job.id} (${chargeMinor} to ${plan.amountMinor}): ${rec}`);
  }
  const approved = plan.action !== 'decline';
  const c = (row?.card ?? {}) as Record<string, any>;
  const card = (c.brand || c.last4 || c.authCode) ? {
    brand: c.brand ?? null, last4: c.last4 ?? null, auth_code: c.authCode ?? null,
    read_method: c.readMethod ?? null, aid: c.aid ?? null, application_name: c.applicationName ?? null,
    cvm: c.cvm ?? null, account_type: null,
  } : null;
  const settled = await settleRpcWithRetry(opsAdmin, {
    p_job_id: job.id,
    p_outcome: approved ? 'approved' : 'declined',
    p_payment_session_id: psp,
    p_transaction_id: psp,
    p_auth_code: c.authCode ?? null,
    p_card: card,
    p_decline_reason: approved ? null : (plan.declineReason ?? 'declined'),
    p_source: opts.source ?? 'adyen_ledger',
    p_session_amount_minor: approved ? (plan.amountMinor ?? null) : null,
  });
  await afterSettle(job.id, settled, { success: approved, psp, merchantAccount: row?.merchant_account ?? null, authorizedMinor: approved ? (plan.amountMinor ?? null) : null, chargeMinor });
  await reportParkedMismatch(opsAdmin, platformAdmin, job.id, settled, {
    success: approved, authorizedMinor: approved ? (plan.amountMinor ?? null) : null, chargeMinor, source: opts.source ?? 'adyen_ledger',
    evidence: { ledger: { psp, amount: plan.amountMinor ?? null, currency: row?.currency ?? null, event: row?.last_event_code ?? null } },
  });
  return { result: 'settled' };
}

// The answer to a settle the database could not record yet: the job stays in
// flight, the till keeps watching it, recovery settles it. 200 on purpose, so
// no till reads it as "could not reach the card machine".
const deferredBody = (status: string) => json({ ok: true, state: 'processing', status, code: 'SETTLE_DEFERRED' });

// ── The reader tip sweep (v5.11.16): every minute, no new cron ───────────────
// Runs inside 'sweep_unsent' (pg_cron adyen-unsent-sweep-1min, service role),
// under waitUntil so that action still answers in milliseconds. Three small
// selects, at most 30 jobs a run, NEWEST first (a backlog of old refusals can
// never starve fresh money), and every step below is compare-and-set, so an
// overlap with the till, the webhook or a previous run is harmless.
//   STRANDED  adyen charging/unknown jobs dispatched 60 s to 3 days ago, when
//             Adyen's ledger holds exactly ONE approved row at least 30 s old.
//             Never touches the reader, success rows only: declines stay with
//             the reader ask. Two approved rows is a possible double charge and
//             is raised, never settled. A row Adyen later saw refunded,
//             cancelled or changed is raised, never settled.
//               'charging' (the till's claim window, 5 minutes from dispatch):
//                 settle from it (settleFromLedger; parking an unexplained
//                 amount is allowed once dispatched 5 minutes ago).
//               'unknown' (the till has given up and showed "We cannot confirm
//                 this payment", so staff may have taken payment another way):
//                 NEVER settled here, since the reconciler would then book a
//                 second sale. The manager is told what Adyen took (and any
//                 tip) and decides in Back Office, where the job already is.
//   PARKED    approved + needs_human with the RPC's exact amount mismatch text,
//             settled in the last 7 days: healReaderTip (heals, or raises a
//             manager alert; "Adyen has not confirmed" after 5 minutes).
//   PENDING   healed jobs whose sale was not booked yet: correctHealedSale;
//             still no sale after 3 days is raised.
// This is also what heals R3618 (job 53ae162a) on the first run after deploy.
async function runReaderTipSweep(locationId: string | null): Promise<void> {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const summary: Record<string, unknown[]> = { stranded: [], parked: [], pending: [] };
  const COLS = 'id, location_id, processor, simulated, training, status, needs_human, last_error, tip_minor, charge_minor, due_minor, '
    + 'tip_basis_minor, reported_minor, currency, tip_config, capture_mode, payment_session_id, transaction_id, '
    + 'closed_check_id, check_key, check_draft, nexo_service_id, created_at, dispatched_at, settled_at, updated_at';
  const scoped = (q: any) => (locationId ? q.eq('location_id', locationId) : q);
  try {
    const [stranded, parked, pending] = await Promise.all([
      scoped(opsAdmin.from('terminal_jobs').select(COLS)
        .eq('processor', 'adyen').eq('simulated', false).eq('training', false)
        .in('status', ['charging', 'unknown']).not('nexo_service_id', 'is', null)
        .gte('dispatched_at', iso(now - STRANDED_MAX_DISPATCH_AGE_MS))
        .lte('dispatched_at', iso(now - STRANDED_MIN_DISPATCH_AGE_MS))
        .order('dispatched_at', { ascending: false }).limit(10)),
      scoped(opsAdmin.from('terminal_jobs').select(COLS)
        .eq('processor', 'adyen').eq('simulated', false).eq('training', false)
        .eq('status', 'approved').eq('needs_human', true)
        .like('last_error', AMOUNT_MISMATCH_LIKE)
        .gte('settled_at', iso(now - HEAL_MAX_AGE_MS))
        .order('settled_at', { ascending: false }).limit(10)),
      scoped(opsAdmin.from('terminal_jobs').select(COLS)
        .eq('processor', 'adyen')
        .like('last_error', PENDING_NOTE_LIKE)
        .gte('settled_at', iso(now - HEAL_MAX_AGE_MS))
        .order('settled_at', { ascending: false }).limit(10)),
    ]);
    for (const [name, res] of [['stranded', stranded], ['parked', parked], ['pending', pending]] as const) {
      if (res.error) console.error(`adyen-terminal-charge reader tip sweep: ${name} select failed: ${res.error.message}`);
    }

    for (const j of (stranded.data ?? []) as any[]) {
      try {
        const { rows, error } = await ledgerRowsForJob(platformAdmin, j.id);
        if (error || !rows.length) continue;
        const pick = pickLedgerRow(rows);
        if (pick.ambiguous) {
          if ((await alertOnce(opsAdmin, platformAdmin, j, 'ambiguous', { reason: 'ambiguous_ledger', chargeMinor: j.charge_minor ?? null })) === 'inserted') {
            summary.stranded.push({ id: j.id, did: 'alert_ambiguous' });
          }
          continue;
        }
        const row = pick.row;
        if (!row || row.success !== true) continue;
        if (now - (Date.parse(row.created_at) || now) < STRANDED_MIN_LEDGER_AGE_MS) continue;
        const approval = ledgerApproval(row);
        if (approval !== 'approved') {
          // Approved, then refunded, cancelled or otherwise changed: never a paid sale.
          if ((await alertOnce(opsAdmin, platformAdmin, j, 'reversed', { reason: approval === 'reversed' ? 'reversed' : 'event_code', chargeMinor: j.charge_minor ?? null })) === 'inserted') {
            summary.stranded.push({ id: j.id, did: 'alert_reversed' });
          }
          continue;
        }
        if (j.status === 'unknown') {
          // The till gave up on it: tell the manager what Adyen took, never book it here.
          if ((await ledgerRowVerified(opsAdmin, row, j.id)) !== true) continue;
          const amount = ledgerAuthAmount(row);
          const ev = amount != null && amount !== Number(j.charge_minor) ? await readTipEvidence(platformAdmin, j.id) : null;
          const facts = lateConfirmationFacts(j, row, ev);
          if ((await alertOnce(opsAdmin, platformAdmin, j, 'confirmed_late', facts)) === 'inserted') {
            summary.stranded.push({ id: j.id, did: 'alert_confirmed_late' });
          }
          continue;
        }
        const allowPark = (Date.parse(j.dispatched_at) || now) < now - STRANDED_PARK_AFTER_MS;
        const r = await settleFromLedger(j, row, { allowPark, source: 'adyen_ledger_sweep' });
        if (r.result === 'settled') summary.stranded.push({ id: j.id, did: r.result, allowPark });
      } catch (e) {
        summary.stranded.push({ id: j.id, did: isSettleDeferred(e) ? 'deferred' : 'error', error: (e as Error)?.message });
      }
    }
    for (const j of (parked.data ?? []) as any[]) {
      // Refusals and waits are recorded once, by their alert row (its id is its key); only a heal
      // or a failure goes in the run summary (no log row every minute for a week).
      const r = await healReaderTip(opsAdmin, platformAdmin, j.id, { trigger: 'sweep', now });
      if (r.outcome === 'healed' || r.outcome === 'error') summary.parked.push({ id: j.id, ...r });
    }
    for (const j of (pending.data ?? []) as any[]) {
      const r = await correctHealedSale(opsAdmin, platformAdmin, j, { trigger: 'sweep' });
      if (r.state === 'pending' && (r.reason === 'no_check' || r.reason === 'final_leg_not_booked')
          && now - (Date.parse(j.settled_at) || now) > PENDING_CHECK_MAX_AGE_MS) {
        const raised = await alertOnce(opsAdmin, platformAdmin, j, 'sale_never_recorded', {
          reason: 'sale_never_recorded', tipMinor: j.tip_minor ?? null,
          reportedMinor: j.charge_minor ?? null, chargeMinor: j.due_minor ?? null,
        });
        if (raised === 'inserted') summary.pending.push({ id: j.id, did: 'alert_never_recorded' });
      } else if (r.state !== 'pending' && r.state !== 'lost_race') {
        summary.pending.push({ id: j.id, ...r });
      }
    }
  } catch (e) {
    console.error(`adyen-terminal-charge reader tip sweep failed: ${(e as Error)?.message || e}`);
  }
  const acted = summary.stranded.length + summary.parked.length + summary.pending.length;
  if (acted) {
    console.log(`adyen-terminal-charge reader tip sweep: ${JSON.stringify(summary)}`);
    await logDurable(platformAdmin, `reader-tip-sweep:${now}:${Math.random().toString(36).slice(2, 8)}`, {
      location_id: locationId, ...summary,
    });
  }
}

// v5.6.87 — DURABLE REFUSAL LOG. Peter has now hit "payments are still not going
// to the device" three times with jobs stuck at charging_unsent and
// nexo_service_id NULL, meaning this function refused BEFORE its write-ahead CAS
// and told nobody why: the till swallowed the reason (fixed v5.6.86) and Supabase
// console logs have proved unreadable through the analytics API all week. Record
// every pre-CAS refusal where we can always query it — the same trick that
// finally cracked pay-at-table.
async function logRefusal(reason: string, ctx: Record<string, unknown>) {
  console.log(`adyen-terminal-charge REFUSED: ${reason} ${JSON.stringify(ctx)}`);
  await platformAdmin.from('adyen_webhook_events').insert({
    event_key: `charge-refused:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    raw: { reason, ...ctx },
  }).then(() => {}, () => {});
}

// v5.6.94 — DEMO BAR-TAB HOLDS. The browser demo reader (?mode=readerdemo) is a
// terminal_devices row whose serial the surface mints as DEMO-… — a real PAX
// serial or paxpay's AID-<ANDROID_ID> ladder can never start with that. That is
// the same server-side authority terminal-job-create trusts to mark demo SALES
// simulated. Sales ride terminal_jobs; bar-tab pre-auth holds have NO job row,
// so they are simulated HERE instead: hold_start on a DEMO- terminal returns a
// DEMO-HOLD-… reference without ever touching Adyen, and any hold action handed
// a DEMO-HOLD-… reference short-circuits BEFORE anything that could reach
// adyenFetch. Every demo hold action is durably logged (same trick as
// logRefusal) so demo tabs stay auditable end-to-end.
const DEMO_HOLD_PREFIX = 'DEMO-HOLD-';
async function logDemoHold(action: string, ctx: Record<string, unknown>) {
  console.log(`adyen-terminal-charge DEMO HOLD ${action}: ${JSON.stringify(ctx)}`);
  await platformAdmin.from('adyen_webhook_events').insert({
    event_key: `demo-hold:${action}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    raw: { demo: true, action, ...ctx },
  }).then(() => {}, () => {});
}

// PER VENUE ENVIRONMENT (7 Sep 2026): the venue's merchant_adyen_accounts row
// says test or live; that config carries the key and the device host for
// every reader message and Checkout modification below. A live venue without
// live keys FAILS CLOSED (503 with the reason) before anything is dispatched.
// PER VENUE REGION (8 Sep 2026): the same row's region ('UK' | 'US') picks the
// live secret set and the classic Terminal API host (terminal-api-live for
// UK, terminal-api-live-us for US). Every terminalEndpoint call passes
// cfg.region, never a value re-derived from the row.
const notConfigured = (cfg: AdyenConfig) => (cfg.configured ? null : json({ error: adyenNotConfiguredMessage(cfg) }, 503));

// ── Store REFERENCE for SaleToAcquirerData (10 Sep 2026) ─────────────────────
// Adyen's Terminal API `store=` takes the store's REFERENCE (its store code,
// SV-1007), not the Management API id (ST…). On test the two are equal, which
// is why store=<id> worked there for weeks; on live the store was made by
// reference, carries SV-1007, and the id is refused (403 910 "Invalid Store"
// on /connectedTerminals, read 9 Sep). Read once per isolate from
// GET /stores/{id} (10 minute cache); when Adyen cannot answer, send nothing:
// the reader is assigned to the store, so Adyen routes the sale there itself.
const storeRefCache = new Map<string, { ref: string | null; at: number }>();
async function storeReferenceFor(cfg: AdyenConfig, storeId: string | null | undefined): Promise<string | undefined> {
  const id = String(storeId ?? '').trim();
  if (!id) return undefined;
  const key = `${cfg.env}:${cfg.region}:${id}`;
  const hit = storeRefCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.ref ?? undefined;
  let ref: string | null = null;
  try {
    const r = await adyenFetch('GET', `${managementBase(cfg)}/stores/${encodeURIComponent(id)}`, undefined, { cfg, apiKey: cfg.managementKey, timeoutMs: 8_000 });
    const got = r.ok ? String((r.data as { reference?: unknown })?.reference ?? '').trim() : '';
    if (got) ref = got;
  } catch { ref = null; }
  storeRefCache.set(key, { ref, at: Date.now() });
  return ref ?? undefined;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const secondStepBlock = await secondStepRefusal(req); if (secondStepBlock) return secondStepBlock; // docs/SECOND_STEP.md
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return json({ error: 'unauthorized' }, 401);
  const isServiceRole = token === SERVICE_ROLE;
  let callerUid: string | null = null;
  if (!isServiceRole) {
    try { const { data } = await opsAdmin.auth.getUser(token); callerUid = data?.user?.id ?? null; } catch { callerUid = null; }
    if (!callerUid) return json({ error: 'unauthorized' }, 401);
  }

  let body: {
    action?: string; job_id?: string; response?: unknown;
    location_id?: string;   // sweep_unsent: optional venue scope (the action itself is service role only)
    kicked_by?: string;     // start: who fired this kick (terminal-job-create | sweep_unsent), for the log only
    [k: string]: unknown;
  };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = String(body.action ?? '');

  // ── BAR-TAB HOLDS (v5.6.57) — pre-auth on the reader, no job row: the tab
  // (bar_tabs pre_auth_* columns) carries the hold. Fence: service role, a
  // paired POS device at the venue, or (v5.6.94) a venue user — see deviceAt.
  // Capture/release/increase mirror the adyen-modify endpoints but stay HERE
  // because that fn's fence is BO-user based and a till must be able to close
  // its own tab. DEMO- terminals / DEMO-HOLD- references simulate server-side
  // and can never reach Adyen (see logDemoHold above).
  if (['hold_start', 'hold_capture', 'hold_release', 'hold_increase'].includes(action)) {
    const deviceAt = async (locId: string) => {
      if (isServiceRole) return true;
      // v5.6.94 — ALSO accept a signed-in USER with user_locations access to
      // the venue (or super_admin), the same mirror v5.6.89 added to the job
      // fence below and for the same live reason: a browser till shares its
      // ONE Supabase session with Back Office, so TabPreAuthTerminal's
      // hold_start (and BarSurface's capture/release/increase) arrive as the
      // BO USER, not a paired devices row, and the tab wedges at open. Any
      // identity trusted to create and kick a whole payment job at this venue
      // (terminal-job-create + the v5.6.89 fence both accept it) must be
      // trusted to place and settle a tab hold there — refusing it can only
      // wedge tabs, never protect money. The device branch is unchanged.
      const [{ data: dev }, { data: ul }, { data: prof }] = await Promise.all([
        opsAdmin.from('devices')
          .select('id').eq('device_uid', callerUid).eq('location_id', locId).maybeSingle(),
        opsAdmin.from('user_locations')
          .select('location_id').eq('user_id', callerUid).eq('location_id', locId).maybeSingle(),
        opsAdmin.from('user_profiles')
          .select('role').eq('id', callerUid).maybeSingle(),
      ]);
      return !!dev || !!ul || prof?.role === 'super_admin';
    };
    // Account row + the venue's environment (one wait). adyenEnvForLocation
    // throws on a real DB error rather than guessing test for a live venue;
    // the caller's fence has already run, so a 500 here is honest.
    const venueFor = async (opsLocId: string) => {
      const { data: ploc } = await platformAdmin.from('locations')
        .select('id').eq('ops_location_id', opsLocId).maybeSingle();
      const platformLocId = ploc?.id ?? opsLocId;
      const [{ data: maa }, target] = await Promise.all([
        platformAdmin.from('merchant_adyen_accounts')
          .select('merchant_account, store_id, region').eq('location_id', platformLocId).maybeSingle(),
        adyenEnvForLocation(platformAdmin, platformLocId),
      ]);
      const cfg = adyenConfig(target);   // { env, region }: the venue's secret set and hosts
      // A row still naming the OTHER environment's merchant account (flipped
      // before set_environment rewrote it) must not reach the live host.
      if (maa) maa.merchant_account = effectiveMerchantAccount(cfg, maa.merchant_account) || null;
      return { maa, cfg };
    };

    if (action === 'hold_start') {
      const terminalDeviceId = String(body.terminal_device_id ?? '');
      const amountMinor = Math.round(Number(body.amount_minor));
      const currency = String(body.currency || 'GBP').toUpperCase().slice(0, 3);
      if (!terminalDeviceId || !Number.isFinite(amountMinor) || amountMinor < 100 || amountMinor > 100_000) {
        return json({ error: 'terminal_device_id and amount_minor (£1–£1000) required' }, 400);
      }
      const { data: term } = await opsAdmin.from('terminal_devices')
        .select('id, location_id, status, active, adyen_terminal_id, serial_number')
        .eq('id', terminalDeviceId).maybeSingle();
      // Demo reader (?mode=readerdemo): paired + active, serial DEMO-…, no
      // Adyen link. The serial on the SERVER'S OWN row is the authority — a
      // caller can neither talk a real terminal into a fake hold nor a demo
      // terminal into a real one.
      const isDemoTerminal = String(term?.serial_number ?? '').toUpperCase().startsWith('DEMO-');
      if (!term || term.status !== 'paired' || !term.active || (!term.adyen_terminal_id && !isDemoTerminal)) {
        return json({ ok: false, error: 'terminal not paired to Adyen' }, 409);
      }
      if (!(await deviceAt(term.location_id))) return json({ error: 'no access to this venue' }, 403);

      if (isDemoTerminal) {
        // SIMULATED hold — this branch returns unconditionally, so no path
        // from a demo terminal can reach adyenFetch (it does not even need the
        // venue to have a merchant account). Same success shape as the real
        // branch below, so the client flow is indistinguishable. ~2s pacing so
        // the demo window's card-present animation has time to play.
        const psp = `${DEMO_HOLD_PREFIX}${Date.now()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
        await new Promise((r) => setTimeout(r, 2000));
        await logDemoHold('hold_start', {
          psp_reference: psp, amount_minor: amountMinor, currency,
          terminal_device_id: terminalDeviceId, location_id: term.location_id, serial: term.serial_number,
        });
        return json({
          ok: true,
          psp_reference: psp,
          held_minor: amountMinor,
          // settleCard()'s snake_case receipt shape, demo-flavoured.
          card: {
            brand: 'visa', last4: '4242',
            auth_code: String(Math.floor(100000 + Math.random() * 900000)),
            read_method: 'contactless', aid: null, application_name: null, cvm: null, account_type: null,
          },
        });
      }

      const { maa, cfg } = await venueFor(term.location_id);
      if (!maa?.merchant_account) {
        // (v5.6.94: this refusal used to log job.id — but hold actions have no
        // job row, and `job` is declared further down, so the log line itself
        // threw a ReferenceError. Log the terminal instead.)
        await logRefusal('venue has no Adyen merchant account', { action, terminalDeviceId, termLocation: term.location_id });
        return json({ ok: false, error: 'venue has no Adyen account — onboarding incomplete' }, 409);
      }
      const nc = notConfigured(cfg);
      if (nc) return nc;

      const serviceId = newServiceId();
      const nexo = buildPaymentRequest({
        poiid: term.adyen_terminal_id,
        saleId: `servos-${String(term.location_id).slice(0, 8)}`,
        serviceId,
        transactionId: `tabhold-${crypto.randomUUID().slice(0, 12)}`,
        amountMinor,
        currency,
        preAuth: true,
        storeId: await storeReferenceFor(cfg, maa.store_id),
      });
      const res = await adyenFetch('POST', terminalEndpoint(maa.merchant_account, term.adyen_terminal_id, 'sync', cfg.region, cfg), nexo, { cfg, timeoutMs: 165_000 });
      if (!res.ok) return json({ ok: false, error: `adyen ${res.status}` }, 200);
      const parsed = parsePaymentResponse(res.data);
      if (parsed.result !== 'Success') {
        // The till needs the reason itself to choose what to tell staff; the
        // condition stays alongside it so cancels and timeouts stay separable
        // from genuine card refusals.
        return json({ ok: false, error: parsed.errorCondition || 'declined', declined: true,
                      refusalReason: parsed.refusalReason, refusalCode: parsed.refusalCode,
                      errorCondition: parsed.errorCondition }, 200);
      }
      return json({
        ok: true,
        psp_reference: parsed.pspReference,
        held_minor: parsed.authorizedMinor ?? amountMinor,
        card: settleCard(parsed),
      });
    }

    // capture / release / increase — by pspReference, venue-fenced.
    const psp = String(body.psp_reference ?? '');
    const opsLocId = String(body.location_id ?? '');
    if (!psp || !opsLocId) return json({ error: 'psp_reference and location_id required' }, 400);
    if (!(await deviceAt(opsLocId))) return json({ error: 'no access to this venue' }, 403);
    const amountMinor = body.amount_minor != null ? Math.round(Number(body.amount_minor)) : null;
    const currency = String(body.currency || 'GBP').toUpperCase().slice(0, 3);

    // DEMO-HOLD short-circuit (v5.6.94) — FIRST, before the merchant-account
    // lookup and before anything that could build an Adyen request. A
    // DEMO-HOLD-… reference is only ever minted by the demo hold_start branch
    // above; this guard makes it impossible to send one to Adyen. Same field
    // requirements and the same success shape as the real branch below
    // ({ ok, status, modification_psp } — the real fn returns no amount echo,
    // so neither does this; the durable log carries the amounts).
    if (psp.toUpperCase().startsWith(DEMO_HOLD_PREFIX)) {
      if (action === 'hold_capture' && !Number.isFinite(amountMinor)) return json({ error: 'amount_minor required' }, 400);
      if (action === 'hold_increase' && !Number.isFinite(amountMinor)) return json({ error: 'amount_minor (new total) required' }, 400);
      await logDemoHold(action, { psp_reference: psp, amount_minor: amountMinor, currency, location_id: opsLocId });
      return json({
        ok: true,
        status: 'received',
        modification_psp: `${DEMO_HOLD_PREFIX}MOD-${Date.now()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      });
    }

    const { maa, cfg } = await venueFor(opsLocId);
    if (!maa?.merchant_account) return json({ ok: false, error: 'venue has no Adyen account' }, 409);
    const nc = notConfigured(cfg);
    if (nc) return nc;
    let path = ''; let payload: Record<string, unknown> = {};
    if (action === 'hold_capture') {
      if (!Number.isFinite(amountMinor)) return json({ error: 'amount_minor required' }, 400);
      path = `/payments/${encodeURIComponent(psp)}/captures`;
      payload = { merchantAccount: maa.merchant_account, amount: { value: amountMinor, currency }, reference: `tabcap:${psp}` };
    } else if (action === 'hold_release') {
      path = `/payments/${encodeURIComponent(psp)}/cancels`;
      payload = { merchantAccount: maa.merchant_account, reference: `tabrel:${psp}` };
    } else { // hold_increase — new TOTAL, not a delta (Adyen amountUpdates semantics)
      if (!Number.isFinite(amountMinor)) return json({ error: 'amount_minor (new total) required' }, 400);
      path = `/payments/${encodeURIComponent(psp)}/amountUpdates`;
      payload = { merchantAccount: maa.merchant_account, amount: { value: amountMinor, currency }, industryUsage: 'delayedCharge', reference: `tabinc:${psp}` };
    }
    // capture/release keep replay-safe deterministic keys; INCREASE must be
    // unique per attempt (Adyen replays the first response for a reused key —
    // a fixed request after a 400 kept echoing the 400).
    const idem = action === 'hold_increase'
      ? `ti:${psp}:${crypto.randomUUID().slice(0, 13)}`
      : `tab:${action}:${psp}:${amountMinor ?? 'full'}`;
    const res = await adyenFetch('POST', `${checkoutBase(cfg)}${path}`, payload, { cfg, idempotencyKey: idem });
    if (!res.ok) return json({ ok: false, error: `adyen ${res.status}`, detail: res.data }, res.status >= 500 ? 502 : 200);
    return json({ ok: true, status: (res.data as Record<string, unknown>)?.status ?? 'received', modification_psp: (res.data as Record<string, unknown>)?.pspReference ?? null });
  }

  // ── wakeup_table (v5.6.95) — DEMO READER ONLY: reader-initiated Pay at table ─
  // The browser demo reader (?mode=readerdemo) starts Pay at table from its own
  // screen, like a real Adyen reader does via adyen-terminal-events. The real
  // responder is display-driven and Adyen-authenticated, so the demo window
  // cannot ride it; instead it calls this action, which is nothing but a fenced
  // doorway to the SAME service-role RPC the real responder uses
  // (terminal_start_table_payment_for — paid-so-far maths, split legs,
  // priorLegs, advisory lock and occupation pinning all shared, and for a
  // DEMO- terminal the RPC mints the job in the pending/simulated shape the
  // demo window's existing claim → tip → report lifecycle consumes).
  //
  // FENCE — demo-only BY CONSTRUCTION, no venue-user branch needed: the caller
  // must OWN the named terminal row (terminal_devices.device_uid = auth.uid(),
  // stamped by register_terminal_device and never client-assertable), the row's
  // OWN serial must be DEMO-… (a real PAX serial or paxpay's AID-<ANDROID_ID>
  // ladder can never start with that), and the row must be paired + active at a
  // location. So only the demo window itself — the one browser session that
  // registered the demo serial — can wake a table, and only for its own venue's
  // demo terminal. A real reader's row can never pass; a demo row can never
  // reach a card (the RPC births it simulated=true, which every charge path
  // refuses).
  if (action === 'wakeup_table') {
    const terminalDeviceId = String(body.terminal_device_id ?? '');
    const tableId = String(body.table_id ?? '');
    if (!terminalDeviceId || !tableId) {
      return json({ error: 'terminal_device_id and table_id required' }, 400);
    }
    let amountMinor: number | null = null;
    if (body.amount_minor != null) {
      amountMinor = Math.round(Number(body.amount_minor));
      if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
        return json({ error: 'amount_minor must be a positive whole number of minor units' }, 400);
      }
    }
    const sessionId = body.session_id != null ? String(body.session_id) : null;
    const seatedAt = body.seated_at != null ? String(body.seated_at) : null;

    const { data: term } = await opsAdmin.from('terminal_devices')
      .select('id, device_uid, location_id, status, active, serial_number')
      .eq('id', terminalDeviceId).maybeSingle();
    const isDemoTerminal = String(term?.serial_number ?? '').toUpperCase().startsWith('DEMO-');
    if (!term || !isDemoTerminal) {
      await logRefusal('wakeup_table: terminal is not a demo reader', {
        action, terminalDeviceId, serial: term?.serial_number ?? null, callerUid,
      });
      return json({ error: 'only the demo reader can wake a table this way' }, 403);
    }
    if (term.status !== 'paired' || !term.active || !term.location_id) {
      await logRefusal('wakeup_table: demo terminal not paired/active at a location', {
        action, terminalDeviceId, termStatus: term.status, termActive: term.active,
        termLocation: term.location_id ?? null, callerUid,
      });
      return json({ error: 'demo reader is not paired at a venue' }, 409);
    }
    if (!isServiceRole && term.device_uid !== callerUid) {
      await logRefusal('wakeup_table: caller does not own the demo terminal row', {
        action, terminalDeviceId, callerUid,
      });
      return json({ error: 'no access to this terminal' }, 403);
    }

    const { data: started, error: startErr } = await opsAdmin.rpc('terminal_start_table_payment_for', {
      p_terminal_device_id: terminalDeviceId,
      p_table_id: tableId,
      p_amount_minor: amountMinor,
      p_session_id: sessionId,
      p_seated_at: seatedAt,
    });
    if (startErr) {
      // The RPC's raise messages are operator-quality ("this table has already
      // been paid", "this table changed while you were choosing — start again").
      // Return them verbatim, and log durably — silent refusals on this exact
      // path cost a full day once already (see logRefusal's header).
      await logRefusal(`wakeup_table: rpc refused: ${startErr.message}`, {
        action, terminalDeviceId, tableId, amountMinor, sessionId, seatedAt, callerUid,
      });
      return json({ ok: false, error: startErr.message }, 409);
    }
    console.log(`adyen-terminal-charge: wakeup_table minted demo job ${JSON.stringify(started)} (terminal ${terminalDeviceId}, table ${tableId})`);
    return json({ ok: true, ...(started as Record<string, unknown>) });
  }

  // ── diag_reader (9 Sep 2026): ask ADYEN where a reader is, read only ───────
  // Service role only. Every call below is a GET (Management API v3) or the
  // documented POST /connectedTerminals and a nexo Diagnosis, none of which
  // changes anything at Adyen or here. It exists because the live AMS1 refused
  // every payment with "010 Not allowed" while the Customer Area showed it
  // boarded, and the only honest way to settle that is Adyen's own answers
  // with the key this function actually signs with. Keys are never returned.
  if (action === 'diag_reader') {
    if (!isServiceRole) return json({ error: 'diag_reader: service role only' }, 403);
    const opsLocId = String(body.location_id ?? '');
    const poiid = String(body.poiid ?? '');
    const serials = Array.isArray(body.serials) ? (body.serials as unknown[]).map(String) : [];
    if (!opsLocId || !poiid) return json({ error: 'location_id and poiid required' }, 400);

    const { data: ploc } = await platformAdmin.from('locations').select('id').eq('ops_location_id', opsLocId).maybeSingle();
    const platformLocId = ploc?.id ?? opsLocId;
    const [{ data: maa }, target] = await Promise.all([
      platformAdmin.from('merchant_adyen_accounts')
        .select('merchant_account, store_id, region, environment, env_stash')
        .eq('location_id', platformLocId).maybeSingle(),
      adyenEnvForLocation(platformAdmin, platformLocId),
    ]);
    const stash = ((maa as any)?.env_stash ?? {}) as Record<string, any>;

    const call = async (cfg: AdyenConfig, method: string, url: string, b?: unknown, apiKey?: string, timeoutMs = 20_000) => {
      try {
        const r = await adyenFetch(method, url, b, { cfg, apiKey, timeoutMs });
        return { url, status: r.status, ok: r.ok, data: r.data };
      } catch (e) { return { url, status: 0, ok: false, data: { thrown: String((e as Error)?.message ?? e) } }; }
    };
    const trim = (t: any) => t && ({
      id: t.id, model: t.model, serialNumber: t.serialNumber, firmwareVersion: t.firmwareVersion,
      assignment: t.assignment, connectivity: t.connectivity, lastActivityAt: t.lastActivityAt, lastTransactionAt: t.lastTransactionAt,
    });
    const diagnosis = (id: string) => ({
      SaleToPOIRequest: {
        MessageHeader: { ProtocolVersion: '3.0', MessageClass: 'Service', MessageCategory: 'Diagnosis', MessageType: 'Request', SaleID: 'servos-diag', ServiceID: newServiceId(), POIID: id },
        DiagnosisRequest: { HostDiagnosisFlag: false },
      },
    });

    const probe = async (label: string, cfg: AdyenConfig, merchant: string | null, storeId: string | null) => {
      if (!cfg.configured) return { label, env: cfg.env, region: cfg.region, configured: false, missing: cfg.missing };
      const M = managementBase(cfg);
      const D = cfg.deviceBase;
      const out: Record<string, unknown> = {
        label, env: cfg.env, region: cfg.region, merchant, storeId, managementBase: M, deviceBase: D,
        sameKeyForManagement: cfg.managementKey === cfg.apiKey,
      };
      const [me, meMgmt, companies, merchants, bySearch, byMerchant, byStore, termSettings, storeSettings, merchantSettings, store, merchantRow] = await Promise.all([
        call(cfg, 'GET', `${M}/me`),
        cfg.managementKey !== cfg.apiKey ? call(cfg, 'GET', `${M}/me`, undefined, cfg.managementKey) : Promise.resolve(null),
        call(cfg, 'GET', `${M}/companies?pageSize=50`),
        call(cfg, 'GET', `${M}/merchants?pageSize=100`),
        call(cfg, 'GET', `${M}/terminals?searchQuery=${encodeURIComponent(poiid)}&pageSize=20`),
        merchant ? call(cfg, 'GET', `${M}/terminals?merchantIds=${encodeURIComponent(merchant)}&pageSize=100`) : Promise.resolve(null),
        storeId ? call(cfg, 'GET', `${M}/terminals?storeIds=${encodeURIComponent(storeId)}&pageSize=100`) : Promise.resolve(null),
        call(cfg, 'GET', `${M}/terminals/${encodeURIComponent(poiid)}/terminalSettings`),
        storeId ? call(cfg, 'GET', `${M}/stores/${encodeURIComponent(storeId)}/terminalSettings`) : Promise.resolve(null),
        merchant ? call(cfg, 'GET', `${M}/merchants/${encodeURIComponent(merchant)}/terminalSettings`) : Promise.resolve(null),
        storeId ? call(cfg, 'GET', `${M}/stores/${encodeURIComponent(storeId)}`) : Promise.resolve(null),
        merchant ? call(cfg, 'GET', `${M}/merchants/${encodeURIComponent(merchant)}`) : Promise.resolve(null),
      ]);
      out.me = me; if (meMgmt) out.meManagementKey = meMgmt;
      out.companies = { status: companies.status, data: (companies.data?.data ?? []).map((c: any) => ({ id: c.id, name: c.name, status: c.status })) , raw: companies.ok ? undefined : companies.data };
      out.merchants = { status: merchants.status, data: (merchants.data?.data ?? []).map((m: any) => ({ id: m.id, name: m.name, companyId: m.companyId, status: m.status, captureDelay: m.captureDelay })), raw: merchants.ok ? undefined : merchants.data };
      out.terminalBySearch = { status: bySearch.status, data: (bySearch.data?.data ?? []).map(trim), raw: bySearch.ok ? undefined : bySearch.data };
      if (byMerchant) out.terminalsOnMerchant = { status: byMerchant.status, count: (byMerchant.data?.data ?? []).length, data: (byMerchant.data?.data ?? []).map(trim), raw: byMerchant.ok ? undefined : byMerchant.data };
      if (byStore) out.terminalsOnStore = { status: byStore.status, count: (byStore.data?.data ?? []).length, data: (byStore.data?.data ?? []).map(trim), raw: byStore.ok ? undefined : byStore.data };
      out.terminalSettings = termSettings;
      if (storeSettings) out.storeTerminalSettings = storeSettings;
      if (merchantSettings) out.merchantTerminalSettings = merchantSettings;
      if (store) out.store = store;
      if (merchantRow) out.merchantAccount = merchantRow;
      // Serial searches (other readers we know of): where do THEY live on this environment?
      // More of Adyen's own records (read only): the company, the credentials it
      // will list, the store's business line (sales channels) and the store's
      // POS payment methods.
      const companyId = String((merchantRow?.data as any)?.companyId ?? '');
      const businessLineId = String(((store?.data as any)?.businessLineIds ?? [])[0] ?? '');
      const [company, merchantCreds, companyCreds, businessLine, storePaymentMethods] = await Promise.all([
        companyId ? call(cfg, 'GET', `${M}/companies/${encodeURIComponent(companyId)}`) : Promise.resolve(null),
        merchant ? call(cfg, 'GET', `${M}/merchants/${encodeURIComponent(merchant)}/apiCredentials?pageSize=50`) : Promise.resolve(null),
        companyId ? call(cfg, 'GET', `${M}/companies/${encodeURIComponent(companyId)}/apiCredentials?pageSize=50`) : Promise.resolve(null),
        businessLineId ? call(cfg, 'GET', `${lemBase(cfg)}/businessLines/${encodeURIComponent(businessLineId)}`, undefined, cfg.lemKey) : Promise.resolve(null),
        merchant && storeId ? call(cfg, 'GET', `${M}/merchants/${encodeURIComponent(merchant)}/paymentMethods?storeId=${encodeURIComponent(storeId)}&pageSize=100`) : Promise.resolve(null),
      ]);
      out.company = company;
      out.merchantCredentials = merchantCreds && { status: merchantCreds.status, data: (merchantCreds.data?.data ?? []).map((c: any) => ({ id: c.id, username: c.username, description: c.description, active: c.active, roles: c.roles })), raw: merchantCreds.ok ? undefined : merchantCreds.data };
      out.companyCredentials = companyCreds && { status: companyCreds.status, data: (companyCreds.data?.data ?? []).map((c: any) => ({ id: c.id, username: c.username, description: c.description, active: c.active, roles: c.roles, associatedMerchantAccounts: c.associatedMerchantAccounts })), raw: companyCreds.ok ? undefined : companyCreds.data };
      out.businessLine = businessLine;
      out.storePaymentMethods = storePaymentMethods && { status: storePaymentMethods.status, data: (storePaymentMethods.data?.data ?? []).map((m: any) => ({ id: m.id, type: m.type, enabled: m.enabled, verificationStatus: m.verificationStatus, shopperInteraction: m.shopperInteraction, storeIds: m.storeIds })), raw: storePaymentMethods.ok ? undefined : storePaymentMethods.data };
      out.serialSearches = await Promise.all(serials.map(async (s) => ({ serial: s, ...(await call(cfg, 'GET', `${M}/terminals?searchQuery=${encodeURIComponent(s)}&pageSize=10`)) }))).then((rs) => rs.map((r) => ({ serial: r.serial, status: r.status, data: (r.data?.data ?? []).map(trim), raw: r.ok ? undefined : r.data })));
      // Cloud connection (docs: POST /connectedTerminals, same key as Terminal API).
      if (merchant) {
        const [ct, ctStore, ctOne] = await Promise.all([
          call(cfg, 'POST', `${D}/connectedTerminals`, { merchantAccount: merchant }),
          storeId ? storeReferenceFor(cfg, storeId).then((ref) => call(cfg, 'POST', `${D}/connectedTerminals`, { merchantAccount: merchant, store: ref ?? storeId })) : Promise.resolve(null),
          call(cfg, 'POST', `${D}/connectedTerminals`, { merchantAccount: merchant, uniqueTerminalId: poiid }),
        ]);
        out.connectedTerminals = { merchant: ct, store: ctStore, one: ctOne };
        // nexo Diagnosis on EVERY regional cloud host (read only; a disconnected
        // reader answers with an error, not a prompt). Live cloud Terminal API is
        // regional and cross-regional calls were decommissioned in 2026, so a
        // terminal homed on another region's cloud refuses from the wrong host.
        const hosts: Array<{ region: string; classic: string; device: string }> = cfg.live
          ? [
              { region: 'EU', classic: 'https://terminal-api-live.adyen.com', device: 'https://device-api-live.adyen.com' },
              { region: 'US', classic: 'https://terminal-api-live-us.adyen.com', device: 'https://device-api-live-us.adyen.com' },
              { region: 'AU', classic: 'https://terminal-api-live-au.adyen.com', device: 'https://device-api-live-au.adyen.com' },
              { region: 'APSE', classic: 'https://terminal-api-live-apse.adyen.com', device: 'https://device-api-live-apse.adyen.com' },
            ]
          : [{ region: 'TEST', classic: terminalEndpoint(merchant, poiid, 'sync', cfg.region, cfg).replace(/\/sync$/, ''), device: 'https://device-api-test.adyen.com' }];
        // Every DISTINCT live key this venue's secret set holds (the API key, the
        // Platforms key, a separate management key if any): who is it, and does the
        // classic cloud gate answer it differently? Read only.
        const keyNames: Array<[string, string]> = [['apiKey', cfg.apiKey], ['bpKey', cfg.bpKey], ['managementKey', cfg.managementKey], ['lemKey', cfg.lemKey]];
        const seen = new Set<string>();
        out.byKey = await Promise.all(keyNames.filter(([, k]) => k && !seen.has(k) && seen.add(k)).map(async ([name, k]) => {
          const [me, sync, asyncCall, connected] = await Promise.all([
            call(cfg, 'GET', `${M}/me`, undefined, k),
            call(cfg, 'POST', `${hosts[0].classic}/sync`, diagnosis(poiid), k, 25_000),
            call(cfg, 'POST', `${hosts[0].classic}/async`, diagnosis(poiid), k, 25_000),
            call(cfg, 'POST', `${hosts[0].classic}/connectedTerminals`, { merchantAccount: merchant }, k),
          ]);
          return { key: name, me: { status: me.status, username: (me.data as any)?.username, roles: ((me.data as any)?.roles ?? []).length, merchants: (me.data as any)?.associatedMerchantAccounts }, sync, async: asyncCall, connected };
        }));
        out.diagnosisByRegion = await Promise.all(hosts.map(async (h) => {
          const alt = `${h.device}/v1/merchants/${encodeURIComponent(merchant)}/devices/${encodeURIComponent(poiid)}/sync`;
          const [connected, d1, d2] = await Promise.all([
            call(cfg, 'POST', `${h.classic}/connectedTerminals`, { merchantAccount: merchant }),
            call(cfg, 'POST', `${h.classic}/sync`, diagnosis(poiid), undefined, 25_000),
            call(cfg, 'POST', alt, diagnosis(poiid), undefined, 25_000),
          ]);
          return { region: h.region, connected, classic: d1, deviceApi: d2 };
        }));
      }
      return out;
    };

    const liveCfg = adyenConfig(target);
    const otherEnv = liveCfg.env === 'live' ? 'test' : 'live';
    const otherCfg = adyenConfig(otherEnv, liveCfg.region);
    const otherStash = stash[otherEnv] ?? {};
    const results = await Promise.all([
      probe('venue', liveCfg, (maa as any)?.merchant_account ?? null, (maa as any)?.store_id ?? null),
      probe(`other (${otherEnv})`, otherCfg, otherStash.merchant_account ?? otherCfg.merchantAccount ?? null, otherStash.store_id ?? null),
    ]);
    return json({ ok: true, poiid, opsLocationId: opsLocId, platformLocationId: platformLocId, row: { environment: (maa as any)?.environment, region: (maa as any)?.region, merchant_account: (maa as any)?.merchant_account, store_id: (maa as any)?.store_id }, probes: results });
  }

  // ── diag_payment (10 Sep 2026): how ADYEN booked one payment, read only ─
  // Service role only, GETs only. Reads the split configuration profile named
  // on the venue row, the store's link to it, and the Balance Platform
  // transfers and transactions in a time window, filtered to the payment's
  // psp reference (and any extra refs). This is Adyen's own record of what
  // went to the venue's balance account, what went to the platform as the
  // venue rate, and the fees Adyen took, so a split is checked, not guessed.
  if (action === 'diag_payment') {
    if (!isServiceRole) return json({ error: 'diag_payment: service role only' }, 403);
    const opsLocId = String(body.location_id ?? '');
    const since = String(body.since ?? '');
    const until = String(body.until ?? '');
    const refs = [String(body.psp ?? ''), ...(Array.isArray(body.refs) ? (body.refs as unknown[]).map(String) : [])].map((x) => x.trim()).filter(Boolean);
    if (!opsLocId || !since || !until) return json({ error: 'location_id, since and until required' }, 400);
    const { data: ploc } = await platformAdmin.from('locations').select('id').eq('ops_location_id', opsLocId).maybeSingle();
    const platformLocId = ploc?.id ?? opsLocId;
    const [{ data: maa }, target] = await Promise.all([
      platformAdmin.from('merchant_adyen_accounts')
        .select('merchant_account, store_id, balance_account_id, account_holder_id, split_profile_id')
        .eq('location_id', platformLocId).maybeSingle(),
      adyenEnvForLocation(platformAdmin, platformLocId),
    ]);
    const cfg = adyenConfig(target);
    const row = (maa ?? {}) as Record<string, any>;
    const { data: kept } = await platformAdmin.from('adyen_platform_settings')
      .select('balance_platform_id').eq('environment', cfg.env).eq('region', cfg.region).maybeSingle();
    const bpId = String((kept as any)?.balance_platform_id ?? '');
    const merchant = effectiveMerchantAccount(cfg, row.merchant_account) || '';
    const call = async (url: string, apiKey?: string) => {
      try {
        const r = await adyenFetch('GET', url, undefined, { cfg, apiKey, timeoutMs: 25_000 });
        return { url, status: r.status, ok: r.ok, data: r.data as any };
      } catch (e) { return { url, status: 0, ok: false, data: { thrown: String((e as Error)?.message ?? e) } as any }; }
    };
    const M = managementBase(cfg);
    const BTL = balancePlatformBase(cfg).replace(/\/bcl\/v2$/, '/btl/v4');
    const window = `createdSince=${encodeURIComponent(since)}&createdUntil=${encodeURIComponent(until)}&limit=100`;
    const matches = (item: unknown) => !refs.length || refs.some((r) => JSON.stringify(item).includes(r));
    const pageAll = async (first: string) => {
      const items: any[] = []; const pages: Array<{ status: number; count: number }> = []; let url: string | null = first; let n = 0;
      while (url && n < 10) {
        const r = await call(url, cfg.bpKey);
        pages.push({ status: r.status, count: Array.isArray(r.data?.data) ? r.data.data.length : 0 });
        if (!r.ok) return { items, pages, error: r.data };
        for (const it of (r.data?.data ?? [])) if (matches(it)) items.push(it);
        url = r.data?._links?.next?.href ?? null; n++;
      }
      return { items, pages, error: null };
    };
    const [profile, store, venueTransfers, platformTransfers, platformTransactions] = await Promise.all([
      row.split_profile_id && merchant ? call(`${M}/merchants/${encodeURIComponent(merchant)}/splitConfigurations/${encodeURIComponent(row.split_profile_id)}`) : Promise.resolve(null),
      row.store_id ? call(`${M}/stores/${encodeURIComponent(row.store_id)}`) : Promise.resolve(null),
      row.balance_account_id ? pageAll(`${BTL}/transfers?balanceAccountId=${encodeURIComponent(row.balance_account_id)}&${window}`) : Promise.resolve(null),
      bpId ? pageAll(`${BTL}/transfers?balancePlatform=${encodeURIComponent(bpId)}&${window}`) : Promise.resolve(null),
      bpId ? pageAll(`${BTL}/transactions?balancePlatform=${encodeURIComponent(bpId)}&${window}`) : Promise.resolve(null),
    ]);
    return json({
      ok: true, env: cfg.env, region: cfg.region, merchant, balancePlatform: bpId || null, refs,
      row: { store_id: row.store_id, balance_account_id: row.balance_account_id, account_holder_id: row.account_holder_id, split_profile_id: row.split_profile_id },
      profile, storeSplit: store ? { status: store.status, splitConfiguration: store.data?.splitConfiguration ?? null } : null,
      venueTransfers, platformTransfers, platformTransactions,
    });
  }

  // ── sweep_unsent (9 Sep 2026): re-kick STRANDED cloud jobs ────────────────
  // The backstop for the incident class where an Adyen job is minted in
  // charging_unsent and nobody ever sends 'start' (stale till bundle, till
  // network blip, till closed mid-create). terminal-job-create now kicks
  // server-side at create time; this action catches whatever that missed.
  //
  // WHO MAY CALL IT. THE SERVICE ROLE ONLY: pg_cron via call_edge_fn, every
  // minute, every venue (migration 20260909_edge_cron_adyen_unsent_sweep.sql).
  // location_id is an optional narrowing for that caller, nothing more.
  //
  // DECISION (9 Sep 2026 review): the first cut also let a caller who passed
  // the 'start' venue fence (a paired device's anonymous JWT, a user_locations
  // member, super_admin) sweep its own venue, so the till's reconciler could
  // ping it every 20s. That granted no new capability (such a caller can list
  // the venue's jobs via terminal-job-status and 'start' each one), but it
  // contradicted the stated requirement that this action cannot be reached
  // with a device JWT, and a payments backstop should be reachable from as few
  // places as possible. The till-side ping was removed with it; the create-time
  // server kick covers the stale till at 1.5s and this cron covers a lost kick
  // within the minute. Do not re-open the fence without re-deciding this.
  //
  // WHAT QUALIFIES (selectUnsentSweepCandidates, unit-tested): an adyen job in
  // charging_unsent with charge_minor stamped, not simulated/training, created
  // between 20s and 100s ago, not touched in the last 20s (backoff after a CAS
  // revert), whose terminal row is a paired CLOUD reader (adyen_terminal_id
  // set), and which is NOT driven by the device itself over the local nexo
  // bridge. Ten per run, oldest first. The 100s ceiling is set by 'result'
  // recovery below: it aborts an InProgress tender dispatched more than 120s
  // ago, and every till polls 'result' from 8s after the job goes 'charging',
  // so a later re-kick would put a prompt up that the next poll tears down
  // under the customer (or, with nobody polling, strand the row in 'charging'
  // for needs_human instead of the quiet cancel terminal_jobs_sweep gives an
  // unsent job at 15 minutes). Older rows belong to terminal_jobs_sweep. The
  // local-bridge tell has no persisted flag (no free column, DDL blocked), so
  // it is read from the job's draft source and from the terminal row and POS
  // device row sharing one auth uid (MPOS on an Adyen terminal registers BOTH
  // rows from the same session; a cloud AMS1 row is minted by
  // adyen-terminal-admin with a random device_uid).
  //
  // Each kick is this function's own 'start' (service-role bearer, same shape
  // adyen-terminal-events uses), fired under waitUntil so the sweep answers
  // in milliseconds: pg_net gives call_edge_fn 25s and a 'start' is one long
  // /sync call. The CAS makes a kick that races the till or another sweeper
  // harmless.
  if (action === 'sweep_unsent') {
    if (!isServiceRole) {
      await logRefusal('sweep_unsent: service role only', { action, callerUid });
      return json({ error: 'sweep_unsent: service role only' }, 403);
    }
    const locationId = body.location_id ? String(body.location_id) : null;

    // v5.11.16: the reader tip sweep rides this every minute cron (see
    // runReaderTipSweep). Started first so an empty or failed unsent select
    // below never skips it; waitUntil keeps it alive past this answer.
    {
      const tipSweep = runReaderTipSweep(locationId);
      // deno-lint-ignore no-explicit-any
      const rt = (globalThis as any).EdgeRuntime;
      if (rt?.waitUntil) rt.waitUntil(tipSweep);
    }

    const now = Date.now();
    let q = opsAdmin.from('terminal_jobs')
      .select('id, location_id, target_terminal_id, pos_device_id, processor, status, charge_minor, simulated, training, check_draft, created_at, updated_at')
      .eq('processor', 'adyen').eq('status', 'charging_unsent')
      .eq('simulated', false).eq('training', false)
      .not('charge_minor', 'is', null)
      .gte('created_at', new Date(now - UNSENT_SWEEP_MAX_AGE_MS).toISOString())
      .lte('created_at', new Date(now - UNSENT_SWEEP_MIN_AGE_MS).toISOString())
      .order('created_at', { ascending: true })
      .limit(50);
    if (locationId) q = q.eq('location_id', locationId);
    const { data: rows, error: qErr } = await q;
    if (qErr) return json({ error: qErr.message }, 500);
    const jobs = rows ?? [];
    if (!jobs.length) return json({ ok: true, scanned: 0, kicked: [], skipped: [] });

    const termIds = [...new Set(jobs.map((j) => j.target_terminal_id).filter(Boolean))];
    const devIds = [...new Set(jobs.map((j) => j.pos_device_id).filter(Boolean))];
    const [{ data: terms }, { data: devs }] = await Promise.all([
      opsAdmin.from('terminal_devices')
        .select('id, device_uid, adyen_terminal_id, status, active').in('id', termIds),
      devIds.length
        ? opsAdmin.from('devices').select('id, device_uid').in('id', devIds)
        : Promise.resolve({ data: [] as { id: string; device_uid: string | null }[] }),
    ]);
    const terminalsById = new Map((terms ?? []).map((t) => [t.id, t]));
    const devicesById = new Map((devs ?? []).map((d) => [d.id, d]));
    const { kick, skipped } = selectUnsentSweepCandidates(jobs, {
      terminalsById, devicesById, now,
      minAgeMs: UNSENT_SWEEP_MIN_AGE_MS, maxAgeMs: UNSENT_SWEEP_MAX_AGE_MS, limit: UNSENT_SWEEP_LIMIT,
    });

    const kickOne = async (id: string) => {
      try {
        const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/adyen-terminal-charge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE}` },
          body: JSON.stringify({ action: 'start', job_id: id, kicked_by: 'sweep_unsent' }),
        });
        const out = await res.text();
        console.log(`adyen-terminal-charge sweep_unsent: kick for job ${id}: ${res.status} ${out.slice(0, 200)}`);
      } catch (e) {
        console.error(`adyen-terminal-charge sweep_unsent: kick for job ${id} failed to send: ${(e as Error)?.message || e}`);
      }
    };
    if (kick.length) {
      const all = Promise.all(kick.map(kickOne));
      // deno-lint-ignore no-explicit-any
      const rt = (globalThis as any).EdgeRuntime;
      if (rt?.waitUntil) rt.waitUntil(all);
      // Durable trace (same trick as logRefusal): "was anything ever re-kicked"
      // must be answerable without console access. Only when something was.
      void platformAdmin.from('adyen_webhook_events').insert({
        event_key: `unsent-sweep:${now}:${Math.random().toString(36).slice(2, 8)}`,
        raw: { by: 'service_role', location_id: locationId, scanned: jobs.length, kicked: kick, skipped },
      }).then(() => {}, () => {});
    }
    console.log(`adyen-terminal-charge sweep_unsent: scanned ${jobs.length}, kicked ${kick.length}${locationId ? ` (venue ${locationId})` : ''}`);
    return json({ ok: true, scanned: jobs.length, kicked: kick, skipped });
  }

  const jobId = String(body.job_id ?? '');
  if (!jobId || !['start', 'prepare_local', 'report_local', 'result', 'abort'].includes(action)) {
    return json({ error: "action ('start'|'prepare_local'|'report_local'|'result'|'abort') and job_id required" }, 400);
  }

  const { data: job, error: jobErr } = await opsAdmin.from('terminal_jobs').select('*').eq('id', jobId).maybeSingle();
  if (jobErr) return json({ error: jobErr.message }, 500);
  if (!job) return json({ error: 'job not found' }, 404);
  if (job.processor !== 'adyen') return json({ error: `job is ${job.processor ?? 'ryft'} — wrong charge path` }, 409);

  // ── Fence ──────────────────────────────────────────────────────────────────
  // Two accepted identities (or the service role). BOTH are server-stamped from
  // auth.uid() by a SECURITY DEFINER RPC — neither can be self-asserted by a caller.
  //
  //   (a) TILL: a paired POS-family device at this job's location
  //       (devices.device_uid = auth.uid(), stamped by claim_device() and gated on
  //       the pairing code). This is the cloud transport's caller.
  //
  //   (b) THE JOB'S OWN TARGET TERMINAL (v5.6.81): a paired, active terminal_devices
  //       row whose id IS job.target_terminal_id and whose device_uid = auth.uid()
  //       (stamped by register_terminal_device(); location set only by
  //       claim_terminal_device() after a manager validated it in Back Office).
  //
  // WHY (b) IS NEEDED: our MPOS wrapper running ON an Adyen Android terminal is both
  // the till and the reader, and one browser holds ONE Supabase session — so a single
  // auth.uid() has to satisfy the till fence here AND the terminal_devices fence that
  // terminal_commit_tip / terminal_jobs RLS use. It usually does (MPOS also pairs as a
  // POS device, so claim_device stamps the same uid), but claim_device is best-effort
  // and both of its call sites swallow the failure — a device whose claim silently
  // failed would hold a manager-claimed reader row and still be told 'no access to
  // this job'. That is a 403 on a card the customer is standing in front of.
  //
  // WHY IT IS STILL TIGHT: (b) is NARROWER than (a), not wider. It is not "any
  // terminal at the venue" — it is THIS job's addressed terminal and no other, so it
  // grants exactly the capability the job already gives that terminal (terminal_jobs'
  // own SELECT policy fences the same way). It cannot reach another venue's jobs,
  // another terminal's jobs, or an unpaired/retired row.
  if (!isServiceRole) {
    // v5.6.89 — (c) a signed-in USER with user_locations access to the job's
    // venue (or super_admin), MIRRORING terminal-job-create's fence. Proven live
    // 19 Aug: Peter's browser POS shares its session with Back Office, so the
    // caller was his BO user — terminal-job-create ACCEPTED it and minted the
    // job, this fence REFUSED it, and the job deadlocked at charging_unsent
    // forever ("fence: caller is neither a paired device..." in the refusal
    // log, callerUid = his BO login). Creating a job is strictly MORE powerful
    // than kicking it (create freezes the money; the kick only transports the
    // DB's own amount behind a CAS), so any identity trusted to create must be
    // trusted to kick — otherwise that identity can only ever wedge terminals.
    const [{ data: dev }, { data: ownTerm }, { data: ul }, { data: prof }] = await Promise.all([
      opsAdmin.from('devices')
        .select('id').eq('device_uid', callerUid).eq('location_id', job.location_id).maybeSingle(),
      opsAdmin.from('terminal_devices')
        .select('id').eq('id', job.target_terminal_id).eq('device_uid', callerUid)
        .eq('status', 'paired').eq('active', true).maybeSingle(),
      opsAdmin.from('user_locations')
        .select('location_id').eq('user_id', callerUid).eq('location_id', job.location_id).maybeSingle(),
      opsAdmin.from('user_profiles')
        .select('role').eq('id', callerUid).maybeSingle(),
    ]);
    const isVenueUser = !!ul || prof?.role === 'super_admin';
    if (!dev && !ownTerm && !isVenueUser) {
      await logRefusal('fence: caller is neither a paired device at this location nor the job\'s own terminal', {
        action, jobId: job.id, jobLocation: job.location_id,
        targetTerminalId: job.target_terminal_id, callerUid,
      });
      return json({ error: 'no access to this job' }, 403);
    }
    if (!dev && ownTerm) {
      console.log(`adyen-terminal-charge: caller authorised as the job's own target terminal ${job.target_terminal_id} (job ${job.id}, action ${action})`);
    }
  }

  if (job.simulated === true) return json({ error: 'simulated job — the real charge path refuses it', code: 'SIMULATED' }, 409);
  if (job.training === true) return json({ error: 'training job — no card may be charged', code: 'TRAINING' }, 409);

  // Terminal + venue resolution shared by the initiating actions.
  const resolveTarget = async () => {
    const { data: term } = await opsAdmin.from('terminal_devices')
      .select('id, status, active, adyen_terminal_id')
      .eq('id', job.target_terminal_id).maybeSingle();
    const { data: ploc } = await platformAdmin.from('locations')
      .select('id').eq('ops_location_id', job.location_id).maybeSingle();
    const platformLocId = ploc?.id ?? job.location_id;
    // Account row + the venue's environment in one wait: the config every
    // reader message for this job goes out with.
    const [{ data: maa }, target] = await Promise.all([
      platformAdmin.from('merchant_adyen_accounts')
        .select('merchant_account, store_id, region, receive_payments_ok')
        .eq('location_id', platformLocId).maybeSingle(),
      adyenEnvForLocation(platformAdmin, platformLocId),
    ]);
    const cfg = adyenConfig(target);   // { env, region }: the venue's secret set and hosts
    // A row still naming the OTHER environment's merchant account (flipped
    // before set_environment rewrote it) must not reach the live host.
    if (maa) maa.merchant_account = effectiveMerchantAccount(cfg, maa.merchant_account) || null;

    // Drift-reconcile the POIID against platform payment_devices — the exact
    // guard that saved the Ryft path (ops column can go stale on re-pair).
    // Retired rows (readers from a previous environment, cleared by
    // set_environment reprovision) are not authoritative for anything.
    let poiid = term?.adyen_terminal_id as string | null;
    const { data: pds } = await platformAdmin.from('payment_devices')
      .select('adyen_terminal_id').eq('location_id', platformLocId)
      .eq('processor', 'adyen').not('adyen_terminal_id', 'is', null).neq('status', 'retired');
    const ids = Array.isArray(pds) ? pds.map((r) => r.adyen_terminal_id as string).filter(Boolean) : [];
    if (poiid && ids.length && !ids.includes(poiid) && ids.length === 1) {
      console.log(`adyen-terminal-charge: ops POIID ${poiid} absent from payment_devices; using authoritative ${ids[0]} (job ${job.id})`);
      poiid = ids[0];
    }
    return { term, maa, poiid, cfg };
  };

  // ── start (cloud sync — the till drives an AMS1-class terminal) ────────────
  if (action === 'start' || action === 'prepare_local') {
    // (settledBody's ok always won this spread; the literal ok:false was dead, v5.11.16.)
    if (SETTLED.includes(job.status)) return json({ error: `job already ${job.status}`, ...settledBody(job) }, 409);
    if (job.charge_minor == null) {
      await logRefusal('job has no server-computed charge', { action, jobId: job.id, status: job.status });
      return json({ ok: false, error: 'job has no server-computed charge — the tip was never committed' }, 409);
    }

    const { term, maa, poiid, cfg } = await resolveTarget();
    if (!term || term.status !== 'paired' || !term.active) {
      await logRefusal('terminal not paired', { action, jobId: job.id, targetTerminalId: job.target_terminal_id, termStatus: term?.status ?? null, termActive: term?.active ?? null });
      return json({ ok: false, error: 'terminal not paired' }, 409);
    }
    if (!poiid) {
      await logRefusal('terminal_not_linked (no POIID on the terminal row)', { action, jobId: job.id, targetTerminalId: job.target_terminal_id });
      return json({ ok: false, error: 'terminal_not_linked' }, 409);
    }
    if (!maa?.merchant_account) return json({ ok: false, error: 'venue has no Adyen account — onboarding incomplete' }, 409);
    // Fail closed BEFORE the CAS claim: a live venue without live keys must
    // never move a job to 'charging' with nothing dispatched.
    const nc = notConfigured(cfg);
    if (nc) return nc;

    // Who fired this kick (9 Sep 2026): the till, terminal-job-create's server
    // kick, or the stranded sweep. Log only; the CAS below decides.
    if (action === 'start') {
      const by = typeof body.kicked_by === 'string' ? body.kicked_by.slice(0, 40) : (isServiceRole ? 'service_role' : 'till');
      console.log(`adyen-terminal-charge: start requested for job ${job.id} by ${by} (status ${job.status})`);
    }

    // Idempotent replay: already in flight. code IN_FLIGHT (9 Sep 2026) lets a
    // till whose own kick lost the CAS to the server's kick treat this as
    // "someone else is already asking the reader", not as a failure.
    if (job.status === 'charging') {
      if (job.payment_session_id) return json({ ok: true, payment_session_id: job.payment_session_id, idempotent: true });
      return json({ ok: false, error: 'in_flight', code: 'IN_FLIGHT', service_id: job.nexo_service_id ?? null }, 409);
    }
    if (job.status !== 'charging_unsent') return json({ ok: false, error: `job is ${job.status} — not ready to charge` }, 409);

    // CAS write-ahead — stamp the ServiceID in the SAME winning update so status
    // recovery always has the key, whatever happens next.
    const serviceId = newServiceId();
    const nowIso = new Date().toISOString();
    const { data: cas, error: casErr } = await opsAdmin.from('terminal_jobs')
      .update({
        status: 'charging', dispatched_at: nowIso, nexo_service_id: serviceId,
        claim_expires_at: new Date(Date.now() + 5 * 60_000).toISOString(), updated_at: nowIso,
      })
      .eq('id', job.id).eq('status', 'charging_unsent').select('id');
    if (casErr) return json({ error: casErr.message }, 500);
    if (!Array.isArray(cas) || cas.length !== 1) {
      const { data: fresh } = await opsAdmin.from('terminal_jobs')
        .select('status, payment_session_id, nexo_service_id').eq('id', job.id).maybeSingle();
      if (fresh?.payment_session_id) return json({ ok: true, payment_session_id: fresh.payment_session_id, idempotent: true });
      if (fresh?.status === 'charging') return json({ ok: false, error: 'in_flight', code: 'IN_FLIGHT' }, 409);
      return json({ ok: false, error: `job is ${fresh?.status ?? 'gone'} — not ready to charge` }, 409);
    }

    const chargeMinor = Number(job.charge_minor);
    // THE AMOUNT IS THE DB'S. Platform commission is NOT computed here — the
    // venue's store split profile (set from the admin portal at onboarding)
    // books it automatically on every payment.
    const nexo = buildPaymentRequest({
      poiid,
      saleId: `servos-${String(job.location_id).slice(0, 8)}`,
      serviceId,
      // v968: merchantReference IS the job pointer — `tj-{id}` lets the
      // AUTHORISATION webhook find and settle an in-flight job (review finding:
      // payment_session_id only exists AFTER settle, so it could never backstop).
      transactionId: `tj-${job.id}`,
      amountMinor: chargeMinor,
      currency: String(job.currency || 'GBP').toUpperCase(),
      storeId: await storeReferenceFor(cfg, maa.store_id),
      // v5.7.5 TIP ON RECEIPT: a manual-capture job authorises without
      // capturing (PreAuth + manualCapture) and FORCES the on-reader tip
      // prompt off - the tip arrives in writing on the merchant slip and is
      // captured later (tip_capture / webhook kick / capture sweep).
      preAuth: job.capture_mode === 'manual' ? true : undefined,
      manualCapture: job.capture_mode === 'manual',
      // Tip prompt ON the reader — from the job's FROZEN tip config (the same
      // config PaxPay renders on-device). The gratuity presets shown come from
      // the store's terminalSettings, synced from Back Office (sync_gratuities).
      askGratuity: job.capture_mode === 'manual'
        ? false
        : (job.tip_config as { enabled?: boolean } | null)?.enabled === true,
    });

    // LOCAL TRANSPORT: hand the message to the on-terminal app / Tap to Pay SDK.
    // The row is 'charging' — the device MUST come back via report_local or the
    // recovery paths own it. Never expose keys; the payload is amount-fixed.
    //
    // ⚠ TODO(GO-LIVE BLOCKER — nexo local protection): `nexo` below is a PLAINTEXT
    // SaleToPOIRequest. A TEST terminal accepts that, which is what makes bench
    // testing on the S1F2L possible today. A LIVE Adyen terminal REFUSES it: the
    // local endpoint requires a SaleToPOISecuredMessage (AES-CBC body + HMAC-SHA256
    // MAC, keys derived from the store's local-comms passphrase via the Adyen
    // Customer Area). THIS FUNCTION IS THE PLACE THAT MUST DO THAT ENCRYPTION —
    // the wrapper posts the bytes verbatim and the web seam never inspects them, so
    // wrapping here (and unwrapping the PaymentResponse in report_local, before
    // parsePaymentResponse) is a change confined to this file plus a new secret.
    // Do NOT switch a venue to LIVE on the local transport until that ships.
    if (action === 'prepare_local') {
      return json({ ok: true, service_id: serviceId, poiid, nexo_request: nexo, charge_minor: chargeMinor, currency: String(job.currency || 'GBP').toUpperCase() });
    }

    // CLOUD TRANSPORT: one long sync call carries the whole cardholder interaction.
    let res;
    let hostUsed = terminalEndpoint(maa.merchant_account, poiid, 'sync', cfg.region, cfg);
    try {
      res = await adyenFetch('POST', hostUsed, nexo, { cfg, timeoutMs: 165_000 });
      // 9 Sep 2026, first live reader: the classic terminal-api-live host answered
      // 403 "010 Not allowed" for a boarded reader on a fully permitted key. Adyen
      // runs two cloud terminal host families (classic terminal-api and the newer
      // device-api); which one a live account has enabled is not visible to us.
      // On that exact refusal try the other family once, same request, same
      // ServiceID, so the outcome is the same to the till whichever host works.
      const notAllowed = !res.ok && res.status === 403 && /010|not allowed/i.test(JSON.stringify(res.data ?? ''));
      if (notAllowed && cfg.live && /terminal-api/.test(hostUsed)) {
        const region = String(cfg.region || 'UK').toUpperCase();
        const deviceHost = region === 'UK' || region === 'EU' ? 'https://device-api-live.adyen.com' : `https://device-api-live-${region.toLowerCase()}.adyen.com`;
        const alt = `${deviceHost}/v1/merchants/${encodeURIComponent(maa.merchant_account)}/devices/${encodeURIComponent(poiid)}/sync`;
        console.log(`adyen-terminal-charge: ${hostUsed} said 010 Not allowed, retrying on ${deviceHost} (job ${job.id})`);
        const second = await adyenFetch('POST', alt, nexo, { cfg, timeoutMs: 165_000 });
        if (second.ok || second.status !== 403) { res = second; hostUsed = alt; }
        else res = { ...second, data: { first_host: hostUsed, first: res.data, second_host: alt, second: second.data } };
      }
    } catch (e) {
      // Outcome UNKNOWABLE (timeout/network) — row stays 'charging'; recovery owns it.
      console.error('adyen-terminal-charge: sync transport error', (e as Error).message);
      return json({ ok: false, error: 'terminal_unreachable — result pending recovery', code: 'UNKNOWN_OUTCOME' }, 502);
    }
    if (!res.ok && res.status >= 400 && res.status < 500) {
      // Definitive rejection before any card interaction — nothing charged.
      // CAS-revert so the till can retry cleanly.
      // 9 Sep 2026: write Adyen's refusal on the job. The first live reader sat
      // unsent for an hour with nothing on the row; the 409 body only ever
      // reached the till's screen.
      const refusal = `adyen ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`;
      await opsAdmin.from('terminal_jobs')
        .update({ status: 'charging_unsent', nexo_service_id: null, last_error: refusal, updated_at: new Date().toISOString() })
        .eq('id', job.id).eq('status', 'charging');
      return json({ ok: false, safe: true, error: refusal }, 409);
    }
    if (!res.ok) {
      return json({ ok: false, error: 'terminal_unreachable — result pending recovery', code: 'UNKNOWN_OUTCOME' }, 502);
    }

    const parsed = parsePaymentResponse(res.data);
    // REVIEW HARDENING (v968, critical): a 200 with an empty/non-PaymentResponse
    // body (documented when the terminal is unreachable or the response timed
    // out mid-tender) parses 'Unknown'. Settling that as DECLINED while the
    // tender may still be LIVE is the double-charge — leave the row 'charging'
    // and let 'result'/events/webhook recovery own the truth.
    if (parsed.result === 'Unknown') {
      return json({ ok: false, error: 'terminal_unreachable — result pending recovery', code: 'UNKNOWN_OUTCOME' }, 502);
    }
    try { await settleFromResponse(job.id, parsed, 'charge_sync', chargeMinor, maa.merchant_account); }
    catch (e) {
      // v5.11.16: the tip or the settle could not be recorded yet. The job stays
      // 'charging'; the till's watch, 'result' and the sweep settle it with the tip.
      if (isSettleDeferred(e)) return deferredBody('charging');
      return json({ ok: false, error: (e as Error).message }, 500);
    }
    const { data: settled } = await opsAdmin.from('terminal_jobs').select('*').eq('id', job.id).maybeSingle();
    return json(await withCapture(settledBody(settled ?? job), settled ?? job));
  }

  // ── report_local (device returns the terminal's PaymentResponse) ───────────
  // REVIEW HARDENING (v968, critical): the device's report is ADVISORY. Three
  // gates before it can settle: (1) the response must carry THIS job's ServiceID
  // — a 51-bit random capability only the prepare_local caller ever received, so
  // stale attempts, other jobs and other devices can't bind; (2) POIID must match
  // the job's terminal when both are known; (3) a Success settle needs a real
  // AuthorizedAmount (enforced in settleFromResponse — no fallback for
  // 'device_report'). We ALSO try a cloud TransactionStatusRequest first: when
  // Adyen itself can answer, its answer wins over the device's claim.
  if (action === 'report_local') {
    if (SETTLED.includes(job.status)) return json(await withCapture(settledBody(job), job));
    if (job.status !== 'charging' && job.status !== 'unknown') {
      return json({ ok: false, error: `job is ${job.status} — nothing in flight` }, 409);
    }
    if (!body.response) return json({ error: 'response (nexo PaymentResponse) required' }, 400);
    const parsed = parsePaymentResponse(body.response);
    if (parsed.result === 'Unknown') return json({ ok: false, error: 'unparseable PaymentResponse' }, 400);
    if (!job.nexo_service_id || parsed.serviceId !== job.nexo_service_id) {
      return json({ ok: false, error: 'response does not match this job\'s attempt (ServiceID)' }, 409);
    }
    const { term: rTerm, maa: rMaa, poiid: rPoiid, cfg: rCfg } = await resolveTarget();
    if (parsed.poiid && rPoiid && parsed.poiid !== rPoiid) {
      return json({ ok: false, error: 'response came from a different terminal (POIID)' }, 409);
    }
    void rTerm;
    // Prefer Adyen's own answer when reachable (boarded terminals stay cloud-
    // addressable even when the app used local comms).
    if (rMaa?.merchant_account && rPoiid && rCfg.configured) {
      try {
        const statusReq = buildTransactionStatusRequest({
          poiid: rPoiid, saleId: `servos-${String(job.location_id).slice(0, 8)}`,
          serviceId: newServiceId(), origServiceId: job.nexo_service_id,
        });
        const sres = await adyenFetch('POST', terminalEndpoint(rMaa.merchant_account, rPoiid, 'sync', rCfg.region, rCfg), statusReq, { cfg: rCfg, timeoutMs: 15_000 });
        const ts = sres.ok ? (sres.data?.SaleToPOIResponse?.TransactionStatusResponse ?? null) : null;
        if (ts?.Response?.Result === 'Success') {
          const inner = parsePaymentResponse(ts?.RepeatedMessageResponse?.RepeatedResponseMessageBody ?? {});
          if (inner.result !== 'Unknown') {
            await settleFromResponse(job.id, inner, 'status_recovery', Number(job.charge_minor), rMaa?.merchant_account);
            const { data: settled } = await opsAdmin.from('terminal_jobs').select('*').eq('id', job.id).maybeSingle();
            return json(await withCapture(settledBody(settled ?? job), settled ?? job));
          }
        }
      } catch (e) {
        // v5.11.16: Adyen DID answer but the tip or settle could not be recorded
        // yet. Never fall through to the device's claim for the same payment.
        if (isSettleDeferred(e)) return deferredBody(job.status);
        /* cloud unreachable — fall through to the gated device report */
      }
    }
    try { await settleFromResponse(job.id, parsed, 'device_report', Number(job.charge_minor), rMaa?.merchant_account); }
    catch (e) {
      if (isSettleDeferred(e)) return deferredBody(job.status);
      return json({ ok: false, error: (e as Error).message }, 409);
    }
    const { data: settled } = await opsAdmin.from('terminal_jobs').select('*').eq('id', job.id).maybeSingle();
    return json(await withCapture(settledBody(settled ?? job), settled ?? job));
  }

  // ── result (recovery via TransactionStatusRequest) ─────────────────────────
  if (action === 'result') {
    if (SETTLED.includes(job.status)) return json(await withCapture(settledBody(job), job));
    // v968: also recover jobs the sweeper flipped charging→'unknown' — that was
    // a dead end (review finding: no automated recovery path existed for them).
    if ((job.status !== 'charging' && job.status !== 'unknown') || !job.nexo_service_id) {
      return json({ ok: true, state: 'processing', status: job.status });
    }
    // If Adyen's own ledger already knows the answer, take it: it is the same
    // truth the terminal would give, and it works when the terminal does not.
    // v5.11.16: this now actually settles (settleFromLedger). Until then the
    // call threw before settling, so it never recovered an approved job. An
    // amount it cannot explain is NOT parked from here (allowPark false): it
    // falls through to the reader's TransactionStatus, which carries TipAmount.
    // Falling through must never lose what the ledger proved: see the
    // not_found branch below, which never reverts a job Adyen approved.
    const early = await askAdyenLedger(job).catch(() => ({ verdict: 'too_soon' as const }));
    if (early.verdict === 'charged') {
      try {
        const r = await settleFromLedger(job, early.row, { allowPark: false });
        if (r.result === 'settled') {
          const { data: st } = await opsAdmin.from('terminal_jobs').select('*').eq('id', job.id).maybeSingle();
          if (st && SETTLED.includes(st.status)) return json(await withCapture(settledBody(st), st));
        }
      } catch (e) {
        if (isSettleDeferred(e)) return deferredBody(job.status);
        console.error(`adyen-terminal-charge: ledger settle for job ${job.id} failed, asking the reader: ${(e as Error).message}`);
      }
    }

    const { maa, poiid, cfg } = await resolveTarget();
    // An unconfigured live venue counts as no target: the Adyen ledger branch
    // below decides, never a status call on the wrong keys.
    const noTarget = !maa?.merchant_account || !poiid || !cfg.configured;
    const statusReq = noTarget ? null : buildTransactionStatusRequest({
      poiid: poiid as string, saleId: `servos-${String(job.location_id).slice(0, 8)}`,
      serviceId: newServiceId(), origServiceId: job.nexo_service_id,
    });
    const res = noTarget
      ? { ok: false, data: null }
      : await adyenFetch('POST', terminalEndpoint(maa!.merchant_account, poiid as string, 'sync', cfg.region, cfg), statusReq, { cfg, timeoutMs: 30_000 });
    if (!res.ok) {
      // The terminal could not be reached. Adyen's ledger is the fallback, and
      // it is the branch that actually matters in service: a dead terminal used
      // to leave the check blocked with no way out.
      const v = await askAdyenLedger(job).catch(() => ({ verdict: 'too_soon' as const }));
      if (v.verdict === 'nothing') {
        await opsAdmin.from('terminal_jobs')
          .update({ status: 'cancelled', decline_reason: 'Card machine could not be reached and Adyen has no record of this payment, so nothing was charged', updated_at: new Date().toISOString() })
          .eq('id', job.id).in('status', ['charging', 'unknown']);
        const { data: st } = await opsAdmin.from('terminal_jobs').select('*').eq('id', job.id).maybeSingle();
        return json(await withCapture(settledBody(st ?? job), st ?? job));
      }
      return json({ ok: true, state: 'processing', status: job.status });
    }
    const ts = res.data?.SaleToPOIResponse?.TransactionStatusResponse ?? {};
    const cond = ts?.Response?.Result === 'Success' ? 'found'
      : ts?.Response?.ErrorCondition === 'InProgress' ? 'in_progress'
      : ts?.Response?.ErrorCondition === 'NotFound' ? 'not_found' : 'unknown';
    if (cond === 'in_progress') {
      // v5.7.85: "in progress" forever is not in progress. A real authorisation
      // finishes in seconds, so a terminal still claiming one after two minutes
      // with NOTHING in Adyen's ledger is a dead tender: the customer walked, or
      // an on-terminal prompt (tip, PIN, application choice) timed out and left
      // the transaction open. Asking again changes nothing, which is exactly how
      // a check ends up wedged for the rest of service.
      //
      // So END it rather than observe it: send the nexo abort the terminal is
      // waiting for, then re-read the ledger before deciding anything. The
      // ledger re-read is what keeps this safe. If the abort raced a real
      // authorisation, the row is there and we settle from it instead.
      //
      // 9 Sep 2026: measured from DISPATCH, not from create. The 'start' CAS
      // re-stamps dispatched_at on every winning kick, so a job the unsent
      // sweep legitimately re-kicked late gets its own two minutes at the
      // reader instead of being aborted because the row is old. created_at is
      // the fallback for a row that never carried dispatched_at.
      const stalled = Date.now() - new Date(job.dispatched_at ?? job.created_at).getTime() > 120_000;
      const led = stalled ? await askAdyenLedger(job).catch(() => ({ verdict: 'too_soon' as const })) : { verdict: 'too_soon' as const };
      if (stalled && led.verdict === 'nothing') {
        const ab = buildAbortRequest({
          poiid: poiid as string, saleId: `servos-${String(job.location_id).slice(0, 8)}`,
          serviceId: newServiceId(), origServiceId: job.nexo_service_id,
          reason: 'MerchantAbort',
        });
        await adyenFetch('POST', terminalEndpoint(maa!.merchant_account, poiid as string, 'sync', cfg.region, cfg), ab, { cfg, timeoutMs: 15_000 }).catch(() => null);
        // Give a racing authorisation a moment to reach the ledger, then look again.
        await new Promise((r) => setTimeout(r, 2_000));
        const after = await askAdyenLedger(job).catch(() => ({ verdict: 'too_soon' as const }));
        if (after.verdict === 'charged') {
          // The tender is being ended and the ledger is the truth: an amount it
          // cannot explain is settled and parked (allowPark) for the heal or a manager.
          try { await settleFromLedger(job, after.row, { allowPark: true }); }
          catch (e) {
            if (isSettleDeferred(e)) return deferredBody(job.status);
            console.error(`adyen-terminal-charge: ledger settle after abort for job ${job.id} failed: ${(e as Error).message}`);
          }
        } else if (after.verdict === 'nothing') {
          // (v5.11.16: only a PROVEN empty ledger cancels. 'too_soon' now also
          // means the ledger could not be read, which decides nothing.)
          await opsAdmin.from('terminal_jobs')
            .update({ status: 'cancelled', decline_reason: 'The card machine was still waiting and Adyen has no record of this payment, so it was cancelled and nothing was charged', updated_at: new Date().toISOString() })
            .eq('id', job.id).in('status', ['charging', 'unknown']);
        }
        const { data: st } = await opsAdmin.from('terminal_jobs').select('*').eq('id', job.id).maybeSingle();
        if (st && !SETTLED.includes(st.status)) return json({ ok: true, state: 'processing', status: st.status });
        return json(await withCapture(settledBody(st ?? job), st ?? job));
      }
      return json({ ok: true, state: 'processing', status: job.status });
    }
    if (cond === 'unknown') {
      const v = await askAdyenLedger(job).catch(() => ({ verdict: 'too_soon' as const }));
      if (v.verdict === 'nothing') {
        await opsAdmin.from('terminal_jobs')
          .update({ status: 'cancelled', decline_reason: 'The card machine gave no answer and Adyen has no record of this payment, so nothing was charged', updated_at: new Date().toISOString() })
          .eq('id', job.id).in('status', ['charging', 'unknown']);
        const { data: st } = await opsAdmin.from('terminal_jobs').select('*').eq('id', job.id).maybeSingle();
        return json(await withCapture(settledBody(st ?? job), st ?? job));
      }
      return json({ ok: true, state: 'processing', status: job.status });
    }
    if (cond === 'not_found') {
      // v5.11.16 review: NotFound is NOT proof when Adyen's own ledger holds an
      // approved payment for this job (the reader was restarted, or its
      // transaction log rolled). Before v5.11.16 a job with a ledger row never
      // got this far (the ledger branch threw); now a ledger settle can skip
      // (an amount it cannot explain, a reversal, an unverified row), so look
      // again and NEVER revert money Adyen approved: settle it and park it with
      // both amounts, or leave it in flight for the sweep and a manager.
      const lg = (early.verdict === 'charged' || (early as any).ambiguous === true)
        ? early
        : await askAdyenLedger(job).catch(() => ({ verdict: 'too_soon' as const }));
      const ledgerApproved = ledgerShowsApproval(lg as any);
      if (ledgerApproved) {
        if (lg.verdict === 'charged') {
          try { await settleFromLedger(job, (lg as any).row, { allowPark: true }); }
          catch (e) {
            if (isSettleDeferred(e)) return deferredBody(job.status);
            console.error(`adyen-terminal-charge: ledger settle after NotFound for job ${job.id} failed: ${(e as Error).message}`);
          }
        }
        const { data: st } = await opsAdmin.from('terminal_jobs').select('*').eq('id', job.id).maybeSingle();
        if (st && SETTLED.includes(st.status)) return json(await withCapture(settledBody(st), st));
        return json({ ok: true, state: 'processing', status: st?.status ?? job.status });
      }
      // The terminal never saw the request — provably nothing charged. Revert so
      // the till can retry (the one branch where reverting in-flight is safe).
      await opsAdmin.from('terminal_jobs')
        .update({ status: 'charging_unsent', nexo_service_id: null, last_error: 'terminal never received the payment (Adyen: not found)', updated_at: new Date().toISOString() })
        .eq('id', job.id).in('status', ['charging', 'unknown']);
      return json({ ok: false, safe: true, error: 'terminal never received the payment — retry' }, 409);
    }
    const inner = ts?.RepeatedMessageResponse?.RepeatedResponseMessageBody ?? {};
    const parsed = parsePaymentResponse(inner);
    if (parsed.result === 'Unknown') return json({ ok: true, state: 'processing', status: job.status });
    try { await settleFromResponse(job.id, parsed, 'status_recovery', Number(job.charge_minor), maa?.merchant_account); }
    catch (e) {
      if (isSettleDeferred(e)) return deferredBody(job.status);
      return json({ ok: false, error: (e as Error).message }, 500);
    }
    const { data: settled } = await opsAdmin.from('terminal_jobs').select('*').eq('id', job.id).maybeSingle();
    return json(await withCapture(settledBody(settled ?? job), settled ?? job));
  }

  // ── abort (best-effort cancel of an in-flight tender) ──────────────────────
  if (action === 'abort') {
    if (SETTLED.includes(job.status)) return json({ ...settledBody(job), ok: false, error: `job already ${job.status}` });
    if (job.status !== 'charging' || !job.nexo_service_id) return json({ ok: true, state: 'processing', note: 'nothing in flight to abort' });
    const { maa, poiid, cfg } = await resolveTarget();
    if (maa?.merchant_account && poiid && cfg.configured) {
      const ab = buildAbortRequest({
        poiid, saleId: `servos-${String(job.location_id).slice(0, 8)}`,
        serviceId: newServiceId(), origServiceId: job.nexo_service_id,
      });
      await adyenFetch('POST', terminalEndpoint(maa.merchant_account, poiid, 'sync', cfg.region, cfg), ab, { cfg, timeoutMs: 15_000 }).catch(() => null);
    }
    // Abort is advisory — the tender may already have completed. The job stays
    // 'charging'; 'result' / the webhook decides the truth.
    return json({ ok: true, state: 'processing', note: 'abort sent — confirm with result' });
  }

  return json({ error: 'unhandled action' }, 400);
});
