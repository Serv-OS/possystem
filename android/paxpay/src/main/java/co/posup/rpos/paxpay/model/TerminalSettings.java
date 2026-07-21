package co.posup.rpos.paxpay.model;

import org.json.JSONObject;

/**
 * What Back Office says this terminal may do, and what it shows when idle.
 *
 * Read off THIS TERMINAL'S OWN terminal_devices row — its SELECT policy is
 * `device_uid = auth.uid()`, so a plain filtered select returns exactly one row
 * and cannot see another venue's terminals. No RPC needed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ABSENT MEANS ENABLED. Both `modes` and `idle_screen` are nullable columns, and
 * every terminal paired before v5.5.838 has NULL in them. A terminal that cannot
 * reach the server, or is running against a database where the migration has not
 * been applied, therefore behaves EXACTLY as it did before: three buttons, no
 * screensaver. A settings fetch is decoration on top of a working terminal — it
 * is never allowed to take one off the floor.
 * ─────────────────────────────────────────────────────────────────────────────
 */
public final class TerminalSettings {

    public final boolean tablePay;
    public final boolean manual;
    public final boolean posDispatch;

    /** Screensaver on, AND an image URL to show. Either missing = off. */
    public final boolean idleEnabled;
    /** Public-bucket https URL, or null. Public objects need no auth to fetch. */
    public final String idleImageUrl;

    public TerminalSettings(boolean tablePay, boolean manual, boolean posDispatch,
                            boolean idleEnabled, String idleImageUrl) {
        this.tablePay = tablePay;
        this.manual = manual;
        this.posDispatch = posDispatch;
        this.idleEnabled = idleEnabled;
        this.idleImageUrl = idleImageUrl;
    }

    /** The pre-settings behaviour: everything on, no screensaver. */
    public static TerminalSettings allowAll() {
        return new TerminalSettings(true, true, true, false, null);
    }

    public boolean anyModeEnabled() {
        return tablePay || manual || posDispatch;
    }

    /**
     * Parse one terminal_devices row. Never throws — an unreadable row falls back
     * to {@link #allowAll()} for the modes, because a parse failure must not be
     * able to disable a terminal's payment buttons.
     */
    public static TerminalSettings from(JSONObject row) {
        if (row == null) return allowAll();
        try {
            JSONObject modes = row.optJSONObject("modes");
            boolean table = modes == null || modes.optBoolean("table_pay", true);
            boolean man = modes == null || modes.optBoolean("manual", true);
            boolean pos = modes == null || modes.optBoolean("pos_dispatch", true);

            JSONObject idle = row.optJSONObject("idle_screen");
            String url = idle == null ? null : idle.optString("imageUrl", null);
            if (url != null && url.trim().isEmpty()) url = null;
            // Enabled with no image is just "off" — there is no placeholder.
            boolean idleOn = idle != null && idle.optBoolean("enabled", false) && url != null;

            return new TerminalSettings(table, man, pos, idleOn, url);
        } catch (Throwable t) {
            return allowAll();
        }
    }

    /** Round-trips through Prefs so the home screen renders correctly at boot, offline. */
    public JSONObject toJson() {
        JSONObject o = new JSONObject();
        try {
            o.put("table_pay", tablePay);
            o.put("manual", manual);
            o.put("pos_dispatch", posDispatch);
            o.put("idle_enabled", idleEnabled);
            o.put("idle_image_url", idleImageUrl == null ? JSONObject.NULL : idleImageUrl);
        } catch (Throwable ignored) {
        }
        return o;
    }

    public static TerminalSettings fromCache(JSONObject o) {
        if (o == null) return allowAll();
        String url = o.optString("idle_image_url", null);
        if (url != null && (url.trim().isEmpty() || "null".equals(url))) url = null;
        return new TerminalSettings(
                o.optBoolean("table_pay", true),
                o.optBoolean("manual", true),
                o.optBoolean("pos_dispatch", true),
                o.optBoolean("idle_enabled", false) && url != null,
                url);
    }
}
