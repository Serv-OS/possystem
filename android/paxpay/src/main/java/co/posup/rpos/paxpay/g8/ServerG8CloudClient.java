package co.posup.rpos.paxpay.g8;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONObject;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import co.posup.rpos.paxpay.net.Http;
import co.posup.rpos.paxpay.net.SupabaseClient;

/**
 * THE REAL IMPLEMENTATION of the {@link G8CloudClient} seam — the one G8CloudClient's own
 * header comment said would exist "when the credential may not sit on the device": every charge
 * is proxied through OUR OWN edge function, <b>terminal-job-charge</b>, and this class never
 * holds a Ryft key and never supplies an amount.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * HOW THE SEAM'S TWO CALLS MAP ONTO THE SERVER CONTRACT
 *
 *   startTransaction  →  POST /functions/v1/terminal-job-charge { action:'start',  job_id }
 *   fetchResult       →  POST /functions/v1/terminal-job-charge { action:'result', job_id }
 *                        polled every ~{@link #RESULT_POLL_MS}ms for up to
 *                        {@link #RESULT_BUDGET_MS}ms, hidden behind the one call exactly as
 *                        the interface designed ("a polling implementation can hide its loop
 *                        behind this one call").
 *
 * THE AMOUNT NEVER TRAVELS FROM HERE. 'start' charges exactly terminal_jobs.charge_minor — the
 * server-computed figure the tip commit already recorded — which is why the request body carries
 * ONLY the job id. The G8SaleRequest amounts are used for nothing but a sanity log line.
 *
 * IDEMPOTENCY lives server-side: 'start' does a CAS write-ahead (charging_unsent → charging)
 * before it touches Ryft, so a double call gets the stored payment_session_id back (an
 * idempotent replay) or 409 { error:'in_flight' } — never a second initiate. This class
 * therefore does NOT retry a failed 'start'; there is no safe device-side retry of a charge.
 *
 * FAILURE TAXONOMY, preserved from SupabaseClient:
 *   - TransportException (never reached the server)   → onError; on the RESULT poll it is
 *     retried inside the budget, because bad wifi in a basement bar fixes itself.
 *   - { ok:false, safe:true } from 'start'            → onError. Nothing was charged (the
 *     server CAS-reverted the row), but PaymentFlow's startTransaction-onError → UNKNOWN
 *     stays authoritative; the job then self-resolves as 'cancelled' server-side.
 *   - any other API answer                            → onError, not retried: the server has
 *     an opinion and repeating the question will not change it.
 *
 * THREADING: this class owns its OWN single background thread. The poll loop can legitimately
 * sit for ~20 seconds, and parking that on SupabaseClient's one executor would starve the
 * heartbeat and the result report behind it. Callbacks are marshalled to the main thread, per
 * the interface contract.
 */
public final class ServerG8CloudClient implements G8CloudClient {

    private static final String TAG = "PaxPayG8";

    /** The edge function this client is a thin device-side face of. */
    private static final String FUNCTION = "terminal-job-charge";

    /** Gap between 'result' polls. The session verify is ~300-800ms server-side. */
    private static final long RESULT_POLL_MS = 1_000L;

    /**
     * Total polling budget behind one fetchResult call. Expiry is NOT a verdict — it surfaces
     * as onError, PaymentFlow quarantines as UNKNOWN, and the webhook/sweeper settle the job
     * server-side; the recovery path then reads the settled row. Twenty seconds keeps a
     * customer-facing screen from sitting on a spinner for ever.
     */
    private static final long RESULT_BUDGET_MS = 20_000L;

    private final SupabaseClient sb;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    /**
     * start-handle → job id. fetchResult receives the handle startTransaction returned (the
     * payment_session_id), but the server contract polls by JOB id — this map reverses it.
     * One live payment at a time in practice, but a map costs nothing and cannot mis-pair.
     */
    private final ConcurrentHashMap<String, String> jobByHandle = new ConcurrentHashMap<>();

    public ServerG8CloudClient(SupabaseClient sb) {
        this.sb = sb;
    }

    /**
     * v2.0-rc5 — the receipt-confirm pump. A single fire-and-forget 'result' call: its ONLY
     * job is to make the server look at the in-flight transaction, because that look is what
     * sends Ryft's confirm-receipt while the controller holds the tap (PointOfSale receipts).
     * Response and errors are deliberately discarded — the authoritative outcome still comes
     * exclusively from fetchResult() after the controller returns.
     */
    @Override
    public void nudgeResult(String handle) {
        final String jobId = handle == null ? null : jobByHandle.getOrDefault(handle, handle);
        if (jobId == null || jobId.isEmpty()) return;
        executor.execute(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("action", "result");
                body.put("job_id", jobId);
                sb.postFunction(FUNCTION, body);
            } catch (Exception ignored) {
                // Best-effort by contract: the next nudge or fetchResult() retries.
            }
        });
    }

    // -------------------------------------------------------------------------------------
    // Step 4 — start
    // -------------------------------------------------------------------------------------

    @Override
    public void startTransaction(G8SaleRequest request, Callback<G8StartResponse> callback) {
        final String jobId = request == null ? null : request.jobId;
        if (jobId == null || jobId.isEmpty()) {
            // A manual sale has no terminal_jobs row, and the server charges BY job id — the
            // real path cannot take it. Said plainly: nothing was dispatched anywhere.
            main.post(() -> callback.onError(
                    "This payment has no server job, so it cannot be charged on this build. "
                            + "(Manual payments need a job row — start the payment from the "
                            + "POS or Table Pay.) No card was charged."));
            return;
        }

        Log.i(TAG, "server startTransaction job=" + jobId + " total=" + request.totalMinor
                + " " + request.currency + " (amount authority is the SERVER row, not this log)");

        executor.execute(() -> {
            final Http.Response r;
            try {
                JSONObject body = new JSONObject();
                body.put("action", "start");
                body.put("job_id", jobId);
                r = sb.postFunction(FUNCTION, body);
            } catch (SupabaseClient.TransportException te) {
                // Never reached the server, so the server never reached Ryft — but PaymentFlow
                // must still treat it as UNKNOWN (a timeout is the classic lost-reply), and the
                // server-side CAS means recovery can prove what actually happened later.
                deliverError(callback, "network: " + te.getMessage());
                return;
            } catch (Exception e) {
                deliverError(callback, message(e));
                return;
            }

            JSONObject j = parse(r.body);
            if (j == null) {
                deliverError(callback, "Unreadable reply from the charge service (" + r.describe() + ")");
                return;
            }

            if (j.optBoolean("ok", false)) {
                String psId = str(j, "payment_session_id");
                // payment_session_id maps onto the seam's transaction id. It can be null on a
                // degenerate initiate reply; fall back to the job id so the flow still holds a
                // truthy handle — fetchResult polls by job id either way.
                String handle = psId != null ? psId : jobId;
                jobByHandle.put(handle, jobId);
                Log.i(TAG, "start ok, payment_session_id=" + psId);
                main.post(() -> callback.onSuccess(new G8StartResponse(handle)));
                return;
            }

            if (j.optBoolean("safe", false)) {
                // Definitive Ryft 4xx: the server CAS-reverted the row and no card was touched.
                // Surfaced as onError all the same — PaymentFlow's conservative UNKNOWN framing
                // stays authoritative, and the job settles 'cancelled' server-side.
                deliverError(callback, "The card processor rejected this payment before any "
                        + "card was charged. " + orDefault(str(j, "error"), "No detail given."));
                return;
            }

            // in_flight (409), unknown-outcome 502, already-settled, simulated/training fence…
            // The server had an opinion; repeat the question through recovery, not here.
            deliverError(callback, orDefault(str(j, "error"), r.describe()));
        });
    }

    // -------------------------------------------------------------------------------------
    // Step 7 — result (the poll loop, hidden behind one call)
    // -------------------------------------------------------------------------------------

    @Override
    public void fetchResult(String transactionId, Callback<G8TransactionResult> callback) {
        final String jobId = transactionId == null ? null : jobByHandle.get(transactionId);
        if (jobId == null) {
            // A handle this process never started (e.g. after a restart). The write-ahead log
            // and RecoveryRunner own that case; answering here would be a guess.
            main.post(() -> callback.onError(
                    "No job is known for this transaction in this process. "
                            + "The recovery path owns it."));
            return;
        }

        executor.execute(() -> {
            final long deadline = System.currentTimeMillis() + RESULT_BUDGET_MS;
            String lastProblem = "no reply yet";

            while (true) {
                Http.Response r = null;
                try {
                    JSONObject body = new JSONObject();
                    body.put("action", "result");
                    body.put("job_id", jobId);
                    r = sb.postFunction(FUNCTION, body);
                } catch (SupabaseClient.TransportException te) {
                    // Transport failures are retried inside the budget — that is the whole
                    // point of the taxonomy. The server's answer will not have changed; our
                    // ability to hear it might.
                    lastProblem = "network: " + te.getMessage();
                } catch (Exception e) {
                    deliverError(callback, message(e));
                    return;
                }

                if (r != null) {
                    JSONObject j = parse(r.body);

                    if (r.ok() && j != null && j.optBoolean("ok", false)) {
                        String state = orDefault(str(j, "state"), orDefault(str(j, "status"), ""));
                        if ("processing".equals(state)) {
                            lastProblem = "still processing";
                        } else if ("approved".equals(state) || "declined".equals(state)
                                || "cancelled".equals(state)) {
                            final G8TransactionResult result = toResult(state, j, transactionId);
                            Log.i(TAG, "result for job " + jobId + ": " + state);
                            main.post(() -> callback.onSuccess(result));
                            return;
                        } else {
                            // A state this build does not know. Never guess at money.
                            deliverError(callback, "The charge service returned an "
                                    + "unrecognised state: '" + state + "'");
                            return;
                        }
                    } else if (r.code >= 500) {
                        // 502 "could not reach the card processor" and friends — transient by
                        // declaration, retried inside the budget.
                        lastProblem = j != null
                                ? orDefault(str(j, "error"), r.describe()) : r.describe();
                    } else {
                        // A definitive 4xx (no access, job not found, simulated fence…) or an
                        // ok:false 2xx. The server has an opinion; polling will not change it.
                        deliverError(callback, j != null
                                ? orDefault(str(j, "error"), r.describe()) : r.describe());
                        return;
                    }
                }

                if (System.currentTimeMillis() + RESULT_POLL_MS > deadline) {
                    // Budget spent. NOT a verdict — PaymentFlow quarantines UNKNOWN, the
                    // webhook/sweeper settle the row, and recovery reads the settled answer.
                    deliverError(callback, "The result was not available within "
                            + (RESULT_BUDGET_MS / 1000) + "s (last: " + lastProblem + "). "
                            + "The payment may still complete server-side.");
                    return;
                }
                try {
                    Thread.sleep(RESULT_POLL_MS);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    deliverError(callback, "Result polling was interrupted (last: " + lastProblem + ")");
                    return;
                }
            }
        });
    }

    @Override
    public String describe() {
        return "server-proxy(terminal-job-charge)";
    }

    // -------------------------------------------------------------------------------------
    // Mapping
    // -------------------------------------------------------------------------------------

    /**
     * Server terminal state → the seam's result DTO. {@code simulated} is ALWAYS false here:
     * nothing this class returns is fabricated, and the simulated=true path lives exclusively
     * in {@link StubG8CloudClient}.
     *
     * 'cancelled' (a start that provably never charged, or a pre-dispatch cancel the webhook
     * never saw) maps to approved=false with the reason carried through — to the customer and
     * the log it reads as a payment that did not happen, which is exactly what it was.
     */
    private static G8TransactionResult toResult(String state, JSONObject j, String fallbackTxn) {
        boolean approved = "approved".equals(state);
        String txn = orDefault(str(j, "transaction_id"),
                orDefault(str(j, "payment_session_id"), fallbackTxn));
        String authCode = str(j, "auth_code");

        String scheme = null;
        String maskedPan = null;
        JSONObject card = j.optJSONObject("card");
        if (card != null) {
            scheme = str(card, "brand");
            if (scheme == null) scheme = str(card, "scheme");
            String last4 = str(card, "last4");
            maskedPan = last4 == null ? null : "•••• " + last4;
            if (authCode == null) authCode = str(card, "auth_code");
        }

        String declineReason = null;
        if (!approved) {
            declineReason = orDefault(str(j, "decline_reason"),
                    "cancelled".equals(state)
                            ? "Cancelled — no card was charged."
                            : "Declined by the card processor.");
        }

        return new G8TransactionResult(
                approved, txn, authCode, scheme, maskedPan, declineReason,
                false /* simulated — this is the real path, without exception */);
    }

    // -------------------------------------------------------------------------------------
    // Small helpers
    // -------------------------------------------------------------------------------------

    private void deliverError(Callback<?> callback, String message) {
        Log.w(TAG, "server G8 error: " + message);
        main.post(() -> callback.onError(message));
    }

    private static JSONObject parse(String body) {
        if (body == null || body.trim().isEmpty()) return null;
        try {
            return new JSONObject(body);
        } catch (Exception e) {
            return null;
        }
    }

    /** Null-safe read: absent, JSON null and "" all come back as Java null. */
    private static String str(JSONObject j, String key) {
        if (j == null || j.isNull(key)) return null;
        String v = j.optString(key, null);
        return (v == null || v.isEmpty()) ? null : v;
    }

    private static String orDefault(String v, String fallback) {
        return (v == null || v.isEmpty()) ? fallback : v;
    }

    private static String message(Exception e) {
        return e.getMessage() == null ? e.toString() : e.getMessage();
    }
}
