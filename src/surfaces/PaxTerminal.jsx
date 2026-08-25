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
 *      v5.7.37 — on ADYEN jobs it is no longer a dead end for staff: the sheet
 *      offers "Check card machine" (and auto-checks by itself), which asks the
 *      READER what really happened via adyen-terminal-charge 'result'. The
 *      server settles the job from the reader's own answer, so this is still
 *      never a client-side guess — the dead-end rule's point is preserved.
 *
 *   3. The tip and the charge come off the job's INTEGERS (tip_minor,
 *      charge_minor), never re-derived from the displayed pounds. Never round twice.
 *
 * Spec: docs/PAXPAY_TRANSPORT_SPEC.md
 */

import { useEffect, useRef, useState } from 'react';
import { pollTerminalJob, cancelTerminalJob, fetchJob, checkJobWithReader } from '../lib/payments/terminalJobs';
import { useStore } from '../store';
import { money } from '../lib/currency';

const STATUS_COPY = {
  pending:         { icon: '📲', title: 'Sent to the card machine',   sub: 'Hand it to the customer.' },
  claimed:         { icon: '📲', title: 'On the card machine',        sub: 'Waiting for the customer.' },
  tipping:         { icon: '💬', title: 'Choosing a tip',             sub: 'The customer is picking a gratuity.' },
  charging_unsent: { icon: '💳', title: 'Ready to take the card',     sub: 'Tip settled — asking for the card.' },
  charging:        { icon: '💳', title: 'Taking the card',            sub: 'Do not walk away — this one is live.' },
  approved:        { icon: '✅', title: 'Approved',                   sub: '' },
  // Same screen as approved: the reconciler simply booked the check before this
  // modal's poll caught up. Without an entry here the header fell back to blank.
  reconciled:      { icon: '✅', title: 'Approved',                   sub: '' },
  declined:        { icon: '⛔', title: 'Declined',                   sub: 'Ask for another card, or take cash.' },
  cancelled:       { icon: '✋', title: 'Cancelled',                  sub: 'Nothing was charged.' },
  expired:         { icon: '⏱', title: 'Timed out',                  sub: 'Nothing was charged — start again.' },
  unknown:         { icon: '⚠️', title: 'Outcome not confirmed',      sub: '' },
};

export default function PaxTerminal({ job: initialJob, terminalLabel, onComplete, onBack, onFailed }) {
  const [job, setJob] = useState(initialJob);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelMsg, setCancelMsg] = useState('');
  const [checkBusy, setCheckBusy] = useState(false);
  const [checkMsg, setCheckMsg] = useState('');
  const abortRef = useRef(null);
  const doneRef = useRef(false);
  // v5.7.37 — one reader-check in flight, EVER. The manual button and the two
  // auto-rescue timers all fire through this latch, so they can never overlap.
  const checkingRef = useRef(false);
  // The timers fire through this ref (v5.7.12 rule), so they always run the
  // current render's closure — never a stale job object.
  const runCheckRef = useRef(null);
  // v5.7.12 - the settle handoff must survive parent re-renders. The old
  // pattern (setTimeout in the effect + clearTimeout in its cleanup, with
  // onComplete - an inline closure with a fresh identity every parent render -
  // in the deps) let ANY re-render inside the 350ms window cancel the timer,
  // while doneRef blocked every retry: the screen said Approved forever, the
  // reconciler booked the check behind it, and no merchant slip printed
  // (live 20 Aug, every card sale of the day). Callbacks live in refs, the
  // timer fires unless the whole screen unmounted first.
  const onCompleteRef = useRef(onComplete);
  const onFailedRef = useRef(onFailed);
  const unmountedRef = useRef(false);
  useEffect(() => { onCompleteRef.current = onComplete; onFailedRef.current = onFailed; });
  useEffect(() => () => { unmountedRef.current = true; }, []);

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
    // v5.6.80 — 'reconciled' counts as approved HERE. Since v5.6.62 the
    // TerminalJobReconciler also closes Adyen jobs, on an ~8s tick, and a
    // send-to-terminal card sale settles well inside that window. So the
    // reconciler can book the check and flip approved → reconciled BEFORE this
    // screen's own poll ever observes 'approved' — and this effect, matching only
    // 'approved', then never fired: the bill closed behind the modal while the
    // card screen sat there forever (live 15 Aug, £16.00 R2).
    // Re-completing is safe: the reconciler closed it under the SAME pre-minted
    // job.closed_check_id this modal owns, so complete()'s upsert is idempotent
    // (the closed_checks PK elects one writer) and simply re-books the same row.
    if ((job.status === 'approved' || job.status === 'reconciled') && !job.needs_human) {
      doneRef.current = true;
      const fire = onCompleteRef;
      // Hand the parent the job's own INTEGERS. tipMinor is what drives the
      // corrected tip-recording line in CheckoutModal; amountReceived is the leg
      // that is genuinely refundable (the charge, never the check face value).
      setTimeout(() => { if (!unmountedRef.current) fire.current?.({
        // v5.6.79 (#107) — WAS HARDCODED 'ryft'. A card sale taken on an ADYEN
        // reader through the till therefore booked processor:'ryft', while
        // closeApprovedTerminalJob booked 'adyen' for the very same sale when the
        // reconciler closed it. Refunds route by the check's processor, so every
        // Adyen sale finished on this screen was unrefundable — aimed at a
        // processor that had never heard of the transaction.
        //
        // The JOB ROW is the authority: terminal_jobs.processor is set server-side
        // by terminal-job-create from the terminal's own record, and it is the
        // same field dispatchTerminalJob already reads to decide whether to kick
        // adyen-terminal-charge. Resolve it, never assume it.
        processor: job.processor || 'ryft',
        tipMinor: job.tip_minor ?? 0,
        amountReceived: job.charge_minor ?? null,
        paymentIntentId: job.transaction_id || null,
        card: job.card || null,
        authCode: job.auth_code || null,
        jobId: job.id,
        closedCheckId: job.closed_check_id,
      }); }, 350);
      return undefined;
    }
    if (['declined', 'cancelled', 'expired'].includes(job.status)) {
      doneRef.current = true;
      onFailedRef.current?.(job);
    }
    return undefined;
  }, [job]);

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
  // v5.7.37 — STAFF SELF-RESCUE FOR A WEDGED ADYEN JOB (live incident 25 Aug,
  // third of its class). The Adyen cloud charge is ONE long sync call; when the
  // response drops (reader wifi blip) the job wedges in 'charging' or 'unknown',
  // cancel refuses ("too late"), and one stuck payment stops service. The truth
  // check has existed server-side all along: adyen-terminal-charge 'result' asks
  // the READER via a nexo TransactionStatusRequest and settles from its answer.
  // In those two states the dead Cancel becomes "Check card machine" — same slot,
  // same tap, an answer instead of a refusal. Adyen only: on Ryft, cancel during
  // 'charging' is a REAL processor void (v5.5.905) and must stay exactly as it is.
  // The processor comes off the job row (falling back to the create-response row —
  // pollTerminalJob's timeout can synthesise a row without it).
  const processor = job?.processor ?? initialJob?.processor ?? null;
  const wedged = processor === 'adyen' && (status === 'charging' || status === 'unknown');
  const canOfferCancel = LIVE.includes(status) && !blocked && !(processor === 'adyen' && status === 'charging');
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

  // ── v5.7.37: ask the reader what actually happened ──────────────────────────
  // One function, two callers (the button and the auto-rescue timers), one
  // in-flight latch. `auto` runs stay quiet on non-answers so a 30s tick never
  // spams staff; the manual tap always says something.
  const runReaderCheck = async (auto = false) => {
    if (checkingRef.current || doneRef.current || unmountedRef.current || !job?.id) return;
    checkingRef.current = true;
    setCheckBusy(true);
    if (!auto) setCheckMsg('');
    try {
      const r = await checkJobWithReader(job.id);
      if (unmountedRef.current || doneRef.current) return;
      if (r.kind === 'settled') {
        // The server settled the row from the reader's answer. Re-read the FULL
        // row and hand it to the existing settle effect — approved/reconciled
        // flows on exactly as if the poll had seen it (onComplete with the job's
        // own integers), declined/cancelled/expired takes the existing failed
        // path. NO forked completion logic here.
        const fresh = await fetchJob(job.id).catch(() => null);
        if (unmountedRef.current || doneRef.current) return;
        setCheckMsg('');
        // Fallback if the row read fails on the same bad network: merge the
        // fn's settledBody onto what we hold. Conservative — needs_human is
        // never invented or cleared client-side.
        setJob(fresh || {
          ...job,
          status: r.body.job_status || r.body.status,
          transaction_id: r.body.transaction_id ?? job.transaction_id ?? null,
          auth_code: r.body.auth_code ?? job.auth_code ?? null,
          card: r.body.card ?? job.card ?? null,
        });
      } else if (r.kind === 'never_received') {
        // PROVEN: the reader answered NotFound, so no card moved, and the server
        // has already reset the job to charging_unsent — the sheet returns to its
        // pre-send state, where Cancel works and a re-press of the card button
        // re-kicks the same job (v5.6.88).
        const msg = 'The card machine never received this payment. Nothing was charged. Try again.';
        useStore.getState().showToast?.(msg, 'info');
        setCheckMsg(msg);
        const fresh = await fetchJob(job.id).catch(() => null);
        if (unmountedRef.current || doneRef.current) return;
        setJob(fresh || { ...job, status: 'charging_unsent' });
      } else if (r.kind === 'in_progress') {
        if (!auto) {
          const msg = 'The card machine is taking this payment. Finish or cancel it on the machine.';
          useStore.getState().showToast?.(msg, 'info');
          setCheckMsg(msg);
        }
      } else if (!auto) {
        setCheckMsg(`Could not check the card machine: ${r.message || 'try again'}.`);
      }
    } finally {
      checkingRef.current = false;
      if (!unmountedRef.current) setCheckBusy(false);
    }
  };
  // Committed-render closure only — same idiom as onCompleteRef above.
  useEffect(() => { runCheckRef.current = runReaderCheck; });

  // ── v5.7.37: auto-rescue ────────────────────────────────────────────────────
  // A healthy Adyen tender settles inside the sync call, so a job still 'charging'
  // (or 'unknown') 25 seconds after last changing status is exactly the wedge —
  // check once, then every 30 seconds while it stays wedged. Deps are two
  // primitives (a status string and a boolean derived from it + the processor),
  // so a parent re-render can NEVER churn this effect — the v5.7.12 rule: the
  // timers fire through runCheckRef and only a status change or unmount clears
  // them. Any status change restarts the 25s clock; leaving the wedge (settled,
  // or reset to charging_unsent) stops the timers for good.
  useEffect(() => {
    if (!wedged) return undefined;
    let interval = null;
    const first = setTimeout(() => {
      runCheckRef.current?.(true);
      interval = setInterval(() => { runCheckRef.current?.(true); }, 30_000);
    }, 25_000);
    return () => { clearTimeout(first); if (interval) clearInterval(interval); };
  }, [wedged, status]);

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
              ? (wedged
                // v5.7.37 — an Adyen unknown has a self-service answer: the reader itself.
                ? 'The card may or may not have been charged. Do NOT take payment again — that risks charging the customer twice. Tap "Check card machine" below to ask the card machine what happened. A manager can also resolve this in Back Office → Unreconciled payments.'
                : 'The card may or may not have been charged. Do NOT take payment again — that risks charging the customer twice. A manager must resolve this in Back Office → Unreconciled payments before this check can close.')
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
      {checkMsg && (
        <div style={{ marginTop: 14, fontSize: 12, color: 'var(--t2)', lineHeight: 1.5 }}>{checkMsg}</div>
      )}

      <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 22, flexWrap: 'wrap' }}>
        {canOfferCancel && (
          <button className="btn" style={{ height: 44, padding: '0 18px' }} disabled={cancelBusy} onClick={doCancel}>
            {cancelBusy ? 'Cancelling…' : 'Cancel payment'}
          </button>
        )}
        {/* v5.7.37 — the wedged Adyen states get an answer instead of a dead Cancel. */}
        {wedged && (
          <button className="btn" style={{ height: 44, padding: '0 18px' }} disabled={checkBusy} onClick={() => runReaderCheck(false)}>
            {checkBusy ? 'Checking…' : 'Check card machine'}
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
