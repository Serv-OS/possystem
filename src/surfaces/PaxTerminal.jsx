/**
 * PaxTerminal.jsx — the POS's view of a payment happening on a PAX terminal.
 *
 * The till dispatches a job row and then WATCHES it. All the interaction — amount
 * confirmation, tip, card — happens on the terminal, in the customer's hand. This
 * screen exists so staff can see where the payment has got to, and cancel it while
 * cancelling is still deterministically safe.
 *
 * Three things this screen is deliberately strict about:
 *
 *   1. Cancel is a REQUEST, not a statement. The server refuses once charged_at is
 *      set. We only tell staff "cancelled" once we have OBSERVED that status
 *      (spec rule 15) — saying it while the card is being charged is exactly the
 *      failure the rule exists to stop.
 *
 *   2. `unknown` is a dead end, on purpose. No retry button, no "try again",
 *      no dismiss. It is never auto-retried (double charge) and never dropped
 *      (lost sale) — a manager resolves it from the Back Office queue.
 *
 *   3. The tip and the charge come off the job's INTEGERS (tip_minor,
 *      charge_minor), never re-derived from the displayed pounds. Never round twice.
 *
 * Spec: docs/PAXPAY_TRANSPORT_SPEC.md
 */

import { useEffect, useRef, useState } from 'react';
import { pollTerminalJob, cancelTerminalJob, fetchJob } from '../lib/payments/terminalJobs';
import { money } from '../lib/currency';

const STATUS_COPY = {
  pending:         { icon: '📲', title: 'Sent to the card machine',   sub: 'Hand it to the customer.' },
  claimed:         { icon: '📲', title: 'On the card machine',        sub: 'Waiting for the customer.' },
  tipping:         { icon: '💬', title: 'Choosing a tip',             sub: 'The customer is picking a gratuity.' },
  charging_unsent: { icon: '💳', title: 'Ready to take the card',     sub: 'Tip settled — asking for the card.' },
  charging:        { icon: '💳', title: 'Taking the card',            sub: 'Do not walk away — this one is live.' },
  approved:        { icon: '✅', title: 'Approved',                   sub: '' },
  declined:        { icon: '⛔', title: 'Declined',                   sub: 'Ask for another card, or take cash.' },
  cancelled:       { icon: '✋', title: 'Cancelled',                  sub: 'Nothing was charged.' },
  expired:         { icon: '⏱', title: 'Timed out',                  sub: 'Nothing was charged — start again.' },
  unknown:         { icon: '⚠️', title: 'Outcome not confirmed',      sub: '' },
};

export default function PaxTerminal({ job: initialJob, terminalLabel, onComplete, onBack, onFailed }) {
  const [job, setJob] = useState(initialJob);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelMsg, setCancelMsg] = useState('');
  const abortRef = useRef(null);
  const doneRef = useRef(false);

  // ── watch the job row ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!initialJob?.id) return undefined;
    const ac = new AbortController();
    abortRef.current = ac;
    pollTerminalJob(initialJob.id, { onUpdate: setJob, signal: ac.signal })
      .then((final) => {
        if (ac.signal.aborted || doneRef.current) return;
        setJob(final);
      })
      .catch(() => { /* aborted on unmount */ });
    return () => { ac.abort(); };
  }, [initialJob?.id]);

  // ── settle ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!job || doneRef.current) return;
    if (job.status === 'approved' && !job.needs_human) {
      doneRef.current = true;
      // Hand the parent the job's own INTEGERS. tipMinor is what drives the
      // corrected tip-recording line in CheckoutModal; amountReceived is the leg
      // that is genuinely refundable (the charge, never the check face value).
      const t = setTimeout(() => onComplete?.({
        processor: 'ryft',
        tipMinor: job.tip_minor ?? 0,
        amountReceived: job.charge_minor ?? null,
        paymentIntentId: job.transaction_id || null,
        card: job.card || null,
        authCode: job.auth_code || null,
        jobId: job.id,
        closedCheckId: job.closed_check_id,
      }), 350);
      return () => clearTimeout(t);
    }
    if (['declined', 'cancelled', 'expired'].includes(job.status)) {
      doneRef.current = true;
      onFailed?.(job);
    }
    return undefined;
  }, [job, onComplete, onFailed]);

  const status = job?.status ?? 'pending';
  const copy = STATUS_COPY[status] ?? STATUS_COPY.pending;
  const blocked = status === 'unknown' || (status === 'approved' && job?.needs_human);
  // v5.5.905 — CANCEL MUST BE AVAILABLE WHILE THE CARD PROMPT IS LIVE. It used to be hidden
  // the instant charged_at appeared — but charged_at is stamped BEFORE the controller is
  // launched, so the button vanished at exactly the moment staff need it: the amount is on
  // the terminal, the customer is standing there, and nothing can call it off. That is the
  // owner-reported "cancelling doesn't close the payment off the machine": the server-side
  // void has been complete and deployed all along, and simply had no caller.
  //
  // THE SERVER IS THE AUTHORITY, not this flag. terminal-job-cancel voids the live action at
  // the processor, then re-reads the payment session and settles from what ACTUALLY happened
  // — a card that already paid comes back as already_captured ("refund instead"), never a
  // false cancel. So the client offers it for every LIVE status and lets the server rule.
  const LIVE = ['pending', 'claimed', 'tipping', 'charging_unsent', 'charging'];
  const canOfferCancel = LIVE.includes(status) && !blocked;
  // Once the terminal is holding a card, say so on the button — cancelling then is a real
  // processor void, not a quiet local abort.
  const cancelIsLive = !!job?.charged_at;

  const doCancel = async () => {
    setCancelBusy(true); setCancelMsg('');
    const r = await cancelTerminalJob(job.id);
    if (r?.ok) {
      // Re-read rather than assuming — we report what the server says happened.
      const fresh = await fetchJob(job.id).catch(() => null);
      if (fresh) setJob(fresh);
    } else if (r?.error === 'already_captured' || r?.reason === 'already_captured') {
      // The tap beat the cancel. Never imply it was called off — the money moved.
      setCancelMsg('That card has already paid — refund it instead of cancelling.');
      const fresh = await fetchJob(job.id).catch(() => null);
      if (fresh) setJob(fresh);
    } else {
      setCancelMsg(r?.reason || r?.error || 'Could not cancel — check the terminal screen before retrying.');
    }
    setCancelBusy(false);
  };

  const dueGbp    = (job?.due_minor ?? 0) / 100;
  const tipGbp    = job?.tip_minor != null ? job.tip_minor / 100 : null;
  const chargeGbp = job?.charge_minor != null ? job.charge_minor / 100 : null;

  return (
    <div style={{ textAlign: 'center', padding: '28px 20px' }}>
      <div style={{ fontSize: 46, marginBottom: 12 }}>{copy.icon}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--t1)' }}>{copy.title}</div>
      {copy.sub && (
        <div style={{ fontSize: 13, color: 'var(--t3)', marginTop: 6, lineHeight: 1.5 }}>{copy.sub}</div>
      )}
      {terminalLabel && (
        <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 8, textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700 }}>
          {terminalLabel}
        </div>
      )}

      {/* The three amounts, shown as they settle */}
      <div style={{
        marginTop: 20, padding: 14, borderRadius: 12,
        background: 'var(--bg3)', border: '1px solid var(--bdr)',
        display: 'flex', flexDirection: 'column', gap: 6, textAlign: 'left',
      }}>
        <Row label="Bill" value={money(dueGbp)} />
        {tipGbp != null && <Row label="Tip" value={money(tipGbp)} />}
        {chargeGbp != null && <Row label="Charging" value={money(chargeGbp)} strong />}
      </div>

      {/* Blocking states — no retry, no dismiss. A human decides. */}
      {blocked && (
        <div style={{
          marginTop: 18, padding: 14, borderRadius: 12, textAlign: 'left',
          background: 'var(--red-d)', border: '1px solid var(--red-b)', color: 'var(--red)',
        }}>
          <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 6 }}>
            {status === 'unknown' ? 'We cannot confirm this payment' : 'Amount does not match'}
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.6 }}>
            {status === 'unknown'
              ? 'The card may or may not have been charged. Do NOT take payment again — that risks charging the customer twice. A manager must resolve this in Back Office → Unreconciled payments before this check can close.'
              : 'The terminal reported a different amount from the one we asked for. This check is held until a manager checks it in Back Office → Unreconciled payments.'}
          </div>
          {job?.last_error && (
            <div style={{ fontSize: 11, marginTop: 8, opacity: .85, fontFamily: 'var(--font-mono, monospace)' }}>
              {job.last_error}
            </div>
          )}
        </div>
      )}

      {cancelMsg && (
        <div style={{ marginTop: 14, fontSize: 12, color: 'var(--red)' }}>{cancelMsg}</div>
      )}

      <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 22, flexWrap: 'wrap' }}>
        {canOfferCancel && (
          <button className="btn" style={{ height: 44, padding: '0 18px' }} disabled={cancelBusy} onClick={doCancel}>
            {cancelBusy ? 'Cancelling…' : 'Cancel payment'}
          </button>
        )}
        {['declined', 'cancelled', 'expired'].includes(status) && (
          <button className="btn" style={{ height: 44, padding: '0 18px' }} onClick={onBack}>
            Back to checkout
          </button>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, strong }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <span style={{ fontSize: 12, color: 'var(--t3)' }}>{label}</span>
      <span style={{ fontSize: strong ? 17 : 14, fontWeight: strong ? 800 : 600, color: strong ? 'var(--t1)' : 'var(--t2)' }}>
        {value}
      </span>
    </div>
  );
}
