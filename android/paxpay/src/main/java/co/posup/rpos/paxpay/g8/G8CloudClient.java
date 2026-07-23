package co.posup.rpos.paxpay.g8;

/**
 * ============================================================================================
 *  ####  T H I S   I S   T H E   H O L E   I N   T H E   I N T E G R A T I O N  ####
 * ============================================================================================
 *
 *  Everything else in this app is real and runs on the terminal today. This interface is the
 *  ONE part that is faked, and it is faked because WE DO NOT HAVE THE VENDOR SPEC.
 *
 *  The only implementation that exists is {@link StubG8CloudClient}, which invents a
 *  transaction id and reports success after a delay. NO CARD IS EVER CHARGED.
 *
 *  --------------------------------------------------------------------------------------
 *  WHAT WE HAVE
 *  --------------------------------------------------------------------------------------
 *  Ryft's document "G8-Hybrid Intents and Cloud" describes the shape of the integration:
 *
 *    1. We launch the STS controller app by package name, passing ONLY a `timeout` extra.
 *    2. The controller connects to "G8:Cloud".
 *    3. It broadcasts com.stspayments.pax.v2.DEVICE_CONNECTED when it is ready to transact.
 *    4. >>> WE start the transaction OVER HTTP TO G8:CLOUD <<<   ← THIS INTERFACE
 *    5. The card is presented on the controller's screen.
 *    6. The controller finishes and hands control back to us.
 *    7. >>> WE read the result from the G8:Cloud API <<<          ← THIS INTERFACE
 *
 *  Note step 4: the launch intent carries NO AMOUNT. The money travels over HTTP, which is
 *  precisely why this interface exists and why it is commercially load-bearing (see below).
 *
 *  --------------------------------------------------------------------------------------
 *  WHAT WE DO NOT HAVE  — this is the exact ask for Ryft / STS Payments
 *  --------------------------------------------------------------------------------------
 *  The doc REFERENCES G8:Cloud but does not DOCUMENT it. Every one of these is unknown:
 *
 *   1. BASE URL / ENDPOINTS
 *        - What host does G8:Cloud live on? Is it one global endpoint, per-region, or a
 *          per-merchant tenant URL?
 *        - Are there separate sandbox and live hosts? (Our terminal runs the `.test`
 *          controller build, so presumably yes — we need both.)
 *        - Which paths start a transaction and fetch a result?
 *
 *   2. AUTHENTICATION
 *        - What credential authenticates the call — a Ryft secret key, an STS-issued API key,
 *          an OAuth client-credentials token, or a mutual-TLS client certificate?
 *        - Which header carries it?
 *        - Does the credential live on the TERMINAL or must the call be made from OUR SERVER?
 *          This one materially changes the architecture: if the credential may not sit on the
 *          device, the HTTP call has to be proxied through a Supabase edge function and this
 *          interface's implementation becomes a thin client to our own backend instead.
 *
 *   3. DEVICE IDENTITY
 *        - How does G8:Cloud know WHICH terminal to push the transaction to? A serial number,
 *          a terminal id, a session token handed to us in the DEVICE_CONNECTED broadcast?
 *        - The broadcast's extras are undocumented. We currently log every extra we receive
 *          (see PaymentFlow.onDeviceConnected) specifically to answer this from a real device.
 *
 *   4. START-TRANSACTION REQUEST SCHEMA
 *        - Field names and types for amount, currency, transaction type (sale / refund /
 *          pre-auth), and our own order reference.
 *        - Is the amount in minor units? (We assume yes — see G8SaleRequest.)
 *        - Is there an idempotency key? There MUST be one before this goes anywhere near a
 *          real card; retrying a start-transaction without one is a double-charge.
 *
 *   5. RESPONSE + RESULT SCHEMA
 *        - What identifier comes back, and is it the same id used to fetch the result?
 *        - Result fields: approved/declined, auth code, scheme, masked PAN, decline reason.
 *        - Is the result fetched by POLLING, or pushed to a webhook? If polling: what interval
 *          and what is the terminal state machine (pending → ...)? Step 7 says "read the
 *          result", implying a pull, but this is not stated.
 *
 *   6. FAILURE + RECONCILIATION SEMANTICS
 *        - If the controller returns to us but the HTTP result fetch fails, how do we later
 *          establish whether the customer was charged? THIS IS THE DANGEROUS CASE and it must
 *          be answered before go-live.
 *        - How is a transaction cancelled/voided mid-flight?
 *        - How do timeouts on their side surface to us?
 *
 *   7. TIPPING — CONFIRM THE COMMERCIAL ASSUMPTION
 *        - Our whole reason for owning the payment UI is that WE compute base + tip and send
 *          ONE total, because Ryft's REST API has no tip field. We need confirmation that
 *          G8:Cloud likewise accepts a single total with no tip semantics of its own, AND
 *          that the STS controller will not show its OWN tip prompt on top of ours (which
 *          would double-prompt the customer). Unverified.
 *
 *   8. FEES
 *        - Whether platformFee / commission survives this route, as it does on Ryft REST.
 *
 *  --------------------------------------------------------------------------------------
 *  WHY THIS MATTERS COMMERCIALLY  (do not "simplify" this away)
 *  --------------------------------------------------------------------------------------
 *  Because WE make the HTTP call, WE control the amount. That lets us render our OWN tip
 *  screen and send (base + tip) as a single total. Ryft's REST API has no tip field at all,
 *  so this is the ONLY route to tipping on a terminal carried to the table. If a future
 *  refactor moves amount selection back to the vendor's screen, the tipping feature dies.
 *
 *  --------------------------------------------------------------------------------------
 *  TO FINISH THIS
 *  --------------------------------------------------------------------------------------
 *  Write a real implementation of this interface (e.g. HttpG8CloudClient) and swap the one
 *  construction site in PaymentFlow. Nothing else in the app should need to change — that is
 *  the point of the seam. Then set BuildVersion.SIMULATED = false.
 *
 *  BLOCKED ON: Ryft / STS Payments supplying the G8:Cloud HTTP API specification.
 * ============================================================================================
 */
public interface G8CloudClient {

    /** Result callback. Implementations MUST invoke these on the Android main thread. */
    interface Callback<T> {
        void onSuccess(T value);
        void onError(String message);
    }

    /**
     * Step 4 of the vendor flow: start the transaction on G8:Cloud.
     *
     * Called AFTER the DEVICE_CONNECTED broadcast confirms the controller is ready. The amount
     * carried here is the FULL total (base + tip) that our own tip screen produced.
     */
    void startTransaction(G8SaleRequest request, Callback<G8StartResponse> callback);

    /**
     * Step 7 of the vendor flow: read the outcome.
     *
     * Called after the controller hands control back to our activity. Whether the real API
     * wants a single GET or a poll loop is unknown (see item 5 above); the interface is
     * deliberately shaped as "give me the final result" so a polling implementation can hide
     * its loop behind this one call.
     */
    void fetchResult(String transactionId, Callback<G8TransactionResult> callback);

    /**
     * Fire-and-forget ping of the result endpoint WHILE the controller still holds the
     * customer's tap (v2.0-rc5).
     *
     * Why this exists: with receiptPrintingSource=PointOfSale the controller waits ON-DEVICE
     * for Ryft's confirm-receipt before completing — and the server only sends those confirms
     * when the result endpoint is polled. fetchResult() only starts AFTER the controller
     * returns, so nobody polled during the wait, nothing confirmed, and Ryft voided real taps
     * (the v5.5.862 live failure). This nudge closes that loop: PaymentFlow calls it on a
     * short timer between "transaction started" and "controller returned"; the server's
     * result path sends the confirms the moment the transaction awaits them.
     *
     * MUST be side-effect-free on the caller: no callback, no outcome interpretation, all
     * errors swallowed. The authoritative result still comes only from fetchResult().
     */
    default void nudgeResult(String transactionId) { /* stub: nothing to nudge */ }

    /** Short label for the diagnostics screen, e.g. "STUB (no card charged)". */
    String describe();
}
