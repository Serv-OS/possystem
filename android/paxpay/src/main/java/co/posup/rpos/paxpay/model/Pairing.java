package co.posup.rpos.paxpay.model;

import org.json.JSONObject;

/** Reply from register_terminal_device(p_serial, p_app_version). */
public final class Pairing {

    public final String deviceId;
    public final String claimCode;
    /** unpaired | paired | retired */
    public final String status;
    public final String locationId;
    /** Venue / till name a manager typed in Back Office. Null until claimed. */
    public final String label;

    public Pairing(String deviceId, String claimCode, String status,
                   String locationId, String label) {
        this.deviceId = deviceId;
        this.claimCode = claimCode;
        this.status = status;
        this.locationId = locationId;
        this.label = label;
    }

    public boolean isPaired() { return "paired".equalsIgnoreCase(status); }
    public boolean isRetired() { return "retired".equalsIgnoreCase(status); }

    public static Pairing from(JSONObject j) {
        if (j == null) return null;
        return new Pairing(
                Json.str(j, "device_id"),
                Json.str(j, "claim_code"),
                j.optString("status", "unpaired"),
                Json.str(j, "location_id"),
                Json.str(j, "label"));
    }
}
