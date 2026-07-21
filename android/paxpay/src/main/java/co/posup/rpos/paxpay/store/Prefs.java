package co.posup.rpos.paxpay.store;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.provider.Settings;

import java.util.UUID;

/**
 * Everything the terminal must remember across restarts, except the payment write-ahead log
 * (that is SQLite — see {@link JobLog}).
 *
 * Two categories live here and they have VERY different consequences if lost:
 *
 *   1. SESSION (access + refresh token). Losing these means losing auth.uid(), and auth.uid() is
 *      what terminal_devices.device_uid was stamped with at registration. A lost session is
 *      therefore a LOST PAIRING, not a re-login. See SupabaseClient.ensureSession().
 *   2. PAIRING (device id, claim code, venue label). Cheap to re-read from the server, but kept
 *      so the home screen renders instantly at boot instead of flashing "pairing…".
 *
 * NOT stored here, ever: a staff PIN, a card number, or anything read off a card.
 */
public final class Prefs {

    private static final String FILE = "paxpay_state";

    // ---- session -------------------------------------------------------------------------
    private static final String K_ACCESS = "access_token";
    private static final String K_REFRESH = "refresh_token";
    private static final String K_EXPIRES_AT = "expires_at_ms";
    private static final String K_AUTH_UID = "auth_uid";

    // ---- identity + pairing ----------------------------------------------------------------
    private static final String K_SERIAL = "serial";
    private static final String K_DEVICE_ID = "device_id";
    private static final String K_CLAIM_CODE = "claim_code";
    private static final String K_STATUS = "status";
    private static final String K_LOCATION_ID = "location_id";
    private static final String K_LABEL = "label";

    // ---- v5.5.838 Back Office settings cache ------------------------------------------------
    /** Serialised TerminalSettings — see the note under {@link #settingsJson()}. */
    private static final String K_SETTINGS = "terminal_settings";
    /** Which URL the file in ScreensaverCache currently holds. */
    private static final String K_SS_URL = "screensaver_url";

    private final SharedPreferences sp;

    public Prefs(Context c) {
        this.sp = c.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    // -------------------------------------------------------------------------------------
    // Session
    // -------------------------------------------------------------------------------------

    public String accessToken() { return sp.getString(K_ACCESS, null); }
    public String refreshToken() { return sp.getString(K_REFRESH, null); }
    public String authUid() { return sp.getString(K_AUTH_UID, null); }
    public long expiresAtMs() { return sp.getLong(K_EXPIRES_AT, 0L); }

    public void saveSession(String access, String refresh, long expiresAtMs, String uid) {
        SharedPreferences.Editor e = sp.edit();
        e.putString(K_ACCESS, access);
        // GoTrue does not always resend the refresh token; never overwrite a good one with null.
        if (refresh != null && !refresh.isEmpty()) e.putString(K_REFRESH, refresh);
        e.putLong(K_EXPIRES_AT, expiresAtMs);
        if (uid != null && !uid.isEmpty()) e.putString(K_AUTH_UID, uid);
        e.apply();
    }

    /** Wipes the access token only — the refresh token survives so we can recover the SAME uid. */
    public void clearAccessToken() {
        sp.edit().remove(K_ACCESS).putLong(K_EXPIRES_AT, 0L).apply();
    }

    /** True once this device has EVER held a session. Guards against minting a second identity. */
    public boolean hasEverAuthenticated() { return authUid() != null || refreshToken() != null; }

    // -------------------------------------------------------------------------------------
    // Identity
    // -------------------------------------------------------------------------------------

    /**
     * The STABLE serial the server keys registration on. It must survive an app reinstall,
     * because that is the whole point of `idx_td_serial` being unique per paired device.
     *
     * Resolution order, first hit wins and is then FROZEN into prefs so it can never change
     * under a paired device:
     *
     *   1. Build.getSerial() — the real hardware serial. On API 29+ this needs READ_PHONE_STATE,
     *      which we do NOT request (asking a payment terminal for the phone permission is both
     *      ugly and, on a PAX, usually refused), so it normally throws and we fall through.
     *      Kept first because some PAX firmware images grant it to system-signed installs.
     *   2. Settings.Secure.ANDROID_ID — survives app reinstall, changes only on factory reset.
     *      This is the realistic answer on an A920 Pro.
     *   3. A random UUID — last resort. Does NOT survive reinstall; a reinstalled terminal would
     *      register as a new device and need re-pairing. Documented rather than hidden.
     *
     * ⚠ ASSUMPTION: that ANDROID_ID is stable enough to be the pairing key on this hardware.
     * If Ryft/PAX expose a proper serial API on the A920 Pro, prefer it here.
     */
    @SuppressLint("HardwareIds")
    public String serial(Context c) {
        String existing = sp.getString(K_SERIAL, null);
        if (existing != null && !existing.isEmpty()) return existing;

        String resolved = null;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                String s = Build.getSerial();
                if (s != null && !s.isEmpty() && !"unknown".equalsIgnoreCase(s)) resolved = s;
            }
        } catch (Throwable ignored) {
            // SecurityException on API 29+ without READ_PHONE_STATE — expected, fall through.
        }
        if (resolved == null) {
            try {
                String aid = Settings.Secure.getString(
                        c.getContentResolver(), Settings.Secure.ANDROID_ID);
                if (aid != null && !aid.isEmpty()) resolved = "AID-" + aid;
            } catch (Throwable ignored) {
            }
        }
        if (resolved == null) resolved = "UUID-" + UUID.randomUUID();

        sp.edit().putString(K_SERIAL, resolved).apply();
        return resolved;
    }

    // -------------------------------------------------------------------------------------
    // Pairing
    // -------------------------------------------------------------------------------------

    public String deviceId() { return sp.getString(K_DEVICE_ID, null); }
    public String claimCode() { return sp.getString(K_CLAIM_CODE, null); }
    public String status() { return sp.getString(K_STATUS, "unpaired"); }
    public String locationId() { return sp.getString(K_LOCATION_ID, null); }
    public String label() { return sp.getString(K_LABEL, null); }

    public boolean isPaired() {
        return "paired".equalsIgnoreCase(status()) && deviceId() != null;
    }

    public void savePairing(String deviceId, String claimCode, String status,
                            String locationId, String label) {
        sp.edit()
                .putString(K_DEVICE_ID, deviceId)
                .putString(K_CLAIM_CODE, claimCode)
                .putString(K_STATUS, status == null ? "unpaired" : status)
                .putString(K_LOCATION_ID, locationId)
                .putString(K_LABEL, label)
                .apply();
    }

    // -------------------------------------------------------------------------------------
    // Back Office settings (v5.5.838)
    // -------------------------------------------------------------------------------------

    /**
     * The last known mode toggles + idle-screen config, as JSON.
     *
     * Cached for the same reason the pairing is: so the home screen renders correctly the
     * instant the app opens, rather than showing three buttons and then removing one a second
     * later when the fetch lands. A terminal whose modes were narrowed must not flash the mode
     * it is no longer allowed to offer.
     *
     * Never authoritative — the server row wins on every fetch. Absent = all modes enabled.
     */
    public String settingsJson() { return sp.getString(K_SETTINGS, null); }

    public void saveSettingsJson(String json) {
        if (json == null) sp.edit().remove(K_SETTINGS).apply();
        else sp.edit().putString(K_SETTINGS, json).apply();
    }

    public String screensaverUrl() { return sp.getString(K_SS_URL, null); }

    public void saveScreensaverUrl(String url) {
        sp.edit().putString(K_SS_URL, url).apply();
    }
}
