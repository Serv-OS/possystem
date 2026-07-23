package co.posup.rpos.paxpay;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.core.content.ContextCompat;

import co.posup.rpos.paxpay.g8.G8CloudClient;
import co.posup.rpos.paxpay.g8.G8SaleRequest;
import co.posup.rpos.paxpay.g8.G8StartResponse;
import co.posup.rpos.paxpay.g8.G8TransactionResult;

/**
 * Drives one card payment through the Ryft / STS "G8" hybrid intents + cloud flow.
 *
 * The vendor flow ("G8-Hybrid Intents and Cloud"), and where each step lives:
 *
 *   1. launch the STS controller by package name, passing ONLY a `timeout` extra  → {@link #start}
 *   2. the controller connects to G8:Cloud                                        → their side
 *   3. it broadcasts DEVICE_CONNECTED when ready to transact                      → {@link #receiver}
 *   4. WE start the transaction over HTTP to G8:Cloud                             → {@link G8CloudClient} (STUBBED)
 *   5. the card is presented on the controller's screen                           → their side
 *   6. the controller finishes and hands control back to us                       → {@link #onControllerResult}
 *   7. WE read the result from the G8:Cloud API                                   → {@link G8CloudClient} (STUBBED)
 *
 * THE LAUNCH INTENT CARRIES NO AMOUNT. The money goes over HTTP in step 4, which is why we,
 * not the vendor, decide the total — and therefore why our own tip screen is possible at all.
 * This is NOT AIDL; there is no bound service and no amount in the intent.
 */
public final class PaymentFlow {

    private static final String TAG = "PaxPayFlow";

    /**
     * Value of the `timeout` extra on the controller launch intent, in ms.
     *
     * A generous timeout, per the vendor's own guidance: the controller has to reach G8:Cloud
     * over the venue's connection, and hospitality venues are routinely on poor connectivity
     * (thick walls, contended wifi, basement bars). Too short and the controller gives up before
     * it has connected, which surfaces to us as RESULT_CANCELED — indistinguishable from the
     * customer simply not presenting a card.
     *
     * v2.0-rc1: raised 30s → 120s for REAL cards. A live payment is insert-or-tap + PIN entry +
     * the terminal printing its own receipt, and a slow customer must time out exceptionally,
     * not routinely — every expiry lands in the RESULT_CANCELED branch below, which now costs a
     * server result lookup. The stub never needed more than 30s because nothing real happened.
     */
    public static final long TENDER_TIMEOUT_MS = 120_000L;

    /**
     * How long we wait for the vendor's DEVICE_CONNECTED broadcast before starting the charge
     * ANYWAY.
     *
     * ⚠ THIS IS THE FIX FOR "stuck on 'waiting for merchant app'". The G8-Hybrid-Intents doc
     * describes an app-switching flow where the controller broadcasts DEVICE_CONNECTED once its
     * socket is up and we THEN start the transaction. But Ryft's in-person model initiates the
     * payment over their standard REST API (which our server calls) and pushes it to the terminal;
     * the controller is launched only to bring its card UI to the foreground, and in that model it
     * does NOT reliably broadcast DEVICE_CONNECTED. Gating the charge on a broadcast that never
     * arrives is precisely why the terminal sat on "waiting for merchant app" and the server saw
     * ZERO charge calls.
     *
     * So: honour DEVICE_CONNECTED if it comes (the fastest path, and correct for a controller that
     * does broadcast it), but if it hasn't arrived by the time the controller should be
     * foregrounded and connected, start the charge anyway. Firing exactly once is guaranteed by
     * the `transactionStarted` guard shared by onDeviceConnected() and startTransactionOverHttp().
     */
    public static final long DEVICE_CONNECTED_FALLBACK_MS = 2_000L;

    /**
     * The broadcast the controller sends when it is ready to take a transaction.
     *
     * ⚠ AMBIGUITY — the vendor doc names ONLY the live action string. It does not say whether
     * the sandbox build (com.stspayments.pax.v2.test) broadcasts the same action or a
     * .test-suffixed one. We register for BOTH, because guessing wrong means the receiver never
     * fires and the app hangs on "waiting for terminal" with no clue why. Harmless if the
     * second action never exists. Confirm with Ryft/STS and delete the spare.
     */
    public static final String ACTION_DEVICE_CONNECTED =
            "com.stspayments.pax.v2.DEVICE_CONNECTED";
    public static final String ACTION_DEVICE_CONNECTED_TEST =
            "com.stspayments.pax.v2.test.DEVICE_CONNECTED";

    /** Name of the only extra the launch intent carries (vendor doc). */
    public static final String EXTRA_TIMEOUT = "timeout";

    /**
     * ★ THE ONLY QUESTION THAT MATTERS WHEN A PAYMENT FAILS ★
     *
     * Not "why did it fail" — "could the customer's card have been charged?" Everything the
     * recovery path does hangs off this one bit, so the flow decides it here, where the state is,
     * rather than leaving the caller to infer it from an error string.
     */
    public enum Outcome {
        /**
         * Nothing was dispatched to the processor. The failure happened before the transaction
         * was started, so no card was touched. Safe to cancel and safe to retry from scratch.
         */
        SAFE_NO_CHARGE,
        /**
         * A transaction WAS dispatched and we do not know how it ended. Never auto-retry this —
         * that is the double charge. It goes to a human. See RecoveryRunner.
         */
        UNKNOWN
    }

    public interface Listener {
        /** Controller launched; waiting for DEVICE_CONNECTED. */
        void onConnecting();
        /** DEVICE_CONNECTED arrived; about to start the transaction over HTTP. */
        void onDeviceConnected();
        /**
         * ★ THE POINT OF NO RETURN ★
         *
         * Fired IMMEDIATELY BEFORE the start-transaction request is issued — not after it
         * succeeds. That is deliberate: a request that times out may still have landed, so the
         * moment the bytes leave is the moment the outcome stops being knowable. Everything the
         * caller does to make a payment recoverable (write-ahead log, terminal_job_sent) belongs
         * on this callback, not on onTransactionStarted.
         */
        void onDispatching();
        /** G8:Cloud accepted the transaction; the card is being taken on their screen. */
        void onTransactionStarted(String transactionId);
        /** Final outcome. */
        void onResult(G8TransactionResult result);
        /** Anything that stopped the flow, already phrased for an operator to read. */
        void onFailure(String message, Outcome outcome);
    }

    private final Activity activity;
    private final Diagnostics diag;
    private final G8CloudClient g8;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());

    private BroadcastReceiver receiver;
    private G8SaleRequest pendingRequest;
    private String transactionId;
    private boolean transactionStarted;
    private boolean finished;
    /** Posted in start(); fires the charge if DEVICE_CONNECTED never arrives. Cancelled once used. */
    private Runnable connectFallback;
    /**
     * v2.0-rc5 — repeats while the CONTROLLER holds the card (transaction started, controller
     * not yet returned). Each tick is a fire-and-forget result ping whose server side sends
     * Ryft's confirm-receipt the moment the tap awaits it (PointOfSale receipts). Without
     * this, the controller waits for a confirmation nobody sends and Ryft voids the tap —
     * the v5.5.862 live failure. Cancelled on controller return, failure, and dispose.
     */
    private Runnable receiptPump;
    private static final long RECEIPT_PUMP_MS = 1_200L;

    public PaymentFlow(Activity activity, Diagnostics diag, G8CloudClient g8, Listener listener) {
        this.activity = activity;
        this.diag = diag;
        this.g8 = g8;
        this.listener = listener;
        diag.g8ClientDescription = g8.describe();
    }

    /**
     * Resolve the controller and hand back the intent to launch, or null if we can't proceed.
     *
     * Registers the DEVICE_CONNECTED receiver as a side effect, BEFORE the caller launches
     * anything — see {@link #registerReceiver}.
     */
    public Intent start(G8SaleRequest request) {
        this.pendingRequest = request;
        this.transactionId = null;
        this.transactionStarted = false;
        this.finished = false;

        ControllerResolver.Resolution res = ControllerResolver.resolve(activity);
        diag.controllerPackage = res.packageName;
        diag.launchIntentFound = res.launchIntent != null;
        diag.controllerProbeLog = res.probeLog;

        if (!res.found()) {
            String msg = "The STS payment app is not installed on this terminal.\n\n"
                    + "Expected one of:\n"
                    + "  " + ControllerResolver.PKG_LIVE + "\n"
                    + "  " + ControllerResolver.PKG_TEST;
            diag.lastError = "controller package not found";
            diag.event("controller NOT FOUND");
            fail(msg, Outcome.SAFE_NO_CHARGE);
            return null;
        }

        if (res.foundButNotLaunchable()) {
            String msg = "The STS payment app (" + res.packageName + ") is installed but could "
                    + "not be launched — it exposes no launch activity.";
            diag.lastError = "no launch intent for " + res.packageName;
            diag.event("controller found but NOT launchable");
            fail(msg, Outcome.SAFE_NO_CHARGE);
            return null;
        }

        diag.event("controller resolved: " + res.packageName
                + (res.isSandbox() ? " (SANDBOX)" : " (live)"));

        // Register BEFORE launching. The controller can broadcast DEVICE_CONNECTED almost
        // immediately on a good connection, and a receiver registered after startActivity()
        // races that broadcast and loses.
        registerReceiver();

        Intent launch = res.launchIntent;
        // The ONLY extra the vendor flow passes. There is deliberately NO amount here.
        launch.putExtra(EXTRA_TIMEOUT, TENDER_TIMEOUT_MS);
        // SINGLE_TOP per the vendor sample: reuse the controller's existing task/instance
        // rather than stacking a second copy of it behind ours.
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);

        diag.launchedAtMs = System.currentTimeMillis();
        diag.deviceConnectedReceived = false;
        diag.deviceConnectedAtMs = 0L;
        diag.resultAtMs = 0L;
        diag.lastResultCode = "pending";
        diag.event("launching controller, timeout=" + TENDER_TIMEOUT_MS + "ms");

        listener.onConnecting();

        // v2.0-rc6 — LAUNCH AND CHARGE IN PARALLEL. The REST initiate takes ~5s at Ryft while
        // the controller foregrounds and connects in well under 1.5s — so serialising them
        // (rc2 waited for DEVICE_CONNECTED or a fallback timer) only added dead time. Fire the
        // charge NOW, on the next main-loop tick; by the time Ryft processes it and pushes to
        // the device, the controller has been connected for seconds. DEVICE_CONNECTED (if it
        // ever arrives first, which it can't at delay 0) stays harmless behind the
        // transactionStarted guard — the charge still fires exactly once.
        connectFallback = () -> {
            connectFallback = null;
            if (finished || transactionStarted) return;
            diag.event("charging in parallel with the controller launch");
            Log.i(TAG, "firing charge in parallel with controller launch");
            startTransactionOverHttp();
        };
        main.post(connectFallback);

        return launch;
    }

    // -------------------------------------------------------------------------------------
    // Step 3 — the broadcast
    // -------------------------------------------------------------------------------------

    /**
     * Registers the DEVICE_CONNECTED receiver.
     *
     * ⚠ RECEIVER_EXPORTED IS LOAD-BEARING. This module targets SDK 34, and from Android 13
     * (API 33) every runtime-registered receiver must declare whether it accepts broadcasts
     * from other apps. The DEVICE_CONNECTED broadcast comes from the STS controller — a
     * DIFFERENT app — so RECEIVER_NOT_EXPORTED would mean the receiver simply never fires,
     * with no exception and no log: the app would sit on "waiting for terminal" forever.
     *
     * ContextCompat.registerReceiver applies the flag on API 33+ and ignores it below, so this
     * is correct all the way down to our minSdk 26.
     */
    private void registerReceiver() {
        unregisterReceiver(); // never stack two

        IntentFilter filter = new IntentFilter();
        filter.addAction(ACTION_DEVICE_CONNECTED);
        filter.addAction(ACTION_DEVICE_CONNECTED_TEST);

        receiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                onDeviceConnected(intent);
            }
        };

        ContextCompat.registerReceiver(
                activity, receiver, filter, ContextCompat.RECEIVER_EXPORTED);
        diag.event("receiver registered (RECEIVER_EXPORTED)");
        Log.i(TAG, "registered DEVICE_CONNECTED receiver (exported)");
    }

    private void onDeviceConnected(Intent intent) {
        if (finished || transactionStarted) return;

        diag.deviceConnectedReceived = true;
        diag.deviceConnectedAtMs = System.currentTimeMillis();
        diag.event("DEVICE_CONNECTED (" + (intent == null ? "?" : intent.getAction()) + ")");
        Log.i(TAG, "DEVICE_CONNECTED after " + diag.connectElapsedMs() + "ms");

        // Log every extra. The broadcast's payload is UNDOCUMENTED, and it is the most likely
        // place to find the terminal/session identifier that the real G8:Cloud call will need
        // (see G8CloudClient item 3). This is here to answer that question from a real device.
        StringBuilder extras = new StringBuilder();
        try {
            Bundle b = intent == null ? null : intent.getExtras();
            if (b == null || b.isEmpty()) {
                extras.append("(no extras)");
            } else {
                for (String key : b.keySet()) {
                    Object v = b.get(key);
                    extras.append(key).append(" = ").append(v).append('\n');
                    Log.i(TAG, "DEVICE_CONNECTED extra: " + key + " = " + v);
                }
            }
        } catch (Throwable t) {
            extras.append("(failed to read extras: ").append(t).append(')');
        }
        diag.deviceConnectedExtras = extras.toString();

        listener.onDeviceConnected();
        startTransactionOverHttp();
    }

    // -------------------------------------------------------------------------------------
    // Step 4 — the HTTP call (STUBBED — see G8CloudClient)
    // -------------------------------------------------------------------------------------

    private void startTransactionOverHttp() {
        // Whichever path got here first (DEVICE_CONNECTED or the fallback timer), the other must
        // not also fire. Cancelling the pending runnable is belt-and-braces on top of the
        // transactionStarted guard below.
        cancelConnectFallback();
        if (pendingRequest == null) {
            fail("Internal error: no sale request to start.", Outcome.SAFE_NO_CHARGE);
            return;
        }
        transactionStarted = true;
        diag.event("G8 startTransaction total=" + pendingRequest.totalMinor
                + " (" + g8.describe() + ")");

        // Point of no return, announced BEFORE the request goes out. The caller persists the
        // fact that a dispatch is happening; from the next line on, "did the card get charged?"
        // is a question only the processor can answer.
        listener.onDispatching();

        g8.startTransaction(pendingRequest, new G8CloudClient.Callback<G8StartResponse>() {
            @Override public void onSuccess(G8StartResponse value) {
                transactionId = value.transactionId;
                diag.lastTransactionId = transactionId;
                diag.event("transaction started: " + transactionId);
                listener.onTransactionStarted(transactionId);
                startReceiptPump();
            }
            @Override public void onError(String message) {
                diag.lastError = "startTransaction: " + message;
                diag.event("startTransaction FAILED: " + message);
                // UNKNOWN, not "failed". Money rule 6: a start-transaction that errors may still
                // have LANDED — a timeout is the classic case, where the request reached G8:Cloud
                // and only the reply was lost. Calling this a clean failure and re-issuing the
                // start is precisely the double charge. So: never re-issue, always surface.
                fail("Could not start the payment.\n\n"
                        + "⚠ Do not retry until someone has checked whether the card was "
                        + "charged.\n\n" + message, Outcome.UNKNOWN);
            }
        });
    }

    // -------------------------------------------------------------------------------------
    // Step 6 — control comes back to us
    // -------------------------------------------------------------------------------------

    /** Call from the ActivityResultLauncher callback. */
    public void onControllerResult(int resultCode) {
        diag.lastResultCode = describeResultCode(resultCode);
        diag.event("controller returned: " + diag.lastResultCode);
        Log.i(TAG, "controller result: " + diag.lastResultCode);

        stopReceiptPump();   // fetchResult owns the outcome from here
        if (finished) return;

        if (resultCode == Activity.RESULT_CANCELED) {
            // Vendor doc: RESULT_CANCELED means the controller TIMED OUT WAITING FOR TENDER.
            // NOTE: it is also what you get if the operator backs out of the controller, and
            // (per the timeout comment above) if the controller never reached G8:Cloud at all.
            // The diagnostics line distinguishes them: no DEVICE_CONNECTED = never connected.
            diag.resultAtMs = System.currentTimeMillis();
            String detail = diag.deviceConnectedReceived
                    ? "The terminal timed out waiting for the customer to present a card."
                    : "The terminal timed out before it connected to the payment network.\n\n"
                      + "DEVICE_CONNECTED was never received — check the terminal's internet "
                      + "connection.";
            diag.event("treated as: timed out waiting for tender");

            // If a transaction was already dispatched, RESULT_CANCELED does NOT reliably mean
            // "no card was presented" — the customer may have tapped at the last instant, and
            // the controller does not tell us apart. So once a transaction id exists we do not
            // guess: we ASK.
            //
            // v2.0-rc1 — THIS IS NO LONGER A SIMULATION CRUTCH. fetchResult() is now a genuine,
            // non-mutating, server-verified lookup: ServerG8CloudClient polls terminal-job-charge
            // { action:'result' }, which reads the Ryft payment session and settles through the
            // one processor-verified writer. A last-instant tap comes back 'approved'; an
            // ordinary walk-away comes back 'processing' until the sweeper cancels it, or
            // 'cancelled' outright — so the class of noise this branch used to dump into the
            // human queue (risk 6) resolves itself instead.
            //
            // The guard that was here ("&& BuildVersion.SIMULATED", v1.4-m2) is gone by its own
            // contract: it existed because the stub's answer was fabricated and a real card
            // "may have been charged" could not be looked up. Now it can be. The floor has not
            // moved, though — if fetchResult itself FAILS, its onError path below still
            // quarantines as UNKNOWN, exactly as before. Asking is safe; assuming never was.
            if (transactionStarted && transactionId != null) {
                diag.event("controller timed out after dispatch — asking the server for the "
                        + "result instead of quarantining");
                fetchResult();
                return;
            }

            Outcome outcome = (transactionStarted && transactionId != null)
                    ? Outcome.UNKNOWN : Outcome.SAFE_NO_CHARGE;
            if (outcome == Outcome.UNKNOWN) {
                detail += "\n\n⚠ A transaction had already been sent. Check whether the card was "
                        + "charged before retrying.\nRef: " + transactionId;
            }
            fail(detail, outcome);
            return;
        }

        if (!transactionStarted || transactionId == null) {
            // Control came back but we never got to start a transaction, so nothing was charged.
            diag.resultAtMs = System.currentTimeMillis();
            diag.lastError = "returned without a started transaction";
            fail("The payment app closed before a transaction was started.\n\n"
                    + (diag.deviceConnectedReceived
                        ? "The transaction could not be started."
                        : "DEVICE_CONNECTED was never received."),
                    // Genuinely safe: transactionStarted is set BEFORE the HTTP call is made, so
                    // reaching here means we never even attempted a dispatch.
                    Outcome.SAFE_NO_CHARGE);
            return;
        }

        fetchResult();
    }

    // -------------------------------------------------------------------------------------
    // Step 7 — read the result (STUBBED — see G8CloudClient)
    // -------------------------------------------------------------------------------------

    private void fetchResult() {
        diag.event("G8 fetchResult " + transactionId);
        g8.fetchResult(transactionId, new G8CloudClient.Callback<G8TransactionResult>() {
            @Override public void onSuccess(G8TransactionResult value) {
                if (finished) return;
                finished = true;
                diag.resultAtMs = System.currentTimeMillis();
                diag.event("result: " + (value.approved ? "APPROVED" : "DECLINED"));
                listener.onResult(value);
            }
            @Override public void onError(String message) {
                diag.resultAtMs = System.currentTimeMillis();
                diag.lastError = "fetchResult: " + message;
                diag.event("fetchResult FAILED: " + message);
                // ⚠ THE DANGEROUS CASE: the card may or may not have been charged. Until Ryft
                // documents reconciliation (G8CloudClient item 6) we can only say so plainly
                // rather than guess — never report this as either success or failure.
                fail("The payment result could not be read.\n\n"
                        + "⚠ The card may still have been charged. Check the terminal or the "
                        + "Ryft dashboard before retrying.\n\n"
                        + "Ref: " + transactionId + "\n" + message, Outcome.UNKNOWN);
            }
        });
    }

    private void fail(String message, Outcome outcome) {
        if (finished) return;
        finished = true;
        diag.event("flow failed (" + outcome + ")");
        listener.onFailure(message, outcome);
    }

    private static String describeResultCode(int code) {
        if (code == Activity.RESULT_OK) return "RESULT_OK";
        if (code == Activity.RESULT_CANCELED) return "RESULT_CANCELED";
        return "code " + code;
    }

    /**
     * Release the receiver.
     *
     * MUST be called from onDestroy, NOT onPause/onStop. Launching the controller sends this
     * activity to the background, and DEVICE_CONNECTED arrives WHILE WE ARE BACKGROUNDED —
     * unregistering on pause would drop the one broadcast the whole flow depends on.
     */
    public void dispose() {
        cancelConnectFallback();
        stopReceiptPump();
        unregisterReceiver();
    }

    private void cancelConnectFallback() {
        if (connectFallback != null) {
            main.removeCallbacks(connectFallback);
            connectFallback = null;
        }
    }

    private void startReceiptPump() {
        stopReceiptPump();
        receiptPump = new Runnable() {
            @Override public void run() {
                if (finished || receiptPump == null) return;
                if (transactionId != null) g8.nudgeResult(transactionId);
                main.postDelayed(this, RECEIPT_PUMP_MS);
            }
        };
        main.postDelayed(receiptPump, RECEIPT_PUMP_MS);
        diag.event("receipt pump started (" + RECEIPT_PUMP_MS + "ms)");
    }

    private void stopReceiptPump() {
        if (receiptPump != null) {
            main.removeCallbacks(receiptPump);
            receiptPump = null;
        }
    }

    private void unregisterReceiver() {
        if (receiver != null) {
            try { activity.unregisterReceiver(receiver); } catch (Exception ignored) {}
            receiver = null;
        }
    }
}
