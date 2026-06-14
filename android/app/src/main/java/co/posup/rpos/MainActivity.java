package co.posup.rpos;

import android.app.Activity;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.content.Context;
import android.hardware.display.DisplayManager;
import android.view.Display;
import android.webkit.*;
import co.posup.rpos.printer.PrinterBridge;

public class MainActivity extends Activity {
    private static final String POS_URL = "https://possystem-liard.vercel.app/?mode=pos";
    // Digital menu board (Fire TV / Android-TV flavor). Boots straight to the board;
    // it shows a pairing code until assigned a menu in Back Office.
    private static final String MENUBOARD_URL = "https://dev.serv-os.app/?mode=menuboard";
    private WebView webView;
    private PrinterBridge printerBridge;
    private UpdateChecker updateChecker;
    private DisplayManager displayManager;
    private CustomerDisplayPresentation customerPresentation;
    private DisplayManager.DisplayListener displayListener;
    private boolean displayDiagShown = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Menu-board flavor (Fire TV): a thin display-only WebView. None of the POS
        // machinery below (printer bridge, Sunmi rear screen, self-updater) applies.
        if ("menuboard".equals(BuildConfig.SURFACE)) {
            setupMenuBoard();
            return;
        }

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

        // Wire native bridges — exposes to React app on window.RposPrinter
        // (Stripe Terminal SDK removed in v5.5.58 — payments are pure REST against the WisePOS E.)
        printerBridge = new PrinterBridge(webView);
        webView.addJavascriptInterface(printerBridge, "RposPrinter");

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

        // v1.3: self-update for the sideloaded APK. Check shortly after boot so the
        // POS UI loads first; UpdateChecker throttles itself and is a no-op when current.
        updateChecker = new UpdateChecker(this);
        webView.postDelayed(() -> updateChecker.check(false), 8000);

        // v1.4: mirror the customer-facing display onto the Sunmi rear/second screen.
        setupCustomerDisplay();
    }

    // ── Menu board (Fire TV / Android-TV) ───────────────────────────────────
    // Display-only WebView pointed at ?mode=menuboard. No printer bridge, no
    // second screen, no self-updater — just a screen that stays on and shows the
    // assigned menu (or a pairing code until one is assigned).
    private void setupMenuBoard() {
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_FULLSCREEN |
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY |
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
        );

        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);     // localStorage: pairing cache + Supabase anon session
        s.setDatabaseEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMediaPlaybackRequiresUserGesture(false);  // marketing video autoplay
        s.setAllowFileAccess(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setDisplayZoomControls(false);
        s.setBuiltInZoomControls(false);
        s.setUserAgentString(
            "Mozilla/5.0 (Linux; Android 11; AFT) AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/120.0.0.0 Safari/537.36 ServOS-MenuBoard/1.0"
        );

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(webView, true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView v, int code, String desc, String url) {
                // Signage must self-heal: reload after a network blip.
                v.postDelayed(() -> v.loadUrl(MENUBOARD_URL), 5000);
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage msg) { return true; }
        });

        webView.loadUrl(MENUBOARD_URL);
    }

    // ── Customer-facing second screen (Sunmi rear display) ──────────────────
    private void setupCustomerDisplay() {
        displayManager = (DisplayManager) getSystemService(Context.DISPLAY_SERVICE);
        if (displayManager == null) return;
        showCustomerPresentation();
        webView.postDelayed(this::showDisplayDiagnostic, 2500); // v1.6 diagnostic
        displayListener = new DisplayManager.DisplayListener() {
            @Override public void onDisplayAdded(int displayId)   { showCustomerPresentation(); }
            @Override public void onDisplayRemoved(int displayId) { dismissCustomerPresentation(); }
            @Override public void onDisplayChanged(int displayId) {}
        };
        displayManager.registerDisplayListener(displayListener, null);
    }

    /** Find the customer-facing screen: prefer the PRESENTATION category, else any non-default display. */
    private Display findSecondaryDisplay() {
        Display[] pres = displayManager.getDisplays(DisplayManager.DISPLAY_CATEGORY_PRESENTATION);
        if (pres != null && pres.length > 0) return pres[0];
        Display[] all = displayManager.getDisplays();
        if (all != null) {
            for (Display d : all) {
                if (d.getDisplayId() != Display.DEFAULT_DISPLAY) return d;
            }
        }
        return null;
    }

    private void showCustomerPresentation() {
        if (displayManager == null) return;
        if (customerPresentation != null && customerPresentation.isShowing()) return;
        Display target = findSecondaryDisplay();
        if (target == null) {
            if (!displayDiagShown) {
                displayDiagShown = true;
                Display[] all = displayManager.getDisplays();
                toast("Customer display: NO 2nd screen found (" + (all == null ? 0 : all.length) + " display(s) total)");
            }
            return;
        }
        try {
            customerPresentation = new CustomerDisplayPresentation(this, target);
            customerPresentation.show();
            toast("Customer display: showing on screen #" + target.getDisplayId());
        } catch (Exception e) {
            customerPresentation = null;
            toast("Customer display error: " + e.getMessage());
        }
    }

    private void toast(String m) {
        try { android.widget.Toast.makeText(this, m, android.widget.Toast.LENGTH_LONG).show(); } catch (Exception ignored) {}
    }

    /** v1.6: unmissable diagnostic — lists every display the device exposes. */
    private void showDisplayDiagnostic() {
        try {
            StringBuilder sb = new StringBuilder();
            sb.append("Device: ").append(android.os.Build.MODEL).append("\n\n");
            Display[] all = displayManager.getDisplays();
            sb.append("Total displays: ").append(all == null ? 0 : all.length).append("\n");
            if (all != null) {
                for (Display d : all) {
                    sb.append("  #").append(d.getDisplayId()).append("  ").append(d.getName())
                      .append(d.getDisplayId() == Display.DEFAULT_DISPLAY ? "  [MAIN]" : "  [2nd]").append("\n");
                }
            }
            Display[] pres = displayManager.getDisplays(DisplayManager.DISPLAY_CATEGORY_PRESENTATION);
            sb.append("\nPresentation-capable: ").append(pres == null ? 0 : pres.length).append("\n");
            sb.append("Our display showing: ")
              .append(customerPresentation != null && customerPresentation.isShowing() ? "YES" : "no");
            new android.app.AlertDialog.Builder(this)
                .setTitle("Serv OS · display check (v1.6)")
                .setMessage(sb.toString())
                .setPositiveButton("OK", null)
                .show();
        } catch (Exception ignored) {}
    }

    private void dismissCustomerPresentation() {
        if (customerPresentation != null) {
            try { customerPresentation.destroyWeb(); customerPresentation.dismiss(); } catch (Exception ignored) {}
            customerPresentation = null;
        }
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
        // Catch updates on long-running devices too (throttled to every few hours).
        if (updateChecker != null) updateChecker.check(false);
        // Re-attach the customer display if it was dismissed / the screen reconnected.
        showCustomerPresentation();
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
        if (displayManager != null && displayListener != null) {
            try { displayManager.unregisterDisplayListener(displayListener); } catch (Exception ignored) {}
        }
        dismissCustomerPresentation();
        if (updateChecker != null) updateChecker.destroy();
        if (printerBridge != null) printerBridge.destroy();
        if (webView != null) webView.destroy();
    }
}
