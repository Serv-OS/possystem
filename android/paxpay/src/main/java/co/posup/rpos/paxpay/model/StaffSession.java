package co.posup.rpos.paxpay.model;

import org.json.JSONObject;

/**
 * Reply from terminal_staff_login(p_pin). Null reply = wrong PIN.
 *
 * Note what is NOT here: the PIN. It is validated server-side and never retained, in memory or
 * otherwise, past the request that carried it. See PinScreen.
 */
public final class StaffSession {

    public final String staffId;
    public final String name;
    /**
     * Server's verdict on whether this person may take money. Enforced on the SERVER too — this
     * copy exists so the terminal can say "you are not permitted" instead of failing later with
     * an opaque RPC error. Never treat the client-side check as the authority.
     */
    public final boolean canTakePayment;

    public StaffSession(String staffId, String name, boolean canTakePayment) {
        this.staffId = staffId;
        this.name = name;
        this.canTakePayment = canTakePayment;
    }

    public static StaffSession from(JSONObject j) {
        if (j == null) return null;
        String id = Json.str(j, "staff_id");
        if (id == null) return null;
        String n = Json.str(j, "name");
        return new StaffSession(id, n == null ? "Staff" : n,
                j.optBoolean("can_take_payment", false));
    }
}
