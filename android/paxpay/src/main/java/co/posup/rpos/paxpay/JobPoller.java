package co.posup.rpos.paxpay;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONObject;

import co.posup.rpos.paxpay.model.TerminalJob;
import co.posup.rpos.paxpay.net.OpsApi;
import co.posup.rpos.paxpay.net.SupabaseClient;

/**
 * Mode 3 — "waiting for POS". Polls terminal_jobs for a job addressed to THIS terminal, claims
 * it, and hands it to the payment flow.
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
        /** Nothing yet. `detail` is a human-readable status for the waiting screen. */
        void onIdle(String detail);
        /** Something is wrong that the operator should see (offline, session lost, bad row). */
        void onProblem(String message);
    }

    private final SupabaseClient sb;
    private final OpsApi api;
    private final Diagnostics diag;
    private final String terminalId;
    private final Listener listener;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean running = false;
    private boolean inFlight = false;
    private int pollCount = 0;
    private int consecutiveFailures = 0;

    public JobPoller(SupabaseClient sb, OpsApi api, Diagnostics diag,
                     String terminalId, Listener listener) {
        this.sb = sb;
        this.api = api;
        this.diag = diag;
        this.terminalId = terminalId;
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

    private void poll() {
        if (!running || inFlight) return;
        inFlight = true;
        pollCount++;

        sb.async(() -> {
            JSONObject row = api.pollPendingJob(terminalId);
            if (row == null) return null;

            String jobId = row.optString("id", null);
            if (jobId == null) return null;

            // Claim BEFORE parsing the money: if another terminal beat us to it, we should not
            // even be looking at this check's amounts.
            if (!api.claimJob(jobId)) {
                Log.i(TAG, "job " + jobId + " already claimed elsewhere — ignoring");
                return null;
            }
            return TerminalJob.fromRow(row);
        }, new SupabaseClient.Result<TerminalJob>() {
            @Override public void onSuccess(TerminalJob job) {
                inFlight = false;
                consecutiveFailures = 0;
                if (!running) return;

                if (job == null) {
                    listener.onIdle("Checked " + pollCount + " time"
                            + (pollCount == 1 ? "" : "s") + " · nothing waiting");
                    schedule();
                    return;
                }
                // A job arrived: stop polling and hand over. The poller does not run during a
                // payment — the one-live-job-per-terminal rule is the server's, but there is no
                // reason to be asking for a second one while a card is in the customer's hand.
                stop();
                diag.currentJobId = job.jobId;
                diag.event("job claimed: " + job.jobId);
                listener.onJobClaimed(job);
            }

            @Override public void onError(String message) {
                inFlight = false;
                if (!running) return;

                consecutiveFailures++;
                diag.lastRpcError = message;

                if (SupabaseClient.isSessionLost(message)) {
                    stop();
                    listener.onProblem("This terminal's pairing session was lost.\n\n" + message);
                    return;
                }
                // A transport blip is normal on venue wifi — keep going quietly, and only speak
                // up once it has clearly stopped being a blip.
                if (consecutiveFailures >= OFFLINE_AFTER_FAILURES) {
                    listener.onIdle("Offline — retrying. (" + message + ")");
                } else {
                    listener.onIdle("Reconnecting…");
                }
                schedule();
            }
        });
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
