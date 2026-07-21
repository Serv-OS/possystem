package co.posup.rpos.paxpay.model;

import org.json.JSONObject;

import co.posup.rpos.paxpay.Money;
import co.posup.rpos.paxpay.TipConfig;

/**
 * One payment the terminal is about to take. The in-memory mirror of a `terminal_jobs` row.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE THREE AMOUNTS — get these wrong and you either rob the staff or double-charge the customer.
 *
 *   tipBasisMinor  the BILL. Tip percentages are calculated against THIS.
 *   dueMinor       what the CARD must take, pre-tip. Already net of gift cards and vouchers.
 *   chargeMinor    dueMinor + tip. THE ONLY NUMBER THE CARD EVER SEES. Computed SERVER-side by
 *                  terminal_commit_tip and copied back here — we never derive it locally.
 *
 * Worked example from the spec: £50 meal, £45 paid by gift card, 10% tip.
 *   tipBasis 5000 → the 10% band offers £5.00 (not 50p — the tip is for the service)
 *   due       500 → the £5 the gift card did not cover
 *   charge   1000 → 500 + 500. Charging tipBasis + tip here would take £45 twice.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
public final class TerminalJob {

    /** Where this payment came from. Drives which RPCs run and what the result screen says. */
    public enum Source {
        /** Staff picked an open table on this terminal. */
        TABLE_PAY,
        /** The POS pushed a job row at this terminal and we polled it up. */
        POS_PUSH,
        /** Manual keypad amount. No server job exists; local write-ahead log only. */
        MANUAL
    }

    public final Source source;
    /** terminal_jobs.id. Null ONLY for MANUAL. Also the write-ahead log's primary key. */
    public final String jobId;
    public final long tipBasisMinor;
    public final long dueMinor;
    public final String currency;
    public final TipConfig tipConfig;
    /** What the waiter sees on the confirm screen, e.g. "Table 12". */
    public final String displayLabel;

    /** Chosen on the tip screen, then committed server-side BEFORE the card is touched. */
    private long tipMinor = 0L;
    /** Returned by terminal_commit_tip. -1 until the server has told us. */
    private long chargeMinor = -1L;

    public TerminalJob(Source source, String jobId, long tipBasisMinor, long dueMinor,
                       String currency, TipConfig tipConfig, String displayLabel) {
        this.source = source;
        this.jobId = jobId;
        this.tipBasisMinor = tipBasisMinor;
        this.dueMinor = dueMinor;
        this.currency = currency == null || currency.isEmpty()
                ? Money.DEFAULT_CURRENCY : currency;
        this.tipConfig = tipConfig;
        this.displayLabel = displayLabel;
    }

    public long tipMinor() { return tipMinor; }

    /**
     * The amount to send to the card.
     *
     * For a server-backed job this is whatever terminal_commit_tip computed — the server owns
     * the arithmetic (spec money rule 11). For MANUAL there is no server, so due + tip is
     * computed here and that is stated plainly rather than hidden.
     */
    public long chargeMinor() {
        if (chargeMinor >= 0) return chargeMinor;
        if (source == Source.MANUAL) return dueMinor + tipMinor;
        return -1L;
    }

    public boolean isChargeSettled() { return chargeMinor() >= 0; }

    public void setTipMinor(long tip) {
        this.tipMinor = Math.max(0L, tip);
    }

    /**
     * Record the server's computed charge.
     *
     * Guard: the server is authoritative, but if what it hands back is not due + tip then
     * something has gone wrong that neither side should paper over. Refuse rather than charge.
     */
    public void setServerCharge(long serverChargeMinor) throws Exception {
        if (serverChargeMinor < 0) {
            throw new Exception("Server returned a negative charge amount.");
        }
        long expected = dueMinor + tipMinor;
        if (serverChargeMinor != expected) {
            throw new Exception("Amount mismatch: the server computed "
                    + Money.format(serverChargeMinor, currency) + " but this terminal expected "
                    + Money.format(expected, currency)
                    + ". No card has been charged. Report this before retrying.");
        }
        this.chargeMinor = serverChargeMinor;
    }

    /** True when the job carries a server-side row that must be reported back to. */
    public boolean hasServerJob() { return jobId != null && source != Source.MANUAL; }

    /**
     * Parse a `terminal_jobs` row polled off the table (mode 3).
     *
     * Money fields are REQUIRED — see Json.requireMinor. A row we cannot read the amounts from
     * is not charged with a guess; it is refused.
     */
    public static TerminalJob fromRow(JSONObject row) throws Exception {
        if (row == null) throw new Exception("Empty job row.");
        String id = Json.str(row, "id");
        if (id == null) throw new Exception("Job row has no id.");

        long basis = Json.requireMinor(row, "tip_basis_minor");
        long due = Json.requireMinor(row, "due_minor");
        if (due <= 0) throw new Exception("Job has nothing left to charge (due = 0).");

        String currency = Json.str(row, "currency");
        TipConfig cfg = TipConfig.fromJobJson(row.optJSONObject("tip_config"));

        // The POS freezes a check snapshot on the row. We only want a human label off it; if it
        // is absent, fall back to the check key so the waiter still sees SOMETHING identifying.
        String label = null;
        JSONObject draft = row.optJSONObject("check_draft");
        if (draft != null) {
            label = Json.str(draft, "table_label");
            if (label == null) label = Json.str(draft, "label");
            if (label == null) label = Json.str(draft, "table_name");
        }
        if (label == null) label = Json.str(row, "check_key");
        if (label == null) label = "Payment";

        return new TerminalJob(Source.POS_PUSH, id, basis, due, currency, cfg, label);
    }

    /** Parse the reply from terminal_start_table_payment (mode 1). */
    public static TerminalJob fromStartTablePayment(JSONObject reply, String tableLabel)
            throws Exception {
        if (reply == null) throw new Exception("The POS did not return a payment job.");
        String id = Json.str(reply, "job_id");
        if (id == null) throw new Exception("Payment job reply has no job_id.");

        long basis = Json.requireMinor(reply, "tip_basis_minor");
        long due = Json.requireMinor(reply, "due_minor");
        if (due <= 0) throw new Exception("This bill has nothing left to charge.");

        return new TerminalJob(
                Source.TABLE_PAY, id, basis, due,
                Json.str(reply, "currency"),
                TipConfig.fromJobJson(reply.optJSONObject("tip_config")),
                tableLabel == null ? "Table" : tableLabel);
    }

    /** The manual-keypad path: no server job, basis == due, tip config from the venue default. */
    public static TerminalJob manual(long amountMinor, TipConfig cfg) {
        return new TerminalJob(Source.MANUAL, null, amountMinor, amountMinor,
                Money.DEFAULT_CURRENCY, cfg, "Manual payment");
    }
}
