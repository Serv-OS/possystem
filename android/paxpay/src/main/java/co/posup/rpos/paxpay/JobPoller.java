package co.posup.rpos.paxpay;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONObject;

import co.posup.rpos.paxpay.model.TerminalJob;
import co.posup.rpos.paxpay.net.OpsApi;
import co.posup.rpos.paxpay.net.SupabaseClient;

/**
 * AMBIENT POS DISPATCH. Polls terminal_jobs for a job addressed to THIS terminal, claims it, and
 * hands it to the payment flow.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * v5.5.841 — THIS IS NO LONGER A MODE SOMEBODY ENTERS.
 *
 * It used to be started by a "Waiting for POS" button. A paired card reader does not have a "now
 * start listening" state, and making it one meant a payment dispatched from the till landed on a
 * terminal that was not polling — because nobody had tapped anything — and never appeared. So
 * MainActivity now runs this continuously whenever modes.pos_dispatch is on, behind whatever is
 * showing.
 *
 * LOOKING IS AMBIENT. CLAIMING IS GATED. See {@link Gate} — that split is the whole safety story.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY POLLING AND NOT REALTIME
 *
 * The spec wants a realtime push as an accelerant with polling as the floor. This build ships
 * only the floor: a websocket client would be a new third-party dependency (or a hand-rolled
 * one), and the honest position is that a 4-second poll is imperceptible to a waiter walking
 * from the till to a table. Add the realtime nudge when there is a reason to; the poll must stay
 * either way, because a dropped socket on venue wifi must never mean a payment that never arrives.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * BACKOFF. A terminal sitting on the "waiting" screen all evening would otherwise make 900
 * requests an hour per device, times every terminal in the estate. So the interval steps up
 * while nothing is happening and snaps back the moment a job appears or the operator re-enters
 * the screen. Nothing here is time-critical: the waiter is walking.
 */
public final class JobPoller {

    private static final String TAG = "PaxPayPoller";

    /** First few polls after entering the screen — the waiter is standing there waiting. */
    private static final long INTERVAL_FAST_MS = 4_000L;
    /** After a quiet minute. Still well inside "walk to the table" time. */
    private static final long INTERVAL_SLOW_MS = 12_000L;
    /** After a quiet ten minutes — the terminal is parked on a shelf. */
    private static final long INTERVAL_IDLE_MS = 30_000L;

    private static final int FAST_POLLS = 15;   // ~1 minute at 4s
    private static final int SLOW_POLLS = 50;   // ~10 more minutes at 12s

    /** Consecutive TRANSPORT failures before we tell the operator the terminal is offline. */
    private static final int OFFLINE_AFTER_FAILURES = 3;

    public interface Listener {
        /** A job was claimed by US and is ready to run. */
        void onJobClaimed(TerminalJob job);
        /** Nothing yet. `detail` is a human-readable status for the idle screen. */
        void onIdle(String detail);
        /** Something is wrong that the operator should see (offline, session lost, bad row). */
        void onProblem(String message);
    }

    /**
     * ★ THE SAFETY GATE ON CLAIMING (v5.5.841) ★
     *
     * Polling is AMBIENT — it runs behind whatever is on screen. Claiming is NOT. A job may only
     * be claimed when the terminal is genuinely idle, because claiming is what hands the screen
     * to a payment: taking a customer off a live tip prompt to start somebody else's payment is
     * how the wrong amount gets charged to the wrong person.
     *
     * The owner of this interface (MainActivity) answers from ONE predicate. This poller must not
     * form a second opinion about what "idle" means — it asks, and it believes the answer.
     */
    public interface Gate {
        /** null when a POS job may be claimed right now, otherwise WHY it may not be. */
        String busyReason();
    }

    private final SupabaseClient sb;
    private final OpsApi api;
    private final Diagnostics diag;
    private final String terminalId;
    private final Gate gate;
    private final Listener listener;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean running = false;
    private boolean inFlight = false;
    private int pollCount = 0;
    private int consecutiveFailures = 0;

    public JobPoller(SupabaseClient sb, OpsApi api, Diagnostics diag,
                     String terminalId, Gate gate, Listener listener) {
        this.sb = sb;
        this.api = api;
        this.diag = diag;
        this.terminalId = terminalId;
        this.gate = gate;
        this.listener = listener;
    }

    public void start() {
        if (running) return;
        running = true;
        pollCount = 0;
        consecutiveFailures = 0;
        diag.event("job poller started");
        poll();
    }

    public void stop() {
        running = false;
        handler.removeCallbacksAndMessages(null);
        diag.event("job poller stopped");
    }

    public boolean isRunning() { return running; }

    private long nextInterval() {
        if (pollCount < FAST_POLLS) return INTERVAL_FAST_MS;
        if (pollCount < FAST_POLLS + SLOW_POLLS) return INTERVAL_SLOW_MS;
        return INTERVAL_IDLE_MS;
    }

    private void schedule() {
        if (!running) return;
        handler.postDelayed(this::poll, nextInterval());
    }

    /**
     * STEP 1 — LOOK. Never claims. Runs no matter what is on screen.
     *
     * Looking is free and side-effect-free, so it is not gated: the terminal should know a
     * payment is waiting even while a waiter is mid-Table-Pay, because that is exactly the state
     * worth logging. The gate is applied in step 2, on the main thread, where the answer is
     * freshest and where claiming actually happens.
     */
    private void poll() {
        if (!running || inFlight) return;
        inFlight = true;
        pollCount++;

        sb.async(() -> api.pollPendingJob(terminalId), new SupabaseClient.Result<JSONObject>() {
            @Override public void onSuccess(JSONObject row) {
                inFlight = false;
                consecutiveFailures = 0;
                if (!running) return;

                final String jobId = row == null ? null : row.optString("id", null);
                if (jobId == null) {
                    listener.onIdle("Checked " + pollCount + " time"
                            + (pollCount == 1 ? "" : "s") + " · nothing waiting");
                    schedule();
                    return;
                }

                // ★ THE GATE ★ — main thread, immediately before the claim, and the ONLY place
                // this class decides whether it may take over the terminal.
                final String busy = gate == null ? null : gate.busyReason();
                if (busy != null) {
                    // LOUD, because the alternative reads as "the payment never arrived". The
                    // job stays `pending` server-side: it is durable, the POS is already showing
                    // its own waiting state, and the next tick will try again. Nothing is queued
                    // in memory and nothing is pre-claimed.
                    diag.event("job " + jobId + " SEEN but NOT CLAIMED — busy: " + busy);
                    Log.i(TAG, "job " + jobId + " left pending: " + busy);
                    listener.onIdle("A payment is waiting — " + busy);
                    schedule();
                    return;
                }
                claim(jobId, row);
            }

            @Override public void onError(String message) { transportFailure(message); }
        });
    }

    /**
     * STEP 2 — CLAIM. Only ever reached through the gate above.
     *
     * The claim is the atomic CAS (UPDATE … WHERE status='pending'), so two terminals racing the
     * same job still resolve to one winner server-side. Parsing the money happens only AFTER the
     * claim succeeds: if somebody else won, we should not even be looking at that check's amounts.
     */
    private void claim(final String jobId, final JSONObject row) {
        inFlight = true;
        sb.async(() -> {
            String why = api.claimJobReason(jobId);
            if (why != null) {
                // Say WHY. "terminal already has a live job" means a previous payment is
                // stuck and Back Office → Release stuck payment is the fix; that is a very
                // different instruction from "another till got there first".
                Log.i(TAG, "job " + jobId + " not claimed: " + why);
                final String msg = why.contains("live job")
                        ? "This terminal has a payment stuck from earlier.\n\nBack Office → Card readers → Release stuck payment."
                        : why;
                if (listener != null) handler.post(() -> listener.onProblem(msg));
                return null;
            }
            return TerminalJob.fromRow(row);
        }, new SupabaseClient.Result<TerminalJob>() {
            @Override public void onSuccess(TerminalJob job) {
                inFlight = false;
                consecutiveFailures = 0;
                if (!running) return;
                if (job == null) {
                    // Claim refused — onProblem has already been posted with the reason.
                    schedule();
                    return;
                }
                // Claimed. Stop polling and hand over: there is no reason to be asking for a
                // second job while a card is in the customer's hand. MainActivity restarts the
                // ambient poll once the payment is finished.
                stop();
                diag.currentJobId = job.jobId;
                diag.event("job CLAIMED: " + job.jobId);
                listener.onJobClaimed(job);
            }

            @Override public void onError(String message) { transportFailure(message); }
        });
    }

    /** Shared failure handling for both steps. Main thread. */
    private void transportFailure(String message) {
        inFlight = false;
        if (!running) return;

        consecutiveFailures++;
        diag.lastRpcError = message;
        diag.event("poll/claim failed (" + consecutiveFailures + "): " + message);

        if (SupabaseClient.isSessionLost(message)) {
            stop();
            listener.onProblem("This terminal's pairing session was lost.\n\n" + message);
            return;
        }
        // A transport blip is normal on venue wifi — keep going quietly, and only speak up once
        // it has clearly stopped being a blip.
        if (consecutiveFailures >= OFFLINE_AFTER_FAILURES) {
            listener.onIdle("Offline — retrying. (" + message + ")");
        } else {
            listener.onIdle("Reconnecting…");
        }
        schedule();
    }

    /** Operator re-entered the screen: go back to the fast interval. */
    public void nudge() {
        pollCount = 0;
        if (running) {
            handler.removeCallbacksAndMessages(null);
            poll();
        }
    }
}
