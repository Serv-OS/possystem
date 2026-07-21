package co.posup.rpos.paxpay.g8;

/**
 * What G8:Cloud gives back when a transaction is started.
 *
 * ⚠ SPECULATIVE SHAPE — see G8CloudClient item 5. We assume a single id that is also the handle
 * used to fetch the result; that assumption is unverified.
 */
public final class G8StartResponse {
    /** Vendor transaction id, used later by {@link G8CloudClient#fetchResult}. */
    public final String transactionId;

    public G8StartResponse(String transactionId) {
        this.transactionId = transactionId;
    }
}
