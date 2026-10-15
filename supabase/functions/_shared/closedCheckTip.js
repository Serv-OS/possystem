// supabase/functions/_shared/closedCheckTip.js
//
// THE MATHS OF ADDING A TIP TO A SALE THAT IS ALREADY BOOKED.
//
// Pure. No I/O, no Deno, no Supabase: _shared/tip_capture.ts applyTipToClosedCheck
// (the ONE server side writer of a tip onto a closed check: US tip on the printed
// receipt since v5.7.5, its webhook revert, the capture sweep, and since v5.11.16
// the reader tip heal) calls closedCheckTipPatch, and src/lib/payments/
// closedCheckTip.test.js tests it under plain node.
//
// closed_checks money is in MAJOR units (numeric, 2 decimals): tip, total, and
// tenders[].amount / tenders[].tip. payment_intents legs carry amountMinor.
//
// Two callers, two shapes:
//   tip on receipt (legFlag set)  tip, total and the payment leg (amountMinor,
//                                 capture flag, captureId, tipError). Tenders are
//                                 left alone; the accounting layer adds that gap
//                                 to the card tender (_shared/accountingDay.js).
//   reader tip heal (tenderRef)   tip, total, the amountMinor of the payment leg
//                                 whose id IS the card's transaction id (if the
//                                 check has one), and the matched CARD TENDER's tip
//                                 plus tip_added_at. No capture flag: the heal must
//                                 never make History show a tip window.

const toMinor = (v) => Math.round((Number(v) || 0) * 100);
const isCard = (t) => !!t && typeof t === 'object' && String(t.method ?? '').trim().toLowerCase() === 'card';

/**
 * The card tender a reader payment paid, matched in this order:
 *   1. psp_ref === the job's transaction id (what every reader booking writes)
 *   2. psp_ref === the psp, or ends with '.' + psp (Adyen's tx id is <poi>.<psp>)
 *   3. the only card tender, when it carries no psp_ref at all
 * Anything else (no match, or more than one match at a rule) is refused.
 * @param {any} check closed_checks row
 * @param {{ transactionId?: string|null, psp?: string|null }} ref
 * @returns {{ ok: true, index: number } | { ok: false, reason: string }}
 */
export function findCardTender(check, { transactionId, psp } = {}) {
  const tenders = Array.isArray(check?.tenders) ? check.tenders : [];
  const cards = tenders.map((t, index) => ({ t, index })).filter(({ t }) => isCard(t));
  const unique = (hits) => (hits.length === 1 ? { ok: true, index: hits[0].index } : null);
  const tx = transactionId ? String(transactionId) : '';
  const p = psp ? String(psp) : '';
  if (tx) {
    const hits = cards.filter(({ t }) => t.psp_ref != null && String(t.psp_ref) === tx);
    if (hits.length) return unique(hits) ?? { ok: false, reason: 'no_matching_tender' };
  }
  if (p) {
    const hits = cards.filter(({ t }) => t.psp_ref != null && (String(t.psp_ref) === p || String(t.psp_ref).endsWith(`.${p}`)));
    if (hits.length) return unique(hits) ?? { ok: false, reason: 'no_matching_tender' };
  }
  if (cards.length === 1 && (cards[0].t.psp_ref == null || cards[0].t.psp_ref === '')) {
    return { ok: true, index: cards[0].index };
  }
  return { ok: false, reason: 'no_matching_tender' };
}

/**
 * Which sale holds a PARTIAL pay-at-table leg? A partial leg never books a check
 * of its own: the FINAL leg books the whole occupation, and its draft's
 * priorLegs (snapshotted by terminal_start_table_payment_for from
 * _terminal_paid_legs_for when the final leg STARTS) name every earlier leg by
 * jobId, with that leg's tipMinor and chargeMinor at that moment. So the final
 * leg's check already carries a heal that landed before the final leg started,
 * and planCheckTipCorrection on that check (matched by this leg's transaction
 * id) computes 0; a heal that landed after it computes the missing tip.
 *   { action: 'use', finalJob }                  correct finalJob's check
 *   { action: 'wait', reason: 'final_leg_not_booked' }  no final leg (yet), or it has not booked
 *   { action: 'refuse', reason: 'ambiguous_final_leg' } two final legs claim this leg
 * @param {any} partialJob terminal_jobs row with check_draft.partial === true
 * @param {any[]|null|undefined} jobs terminal_jobs rows on the same check_key
 */
export function findFinalLeg(partialJob, jobs) {
  const id = partialJob?.id ? String(partialJob.id) : '';
  const hits = (Array.isArray(jobs) ? jobs : []).filter((j) => {
    if (!j || typeof j !== 'object' || String(j.id) === id) return false;
    if (partialJob?.location_id && String(j.location_id) !== String(partialJob.location_id)) return false;
    const d = j.check_draft && typeof j.check_draft === 'object' ? j.check_draft : {};
    if (d.partial === true || !Array.isArray(d.priorLegs)) return false;
    if (j.status !== 'approved' && j.status !== 'reconciled') return false;
    return d.priorLegs.some((l) => l && String(l.jobId) === id);
  });
  if (hits.length > 1) return { action: 'refuse', reason: 'ambiguous_final_leg' };
  if (hits.length === 1 && hits[0].closed_check_id) return { action: 'use', finalJob: hits[0] };
  return { action: 'wait', reason: 'final_leg_not_booked' };
}

/**
 * Should a healed job's sale be corrected, and by how much?
 *   { action: 'wait', reason: 'no_check' }       the till has not booked it yet
 *   { action: 'noop', healedBefore }             the sale already carries the tip;
 *                                                healedBefore = the heal itself put
 *                                                it there (the tender carries its
 *                                                tip_added_at marker), so the sale
 *                                                WAS corrected after booking, even
 *                                                when that write's reply was lost
 *   { action: 'refuse', reason }                 a person corrects it
 *   { action: 'apply', deltaMinor, tenderIndex, expect: { tip, total } }
 * CONVERGENT: delta = the job's tip minus the tender's tip, so a replay after a
 * landed correction computes 0. `expect` is the compare-and-set guard for the write.
 * For a partial pay-at-table leg, `check` is the FINAL leg's check (findFinalLeg).
 * @param {any} check closed_checks row, or null when there is none
 * @param {any} job terminal_jobs row (healed: tip_minor set)
 */
export function planCheckTipCorrection(check, job) {
  if (!check) return { action: 'wait', reason: 'no_check' };
  if (check.status !== 'paid') return { action: 'refuse', reason: 'not_paid' };
  if (check.voided === true) return { action: 'refuse', reason: 'voided' };
  if (Array.isArray(check.refunds) && check.refunds.length) return { action: 'refuse', reason: 'refunded' };
  const target = Number(job?.tip_minor);
  if (!Number.isInteger(target) || target <= 0) return { action: 'refuse', reason: 'no_tip_on_job' };
  const m = findCardTender(check, { transactionId: job?.transaction_id, psp: job?.payment_session_id });
  if (!m.ok) return { action: 'refuse', reason: m.reason };
  const tender = check.tenders[m.index];
  if (toMinor(tender.amount) !== Number(job?.due_minor)) return { action: 'refuse', reason: 'amount_differs' };
  const current = toMinor(tender.tip);
  const delta = target - current;
  if (delta === 0) return { action: 'noop', healedBefore: tender.tip_added_at != null && tender.tip_added_at !== '', tenderIndex: m.index };
  if (delta < 0) return { action: 'refuse', reason: 'check_has_more_tip' };
  return { action: 'apply', deltaMinor: delta, tenderIndex: m.index, expect: { tip: check.tip ?? null, total: check.total ?? null } };
}

/**
 * The closed_checks patch that adds `tipMinor` (may be negative on a revert, 0 =
 * a flag only update). Moved verbatim from applyTipToClosedCheck (v5.7.5):
 *   tip   += tipMinor/100, total += tipMinor/100      (2 decimals)
 *   payment_intents leg (captureId, else psp, else the single leg):
 *     amountMinor += tipMinor, and when legFlag is given: capture = legFlag,
 *     captureId kept or stamped, tipError set or cleared.
 * Opt in (the reader tip heal):
 *   tenderRef  { transactionId, psp } or a transaction id: the matched card
 *              tender's tip += tipMinor/100 and tip_added_at = markAt. No match
 *              writes nothing (patch null, reason 'no_matching_tender').
 *   legFlag undefined: no capture flag, no captureId, tipError untouched, and
 *              the leg is matched by its id ONLY (id === psp, the job's
 *              transaction id). Never the single leg fallback: a reader sale
 *              that used a booking deposit carries ONLY the deposit leg
 *              ({ id: null, method: 'booking_deposit' }), which must never
 *              absorb a card tip.
 *
 * @param {any} check { tip, total, payment_intents, tenders? }
 * @param {{ tipMinor: number, captureId?: string|null, psp?: string|null, legFlag?: string, tipError?: string|null, tenderRef?: any, markAt?: string }} o
 * @returns {{ patch: Record<string, unknown>|null, legMatched: boolean, tenderMatched: boolean, reason?: string }}
 */
export function closedCheckTipPatch(check, o) {
  const tipMinor = Number(o?.tipMinor) || 0;
  const tipPounds = tipMinor / 100;
  const flagged = o?.legFlag !== undefined;
  /** @type {Record<string, unknown>} */
  const patch = {};
  if (tipMinor !== 0) {
    patch.tip = +((Number(check?.tip) || 0) + tipPounds).toFixed(2);
    patch.total = +((Number(check?.total) || 0) + tipPounds).toFixed(2);
  }
  const legs = Array.isArray(check?.payment_intents) ? check.payment_intents : [];
  let legMatched = false;
  const next = legs.map((leg) => {
    if (legMatched || !leg || typeof leg !== 'object') return leg;
    const hit = flagged
      ? ((leg.captureId && leg.captureId === o.captureId)
        || (o.psp && leg.id && leg.id === o.psp)
        || (legs.length === 1))
      : !!(o.psp && leg.id && String(leg.id) === String(o.psp));
    if (!hit) return leg;
    legMatched = true;
    const out = flagged
      ? { ...leg, capture: o.legFlag, captureId: leg.captureId ?? o.captureId }
      : { ...leg };
    if (tipMinor !== 0 && Number.isFinite(Number(leg.amountMinor))) {
      out.amountMinor = Number(leg.amountMinor) + tipMinor;
    }
    if (flagged) {
      if (o.tipError) out.tipError = o.tipError; else delete out.tipError;
    }
    return out;
  });
  if (legMatched) patch.payment_intents = next;

  let tenderMatched = false;
  if (o?.tenderRef) {
    const ref = typeof o.tenderRef === 'object' ? o.tenderRef : { transactionId: o.tenderRef };
    const m = findCardTender(check, { transactionId: ref.transactionId ?? null, psp: ref.psp ?? null });
    if (!m.ok) return { patch: null, legMatched, tenderMatched: false, reason: m.reason };
    tenderMatched = true;
    patch.tenders = check.tenders.map((t, i) => (i !== m.index ? t : {
      ...t,
      tip: +((Number(t.tip) || 0) + tipPounds).toFixed(2),
      tip_added_at: o.markAt ?? null,
    }));
  }

  if (!legMatched && !tenderMatched && tipMinor === 0) return { patch: null, legMatched, tenderMatched, reason: 'nothing_to_write' };
  return { patch, legMatched, tenderMatched };
}
