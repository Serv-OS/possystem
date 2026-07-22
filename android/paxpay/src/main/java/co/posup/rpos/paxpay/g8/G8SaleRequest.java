package co.posup.rpos.paxpay.g8;

/**
 * What we want G8:Cloud to charge.
 *
 * ⚠ SPECULATIVE SHAPE. These fields are our best guess at what the real start-transaction
 * request needs; the actual schema is unknown (see the block comment in G8CloudClient, item 4).
 * Expect to rename/extend when Ryft supplies the spec. In particular {@code idempotencyKey} is
 * included because a start-transaction retry without one is a double-charge — if the real API
 * has no such field, that is a question to raise with the vendor, not a field to delete.
 */
public final class G8SaleRequest {

    /** FULL amount to charge in MINOR units — base + tip, already summed by our tip screen. */
    public final long totalMinor;

    /** Base (pre-tip) amount, minor units. Sent for reporting; may not map to a vendor field. */
    public final long baseMinor;

    /** Tip portion, minor units. Ryft REST has no tip field — this is ours, for our records. */
    public final long tipMinor;

    /** ISO-4217, e.g. "GBP". */
    public final String currency;

    /** Our own order reference, so a G8 transaction can be tied back to an RPOS check. */
    public final String reference;

    /** Unique per logical sale; MUST survive a retry of the same sale. */
    public final String idempotencyKey;

    /**
     * terminal_jobs.id, or null for a manual sale that has no server row.
     *
     * The REAL charge path (ServerG8CloudClient → terminal-job-charge) charges BY job id and
     * nothing else: the amount the card takes is the row's server-computed charge_minor, never
     * a number from this device. A null here means the server proxy cannot take the payment —
     * it refuses cleanly rather than inventing a job.
     */
    public final String jobId;

    public G8SaleRequest(long baseMinor, long tipMinor, String currency,
                         String reference, String idempotencyKey, String jobId) {
        this.baseMinor = baseMinor;
        this.tipMinor = tipMinor;
        this.totalMinor = baseMinor + tipMinor;
        this.currency = currency;
        this.reference = reference;
        this.idempotencyKey = idempotencyKey;
        this.jobId = jobId;
    }
}
