package co.posup.rpos.payments;

import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.core.app.ActivityCompat;

import com.stripe.stripeterminal.Terminal;
import com.stripe.stripeterminal.external.callable.Callback;
import com.stripe.stripeterminal.external.callable.Cancelable;
import com.stripe.stripeterminal.external.callable.ConnectionTokenCallback;
import com.stripe.stripeterminal.external.callable.ConnectionTokenProvider;
import com.stripe.stripeterminal.external.callable.DiscoveryListener;
import com.stripe.stripeterminal.external.callable.PaymentIntentCallback;
import com.stripe.stripeterminal.external.callable.ReaderCallback;
import com.stripe.stripeterminal.external.callable.TerminalListener;
import com.stripe.stripeterminal.external.models.CollectConfiguration;
import com.stripe.stripeterminal.external.models.ConnectionConfiguration;
import com.stripe.stripeterminal.external.models.ConnectionStatus;
import com.stripe.stripeterminal.external.models.ConnectionTokenException;
import com.stripe.stripeterminal.external.models.DiscoveryConfiguration;
import com.stripe.stripeterminal.external.models.PaymentIntent;
import com.stripe.stripeterminal.external.models.PaymentStatus;
import com.stripe.stripeterminal.external.models.Reader;
import com.stripe.stripeterminal.external.models.TerminalException;
import com.stripe.stripeterminal.log.LogLevel;

import org.jetbrains.annotations.NotNull;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * StripeTerminalBridge — exposes window.RposStripeTerminal to the React POS.
 *
 * This is the JAVA implementation. The previous Kotlin version was being
 * silently rejected by Android WebView's addJavascriptInterface — likely
 * because Kotlin generates extra reflection metadata (companion object,
 * private val with object initializer for SDK listener types, etc.) that
 * caused the WebView's class-enumeration step to throw and bail.
 *
 * Mirrors PrinterBridge.java pattern exactly. All Stripe SDK references live
 * inside method bodies — no SDK types are referenced at construction time.
 *
 * JS API:
 *   isAvailable()                                                      — sync, returns "true"
 *   setAuthToken(jwt)                                                  — store token for connection-token fetches
 *   initialize(callbackId)                                             — initialise Terminal singleton (lazy)
 *   checkPermissions(callbackId), requestPermissions(callbackId)
 *   discoverReaders(callbackId)                                        — streaming
 *   cancelDiscovery(callbackId)
 *   connectReader(serial, locationId, callbackId)                      — Bluetooth
 *   connectInternetReader(stripeReaderId, locationId, callbackId)      — Network (S700, WisePOS E)
 *   disconnectReader(callbackId)
 *   getStatus()                                                        — sync, returns JSON
 *   collectPayment(amountMinor, currency, locationId, channel, closedCheckId, callbackId)
 */
public class StripeTerminalBridge {

    private static final String TAG = "StripeTerminalBridge";
    private static final String CONNECTION_TOKEN_URL =
        "https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/stripe-terminal-connection-token";
    private static final String PAYMENT_INTENT_URL =
        "https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/stripe-create-payment-intent";
    private static final int HTTP_TIMEOUT_MS = 30_000;
    private static final int PERMISSIONS_REQUEST_CODE = 4242;

    private final Activity activity;
    private final WebView webView;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private volatile String authToken = null;

    // Stripe SDK references — declared but NOT initialised at construction.
    // Lazy-initialised on first call to initialize(). This is critical: it
    // means addJavascriptInterface can register the bridge without forcing
    // class-load of any Stripe SDK class, which is what was tripping the
    // WebView reflection scan in the Kotlin version.
    private ConnectionTokenProvider tokenProvider = null;
    private TerminalListener terminalListener = null;
    private Cancelable discoveryCancelable = null;

    public StripeTerminalBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
    }

    // ────────────────────────────────────────────────────────────────────────
    // PUBLIC JS API
    // ────────────────────────────────────────────────────────────────────────

    @JavascriptInterface
    public String isAvailable() {
        return "true";
    }

    @JavascriptInterface
    public void setAuthToken(String token) {
        this.authToken = (token != null && !token.isEmpty()) ? token : null;
    }

    @JavascriptInterface
    public void initialize(String callbackId) {
        try {
            if (!Terminal.isInitialized()) {
                if (tokenProvider == null) tokenProvider = createTokenProvider();
                if (terminalListener == null) terminalListener = createTerminalListener();
                Terminal.initTerminal(
                    activity.getApplicationContext(),
                    LogLevel.INFO,
                    tokenProvider,
                    terminalListener
                );
                Log.d(TAG, "Terminal initialised");
            }
            JSONObject ok = new JSONObject();
            ok.put("initialized", true);
            postCallback(callbackId, true, ok);
        } catch (Throwable e) {
            Log.e(TAG, "initialize failed", e);
            postCallback(callbackId, false, errPayload(e));
        }
    }

    @JavascriptInterface
    public void checkPermissions(String callbackId) {
        try {
            String[] missing = missingPermissions();
            JSONObject p = new JSONObject();
            p.put("granted", missing.length == 0);
            JSONArray ja = new JSONArray();
            for (String s : missing) ja.put(s);
            p.put("missing", ja);
            postCallback(callbackId, true, p);
        } catch (Throwable e) {
            postCallback(callbackId, false, errPayload(e));
        }
    }

    @JavascriptInterface
    public void requestPermissions(String callbackId) {
        try {
            String[] missing = missingPermissions();
            if (missing.length == 0) {
                JSONObject p = new JSONObject();
                p.put("granted", true);
                postCallback(callbackId, true, p);
                return;
            }
            mainHandler.post(() -> {
                ActivityCompat.requestPermissions(activity, missing, PERMISSIONS_REQUEST_CODE);
                try {
                    JSONObject p = new JSONObject();
                    p.put("requested", true);
                    postCallback(callbackId, true, p);
                } catch (Throwable e) {
                    postCallback(callbackId, false, errPayload(e));
                }
            });
        } catch (Throwable e) {
            postCallback(callbackId, false, errPayload(e));
        }
    }

    @JavascriptInterface
    public void discoverReaders(final String callbackId) {
        if (!Terminal.isInitialized()) {
            postCallback(callbackId, false, errMsg("Terminal not initialised"));
            return;
        }
        String[] missing = missingPermissions();
        if (missing.length > 0) {
            try {
                JSONObject p = new JSONObject();
                p.put("error", "Missing permissions");
                JSONArray ja = new JSONArray();
                for (String s : missing) ja.put(s);
                p.put("missing", ja);
                postCallback(callbackId, false, p);
            } catch (Throwable e) {
                postCallback(callbackId, false, errPayload(e));
            }
            return;
        }

        // Cancel any in-flight discovery first
        if (discoveryCancelable != null) {
            discoveryCancelable.cancel(new Callback() {
                @Override public void onSuccess() {}
                @Override public void onFailure(@NotNull TerminalException e) {}
            });
        }

        DiscoveryConfiguration.BluetoothDiscoveryConfiguration config =
            new DiscoveryConfiguration.BluetoothDiscoveryConfiguration(0, false);

        discoveryCancelable = Terminal.getInstance().discoverReaders(
            config,
            new DiscoveryListener() {
                @Override
                public void onUpdateDiscoveredReaders(@NotNull List<Reader> readers) {
                    try {
                        JSONArray arr = new JSONArray();
                        for (Reader r : readers) arr.put(readerToJson(r));
                        JSONObject p = new JSONObject();
                        p.put("event", "readers");
                        p.put("readers", arr);
                        postCallback(callbackId, true, p);
                    } catch (Throwable e) {
                        Log.w(TAG, "discoverReaders update payload failed", e);
                    }
                }
            },
            new Callback() {
                @Override
                public void onSuccess() {
                    try {
                        JSONObject p = new JSONObject();
                        p.put("event", "complete");
                        postCallback(callbackId, true, p);
                    } catch (Throwable ignored) {}
                }
                @Override
                public void onFailure(@NotNull TerminalException e) {
                    try {
                        JSONObject p = new JSONObject();
                        p.put("event", "error");
                        p.put("error", e.getErrorMessage());
                        p.put("code", e.getErrorCode().name());
                        postCallback(callbackId, false, p);
                    } catch (Throwable ignored) {}
                }
            }
        );
    }

    @JavascriptInterface
    public void cancelDiscovery(final String callbackId) {
        if (discoveryCancelable == null) {
            try {
                JSONObject p = new JSONObject();
                p.put("cancelled", false);
                postCallback(callbackId, true, p);
            } catch (Throwable e) {
                postCallback(callbackId, false, errPayload(e));
            }
            return;
        }
        discoveryCancelable.cancel(new Callback() {
            @Override public void onSuccess() {
                discoveryCancelable = null;
                try {
                    JSONObject p = new JSONObject();
                    p.put("cancelled", true);
                    postCallback(callbackId, true, p);
                } catch (Throwable e) {
                    postCallback(callbackId, false, errPayload(e));
                }
            }
            @Override public void onFailure(@NotNull TerminalException e) {
                postCallback(callbackId, false, errMsg(e.getErrorMessage()));
            }
        });
    }

    @JavascriptInterface
    public void connectReader(final String serialNumber, final String locationId, final String callbackId) {
        if (!Terminal.isInitialized()) {
            postCallback(callbackId, false, errMsg("Terminal not initialised"));
            return;
        }
        // Brief rediscovery to bind serial → MAC, then connect.
        DiscoveryConfiguration.BluetoothDiscoveryConfiguration discoveryConfig =
            new DiscoveryConfiguration.BluetoothDiscoveryConfiguration(15, false);
        final Reader[] foundReader = new Reader[]{null};

        Terminal.getInstance().discoverReaders(
            discoveryConfig,
            new DiscoveryListener() {
                @Override
                public void onUpdateDiscoveredReaders(@NotNull List<Reader> readers) {
                    if (foundReader[0] != null) return;
                    for (Reader r : readers) {
                        if (serialNumber.equals(r.getSerialNumber())) {
                            foundReader[0] = r;
                            break;
                        }
                    }
                }
            },
            new Callback() {
                @Override
                public void onSuccess() {
                    Reader reader = foundReader[0];
                    if (reader == null) {
                        postCallback(callbackId, false, errMsg(
                            "Reader " + serialNumber + " not found within 15s. Is it powered on and in pairing mode?"));
                        return;
                    }
                    ConnectionConfiguration.BluetoothConnectionConfiguration connConfig =
                        new ConnectionConfiguration.BluetoothConnectionConfiguration(locationId);
                    Terminal.getInstance().connectBluetoothReader(
                        reader, connConfig, null,
                        new ReaderCallback() {
                            @Override public void onSuccess(@NotNull Reader connectedReader) {
                                try {
                                    JSONObject p = new JSONObject();
                                    p.put("connected", true);
                                    p.put("reader", readerToJson(connectedReader));
                                    postCallback(callbackId, true, p);
                                } catch (Throwable e) {
                                    postCallback(callbackId, false, errPayload(e));
                                }
                            }
                            @Override public void onFailure(@NotNull TerminalException e) {
                                postCallback(callbackId, false, errCodeMsg(e));
                            }
                        }
                    );
                }
                @Override public void onFailure(@NotNull TerminalException e) {
                    postCallback(callbackId, false, errMsg(e.getErrorMessage()));
                }
            }
        );
    }

    @JavascriptInterface
    public void disconnectReader(final String callbackId) {
        if (!Terminal.isInitialized()) {
            try {
                JSONObject p = new JSONObject();
                p.put("disconnected", true);
                postCallback(callbackId, true, p);
            } catch (Throwable e) {
                postCallback(callbackId, false, errPayload(e));
            }
            return;
        }
        Terminal.getInstance().disconnectReader(new Callback() {
            @Override public void onSuccess() {
                try {
                    JSONObject p = new JSONObject();
                    p.put("disconnected", true);
                    postCallback(callbackId, true, p);
                } catch (Throwable e) {
                    postCallback(callbackId, false, errPayload(e));
                }
            }
            @Override public void onFailure(@NotNull TerminalException e) {
                postCallback(callbackId, false, errMsg(e.getErrorMessage()));
            }
        });
    }

    @JavascriptInterface
    public void connectInternetReader(final String stripeReaderId, final String locationId, final String callbackId) {
        if (!Terminal.isInitialized()) {
            postCallback(callbackId, false, errMsg("Terminal not initialised"));
            return;
        }
        if (Terminal.getInstance().getConnectedReader() != null) {
            Terminal.getInstance().disconnectReader(new Callback() {
                @Override public void onSuccess() {
                    discoverAndConnectInternet(stripeReaderId, locationId, callbackId);
                }
                @Override public void onFailure(@NotNull TerminalException e) {
                    postCallback(callbackId, false, errMsg("disconnect prior reader: " + e.getErrorMessage()));
                }
            });
        } else {
            discoverAndConnectInternet(stripeReaderId, locationId, callbackId);
        }
    }

    private void discoverAndConnectInternet(final String stripeReaderId, String locationId, final String callbackId) {
        boolean isSim = "simulated-wisepos-e".equals(stripeReaderId)
            || (stripeReaderId != null && stripeReaderId.startsWith("tmr_"));
        DiscoveryConfiguration.InternetDiscoveryConfiguration config =
            new DiscoveryConfiguration.InternetDiscoveryConfiguration(null, isSim);
        final Reader[] found = new Reader[]{null};

        Terminal.getInstance().discoverReaders(
            config,
            new DiscoveryListener() {
                @Override public void onUpdateDiscoveredReaders(@NotNull List<Reader> readers) {
                    if (found[0] != null) return;
                    for (Reader r : readers) {
                        if (stripeReaderId.equals(r.getId()) || stripeReaderId.equals(r.getSerialNumber())) {
                            found[0] = r;
                            break;
                        }
                    }
                }
            },
            new Callback() {
                @Override public void onSuccess() {
                    Reader reader = found[0];
                    if (reader == null) {
                        postCallback(callbackId, false, errMsg(
                            "Network reader " + stripeReaderId + " not discovered. Confirm it is online and on the same Stripe Terminal Location."));
                        return;
                    }
                    ConnectionConfiguration.InternetConnectionConfiguration connConfig =
                        new ConnectionConfiguration.InternetConnectionConfiguration();
                    Terminal.getInstance().connectInternetReader(
                        reader, connConfig,
                        new ReaderCallback() {
                            @Override public void onSuccess(@NotNull Reader connectedReader) {
                                try {
                                    JSONObject p = new JSONObject();
                                    p.put("connected", true);
                                    p.put("reader", readerToJson(connectedReader));
                                    postCallback(callbackId, true, p);
                                } catch (Throwable e) {
                                    postCallback(callbackId, false, errPayload(e));
                                }
                            }
                            @Override public void onFailure(@NotNull TerminalException e) {
                                postCallback(callbackId, false, errCodeMsg(e));
                            }
                        }
                    );
                }
                @Override public void onFailure(@NotNull TerminalException e) {
                    postCallback(callbackId, false, errMsg("discovery: " + e.getErrorMessage()));
                }
            }
        );
    }

    @JavascriptInterface
    public String getStatus() {
        try {
            JSONObject obj = new JSONObject();
            obj.put("initialized", Terminal.isInitialized());
            obj.put("hasAuthToken", authToken != null);
            if (Terminal.isInitialized()) {
                Terminal term = Terminal.getInstance();
                obj.put("connection", term.getConnectionStatus().name());
                Reader cr = term.getConnectedReader();
                if (cr != null) obj.put("reader", readerToJson(cr));
            }
            return obj.toString();
        } catch (Throwable e) {
            try { return new JSONObject().put("error", e.getMessage()).toString(); }
            catch (Throwable ignored) { return "{\"error\":\"unknown\"}"; }
        }
    }

    @JavascriptInterface
    public void collectPayment(
            final long amountMinor, final String currency, final String locationId,
            final String channel, final String closedCheckId, final String callbackId) {
        if (!Terminal.isInitialized()) {
            postCallback(callbackId, false, errMsg("Terminal not initialised"));
            return;
        }
        final Terminal term = Terminal.getInstance();
        if (term.getConnectedReader() == null) {
            postCallback(callbackId, false, errMsg("No reader connected"));
            return;
        }

        // Network IO off the main thread
        new Thread(() -> {
            try {
                final JSONObject piResult = createPaymentIntentOnServer(
                    amountMinor, currency, locationId, channel, closedCheckId);
                final String clientSecret = piResult.optString("client_secret", "");
                if (clientSecret.isEmpty()) {
                    JSONObject err = new JSONObject();
                    err.put("error", piResult.optString("error", "no client_secret in PaymentIntent response"));
                    err.put("step", "create");
                    postCallback(callbackId, false, err);
                    return;
                }

                term.retrievePaymentIntent(clientSecret, new PaymentIntentCallback() {
                    @Override public void onSuccess(@NotNull PaymentIntent intent) {
                        CollectConfiguration cfg = new CollectConfiguration.Builder().build();
                        term.collectPaymentMethod(intent, new PaymentIntentCallback() {
                            @Override public void onSuccess(@NotNull PaymentIntent intentAfterCollect) {
                                term.confirmPaymentIntent(intentAfterCollect, new PaymentIntentCallback() {
                                    @Override public void onSuccess(@NotNull PaymentIntent intentAfterConfirm) {
                                        try {
                                            JSONObject ok = new JSONObject();
                                            ok.put("status", intentAfterConfirm.getStatus() != null ? intentAfterConfirm.getStatus().name() : "unknown");
                                            ok.put("paymentIntentId", intentAfterConfirm.getId());
                                            ok.put("amount", intentAfterConfirm.getAmount());
                                            ok.put("markup_percent", piResult.optDouble("markup_percent", 0.0));
                                            ok.put("application_fee_minor", piResult.optLong("application_fee_minor", 0L));
                                            postCallback(callbackId, true, ok);
                                        } catch (Throwable e) {
                                            postCallback(callbackId, false, errPayload(e));
                                        }
                                    }
                                    @Override public void onFailure(@NotNull TerminalException e) {
                                        postCallback(callbackId, false, stepErr(e, "confirm"));
                                    }
                                });
                            }
                            @Override public void onFailure(@NotNull TerminalException e) {
                                postCallback(callbackId, false, stepErr(e, "collect"));
                            }
                        }, cfg);
                    }
                    @Override public void onFailure(@NotNull TerminalException e) {
                        postCallback(callbackId, false, stepErr(e, "retrieve"));
                    }
                });
            } catch (Throwable e) {
                Log.e(TAG, "collectPayment failed", e);
                try {
                    JSONObject err = new JSONObject();
                    err.put("error", e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName());
                    err.put("step", "create");
                    postCallback(callbackId, false, err);
                } catch (Throwable ignored) {}
            }
        }).start();
    }

    // ────────────────────────────────────────────────────────────────────────
    // INTERNAL helpers — lazy SDK references
    // ────────────────────────────────────────────────────────────────────────

    private ConnectionTokenProvider createTokenProvider() {
        return new ConnectionTokenProvider() {
            @Override
            public void fetchConnectionToken(@NotNull ConnectionTokenCallback callback) {
                final String jwt = authToken;
                if (jwt == null) {
                    callback.onFailure(new ConnectionTokenException("No auth token set on bridge"));
                    return;
                }
                new Thread(() -> {
                    try {
                        JSONObject resp = httpPostJson(CONNECTION_TOKEN_URL, jwt, new JSONObject());
                        String secret = resp.optString("secret", "");
                        if (secret.isEmpty()) {
                            String snippet = resp.optString("error", resp.toString());
                            if (snippet.length() > 200) snippet = snippet.substring(0, 200);
                            callback.onFailure(new ConnectionTokenException("no 'secret' in response: " + snippet));
                        } else {
                            callback.onSuccess(secret);
                        }
                    } catch (Throwable e) {
                        callback.onFailure(new ConnectionTokenException(
                            e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName()));
                    }
                }).start();
            }
        };
    }

    private TerminalListener createTerminalListener() {
        return new TerminalListener() {
            @Override public void onConnectionStatusChange(@NotNull ConnectionStatus status) {
                try {
                    JSONObject p = new JSONObject();
                    p.put("status", status.name());
                    postEvent("connectionStatus", p);
                } catch (Throwable ignored) {}
            }
            @Override public void onPaymentStatusChange(@NotNull PaymentStatus status) {
                try {
                    JSONObject p = new JSONObject();
                    p.put("status", status.name());
                    postEvent("paymentStatus", p);
                } catch (Throwable ignored) {}
            }
            @Override public void onUnexpectedReaderDisconnect(@NotNull Reader reader) {
                try {
                    JSONObject p = new JSONObject();
                    p.put("reader", readerToJson(reader));
                    postEvent("readerDisconnected", p);
                } catch (Throwable ignored) {}
            }
        };
    }

    private JSONObject createPaymentIntentOnServer(
            long amountMinor, String currency, String locationId,
            String channel, String closedCheckId) throws Exception {
        if (authToken == null) throw new IllegalStateException("No auth token");
        JSONObject body = new JSONObject();
        body.put("location_id", locationId);
        body.put("amount_minor", amountMinor);
        body.put("currency", currency);
        body.put("channel", channel);
        JSONArray pmTypes = new JSONArray();
        pmTypes.put("card_present");
        body.put("payment_method_types", pmTypes);
        body.put("capture_method", "automatic");
        if (closedCheckId != null && !closedCheckId.isEmpty()) {
            body.put("closed_check_id", closedCheckId);
        }
        return httpPostJson(PAYMENT_INTENT_URL, authToken, body);
    }

    private JSONObject httpPostJson(String url, String bearer, JSONObject body) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        try {
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(HTTP_TIMEOUT_MS);
            conn.setReadTimeout(HTTP_TIMEOUT_MS);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("Authorization", "Bearer " + bearer);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int code = conn.getResponseCode();
            InputStream stream = (code >= 200 && code <= 299) ? conn.getInputStream() : conn.getErrorStream();
            String text = "";
            if (stream != null) {
                StringBuilder sb = new StringBuilder();
                try (BufferedReader br = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = br.readLine()) != null) sb.append(line).append('\n');
                }
                text = sb.toString();
            }
            try {
                return new JSONObject(text);
            } catch (Throwable ignored) {
                JSONObject err = new JSONObject();
                String snippet = text.length() > 200 ? text.substring(0, 200) : text;
                err.put("error", "non-json response: " + snippet);
                return err;
            }
        } finally {
            conn.disconnect();
        }
    }

    private String[] missingPermissions() {
        List<String> needed = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            needed.add(android.Manifest.permission.BLUETOOTH_SCAN);
            needed.add(android.Manifest.permission.BLUETOOTH_CONNECT);
        } else {
            needed.add(android.Manifest.permission.ACCESS_FINE_LOCATION);
            needed.add(android.Manifest.permission.BLUETOOTH);
            needed.add(android.Manifest.permission.BLUETOOTH_ADMIN);
        }
        List<String> missing = new ArrayList<>();
        for (String perm : needed) {
            if (ActivityCompat.checkSelfPermission(activity, perm) != PackageManager.PERMISSION_GRANTED) {
                missing.add(perm);
            }
        }
        return missing.toArray(new String[0]);
    }

    private JSONObject readerToJson(Reader r) throws Exception {
        JSONObject obj = new JSONObject();
        obj.put("serialNumber", r.getSerialNumber() != null ? r.getSerialNumber() : "");
        obj.put("deviceType", r.getDeviceType() != null ? r.getDeviceType().name() : "");
        obj.put("locationId", r.getLocation() != null ? r.getLocation().getId() : "");
        obj.put("batteryLevel", r.getBatteryLevel() != null ? r.getBatteryLevel() : JSONObject.NULL);
        obj.put("label", r.getLabel() != null ? r.getLabel() : (r.getSerialNumber() != null ? r.getSerialNumber() : ""));
        obj.put("status", r.getNetworkStatus() != null ? r.getNetworkStatus().name() : "");
        return obj;
    }

    // ────────────────────────────────────────────────────────────────────────
    // JS dispatch
    // ────────────────────────────────────────────────────────────────────────

    private void postCallback(String callbackId, boolean ok, JSONObject payload) {
        try {
            JSONObject outer = new JSONObject();
            outer.put("ok", ok);
            outer.put("data", payload);
            String js = "window.dispatchPosTerminalCallback("
                + JSONObject.quote(callbackId) + "," + outer.toString() + ")";
            mainHandler.post(() -> webView.evaluateJavascript(js, null));
        } catch (Throwable e) {
            Log.e(TAG, "postCallback failed", e);
        }
    }

    private void postEvent(String name, JSONObject payload) {
        try {
            JSONObject outer = new JSONObject();
            outer.put("event", name);
            outer.put("data", payload);
            String js = "window.dispatchPosTerminalEvent(" + outer.toString() + ")";
            mainHandler.post(() -> webView.evaluateJavascript(js, null));
        } catch (Throwable e) {
            Log.e(TAG, "postEvent failed", e);
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // Error payload helpers
    // ────────────────────────────────────────────────────────────────────────

    private JSONObject errMsg(String message) {
        JSONObject p = new JSONObject();
        try { p.put("error", message); } catch (Throwable ignored) {}
        return p;
    }
    private JSONObject errCodeMsg(TerminalException e) {
        JSONObject p = new JSONObject();
        try {
            p.put("error", e.getErrorMessage());
            p.put("code", e.getErrorCode().name());
        } catch (Throwable ignored) {}
        return p;
    }
    private JSONObject stepErr(TerminalException e, String step) {
        JSONObject p = new JSONObject();
        try {
            p.put("error", e.getErrorMessage());
            p.put("code", e.getErrorCode().name());
            p.put("step", step);
        } catch (Throwable ignored) {}
        return p;
    }
    private JSONObject errPayload(Throwable e) {
        JSONObject p = new JSONObject();
        try { p.put("error", e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName()); }
        catch (Throwable ignored) {}
        return p;
    }
}
