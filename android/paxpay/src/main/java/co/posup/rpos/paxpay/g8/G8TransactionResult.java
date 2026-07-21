package co.posup.rpos.paxpay.g8;

/**
 * The outcome of a card transaction.
 *
 * ⚠ SPECULATIVE SHAPE — see G8CloudClient item 5. Field names here are ours; the real result
 * payload is undocumented. {@code simulated} is NOT a vendor concept: it is our own flag so a
 * fake approval can never be mistaken for a real one on screen or in a log.
 */
public final class G8TransactionResult {
    public final boolean approved;
    public final String transactionId;
    /** Acquirer auth code, when approved. May be null. */
    public final String authCode;
    /** e.g. "VISA" / "MASTERCARD". May be null. */
    public final String scheme;
    /** e.g. "•••• 4242". May be null. */
    public final String maskedPan;
    /** Populated when !approved. May be null. */
    public final String declineReason;
    /** TRUE when this came from the stub and no card was charged. */
    public final boolean simulated;

    public G8TransactionResult(boolean approved, String transactionId, String authCode,
                               String scheme, String maskedPan, String declineReason,
                               boolean simulated) {
        this.approved = approved;
        this.transactionId = transactionId;
        this.authCode = authCode;
        this.scheme = scheme;
        this.maskedPan = maskedPan;
        this.declineReason = declineReason;
        this.simulated = simulated;
    }
}
