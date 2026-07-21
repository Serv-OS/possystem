package co.posup.rpos.paxpay.net;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;

import co.posup.rpos.paxpay.BuildVersion;
import co.posup.rpos.paxpay.model.Json;
import co.posup.rpos.paxpay.model.OpenTable;
import co.posup.rpos.paxpay.model.Pairing;
import co.posup.rpos.paxpay.model.StaffSession;
import co.posup.rpos.paxpay.model.TerminalJob;

/**
 * THE CONTRACT. One method per server RPC, nothing invented, nothing renamed.
 *
 * The server side of these is built in parallel by another agent against the same list, so this
 * file is the single place the two halves have to agree. If a signature here drifts from the
 * migration, the terminal breaks silently at the till — so keep this file boring and literal.
 *
 *   register_terminal_device(p_serial, p_app_version)
 *   terminal_heartbeat(p_device_id, p_app_version)
 *   terminal_staff_login(p_pin)
 *   terminal_open_tables()
 *   terminal_start_table_payment(p_table_id, p_staff_id)
 *   terminal_claim_job(p_job_id)
 *   terminal_commit_tip(p_job_id, p_tip_minor)
 *   terminal_report_result(p_job_id, p_status, p_transaction_id, p_auth_code, p_card,
 *                          p_reported_minor, p_decline_reason)
 *
 * Job pickup is a filtered SELECT on terminal_jobs, not an RPC — see {@link #pollPendingJob}.
 * Ditto the terminal's own settings row — see {@link #fetchSettings}.
 *
 * Every method here BLOCKS. Call them inside SupabaseClient.async().
 */
public final class OpsApi {

    /** Job statuses we report back. Kept as constants so a typo cannot become a DB state. */
    public static final String STATUS_APPROVED = "approved";
    public static final String STATUS_DECLINED = "declined";
    public static final String STATUS_CANCELLED = "cancelled";
    /**
     * The card MAY have been charged and we cannot establish which. Never auto-retried, never
     * dropped — it is a human's problem by design. See RecoveryRunner.
     */
    public static final String STATUS_UNKNOWN = "unknown";

    private final SupabaseClient sb;

    public OpsApi(SupabaseClient sb) {
        this.sb = sb;
    }

    // -------------------------------------------------------------------------------------
    // Pairing
    // -------------------------------------------------------------------------------------

    /**
     * Register (or re-find) this terminal. Idempotent per SERIAL on the server.
     *
     * This is the ONE call allowed to create an anonymous identity — everywhere else a missing
     * session is an error, not a licence to become a different device. See SupabaseClient.
     */
    public Pairing registerDevice(String serial) throws Exception {
        JSONObject p = new JSONObject();
        p.put("p_serial", serial);
        p.put("p_app_version", BuildVersion.VERSION);
        Pairing pairing = Pairing.from(sb.rpcObject("register_terminal_device", p, true));
        if (pairing == null) throw new Exception("Registration returned no device.");
        return pairing;
    }

    /**
     * Tell the server we are alive. Also how the terminal LEARNS IT HAS BEEN PAIRED: a manager
     * types the claim code into Back Office and the next heartbeat's re-register picks up the
     * new status. Fire-and-forget — a failed heartbeat must never block a payment.
     */
    public void heartbeat(String deviceId) throws Exception {
        JSONObject p = new JSONObject();
        p.put("p_device_id", deviceId);
        p.put("p_app_version", BuildVersion.VERSION);
        sb.rpcRaw("terminal_heartbeat", p, false);
    }

    /**
     * v5.5.838: what Back Office says this terminal may do, and its idle image.
     *
     * A filtered select rather than an RPC, and that is safe here for one specific reason:
     * terminal_devices' SELECT policy is `device_uid = auth.uid()`, so this query can only ever
     * return OUR OWN row. Adding the id filter on top is belt and braces.
     *
     * Returns null when the row cannot be read — including on a database where 20260723 has not
     * been applied and the columns do not exist yet. The caller treats null as "no settings", not
     * as "everything off"; see TerminalSettings.allowAll().
     */
    public JSONObject fetchSettings(String deviceId) throws Exception {
        String q = "terminal_devices"
                + "?select=modes,idle_screen,label"
                + "&id=eq." + Http.enc(deviceId)
                + "&limit=1";
        JSONArray arr = sb.select(q);
        return arr.length() == 0 ? null : arr.optJSONObject(0);
    }

    // -------------------------------------------------------------------------------------
    // Table Pay
    // -------------------------------------------------------------------------------------

    /**
     * Validate a staff PIN. Returns null for "wrong PIN" — that is a normal outcome, not an error.
     *
     * ⚠ The PIN reaches this method as a String because org.json gives us no way to build a body
     * from a char[]. It is used once, never stored, never logged, and the request buffer is
     * zeroed after the write (Http.request). See PinScreen for the full picture and its limits.
     */
    public StaffSession staffLogin(String pin) throws Exception {
        JSONObject p = new JSONObject();
        p.put("p_pin", pin);
        return StaffSession.from(sb.rpcObject("terminal_staff_login", p));
    }

    public List<OpenTable> openTables() throws Exception {
        JSONArray arr = sb.rpcArray("terminal_open_tables", new JSONObject());
        return OpenTable.list(arr);
    }

    /**
     * Ask the server to mint a payment job for a whole table bill.
     *
     * WHOLE BILL ONLY — there is deliberately no split argument. Splitting stays on the POS; a
     * terminal carried to a table has no good way to show a per-item split and the mutex index
     * on check_key assumes one live job per check.
     */
    public TerminalJob startTablePayment(String tableId, String staffId, String tableLabel)
            throws Exception {
        JSONObject p = new JSONObject();
        p.put("p_table_id", tableId);
        p.put("p_staff_id", staffId);
        JSONObject reply = sb.rpcObject("terminal_start_table_payment", p);
        return TerminalJob.fromStartTablePayment(reply, tableLabel);
    }

    // -------------------------------------------------------------------------------------
    // Waiting for POS
    // -------------------------------------------------------------------------------------

    /**
     * Look for a job the POS has addressed to this terminal.
     *
     * A filtered select, per the contract — status='pending' only. A row that has already moved
     * to 'claimed' belongs to somebody else (or to an earlier run of ours that the recovery path
     * owns) and must not be picked up here.
     */
    public JSONObject pollPendingJob(String terminalId) throws Exception {
        String q = "terminal_jobs"
                + "?select=id,check_key,tip_basis_minor,due_minor,currency,tip_config,"
                + "check_draft,status,created_at"
                + "&target_terminal_id=eq." + Http.enc(terminalId)
                + "&status=eq.pending"
                + "&order=created_at.asc"
                + "&limit=1";
        JSONArray arr = sb.select(q);
        return arr.length() == 0 ? null : arr.optJSONObject(0);
    }

    /**
     * Take ownership. Returns TRUE only if this terminal now holds the job.
     *
     * A job another device claimed between our poll and our claim comes back not-ok, and the
     * caller simply carries on polling. That race is EXPECTED on a floor with two terminals, so
     * it is a normal return value and not an exception.
     */
    public boolean claimJob(String jobId) throws Exception {
        JSONObject p = new JSONObject();
        p.put("p_job_id", jobId);
        JSONObject r = sb.rpcObject("terminal_claim_job", p);
        return r != null && r.optBoolean("ok", false);
    }

    // -------------------------------------------------------------------------------------
    // Money
    // -------------------------------------------------------------------------------------

    /**
     * ★ THE ORDERING RULE ★
     *
     * Commit the chosen tip to the database BEFORE the card is touched, and get back the
     * server-computed charge. Every payment path in this app calls this and waits for it to
     * SUCCEED before launching the STS controller.
     *
     * Why this order and not the obvious one: if the terminal dies between here and the card, the
     * row already says exactly what was about to be charged, so the sale is recoverable. Charge
     * first and record after, and a crash in the gap leaves money taken with no record of what
     * for — unrecoverable by anything except a human reading the Ryft dashboard.
     *
     * If this call fails, DO NOT CHARGE. That is not an optimisation to route around.
     */
    public long commitTip(String jobId, long tipMinor) throws Exception {
        JSONObject p = new JSONObject();
        p.put("p_job_id", jobId);
        p.put("p_tip_minor", tipMinor);
        JSONObject r = sb.rpcObject("terminal_commit_tip", p);
        if (r == null) throw new Exception("The tip could not be recorded — no reply from the server.");
        return Json.requireMinor(r, "charge_minor");
    }

    /**
     * ★ THE POINT OF NO RETURN ★  charging_unsent → charging.
     *
     * ─────────────────────────────────────────────────────────────────────────────────────────
     * NOT IN THE ORIGINAL EIGHT-RPC CONTRACT — but calling it is NOT optional, and here is why.
     *
     * terminal_commit_tip leaves the row in `charging_unsent`, which the server treats as
     * DETERMINISTICALLY SAFE: terminal_jobs_sweep turns an expired `charging_unsent` row into
     * **cancelled**, with the reason "tip taken but request never dispatched".
     *
     * So if this terminal dispatches a transaction and never says so, and the 5-minute claim
     * lease then runs out — a slow customer, a re-tap, a card that needs a PIN — the sweeper
     * records a real charge as a clean cancellation. That is a LOST SALE written down as if
     * nothing happened, which is worse than an error: nobody goes looking for it.
     *
     * The same split is what keeps the human queue meaningful (spec rule 5 / risk 6): ordinary
     * customer walk-aways settle as `cancelled` from charging_unsent, and only genuinely
     * dispatched-then-silent jobs become `unknown`. Collapse the two and staff learn to
     * rubber-stamp the queue, and then mis-resolve the one that mattered.
     *
     * Called at the exact moment the HTTP dispatch is issued — see PaymentFlow.onDispatching().
     * ─────────────────────────────────────────────────────────────────────────────────────────
     */
    public boolean jobSent(String jobId, String transactionId) throws Exception {
        JSONObject p = new JSONObject();
        p.put("p_job_id", jobId);
        p.put("p_transaction_id", transactionId == null ? JSONObject.NULL : transactionId);
        JSONObject r = sb.rpcObject("terminal_job_sent", p);
        return r != null && r.optBoolean("ok", false);
    }

    /**
     * Write the outcome back.
     *
     * reportedMinor is what THIS DEVICE believes was charged. The server stores it separately
     * from its own charge_minor and compares — a mismatch is a human's problem, not something
     * the terminal gets to reconcile for itself.
     */
    public boolean reportResult(String jobId, String status, String transactionId, String authCode,
                                String cardJson, long reportedMinor, String declineReason)
            throws Exception {
        JSONObject p = new JSONObject();
        p.put("p_job_id", jobId);
        p.put("p_status", status);
        p.put("p_transaction_id", transactionId == null ? JSONObject.NULL : transactionId);
        p.put("p_auth_code", authCode == null ? JSONObject.NULL : authCode);
        if (cardJson == null || cardJson.isEmpty()) {
            p.put("p_card", JSONObject.NULL);
        } else {
            try {
                p.put("p_card", new JSONObject(cardJson));
            } catch (Exception e) {
                p.put("p_card", JSONObject.NULL);
            }
        }
        p.put("p_reported_minor", reportedMinor);
        p.put("p_decline_reason", declineReason == null ? JSONObject.NULL : declineReason);

        JSONObject r = sb.rpcObject("terminal_report_result", p);
        return r != null && r.optBoolean("ok", false);
    }
}
