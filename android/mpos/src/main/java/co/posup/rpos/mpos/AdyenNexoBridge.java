package co.posup.rpos.mpos;

import android.app.Activity;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.cert.X509Certificate;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * AdyenNexoBridge — exposes window.RposAdyenNexo to the MPOS web app when it runs
 * ON an Adyen Android terminal (S1E4 Pro / S1E2L). Mirrors BiometricBridge/PrinterBridge.
 *
 * WHY: on-terminal apps talk to the payment core over the LOCAL Terminal API at
 * https://127.0.0.1:8443/nexo (nexo 3.0 JSON). The WEB APP CANNOT call that URL
 * itself (self-signed cert + mixed-content rules in the WebView), so this bridge
 * is the transport. The MONEY CONTRACT stays server-side, same as PaxPay:
 * the web seam (src/lib/payments/adyenLocalTerminal.js) fetches the server-built
 * PaymentRequest from adyen-terminal-charge 'prepare_local' (amount = the DB's,
 * never the device's), posts it here, and returns the terminal's PaymentResponse
 * to 'report_local' where the server verifies and settles. This class never
 * builds or amends a payment message.
 *
 * Native → web callback: window.__rposAdyenNexoCallback(id, ok, payloadJson).
 *
 * TLS: the terminal's local endpoint presents Adyen's self-signed terminal cert.
 * Trust here is scoped to HOST 127.0.0.1 ONLY — never a global trust-all.
 * TODO(go-live): pin the Adyen terminal certificate (downloadable from CA) and
 * implement nexo local-protection message encryption — LIVE terminals refuse
 * plaintext ("A live terminal will not accept API requests without encryption");
 * TEST terminals accept it, which is what unblocks next week's bench work.
 */
public class AdyenNexoBridge {

    private static final String TAG = "AdyenNexoBridge";
    private static final String NEXO_URL = "https://127.0.0.1:8443/nexo";
    // Local payments expire after 120s; give the connection a little headroom.
    private static final int READ_TIMEOUT_MS = 150_000;
    private static final int CONNECT_TIMEOUT_MS = 5_000;

    private final Activity activity;
    private final WebView webView;

    public AdyenNexoBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
    }

    /** Feature probe: the web seam shows Adyen local payment UI only when true. */
    @JavascriptInterface
    public boolean isAvailable() {
        return true; // presence of the bridge == running inside this wrapper
    }

    /**
     * POST a server-built nexo message to the terminal's local endpoint.
     * requestJson is passed through VERBATIM — no inspection, no mutation.
     */
    @JavascriptInterface
    public void postNexo(final String requestId, final String requestJson) {
        new Thread(() -> {
            try {
                HttpsURLConnection conn = (HttpsURLConnection) new java.net.URL(NEXO_URL).openConnection();
                applyLocalhostTrust(conn);
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
                conn.setReadTimeout(READ_TIMEOUT_MS);
                conn.setDoOutput(true);
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(requestJson.getBytes(StandardCharsets.UTF_8));
                }
                int code = conn.getResponseCode();
                InputStream is = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
                StringBuilder sb = new StringBuilder();
                if (is != null) {
                    try (BufferedReader r = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
                        String line;
                        while ((line = r.readLine()) != null) sb.append(line);
                    }
                }
                if (code >= 200 && code < 300) {
                    deliver(requestId, true, sb.toString());
                } else {
                    deliver(requestId, false, errorJson("http_" + code, sb.toString()));
                }
            } catch (java.net.SocketTimeoutException e) {
                // Outcome UNKNOWABLE — the web seam must route to the server's
                // 'result' recovery, never assume declined.
                deliver(requestId, false, errorJson("timeout", e.getMessage()));
            } catch (Exception e) {
                Log.e(TAG, "postNexo failed", e);
                deliver(requestId, false, errorJson("transport", e.getMessage()));
            }
        }, "adyen-nexo").start();
    }

    private void deliver(String id, boolean ok, String payloadJson) {
        String payload = payloadJson == null ? "null" : payloadJson;
        // JSON.stringify-equivalent escaping for the payload-as-string argument.
        String js = "window.__rposAdyenNexoCallback && window.__rposAdyenNexoCallback("
                + JSONObject.quote(id) + "," + ok + "," + JSONObject.quote(payload) + ")";
        webView.post(() -> webView.evaluateJavascript(js, null));
    }

    private static String errorJson(String code, String message) {
        try {
            JSONObject o = new JSONObject();
            o.put("error", code);
            o.put("message", message == null ? "" : message);
            return o.toString();
        } catch (Exception e) { return "{\"error\":\"" + code + "\"}"; }
    }

    /**
     * Trust the terminal's self-signed cert for 127.0.0.1 ONLY. The connection
     * never leaves the device; a MITM would have to be resident on the terminal
     * itself. Still: TODO(go-live) replace with Adyen certificate pinning.
     */
    private static void applyLocalhostTrust(HttpsURLConnection conn) throws Exception {
        TrustManager[] localOnly = new TrustManager[]{ new X509TrustManager() {
            public void checkClientTrusted(X509Certificate[] chain, String authType) {}
            public void checkServerTrusted(X509Certificate[] chain, String authType) {}
            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        }};
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, localOnly, new java.security.SecureRandom());
        conn.setSSLSocketFactory(ctx.getSocketFactory());
        HostnameVerifier loopbackOnly = (hostname, session) ->
                "127.0.0.1".equals(hostname) || "localhost".equals(hostname);
        conn.setHostnameVerifier(loopbackOnly);
    }
}
