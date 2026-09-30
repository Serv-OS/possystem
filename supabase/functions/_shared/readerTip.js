// supabase/functions/_shared/readerTip.js
//
// A TIP ADDED ON THE CARD MACHINE IS NEVER LOST (29 Sep 2026, v5.11.16).
//
// Pure decisions only. No I/O, no Deno, no Supabase: this file is imported by
// _shared/readerTipHeal.ts (adyen-terminal-charge, adyen-webhook,
// adyen-terminal-events) and unit-tested from src/lib/payments/readerTip.test.js
// under plain node. Keep it that way.
//
// THE INCIDENT (Coffee Boy Huddersfield, R3618, job 53ae162a). The Adyen reader
// asked for a tip and the customer added 72p: AuthorizedAmount 797 on a 725
// bill, TipAmount 72. settleFromResponse recognised the tip, but the ONE write
// that records it (tip_minor 72, charge_minor 797) hit "connection reset". The
// code logged it and settled anyway with 797, so the settle RPC parked the job
// "amount mismatch: processor 797 vs server 725", the till booked the sale at
// 7.25 with no tip, and the 72p was recorded nowhere in ServOS. 1 of 658 reader
// payments; the owner's bar is none, ever.
//
// Three rules live here:
//   PREVENT     the tip write is retried and VERIFIED by reading the job back
//               (tipWriteOutcome). If it still cannot be recorded, the settle
//               does not happen; recovery settles later WITH the tip.
//   SELF-CORRECT a job parked with an amount mismatch is healed only when every
//               guard in planTipHeal passes, and only against ADYEN'S OWN record
//               (platform adyen_payments), never the job's text alone.
//   ALERT       anything that cannot be healed says so with both amounts.
//
// THE TIP BOUND (tipHealCapMinor). A heal credits at most the larger of 50% of
// the bill or 5.00 (500 minor units, in the job's currency):
//   * every tip credited live so far is a 5, 10 or 15% band;
//   * custom tips are allowed on these readers and pass 20% on a coffee, so the
//     5.00 floor keeps small sales healable;
//   * 50% stops a mislinked or odd authorisation being booked as a tip;
//   * a band based cap was rejected: the reader's presets come from Adyen store
//     terminalSettings, which are not on the job, so the job cannot prove what
//     the reader offered.
// Anything outside the bound goes to a manager with both amounts. The settle
// time rule (TipAmount explains the difference EXACTLY) keeps no cap, as before.

/** Tip write attempts: now, then after 250 ms, then after 750 ms (under 1.5 s). */
export const TIP_WRITE_RETRY_DELAYS_MS = Object.freeze([0, 250, 750]);
/** A heal credits at most this percentage of the bill... */
export const TIP_HEAL_MAX_PCT = 50;
/** ...or this many minor units, whichever is larger. */
export const TIP_HEAL_FLOOR_MINOR = 500;
/** Parked jobs are healed for this long after they settled. */
export const HEAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** A stranded charging/unknown job is looked at once dispatched this long ago... */
export const STRANDED_MIN_DISPATCH_AGE_MS = 60_000;
/** ...and no longer after this (older rows are a manager's). */
export const STRANDED_MAX_DISPATCH_AGE_MS = 3 * 24 * 60 * 60 * 1000;
/** Adyen's success row must be at least this old before the sweep trusts it alone. */
export const STRANDED_MIN_LEDGER_AGE_MS = 30_000;
/** After this, a stranded job whose amount is unexplained is settled and parked, not left. */
export const STRANDED_PARK_AFTER_MS = 5 * 60_000;
/** A parked job Adyen has still not confirmed after this is raised to a manager. */
export const HEAL_WAIT_ALERT_AFTER_MS = 5 * 60_000;
/** A healed job whose sale has still not been booked after this is raised to a manager. */
export const PENDING_CHECK_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
/** Every heal note starts with this (terminal_jobs.last_error). */
export const TIP_NOTE_PREFIX = 'tip added from the card machine';
/** Exactly what the settle RPC writes when it parks an amount mismatch, and nothing else. */
export const AMOUNT_MISMATCH_RE = /^amount mismatch: processor (\d+) vs server (\d+)$/;
/** The LIKE pattern the sweep selects parked mismatch jobs with. */
export const AMOUNT_MISMATCH_LIKE = 'amount mismatch: processor % vs server %';
/** The LIKE pattern the sweep selects healed jobs whose sale was not booked yet. */
export const PENDING_NOTE_LIKE = `${TIP_NOTE_PREFIX}:%sale not booked yet`;
/**
 * Ledger event codes after which a success row no longer stands for money the
 * venue kept. adyen-webhook never clears `success` on a modification (a failed
 * refund is not a failed payment); only last_event_code and
 * amount_refunded_minor move. Same rule as paymentProofRules.js adyenProof,
 * plus the chargeback family.
 */
export const REVERSAL_EVENT_CODES = Object.freeze([
  'CANCELLATION', 'CANCEL_OR_REFUND', 'REFUND', 'TECHNICAL_CANCEL',
  'CHARGEBACK', 'SECOND_CHARGEBACK', 'NOTIFICATION_OF_CHARGEBACK', 'PREARBITRATION_LOST',
]);

const SETTLED_STATUSES = Object.freeze(['approved', 'declined', 'cancelled', 'expired', 'reconciled']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const int = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};
const cur = (v) => String(v || 'GBP').trim().toUpperCase();

/**
 * Was the reader asked for a tip on this job? Exactly the askGratuity
 * expression adyen-terminal-charge 'start' sends, read off the job's FROZEN
 * tip_config, so the job itself is the proof that AskGratuity went out.
 * @param {any} job
 * @returns {boolean}
 */
export function tipAskedOnReader(job) {
  if (!job || typeof job !== 'object') return false;
  if (job.capture_mode === 'manual') return false;
  const cfg = job.tip_config;
  return !!cfg && typeof cfg === 'object' && cfg.enabled === true;
}

/**
 * The largest tip a heal may credit: max(50% of the bill, 5.00).
 * @param {any} job
 * @returns {number}
 */
export function tipHealCapMinor(job) {
  const basis = int(job?.tip_basis_minor) || int(job?.due_minor) || 0;
  return Math.max(Math.floor((basis * TIP_HEAL_MAX_PCT) / 100), TIP_HEAL_FLOOR_MINOR);
}

/**
 * The amount Adyen AUTHORISED on a ledger row: the AUTHORISATION's own amount
 * when stored, else the row's amount.
 * @param {any} row platform adyen_payments row
 * @returns {number|null}
 */
export function ledgerAuthAmount(row) {
  const fromAuth = int(row?.raw?.authorisation?.amount?.value);
  if (fromAuth != null) return fromAuth;
  return int(row?.amount_minor);
}

/**
 * Does a ledger row still stand for an APPROVED payment whose money was kept?
 *   'approved'  success, last event AUTHORISATION (or CAPTURE), nothing refunded
 *   'refused'   Adyen refused the authorisation (success is not true)
 *   'reversed'  approved, then cancelled, refunded or charged back
 *   'changed'   approved, then any other event (a failed capture or refund, an
 *               adjustment, no event code at all): a person looks
 * Only 'approved' may ever settle or heal a job automatically.
 * @param {any} row platform adyen_payments row
 * @returns {'approved'|'refused'|'reversed'|'changed'}
 */
export function ledgerApproval(row) {
  if (!row || typeof row !== 'object') return 'changed';
  if (row.success !== true) return 'refused';
  const code = String(row.last_event_code ?? '').trim().toUpperCase();
  if (REVERSAL_EVENT_CODES.includes(code) || (int(row.amount_refunded_minor) ?? 0) > 0) return 'reversed';
  if (code === 'AUTHORISATION' || code === 'CAPTURE') return 'approved';
  return 'changed';
}

/**
 * PROVENANCE. A ledger row may decide an automated settle only when the
 * AUTHORISATION that wrote it arrived HMAC VERIFIED: adyen-webhook records
 * hmac_valid per item in Ops adyen_events. Every reader event so far is signed
 * and verified (read-only SQL, 29 Sep 2026: 800 of 800 reader AUTHORISATIONs,
 * R3618's included), so this refuses only
 * an unsigned or forged item, or a row whose event cannot be read.
 * @param {any[]|null|undefined} events adyen_events rows for the row's psp_reference
 * @param {any} row platform adyen_payments row
 * @param {string} jobId
 * @returns {boolean}
 */
export function verifiedAuthorisation(events, row, jobId) {
  if (!row || !row.psp_reference || !jobId) return false;
  const list = Array.isArray(events) ? events : [];
  return list.some((e) => !!e && typeof e === 'object'
    && e.hmac_valid === true
    && String(e.event_code ?? '') === 'AUTHORISATION'
    && String(e.psp_reference ?? '') === String(row.psp_reference)
    && String(e.merchant_reference ?? '') === `tj-${jobId}`
    && (e.success === true) === (row.success === true)
    && (typeof row.live !== 'boolean' || typeof e.live !== 'boolean' || e.live === row.live));
}

/**
 * May a reader's NotFound revert a job to "never received" (charging_unsent, so
 * the till may charge again)? NEVER while Adyen's ledger holds a success row for
 * the job, whatever happened to that row since, or two of them.
 * @param {{ verdict?: string, row?: any, ambiguous?: boolean }|null|undefined} ask askAdyenLedger's answer
 * @returns {boolean} true = the ledger shows an approval, do not revert
 */
export function ledgerShowsApproval(ask) {
  if (!ask || typeof ask !== 'object') return false;
  if (ask.ambiguous === true) return true;
  return ask.verdict === 'charged' && !!ask.row && ask.row.success === true;
}

/**
 * Which ledger row speaks for a job (rows found by merchant_reference 'tj-<id>').
 *   none                → { row: null }
 *   exactly one success → that row
 *   no success          → the newest refusal
 *   two or more successes → { row: null, ambiguous: true } (a possible double
 *                          charge: never settled or healed automatically)
 * @param {any[]|null|undefined} rows
 * @returns {{ row: any, ambiguous: boolean }}
 */
export function pickLedgerRow(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === 'object');
  if (!list.length) return { row: null, ambiguous: false };
  const ok = list.filter((r) => r.success === true);
  if (ok.length >= 2) return { row: null, ambiguous: true };
  if (ok.length === 1) return { row: ok[0], ambiguous: false };
  const newest = [...list].sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0))[0];
  return { row: newest, ambiguous: false };
}

/**
 * A database refusal that retrying cannot change (a constraint, a bad value, a
 * missing column, an exception raised by our own RPC). Everything else
 * (connection reset, timeouts, PostgREST 5xx codes, a thrown fetch) is worth a
 * retry.
 * @param {any} error
 * @returns {boolean}
 */
export function isDefinitiveDbRefusal(error) {
  const code = String(error?.code ?? '').trim();
  return /^(22|23|42|P0)[0-9A-Z]{3}$/.test(code);
}

/**
 * VERIFY a tip write by reading the job back. A write can land while its reply
 * is lost, so "no reply" is never read as "not written".
 *   'recorded'          tip and charge are what we wrote (ours, or another path's)
 *   'retry'             untouched (tip null, charge unchanged, still in flight),
 *                       or the read itself failed (null)
 *   'settled_elsewhere' another path settled the job meanwhile
 *   'conflict'          anything else: settle anyway, the RPC parks it honestly
 * @param {any} readBack { tip_minor, charge_minor, status } or null
 * @param {{ tipMinor: number, authorizedMinor: number, chargeMinor: number }} p
 * @returns {'recorded'|'retry'|'settled_elsewhere'|'conflict'}
 */
export function tipWriteOutcome(readBack, { tipMinor, authorizedMinor, chargeMinor }) {
  if (!readBack || typeof readBack !== 'object') return 'retry';
  const tip = int(readBack.tip_minor);
  const charge = int(readBack.charge_minor);
  if (tip != null && tip === tipMinor && charge === authorizedMinor) return 'recorded';
  if (SETTLED_STATUSES.includes(readBack.status)) return 'settled_elsewhere';
  if (tip == null && charge === chargeMinor && (readBack.status === 'charging' || readBack.status === 'unknown')) return 'retry';
  return 'conflict';
}

/** Adyen's own refusal text on a ledger row. */
function ledgerRefusal(row) {
  const auth = row?.raw?.authorisation ?? {};
  const ad = auth?.additionalData ?? {};
  const text = ad.refusalReason ?? auth.reason ?? null;
  return text ? String(text).slice(0, 200) : 'declined';
}

/**
 * How to settle a job that is still in flight from Adyen's own record.
 *   decline      the payment was refused
 *   approve      the amount is the charge; or the reader's own TipAmount (the
 *                evidence a deferred settle stored, readerTipMinor) explains the
 *                difference EXACTLY (no cap, the settle time rule); or the
 *                difference is a tip the reader was asked for within the heal
 *                bound (tipMinor set)
 *   approve_park settle at Adyen's amount and let the RPC park it (allowPark)
 *   skip         leave it for the reader's own answer or a person: the payment
 *                was later refunded, cancelled or otherwise changed ('reversed',
 *                'event_code'), the currency differs, there is no amount, or an
 *                unexplained amount while parking is not allowed
 * @param {any} job
 * @param {any} row
 * @param {{ allowPark?: boolean, readerTipMinor?: number|null }} [opts]
 * @returns {{ action: 'decline'|'approve'|'approve_park'|'skip', reason?: string, amountMinor?: number, tipMinor?: number|null, psp?: string|null, declineReason?: string }}
 */
export function planLedgerSettle(job, row, { allowPark = false, readerTipMinor = null } = {}) {
  if (!job || !row) return { action: 'skip', reason: 'no_row' };
  const psp = row.psp_reference ? String(row.psp_reference) : null;
  const approval = ledgerApproval(row);
  if (approval === 'refused') return { action: 'decline', psp, declineReason: ledgerRefusal(row) };
  // A success row whose money did not stay (REFUND, CANCELLATION, chargeback,
  // anything refunded) or that moved on to some other event never settles a job.
  if (approval !== 'approved') return { action: 'skip', reason: approval === 'reversed' ? 'reversed' : 'event_code', psp };
  if (row.currency && cur(row.currency) !== cur(job.currency)) return { action: 'skip', reason: 'currency', psp };
  const amount = ledgerAuthAmount(row);
  const charge = int(job.charge_minor);
  if (amount == null || charge == null) return { action: 'skip', reason: 'no_amount', psp };
  if (amount === charge) return { action: 'approve', amountMinor: amount, tipMinor: null, psp };
  const diff = amount - charge;
  const readerTip = int(readerTipMinor);
  if (diff > 0 && job.tip_minor == null && readerTip != null && readerTip === diff) {
    return { action: 'approve', amountMinor: amount, tipMinor: diff, psp, reason: 'reader_tip' };
  }
  if (diff > 0 && job.tip_minor == null && tipAskedOnReader(job) && diff <= tipHealCapMinor(job)) {
    return { action: 'approve', amountMinor: amount, tipMinor: diff, psp };
  }
  return allowPark
    ? { action: 'approve_park', amountMinor: amount, tipMinor: null, psp, reason: 'unexplained_amount' }
    : { action: 'skip', reason: 'unexplained_amount', amountMinor: amount, psp };
}

/**
 * The settle RPC's own park text, and ONLY that text. A combined
 * "payment session mismatch ... / amount mismatch ..." never parses, so a
 * wiring fault is never healed.
 * @param {unknown} lastError
 * @returns {{ processorMinor: number, serverMinor: number } | null}
 */
export function parseAmountMismatch(lastError) {
  if (typeof lastError !== 'string') return null;
  const m = lastError.match(AMOUNT_MISMATCH_RE);
  if (!m) return null;
  const processorMinor = Number(m[1]);
  const serverMinor = Number(m[2]);
  if (!Number.isSafeInteger(processorMinor) || !Number.isSafeInteger(serverMinor)) return null;
  return { processorMinor, serverMinor };
}

/** Refusals that need no alert of their own (the job is parked for another reason, or a person already decided). */
export const QUIET_REFUSALS = Object.freeze(['not_amount_mismatch', 'changed_meanwhile']);

/**
 * Should a parked job be healed, and with what?
 *   { outcome: 'not_parked' }                        nothing to do
 *   { outcome: 'wait', reason }                      Adyen's record has not arrived
 *   { outcome: 'refuse', reason }                    a person must look (reason is machine readable)
 *   { outcome: 'heal', tipMinor, amountMinor, psp, currency }
 * @param {any} job terminal_jobs row
 * @param {any[]|null|undefined} ledgerRows platform adyen_payments rows for 'tj-<id>'
 * @returns {{ outcome: 'not_parked'|'wait'|'refuse'|'heal', reason?: string, tipMinor?: number, amountMinor?: number, psp?: string, currency?: string }}
 */
export function planTipHeal(job, ledgerRows) {
  if (!job || typeof job !== 'object') return { outcome: 'not_parked', reason: 'no_job' };
  if (job.processor !== 'adyen') return { outcome: 'not_parked', reason: 'processor' };
  if (job.simulated === true || job.training === true) return { outcome: 'not_parked', reason: 'simulated_or_training' };
  if (job.status !== 'approved' || job.needs_human !== true) return { outcome: 'not_parked', reason: 'not_parked' };

  const parsed = parseAmountMismatch(job.last_error);
  if (!parsed) {
    const mentionsAmount = typeof job.last_error === 'string' && job.last_error.includes('amount mismatch');
    return { outcome: 'refuse', reason: mentionsAmount ? 'wiring_fault' : 'not_amount_mismatch' };
  }
  if (job.tip_minor != null) return { outcome: 'refuse', reason: 'tip_already_set' };
  const charge = int(job.charge_minor);
  const due = int(job.due_minor);
  if (charge == null || charge !== due || charge !== parsed.serverMinor) return { outcome: 'refuse', reason: 'charge_not_due' };

  const { row, ambiguous } = pickLedgerRow(ledgerRows);
  if (ambiguous) return { outcome: 'refuse', reason: 'ambiguous_ledger' };
  if (!row) return { outcome: 'wait', reason: 'no_ledger_row' };

  if (!row.psp_reference || !job.payment_session_id || String(row.psp_reference) !== String(job.payment_session_id)) {
    return { outcome: 'refuse', reason: 'psp_mismatch' };
  }
  const approval = ledgerApproval(row);
  if (approval === 'refused') return { outcome: 'refuse', reason: 'not_success' };
  if (approval !== 'approved') return { outcome: 'refuse', reason: 'event_code' };
  const auth = ledgerAuthAmount(row);
  if (auth == null || int(row.amount_minor) !== auth) return { outcome: 'refuse', reason: 'auth_amount_differs' };
  if (!row.currency || cur(row.currency) !== cur(job.currency)) return { outcome: 'refuse', reason: 'currency' };
  // Corroboration only: the amount comes from the ledger, the text must agree with it.
  if (auth !== parsed.processorMinor) return { outcome: 'refuse', reason: 'text_differs_from_ledger' };

  const tip = auth - charge;
  if (tip <= 0) return { outcome: 'refuse', reason: 'not_a_tip' };
  if (job.capture_mode === 'manual') return { outcome: 'refuse', reason: 'manual_capture' };
  if (!tipAskedOnReader(job)) return { outcome: 'refuse', reason: 'not_asked' };
  if (tip > tipHealCapMinor(job)) return { outcome: 'refuse', reason: 'over_cap' };
  return { outcome: 'heal', tipMinor: tip, amountMinor: auth, psp: String(row.psp_reference), currency: cur(row.currency) };
}

/**
 * What the reader said, minus anything about the card. Stored durably when a
 * tip could not be recorded or a job parked, so the evidence exists next time.
 * @param {any} parsed parsePaymentResponse(...) output
 */
export function amountEvidence(parsed) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  const add = p.additional && typeof p.additional === 'object' ? p.additional : {};
  const keep = ['posAmountGratuityValue', 'posOriginalAmountValue', 'posAuthAmountValue', 'tipAmount'];
  const additional = {};
  for (const k of keep) if (add[k] != null) additional[k] = String(add[k]).slice(0, 40);
  return {
    result: p.result ?? null,
    authorizedMinor: p.authorizedMinor ?? null,
    tipMinor: p.tipMinor ?? null,
    pspReference: p.pspReference ?? null,
    poiTransactionId: p.poiTransactionId ?? null,
    additional,
  };
}

const clip = (v, n) => String(v ?? '').replace(/[\r\n]+/g, ' ').slice(0, n);

/**
 * The durable note a heal leaves on terminal_jobs.last_error.
 *   sale.state 'pending'        ...; sale not booked yet
 *   sale.state 'corrected'      ...; sale R3618 corrected from 725 to 797
 *   sale.state 'right'          ...; sale R3618 already right
 *   sale.state 'not_corrected'  ...; sale R3618 NOT corrected (<reason>)
 * @param {{ tipMinor: number, psp: string, amountMinor: number, billMinor: number, sale?: any }} p
 * @returns {string}
 */
export function healNote({ tipMinor, psp, amountMinor, billMinor, sale }) {
  const head = `${TIP_NOTE_PREFIX}: +${int(tipMinor) ?? 0} (Adyen ${clip(psp, 40)} took ${int(amountMinor) ?? 0}, bill ${int(billMinor) ?? 0})`;
  const s = sale && typeof sale === 'object' ? sale : { state: 'pending' };
  const ref = clip(s.ref || 'without a ref', 40);
  if (s.state === 'corrected') return `${head}; sale ${ref} corrected from ${int(s.fromMinor) ?? 0} to ${int(s.toMinor) ?? 0}`;
  if (s.state === 'right') return `${head}; sale ${ref} already right`;
  if (s.state === 'not_corrected') return `${head}; sale ${ref} NOT corrected (${clip(s.reason || 'unknown', 60)})`;
  return `${head}; sale not booked yet`;
}

/**
 * Where a heal note says the sale is. A healed note can never match
 * parseAmountMismatch, so a healed job can never be healed twice.
 * @param {unknown} lastError
 * @returns {'pending'|'corrected'|'not_corrected'|null}
 */
export function healNoteState(lastError) {
  if (typeof lastError !== 'string' || !lastError.startsWith(`${TIP_NOTE_PREFIX}: `)) return null;
  if (lastError.endsWith('; sale not booked yet')) return 'pending';
  if (/; sale .* NOT corrected \(.*\)$/.test(lastError)) return 'not_corrected';
  if (/; sale .* corrected from \d+ to \d+$/.test(lastError) || /; sale .* already right$/.test(lastError)) return 'corrected';
  return null;
}

/**
 * Where a settle that had to DEFER keeps the reader's own figures (platform
 * adyen_webhook_events, a fixed key, so the first write wins and a recovery pass
 * can read it back by primary key). Written only from a reader response
 * (settleFromResponse, adyen-terminal-events), never from the ledger.
 * @param {string} jobId
 */
export const tipEvidenceKey = (jobId) => `tip-unrecorded:${jobId}`;

/**
 * The reader's OWN TipAmount from a deferred settle's evidence, when it explains
 * Adyen's amount EXACTLY on this job's charge (the settle time rule, which has
 * no cap); else null.
 * @param {any} raw the evidence row's raw ({ chargeMinor, tipMinor, authorizedMinor, ... })
 * @param {{ amountMinor: number|null|undefined, chargeMinor: number|null|undefined }} p
 * @returns {number|null}
 */
export function readerTipFromEvidence(raw, { amountMinor, chargeMinor }) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const tip = int(r.tipMinor);
  const auth = int(r.authorizedMinor);
  const evCharge = int(r.chargeMinor);
  const amount = int(amountMinor);
  const charge = int(chargeMinor);
  if (tip == null || tip <= 0 || auth == null || amount == null || charge == null) return null;
  if (auth !== amount || evCharge !== charge || charge + tip !== amount) return null;
  return tip;
}

/**
 * The figures for a 'confirmed_late' alert: a job the till gave up on
 * ('unknown') that Adyen has since approved. The tip is named only when it is
 * proven: the reader's own TipAmount (evidence), else the heal rule (asked for,
 * within the bound).
 * @param {any} job terminal_jobs row
 * @param {any} row the approved ledger row
 * @param {any} [evidenceRaw] tipEvidenceKey row's raw, if any
 * @returns {{ reportedMinor: number|null, chargeMinor: number|null, tipMinor: number|null }}
 */
export function lateConfirmationFacts(job, row, evidenceRaw = null) {
  const amount = ledgerAuthAmount(row);
  const charge = int(job?.charge_minor);
  let tip = null;
  if (amount != null && charge != null && amount > charge && job?.tip_minor == null) {
    tip = readerTipFromEvidence(evidenceRaw, { amountMinor: amount, chargeMinor: charge });
    if (tip == null && tipAskedOnReader(job) && amount - charge <= tipHealCapMinor(job)) tip = amount - charge;
  }
  return { reportedMinor: amount, chargeMinor: charge, tipMinor: tip };
}

/**
 * The job id in a reader payment's merchant reference ('tj-<uuid>'), else null.
 * @param {unknown} ref
 * @returns {string|null}
 */
export function jobIdFromMerchantReference(ref) {
  const s = String(ref ?? '');
  if (!s.startsWith('tj-')) return null;
  const id = s.slice(3);
  return UUID_RE.test(id) ? id : null;
}

/**
 * EXACTLY ONCE, WITHOUT A GATE. Every alert and heal row in activity_events is
 * inserted with an id derived from its key, so a retry after a lost reply, a
 * second healer, or the next sweep pass hits the primary key (23505) instead of
 * writing a copy. The row itself is the durable "already told them" fact; no
 * separate gate can go stale or be lost. SHA-256 of the key, shaped as a
 * version 5 style UUID (activity_events.id is a plain uuid with a default).
 * @param {string} key
 * @returns {Promise<string>}
 */
export async function activityIdFor(key) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`servos-activity:${String(key)}`));
  const b = new Uint8Array(digest).slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * One alert per job and SUBJECT, so a later alert about something else is never
 * swallowed by an earlier one ('wait' then a refusal, a payment alert then a
 * sale alert):
 *   refuse, ambiguous               amount-alert:<job>
 *   wait                            amount-alert:<job>:wait
 *   sale_not_corrected, _never_...  amount-alert:<job>:sale
 *   reversed                        amount-alert:<job>:reversed
 *   confirmed_late                  amount-alert:<job>:late
 * @param {string} jobId
 * @param {string} kind
 * @returns {string}
 */
export function alertKey(jobId, kind) {
  const suffix = kind === 'wait' ? ':wait'
    : (kind === 'sale_not_corrected' || kind === 'sale_never_recorded') ? ':sale'
    : kind === 'reversed' ? ':reversed'
    : kind === 'confirmed_late' ? ':late'
    : '';
  return `amount-alert:${jobId}${suffix}`;
}

/** The key of the one info row a heal leaves for its sale. */
export const healActivityKey = (jobId) => `tip-heal-activity:${jobId}`;

const SYMBOLS = Object.freeze({ GBP: '£', USD: '$', EUR: '€' });

/**
 * Minor units as a person reads them: £7.25, $7.25, €7.25, else "7.25 CAD".
 * @param {number} minor
 * @param {string} [currency]
 * @returns {string}
 */
export function money(minor, currency = 'GBP') {
  const n = Number(minor);
  const v = Number.isFinite(n) ? n : 0;
  const abs = (Math.abs(Math.round(v)) / 100).toFixed(2);
  const sign = v < 0 ? '-' : '';
  const c = cur(currency);
  const sym = SYMBOLS[c];
  return sym ? `${sign}${sym}${abs}` : `${sign}${abs} ${c}`;
}

/** Why a heal or a sale correction did not happen, in words a manager reads. */
const REASON_TEXT = Object.freeze({
  over_cap: 'the difference is bigger than a tip is allowed to be added automatically',
  not_asked: 'the card machine was not asked for a tip on this payment',
  manual_capture: 'this payment takes its tip on the printed receipt',
  psp_mismatch: "Adyen's record names a different payment",
  not_success: 'Adyen did not approve this payment',
  event_code: 'Adyen has changed this payment since (captured, refunded or cancelled)',
  auth_amount_differs: "Adyen's amount has been adjusted since the payment",
  currency: 'the currency does not match',
  text_differs_from_ledger: "Adyen's record does not match what the card machine said",
  not_a_tip: 'the card machine took less than the bill',
  tip_already_set: 'the payment already has a tip recorded',
  charge_not_due: 'the payment was changed after it was sent',
  ambiguous_ledger: 'Adyen shows more than one approved payment for this sale',
  wiring_fault: 'the payment reference did not match',
  no_ledger_row: 'Adyen has not confirmed this payment yet',
  write_refused: 'the database refused the change',
  sale_never_recorded: 'the sale was never recorded',
  no_matching_tender: 'the card payment could not be found on the sale',
  refunded: 'the sale has been refunded',
  voided: 'the sale was voided',
  not_paid: 'the sale is not marked paid',
  amount_differs: 'the card payment on the sale is a different amount',
  check_has_more_tip: 'the sale already shows a bigger tip',
  ambiguous_final_leg: 'more than one final payment was found for this table',
  no_tip_on_job: 'no tip was recorded on the payment',
  reversed: 'Adyen shows it was refunded or cancelled after it was taken',
  unverified: "Adyen's record of it could not be verified",
});

/** @param {string} reason */
export function reasonText(reason) {
  return REASON_TEXT[reason] || String(reason || 'of an unexpected answer').replace(/_/g, ' ');
}

/**
 * The info row a successful heal leaves in the venue's activity feed.
 * @param {{ ref?: string|null, tipMinor: number, fromMinor: number, toMinor: number, currency?: string, corrected: boolean }} p
 * @returns {{ title: string, body: string, severity: 'info' }}
 */
export function healActivity({ ref, tipMinor, fromMinor, toMinor, currency = 'GBP', corrected }) {
  const sale = ref ? `sale ${ref}` : 'the sale';
  const title = `Tip added from the card machine: ${ref || 'card sale'}`;
  const body = corrected
    ? `The customer added a ${money(tipMinor, currency)} tip on the card machine and it had not been recorded. `
      + `Adyen confirmed it, so ${sale} was corrected from ${money(fromMinor, currency)} to ${money(toMinor, currency)} `
      + `with a ${money(tipMinor, currency)} tip. If this day's Z report or Xero post already ran, run it again.`
    : `The customer added a ${money(tipMinor, currency)} tip on the card machine. Adyen confirmed it, `
      + `so ${sale} was recorded at ${money(toMinor, currency)} with the tip. Nothing else to do.`;
  return { title, body, severity: 'info' };
}

/**
 * The action row for anything that could not be healed or corrected.
 * kind: 'refuse' | 'wait' | 'sale_not_corrected' | 'sale_never_recorded' | 'ambiguous'
 *       | 'reversed' (Adyen approved it, then it was refunded, cancelled or changed)
 *       | 'confirmed_late' (the till gave up on it, Adyen has since approved it)
 * @param {{ kind: string, reason?: string, ref?: string|null, reportedMinor?: number|null, chargeMinor?: number|null, tipMinor?: number|null, currency?: string }} p
 * @returns {{ title: string, body: string, severity: 'action' }}
 */
export function mismatchAlert({ kind, reason, ref, reportedMinor, chargeMinor, tipMinor, currency = 'GBP' }) {
  const where = 'Check it in Back Office, Card readers, Payments that need checking.';
  if (kind === 'reversed') {
    return {
      title: `Check this card payment: ${ref || 'card sale'}`,
      body: `This card payment was not recorded automatically because ${reasonText(reason || 'reversed')}. `
        + `Check whether the customer paid another way. ${where}`,
      severity: 'action',
    };
  }
  if (kind === 'confirmed_late') {
    const took = reportedMinor != null ? money(reportedMinor, currency) : 'the payment';
    const differs = reportedMinor != null && chargeMinor != null && Number(reportedMinor) !== Number(chargeMinor);
    const tipped = differs && tipMinor != null && Number(tipMinor) > 0
      && Number(reportedMinor) === Number(chargeMinor) + Number(tipMinor);
    const detail = !differs ? ''
      : tipped ? ` The bill was ${money(chargeMinor, currency)} and the customer added a ${money(tipMinor, currency)} tip on the card machine.`
      : ` The bill was ${money(chargeMinor, currency)}.`;
    const tipStep = tipped ? ` and add the ${money(tipMinor, currency)} tip to the sale` : '';
    return {
      title: `Card payment confirmed later: ${ref || 'card sale'}`,
      body: `The till could not confirm this card payment, and Adyen has since confirmed it took ${took}.${detail} `
        + 'It was not recorded automatically in case the customer paid another way. '
        + `If they did not, choose Customer was charged${tipStep}; if they did, refund one of the two payments. ${where}`,
      severity: 'action',
    };
  }
  const amounts = (reportedMinor != null && chargeMinor != null)
    ? `The card machine took ${money(reportedMinor, currency)} and the bill was ${money(chargeMinor, currency)}.`
    : 'The card machine took a different amount from the bill.';
  if (kind === 'sale_not_corrected' || kind === 'sale_never_recorded') {
    const sale = ref ? `sale ${ref}` : 'the sale';
    const tip = tipMinor != null ? `a ${money(tipMinor, currency)} tip` : 'the tip';
    const body = kind === 'sale_never_recorded'
      ? `The customer added ${tip} on the card machine and it was added to the card payment, but the sale was never recorded on a till. Record the sale by hand.`
      : `The customer added ${tip} on the card machine and it was added to the card payment, but ${sale} could not be corrected because ${reasonText(reason || 'unknown')}. Correct the sale by hand.`;
    return { title: `Tip not on the sale: ${ref || 'card sale'}`, body, severity: 'action' };
  }
  if (kind === 'ambiguous') {
    return {
      title: `Check this card payment: ${ref || 'card sale'}`,
      body: `Adyen shows more than one approved payment for this sale, so nothing was recorded automatically. ${where}`,
      severity: 'action',
    };
  }
  const why = kind === 'wait' ? reasonText('no_ledger_row') : reasonText(reason || 'unknown');
  return {
    title: `Card amount differs: ${ref || 'card sale'}`,
    body: `${amounts} The sale is recorded at the bill amount. The difference was not added automatically because ${why}. ${where}`,
    severity: 'action',
  };
}
