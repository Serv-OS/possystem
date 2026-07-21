package co.posup.rpos.paxpay.g8;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.util.Locale;
import java.util.Random;

/**
 * ############################################################################################
 * #  FAKE.  NO CARD IS EVER CHARGED BY THIS CLASS.                                           #
 * ############################################################################################
 *
 * Milestone-1 stand-in for the real G8:Cloud HTTP client. It waits a beat (to imitate network
 * + cardholder time so the UI's loading states are actually exercised) and then reports an
 * approval with an invented transaction id.
 *
 * It exists so the ENTIRE rest of the integration — controller package resolution, the launch
 * intent, the DEVICE_CONNECTED broadcast, our tip screen, the totals maths, the result screen
 * and the diagnostics — can be tested on the real terminal TODAY, with the one undocumented
 * piece isolated behind {@link G8CloudClient}.
 *
 * READ {@link G8CloudClient} FOR THE FULL LIST OF WHAT RYFT/STS MUST SUPPLY.
 *
 * Every transaction id is prefixed "STUB-" on purpose: if that string ever turns up in a
 * report, a receipt, or the CRM, something has shipped that should not have.
 */
public final class StubG8CloudClient implements G8CloudClient {

    private static final String TAG = "PaxPayG8";

    /** Imitates "reaching G8:Cloud and getting the transaction accepted". */
    private static final long START_DELAY_MS = 700L;
    /** Imitates the cardholder actually presenting a card on the controller's screen. */
    private static final long RESULT_DELAY_MS = 900L;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Random random = new Random();

    @Override
    public void startTransaction(G8SaleRequest request, Callback<G8StartResponse> callback) {
        final String txnId = "STUB-" + String.format(Locale.UK, "%08X", random.nextInt());
        Log.w(TAG, "STUB startTransaction — NO REAL CHARGE. total=" + request.totalMinor
                + " " + request.currency + " (base=" + request.baseMinor
                + " tip=" + request.tipMinor + ") ref=" + request.reference
                + " idem=" + request.idempotencyKey + " -> " + txnId);
        main.postDelayed(() -> callback.onSuccess(new G8StartResponse(txnId)), START_DELAY_MS);
    }

    @Override
    public void fetchResult(String transactionId, Callback<G8TransactionResult> callback) {
        Log.w(TAG, "STUB fetchResult — fabricating an APPROVAL for " + transactionId);
        main.postDelayed(() -> callback.onSuccess(new G8TransactionResult(
                true,
                transactionId,
                String.format(Locale.UK, "%06d", random.nextInt(1000000)),
                "SIMULATED",
                "•••• 0000",
                null,
                true              // simulated — must stay true for anything this class returns
        )), RESULT_DELAY_MS);
    }

    @Override
    public String describe() {
        return "STUB (no card charged)";
    }
}
