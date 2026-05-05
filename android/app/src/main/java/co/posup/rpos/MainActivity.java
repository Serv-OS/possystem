package co.posup.rpos;

import android.app.Activity;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.*;
import co.posup.rpos.payments.StripeTerminalBridge;
import co.posup.rpos.printer.PrinterBridge;

public class MainActivity extends Activity {
    private static final String POS_URL = "https://possystem-liard.vercel.app/?mode=pos";
    private WebView webView;
    private PrinterBridge printerBridge;
    private StripeTerminalBridge stripeTerminalBridge;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Keep screen on permanently — POS terminal must never sleep
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Full immersive mode
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_FULLSCREEN |
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY |
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
        );

        webView = new WebView(this);
        setContentView(webView);

        // Wire native bridges — exposes to React app on window.RposPrinter and window.RposStripeTerminal
        printerBridge = new PrinterBridge(webView);
        webView.addJavascriptInterface(printerBridge, "RposPrinter");

        stripeTerminalBridge = new StripeTerminalBridge(this, webView);
        webView.addJavascriptInterface(stripeTerminalBridge, "RposStripeTerminal");

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setDisplayZoomControls(false);
        s.setBuiltInZoomControls(false);
        // Sunmi device user agent so the app knows it's on hardware
        s.setUserAgentString(
            "Mozilla/5.0 (Linux; Android 11; Sunmi) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/120.0.0.0 Mobile Safari/537.36 RestaurantOS/1.0 Sunmi/1.0"
        );

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(webView, true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                String url = r.getUrl().toString();
                // Only allow our app domain + Supabase
                return !url.startsWith("https://possystem-liard.vercel.app") &&
                       !url.startsWith("https://tbetcegmszzotrwdtqhi.supabase.co");
            }

            @Override
            public void onReceivedError(WebView v, int code, String desc, String url) {
                // Auto-reload on network error after 5 seconds
                v.postDelayed(() -> v.loadUrl(POS_URL), 5000);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage msg) {
                return true; // suppress console logs in release
            }
        });

        webView.loadUrl(POS_URL);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        }
        // Intentionally do not call super — back button cannot exit the POS
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
        // Re-apply immersive mode on resume (system UI may have re-appeared)
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_FULLSCREEN |
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY |
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
        );
    }

    @Override
    protected void onPause() {
        super.onPause();
        webView.onPause();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (printerBridge != null) printerBridge.destroy();
        if (webView != null) webView.destroy();
    }
}
