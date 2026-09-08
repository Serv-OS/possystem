package co.posup.rpos.paxpay;

import android.util.Log;

import java.util.ArrayList;
import java.util.List;

import co.posup.rpos.paxpay.model.TerminalJob;
import co.posup.rpos.paxpay.net.OpsApi;
import co.posup.rpos.paxpay.net.SupabaseClient;
import co.posup.rpos.paxpay.store.JobLog;

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 *  WHAT HAPPENS AFTER THE APP DIES MID-PAYMENT.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Runs at every boot, before the home screen is reachable. Reads the write-ahead log and sorts
 * every unfinished row into exactly one of three buckets. The sorting rule is the whole point:
 *
 *   RESULT  → we KNOW the outcome, the server does not.
 *             REPLAY IT. Forever, with no staleness floor, until the server accepts it. This is
 *             a fact, and facts do not expire — RPOS's ALWAYS_REPLAY rule. A charge that
 *             happened three days ago in a terminal left in a drawer is still owed to the venue.
 *
 *   INTENT  → the tip was committed but the controller was never launched.
 *             DETERMINISTICALLY SAFE: no card was touched. Report it cancelled and move on.
 *             Note what we do NOT do: resume it. An intent is an intention, and intentions go
 *             stale (money rule 10) — a terminal that woke up after an hour must not fire
 *             yesterday's tender at whoever is standing in front of it now.
 *
 *   SENT    → the controller WAS launched and we never saw the outcome.
 *             ☠ THE ONE THAT MATTERS. The card may or may not have been charged, and until Ryft
 *             ship the G8:Cloud spec there is NOTHING that can be asked to find out — no
 *             lookupByReference, no server-side reconciler with a processor to query.
 *
 *             So: NEVER auto-retry (that is the double charge) and NEVER discard (that is the
 *             lost sale). It is reported to the server as `unknown` so it lands in the human
 *             queue, and it BLOCKS this terminal's home screen until a person acknowledges it.
 *             Blocking is deliberate. A terminal that quietly carries on is a terminal where
 *             nobody ever goes and looks.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */
public final class RecoveryRunner {

    private static final String TAG = "PaxPayRecovery";

    public interface Listener {
        /**
         * @param needingHuman rows a person must resolve. Empty = the terminal is clear to trade.
         */
        void onRecoveryComplete(List<JobLog.Entry> needingHuman);
    }

    private final SupabaseClient sb;
    private final OpsApi api;
    private final JobLog log;
    private final Diagnostics diag;

    public RecoveryRunner(SupabaseClient sb, OpsApi api, JobLog log, Diagnostics diag) {
        this.sb = sb;
        this.api = api;
        this.log = log;
        this.diag = diag;
    }

    /** Run the sweep. Safe to call repeatedly — every step is idempotent. */
    public void run(Listener listener) {
        sb.async(() -> {
            log.prune();
            List<JobLog.Entry> unfinished = log.unfinished();
            List<JobLog.Entry> needingHuman = new ArrayList<>();

            for (JobLog.Entry e : unfinished) {
                try {
                    switch (e.state) {
                        case JobLog.STATE_RESULT:
                            replayResult(e, needingHuman);
                            break;
                        case JobLog.STATE_INTENT:
                            resolveIntent(e);
                            break;
                        case JobLog.STATE_SENT:
                            // v5.5.871: ask the server what actually happened BEFORE
                            // quarantining. If the POS cancelled/voided (or the sale
                            // already settled) while we were dead, the outcome is
                            // established — clear the local row and do NOT block. Only a
                            // genuinely-still-unresolved (or unreadable) row falls through
                            // to the quarantine that blocks the terminal.
                            if (reconcileSentAgainstServer(e)) {
                                break;
                            }
                            quarantineUnknown(e);
                            needingHuman.add(e);
                            break;
                        default:
                            break;
                    }
                } catch (Exception ex) {
                    // A failure here must never stop the OTHER rows being resolved, and must
                    // never delete anything. Note it and carry on; the next boot tries again.
                    log.noteAttempt(e.jobId, ex.getMessage());
                    Log.w(TAG, "recovery step failed for " + e.jobId + ": " + ex.getMessage());
                    if (JobLog.STATE_SENT.equals(e.state) && !needingHuman.contains(e)) {
                        needingHuman.add(e);
                    }
                }
            }

            diag.unresolvedPayments = log.unfinishedCount();
            return needingHuman;
        }, new SupabaseClient.Result<List<JobLog.Entry>>() {
            @Override public void onSuccess(List<JobLog.Entry> value) {
                diag.event("recovery complete, " + (value == null ? 0 : value.size())
                        + " need a human");
                listener.onRecoveryComplete(value == null ? new ArrayList<>() : value);
            }
            @Override public void onError(String message) {
                // Could not even read the log or reach the server. Do NOT let the terminal trade
                // as if everything were fine — surface whatever is on the device.
                diag.lastRpcError = message;
                diag.event("recovery FAILED: " + message);
                listener.onRecoveryComplete(pendingSentRowsOffline());
            }
        });
    }

    private List<JobLog.Entry> pendingSentRowsOffline() {
        List<JobLog.Entry> out = new ArrayList<>();
        for (JobLog.Entry e : log.unfinished()) {
            if (JobLog.STATE_SENT.equals(e.state)) out.add(e);
        }
        return out;
    }

    // -------------------------------------------------------------------------------------

    /** A known outcome the server has not got yet. Replay until it lands. */
    private void replayResult(JobLog.Entry e, List<JobLog.Entry> needingHuman) throws Exception {
        if (isManual(e)) {
            // No server row exists for a manual sale; the local record is the whole record.
            log.closeLocal(e.jobId);
            return;
        }
        boolean approved = e.approved != null && e.approved;
        boolean ok = api.reportResult(
                e.jobId,
                approved ? OpsApi.STATUS_APPROVED : OpsApi.STATUS_DECLINED,
                e.transactionId, e.authCode, e.cardJson, e.reportedMinor, e.declineReason);
        if (ok) {
            log.markReported(e.jobId);
            diag.event("replayed result for " + e.jobId);
        } else {
            // The server declined to accept it. That is not a network problem, so retrying on a
            // loop will not help — a human needs to look.
            log.noteAttempt(e.jobId, "server rejected the result");
            needingHuman.add(e);
        }
    }

    /** Tip committed, card never touched. Safe and deterministic. */
    private void resolveIntent(JobLog.Entry e) throws Exception {
        if (isManual(e)) {
            log.closeLocal(e.jobId);
            return;
        }
        api.reportResult(e.jobId, OpsApi.STATUS_CANCELLED, null, null, null, 0L,
                e.isStaleIntent()
                        ? "Terminal restarted before the card was presented (stale intent)."
                        : "Terminal restarted before the card was presented.");
        log.markReported(e.jobId);
        diag.event("cancelled un-launched intent " + e.jobId);
    }

    /**
     * v5.5.871 — RECONCILE A 'SENT' ROW AGAINST THE SERVER BEFORE QUARANTINING IT.
     *
     * The bug this closes: a SENT row (controller launched, outcome unseen) was
     * quarantined 'unknown' on EVERY boot and cleared only by a human tap — even after
     * the POS had already cancelled the payment. The new POS cancel path voids the live
     * Ryft action AND settles the job, so the outcome is now knowable; ask for it:
     *
     *   cancelled / expired / declined → no money is owed on this terminal. Clear the
     *       write-ahead row and do NOT block. THIS is the fix for "force-close reopens
     *       the cancelled payment".
     *   approved / reconciled → the card WAS charged and the server already recorded it
     *       (settled from the session — its source of truth). The stale local row is
     *       cleared; the sale is closed on the till side.
     *   anything still live/unknown, or an unreadable/absent row → fall through to the
     *       existing quarantine. We NEVER assume an outcome we cannot prove.
     *
     * Manual sales have no server row and keep today's behaviour. Any read failure is
     * treated as "cannot prove" → quarantine, never as a clear.
     *
     * @return true if the row was resolved and cleared here (skip the quarantine).
     */
    private boolean reconcileSentAgainstServer(JobLog.Entry e) {
        if (isManual(e)) return false;
        String serverStatus;
        try {
            serverStatus = api.fetchJobStatus(e.jobId);
        } catch (Exception ex) {
            Log.w(TAG, "sent-row server status check failed for " + e.jobId + ": " + ex.getMessage());
            return false;   // cannot prove → quarantine as before
        }
        if (serverStatus == null) return false;
        switch (serverStatus) {
            case "cancelled":
            case "expired":
            case "declined":
            case "approved":
            case "reconciled":
                log.markReported(e.jobId);   // outcome established server-side — clear the WAL
                diag.event("sent row " + e.jobId + " reconciled from server as '"
                        + serverStatus + "', cleared (no block)");
                return true;
            default:
                return false;   // pending/claimed/tipping/charging(_unsent)/unknown → still unresolved
        }
    }

    /**
     * ☠ The dangerous one. Tell the server we do not know, and let it block.
     *
     * Reported EVERY boot until it sticks, because an unknown that never reached the server is
     * a tip with no recipient — and under the Tipping Act 2023 an unresolved gratuity is not
     * merely untidy.
     */
    private void quarantineUnknown(JobLog.Entry e) throws Exception {
        if (isManual(e)) return;   // stays on screen; no server row to quarantine
        api.reportResult(e.jobId, OpsApi.STATUS_UNKNOWN, e.transactionId, null, null,
                e.chargeMinor,
                "Terminal stopped after the card was presented and before the outcome was read. "
                        + "The card MAY have been charged.");
        diag.event("quarantined unknown " + e.jobId);
    }

    private static boolean isManual(JobLog.Entry e) {
        return TerminalJob.Source.MANUAL.name().equals(e.source);
    }

    /**
     * A human has looked at the Ryft dashboard / the terminal and decided.
     *
     * This does NOT decide anything about the money — the server's `unknown` row stays for the
     * back-office queue to resolve. It only clears the block on THIS terminal, so the venue can
     * carry on trading once someone has actually looked.
     */
    public void acknowledge(String localJobId, Listener listener) {
        sb.async(() -> {
            log.markReported(localJobId);
            diag.unresolvedPayments = log.unfinishedCount();
            return pendingSentRowsOffline();
        }, new SupabaseClient.Result<List<JobLog.Entry>>() {
            @Override public void onSuccess(List<JobLog.Entry> v) {
                listener.onRecoveryComplete(v);
            }
            @Override public void onError(String m) {
                listener.onRecoveryComplete(pendingSentRowsOffline());
            }
        });
    }
}
