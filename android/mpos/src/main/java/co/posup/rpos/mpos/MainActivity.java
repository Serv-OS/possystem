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

        webView.loadUrl(MPOS_URL);

        // Self-update: check shortly after launch (throttled, no-op when already current).
        updateChecker = new UpdateChecker(this);
        webView.postDelayed(() -> updateChecker.check(false), 8000);
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
