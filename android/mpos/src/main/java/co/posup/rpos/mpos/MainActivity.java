package co.posup.rpos.mpos;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

/**
 * Serv OS MPOS — mobile point-of-sale for a phone.
 *
 * A WebView pointed at ?mode=mpos for tableside ordering, plus a native Tap to Pay bridge
 * (window.RposTapToPay) so the web checkout can take contactless card payments through the
 * Stripe Terminal SDK — which cannot run inside a WebView. The bridge is wired here exactly
 * like the POS app wires its printer bridge.
 */
public class MainActivity extends Activity {
    // To point at a different environment, change this and rebuild.
    private static final String MPOS_URL = "https://dev.serv-os.app/?mode=mpos";
    private static final int REQ_LOCATION = 1001;

    private WebView webView;
    private TapToPayBridge tapBridge;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // A POS terminal shouldn't dim/sleep mid-order.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Tap to Pay needs location granted before the reader can connect; ask up front.
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this,
                    new String[]{Manifest.permission.ACCESS_FINE_LOCATION}, REQ_LOCATION);
        }

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

        // Expose the Tap to Pay bridge to the web POS as window.RposTapToPay.
        tapBridge = new TapToPayBridge(this, webView);
        webView.addJavascriptInterface(tapBridge, "RposTapToPay");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView v, int code, String desc, String url) {
                v.postDelayed(() -> v.loadUrl(MPOS_URL), 5000);
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage msg) { return true; }
            @Override public void onPermissionRequest(PermissionRequest req) { req.grant(req.getResources()); }
        });

        webView.loadUrl(MPOS_URL);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
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
        if (webView != null) webView.destroy();
    }
}
