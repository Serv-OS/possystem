package co.posup.rpos;

import android.app.Presentation;
import android.content.Context;
import android.os.Bundle;
import android.view.Display;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * v1.4: renders the customer-facing display surface on the Sunmi rear/second screen.
 *
 * Standard Android Presentation on the secondary display, hosting a WebView that
 * loads ?mode=customer-display. Because both WebViews live in the same app, they
 * share cookies + localStorage, so the rear screen reads the same paired device id
 * as the POS and mirrors that till's broadcast automatically (no ?till needed).
 */
public class CustomerDisplayPresentation extends Presentation {
    private static final String DISPLAY_URL =
        "https://possystem-liard.vercel.app/?mode=customer-display";
    private WebView webView;

    public CustomerDisplayPresentation(Context outerContext, Display display) {
        super(outerContext, display);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(getContext());
        setContentView(webView, new ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);   // shares localStorage with the POS WebView (same app)
        s.setDatabaseEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView v, int code, String desc, String url) {
                // Auto-retry on transient network errors.
                v.postDelayed(() -> v.loadUrl(DISPLAY_URL), 5000);
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage msg) { return true; }
        });

        webView.loadUrl(DISPLAY_URL);
    }

    /** Release the WebView when the presentation goes away. */
    public void destroyWeb() {
        if (webView != null) {
            try { webView.destroy(); } catch (Exception ignored) {}
            webView = null;
        }
    }
}
