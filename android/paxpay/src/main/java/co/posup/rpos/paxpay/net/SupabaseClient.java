package co.posup.rpos.paxpay.net;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import co.posup.rpos.paxpay.Config;
import co.posup.rpos.paxpay.store.Prefs;

/**
 * Supabase auth + PostgREST, for a device that has no user.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE SESSION IS THE PAIRING. READ THIS BEFORE CHANGING ANYTHING HERE.
 *
 * register_terminal_device() stamps terminal_devices.device_uid from auth.uid(). Every RLS
 * policy the terminal relies on — reading its own device row, reading jobs addressed to it —
 * filters on that uid. So the anonymous session is not a convenience, it IS the device's
 * identity. Consequences, all of them deliberate:
 *
 *   - We sign in anonymously EXACTLY ONCE, on a device that has never authenticated. This
 *     mirrors ensureAuthToken() in src/lib/supabase.js (which the kiosk/QR/online surfaces use)
 *     but adds one rule the web app does not need: NEVER mint a second anonymous user on a
 *     device that already has one. A silent re-signup would hand us a brand-new uid, orphan the
 *     paired row, and present the operator with a terminal that is "paired" and can see nothing.
 *   - The refresh token is persisted and used to recover the SAME uid across restarts, expiry,
 *     and long offline periods. It is the only thing standing between us and a re-pair.
 *   - If the refresh genuinely fails (token revoked/expired beyond recovery) we do NOT paper over
 *     it. We surface SESSION_LOST and let the pairing screen re-register against the same SERIAL,
 *     which is the server's idempotency key. See PairingScreen for what the operator sees.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
public final class SupabaseClient {

    private static final String TAG = "PaxPaySupabase";

    /** Marker prefix on the error message when the device's identity could not be recovered. */
    public static final String SESSION_LOST = "SESSION_LOST";

    /** Refresh this far before the token actually expires, so a call never races the clock. */
    private static final long REFRESH_SKEW_MS = 120_000L;

    public interface Result<T> {
        void onSuccess(T value);
        void onError(String message);
    }

    /** A unit of work that runs on the background thread and may throw. */
    public interface Call<T> {
        T run() throws Exception;
    }

    private final Prefs prefs;
    private final Context appContext;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    /** Last transport/auth failure, surfaced on the diagnostics screen. */
    public volatile String lastError = null;

    public SupabaseClient(Context c, Prefs prefs) {
        this.appContext = c.getApplicationContext();
        this.prefs = prefs;
    }

    // -------------------------------------------------------------------------------------
    // Threading
    // -------------------------------------------------------------------------------------

    /** Run on the background thread; deliver the outcome on the main thread. */
    public <T> void async(final Call<T> call, final Result<T> cb) {
        executor.execute(() -> {
            T value = null;
            String error = null;
            try {
                value = call.run();
            } catch (Exception e) {
                error = e.getMessage() == null ? e.toString() : e.getMessage();
                lastError = error;
            }
            final T v = value;
            final String err = error;
            main.post(() -> {
                if (cb == null) return;
                if (err != null) cb.onError(err);
                else cb.onSuccess(v);
            });
        });
    }

    public void shutdown() {
        executor.shutdownNow();
    }

    // -------------------------------------------------------------------------------------
    // Session
    // -------------------------------------------------------------------------------------

    /**
     * Guarantee a usable access token, or throw. BLOCKING — background thread only.
     *
     * @param allowNewIdentity true only on the pairing path. Everywhere else a missing session
     *                         must NOT quietly become a new anonymous user (see class comment).
     */
    public synchronized String ensureSession(boolean allowNewIdentity) throws Exception {
        Config.requireConfigured();

        String token = prefs.accessToken();
        if (token != null && System.currentTimeMillis() < prefs.expiresAtMs() - REFRESH_SKEW_MS) {
            return token;
        }

        String refresh = prefs.refreshToken();
        if (refresh != null && !refresh.isEmpty()) {
            try {
                return refreshSession(refresh);
            } catch (Exception e) {
                // Distinguish "no network" from "the server rejected this token". A transport failure
                // must NOT be treated as a lost pairing — the terminal is simply offline.
                if (e instanceof TransportException) throw e;
                Log.w(TAG, "refresh rejected: " + e.getMessage());
                if (!allowNewIdentity) {
                    throw new Exception(SESSION_LOST + ": this terminal's session could not be "
                            + "renewed. Re-pair from the pairing screen.");
                }
            }
        }

        if (!allowNewIdentity && prefs.hasEverAuthenticated()) {
            throw new Exception(SESSION_LOST + ": no session, and refusing to create a second "
                    + "identity for an already-registered terminal.");
        }

        return signInAnonymously();
    }

    /** Convenience for the common case. */
    public String ensureSession() throws Exception {
        return ensureSession(false);
    }

    private String signInAnonymously() throws Exception {
        // Same call supabase-js signInAnonymously() makes: POST /auth/v1/signup with no
        // credentials. Returns a full session whose user has is_anonymous = true.
        Map<String, String> h = new HashMap<>();
        h.put("apikey", Config.anonKey());
        Http.Response r = Http.request("POST", Config.url() + "/auth/v1/signup", h, "{}");
        return storeSession(r, "anonymous sign-in");
    }

    private String refreshSession(String refreshToken) throws Exception {
        Map<String, String> h = new HashMap<>();
        h.put("apikey", Config.anonKey());
        JSONObject body = new JSONObject();
        body.put("refresh_token", refreshToken);
        Http.Response r = Http.request("POST",
                Config.url() + "/auth/v1/token?grant_type=refresh_token", h, body.toString());
        return storeSession(r, "token refresh");
    }

    private String storeSession(Http.Response r, String what) throws Exception {
        if (r.isTransportFailure()) throw new TransportException(what + " — " + r.describe());
        if (!r.ok()) throw new Exception(what + " failed (" + r.describe() + ")");

        JSONObject j = new JSONObject(r.body);
        String access = j.optString("access_token", null);
        if (access == null || access.isEmpty()) {
            throw new Exception(what + " returned no access token");
        }
        String refresh = j.optString("refresh_token", null);
        long expiresIn = j.optLong("expires_in", 3600L);
        JSONObject user = j.optJSONObject("user");
        String uid = user == null ? null : user.optString("id", null);

        // Never let a refresh silently change WHICH user we are — that is the pairing moving
        // under our feet, and it must be loud, not quiet.
        String known = prefs.authUid();
        if (known != null && uid != null && !known.equals(uid)) {
            Log.e(TAG, "auth uid CHANGED " + known + " -> " + uid);
        }

        prefs.saveSession(access, refresh,
                System.currentTimeMillis() + expiresIn * 1000L, uid);
        return access;
    }

    // -------------------------------------------------------------------------------------
    // PostgREST
    // -------------------------------------------------------------------------------------

    /**
     * Call a Postgres function. BLOCKING — background thread only.
     *
     * Returns the raw body so the caller can decide whether it is an object, an array, or the
     * literal `null` a "no match" RPC returns.
     */
    public String rpcRaw(String fn, JSONObject params, boolean allowNewIdentity) throws Exception {
        String url = Config.url() + "/rest/v1/rpc/" + fn;
        String body = params == null ? "{}" : params.toString();
        Http.Response r = send("POST", url, body, allowNewIdentity);
        return r.body;
    }

    public JSONObject rpcObject(String fn, JSONObject params) throws Exception {
        return rpcObject(fn, params, false);
    }

    public JSONObject rpcObject(String fn, JSONObject params, boolean allowNewIdentity)
            throws Exception {
        String body = rpcRaw(fn, params, allowNewIdentity).trim();
        if (body.isEmpty() || "null".equals(body)) return null;
        if (body.startsWith("[")) {
            org.json.JSONArray arr = new org.json.JSONArray(body);
            return arr.length() == 0 ? null : arr.optJSONObject(0);
        }
        return new JSONObject(body);
    }

    public org.json.JSONArray rpcArray(String fn, JSONObject params) throws Exception {
        String body = rpcRaw(fn, params, false).trim();
        if (body.isEmpty() || "null".equals(body)) return new org.json.JSONArray();
        if (body.startsWith("{")) {
            org.json.JSONArray one = new org.json.JSONArray();
            one.put(new JSONObject(body));
            return one;
        }
        return new org.json.JSONArray(body);
    }

    /** Filtered table read. BLOCKING — background thread only. */
    public org.json.JSONArray select(String pathAndQuery) throws Exception {
        Http.Response r = send("GET", Config.url() + "/rest/v1/" + pathAndQuery, null, false);
        String body = r.body.trim();
        if (body.isEmpty()) return new org.json.JSONArray();
        return new org.json.JSONArray(body);
    }

    /**
     * One authenticated request, with a single 401 → refresh → retry.
     *
     * The retry exists because a token can expire between our skew check and the server reading
     * it. It is deliberately ONE retry: a loop here would hammer GoTrue from a device that is
     * simply not authorised any more.
     */
    private Http.Response send(String method, String url, String body, boolean allowNewIdentity)
            throws Exception {
        String token = ensureSession(allowNewIdentity);
        Http.Response r = Http.request(method, url, headers(token), body);

        if (r.code == 401) {
            prefs.clearAccessToken();
            token = ensureSession(allowNewIdentity);
            r = Http.request(method, url, headers(token), body);
        }

        if (r.isTransportFailure()) {
            lastError = r.describe();
            throw new TransportException(r.describe());
        }
        if (!r.ok()) {
            lastError = r.describe();
            throw new Exception(describeApiError(r));
        }
        return r;
    }

    private Map<String, String> headers(String token) {
        Map<String, String> h = new HashMap<>();
        h.put("apikey", Config.anonKey());
        h.put("Authorization", "Bearer " + token);
        h.put("Accept", "application/json");
        return h;
    }

    /** PostgREST errors carry a useful `message`; surface it rather than a bare status code. */
    private static String describeApiError(Http.Response r) {
        try {
            JSONObject j = new JSONObject(r.body);
            String msg = j.optString("message", null);
            String hint = j.optString("hint", null);
            if (msg != null && !msg.isEmpty()) {
                return "HTTP " + r.code + ": " + msg + (hint == null || hint.isEmpty() ? "" : " (" + hint + ")");
            }
        } catch (Exception ignored) {
        }
        return r.describe();
    }

    /**
     * "We could not reach the server" — as distinct from "the server said no".
     *
     * This distinction is the single most important thing in this file after the session rule.
     * The write-ahead log retries a payment result FOREVER on a TransportException and NEVER on
     * anything else (see JobLog / RecoveryRunner): the server having an opinion means retrying
     * will not change it, whereas bad wifi in a basement bar will fix itself.
     */
    public static final class TransportException extends Exception {
        public TransportException(String m) { super(m); }
    }

    public static boolean isTransport(Throwable t) {
        return t instanceof TransportException;
    }

    public static boolean isSessionLost(String message) {
        return message != null && message.startsWith(SESSION_LOST);
    }
}
