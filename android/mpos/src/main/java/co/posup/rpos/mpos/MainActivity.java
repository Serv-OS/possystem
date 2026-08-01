package co.posup.rpos.mpos;

import android.app.Activity;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.net.http.SslError;
import android.webkit.SslErrorHandler;
import android.util.Log;
import android.os.Build;

/**
 * Serv OS MPOS — mobile point-of-sale for a phone.
 *
 * A WebView pointed at ?mode=mpos for tableside ordering. Unlike the menu board this is an
 * interactive app, so it keeps the system bars, lets the soft keyboard resize the view, and
 * allows in-app back navigation. Card payments are handled by the web surface (assigned
 * hardware reader, or simulated in a browser); there is no native payment SDK in this app.
 */
public class MainActivity extends Activity {
    private static final String TAG = "ServOSMPOS";
    // To point at a different environment (e.g. production), change this and rebuild.
    private static final String MPOS_URL = "https://dev.serv-os.app/?mode=mpos";
    private WebView webView;
    private UpdateChecker updateChecker;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // A POS terminal shouldn't dim/sleep mid-order.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);     // localStorage: pairing cache + Supabase session
        s.setDatabaseEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setDisplayZoomControls(false);
        s.setBuiltInZoomControls(false);
        s.setUserAgentString(
            "Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/120.0.0.0 Mobile Safari/537.36 ServOS-MPOS/1.0"
        );

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(webView, true);

        // v1.2 DIAGNOSTIC: a WebView failure used to retry silently every 5s, which
        // looks identical to a black screen. Surface the reason instead — on a PAX the
        // usual causes are an ancient system WebView (our SPA needs a modern engine),
        // no route to the host, or a TLS failure. Also stop swallowing JS console
        // errors, which is what hides a bundle that failed to parse.
        webView.setWebViewClient(new WebViewClient() {
            private void fail(WebView v, String what) {
                Log.e(TAG, "LOAD FAIL: " + what);
                final String ua = v.getSettings().getUserAgentString();
                String html = "<html><body style='background:#111;color:#eee;font:14px -apple-system,sans-serif;padding:18px'>"
                    + "<h2 style='color:#ff6b6b;margin:0 0 10px'>Could not load</h2>"
                    + "<p style='margin:0 0 14px'><b>" + what.replace("<","&lt;") + "</b></p>"
                    + "<p style='color:#9aa'>URL<br>" + MPOS_URL + "</p>"
                    + "<p style='color:#9aa'>Android " + Build.VERSION.RELEASE + " (SDK " + Build.VERSION.SDK_INT + ")<br>"
                    + Build.MANUFACTURER + " " + Build.MODEL + "</p>"
                    + "<p style='color:#9aa;word-break:break-all'>WebView UA<br>" + ua.replace("<","&lt;") + "</p>"
                    + "<p style='color:#666;margin-top:16px'>adb logcat -s ServOSMPOS  for detail</p>"
                    + "</body></html>";
                v.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
            }
            @Override public void onReceivedError(WebView v, int code, String desc, String url) {
                fail(v, "Network error " + code + ": " + desc);
            }
            @Override public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                if (req != null && req.isForMainFrame()) fail(v, "Network error " + err.getErrorCode() + ": " + err.getDescription());
            }
            @Override public void onReceivedHttpError(WebView v, WebResourceRequest req, WebResourceResponse res) {
                if (req != null && req.isForMainFrame()) fail(v, "HTTP " + res.getStatusCode() + " from server");
            }
            @Override public void onReceivedSslError(WebView v, SslErrorHandler h, SslError e) {
                h.cancel();
                fail(v, "TLS/certificate error (" + e.getPrimaryError() + ") — the terminal may not trust this certificate");
            }
            @Override public void onPageFinished(WebView v, String url) {
                Log.i(TAG, "page finished: " + url);
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage msg) {
                Log.e(TAG, "JS " + msg.messageLevel() + " line " + msg.lineNumber() + ": " + msg.message());
                return true;
            }
        });

        // v1.3-diag: boot into a SELF-CONTAINED local page. It needs no network and
        // no SPA bundle, so it isolates "can this terminal run our app at all?" from
        // "can its WebView run our React build?". Tap through to try the real URL.
        webView.addJavascriptInterface(new Object() {
            @android.webkit.JavascriptInterface
            public void loadReal() { runOnUiThread(() -> webView.loadUrl(MPOS_URL)); }
        }, "Probe");

        // v5.5.967 — Adyen local Terminal API transport for MPOS running ON an
        // Adyen Android terminal (S1E4 Pro / S1E2L). Harmless elsewhere: the web
        // seam feature-probes isAvailable() before showing any Adyen payment UI.
        webView.addJavascriptInterface(new AdyenNexoBridge(this, webView), "RposAdyenNexo");

        webView.loadDataWithBaseURL(null, bootProbeHtml(), "text/html", "utf-8", null);

        // Self-update: check shortly after launch (throttled, no-op when already current).
        updateChecker = new UpdateChecker(this);
        webView.postDelayed(() -> updateChecker.check(false), 8000);
    }

    /** Self-contained probe page: proves the WebView renders and reports the engine. */
    private String bootProbeHtml() {
        String ua = "unknown";
        try { ua = new WebView(this).getSettings().getUserAgentString(); } catch (Throwable ignored) {}
        String chrome = "not found";
        try {
            java.util.regex.Matcher m = java.util.regex.Pattern.compile("Chrome/(\\d+)").matcher(ua);
            if (m.find()) chrome = m.group(1);
        } catch (Throwable ignored) {}
        return "<html><head><meta name=viewport content='width=device-width,initial-scale=1'></head>"
            + "<body style=\"margin:0;background:#0d5c2f;color:#fff;font:15px -apple-system,Roboto,sans-serif;padding:18px\">"
            + "<h2 style='margin:0 0 6px'>&#10003; WebView is alive</h2>"
            + "<p style='margin:0 0 16px;opacity:.85'>This page is built into the app &mdash; no network, no bundle.</p>"
            + "<div style='background:rgba(0,0,0,.25);border-radius:10px;padding:12px;line-height:1.7'>"
            + "<b>Device</b><br>" + Build.MANUFACTURER + " " + Build.MODEL + "<br>"
            + "Android " + Build.VERSION.RELEASE + " (SDK " + Build.VERSION.SDK_INT + ")<br><br>"
            + "<b>WebView engine</b><br>Chrome " + chrome + "<br><br>"
            + "<b>User agent</b><br><span style='font-size:11px;word-break:break-all;opacity:.8'>" + ua.replace("<","&lt;") + "</span>"
            + "</div>"
            + "<p style='margin:16px 0 8px;opacity:.85'>Chrome <b>&lt; 90</b> is likely too old for the ServOS bundle.</p>"
            + "<button onclick='Probe.loadReal()' style=\"width:100%;padding:16px;border:0;border-radius:10px;"
            + "background:#fff;color:#0d5c2f;font-size:16px;font-weight:700\">Now try loading ServOS &rarr;</button>"
            + "</body></html>";
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        if (updateChecker != null) updateChecker.check(false);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) webView.onPause();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (updateChecker != null) updateChecker.destroy();
        if (webView != null) webView.destroy();
    }
}
