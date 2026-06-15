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

/**
 * Serv OS MPOS — mobile point-of-sale for a phone.
 *
 * A WebView pointed at ?mode=mpos for tableside ordering. Unlike the menu board this is an
 * interactive app, so it keeps the system bars, lets the soft keyboard resize the view, and
 * allows in-app back navigation. Card payments are handled by the web surface (assigned
 * hardware reader, or simulated in a browser); there is no native payment SDK in this app.
 */
public class MainActivity extends Activity {
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

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView v, int code, String desc, String url) {
                v.postDelayed(() -> v.loadUrl(MPOS_URL), 5000);
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage msg) { return true; }
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
