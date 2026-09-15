package co.posup.rpos.webshell;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * The Serv OS device app screen, shared by KDS, Kiosk, Owner, Manager, Staff, Time Clock, Waitlist
 * and the Bookings host stand (see webshell/build.gradle for the per app settings).
 *
 * Parity with the iOS shell (ios/ServOSPOS/WebView.swift):
 *   window.RposAndroid  { platform: 'android', version, hasLocation } so the web app can tell it is
 *                       inside the native app (the staff clock card only shows in the app).
 *   window.RposLocation.get() -> Promise<{ lat, lng, accuracy, age_ms, mocked }> for the staff
 *                       geofenced clock in, on the Staff app only (ShellLocationBridge).
 *   "RposAndroid/<version>" on the user agent as a second detection seam.
 * The camera is never granted (no app here scans; POS keeps its own module). File inputs work, so
 * staff can upload documents.
 */
public class ShellActivity extends Activity {
    private static final String TAG = "ServOSShell";
    private static final int FILE_CHOOSER_REQUEST = 4101;

    private WebView webView;
    private ShellUpdateChecker updateChecker;
    private ShellLocationBridge locationBridge;
    private ValueCallback<Uri[]> fileCallback;
    private String appUrl;
    private boolean immersive;
    private boolean lockBack;
    private boolean allowsLocation;
    private String versionName = "1.0";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        appUrl = getString(R.string.shell_app_url);
        immersive = getResources().getBoolean(R.bool.shell_immersive);
        lockBack = getResources().getBoolean(R.bool.shell_lock_back);
        allowsLocation = getResources().getBoolean(R.bool.shell_allows_location);
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            if (pi.versionName != null) versionName = pi.versionName;
        } catch (Exception ignored) {}

        if (getResources().getBoolean(R.bool.shell_keep_screen_on)) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#0F1211"));
        setContentView(webView);
        if (immersive) hideSystemBars();

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // localStorage: pairing and the signed in session
        s.setDatabaseEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMediaPlaybackRequiresUserGesture(false);   // order chimes, attract videos
        s.setAllowFileAccess(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setDisplayZoomControls(false);
        s.setBuiltInZoomControls(false);
        s.setUserAgentString(s.getUserAgentString() + " RposAndroid/" + versionName
            + " ServOS-" + getString(R.string.shell_channel));

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(webView, true);

        // Native markers. A Java object is on window before the page's own scripts run.
        webView.addJavascriptInterface(new ShellMarker(), "RposAndroid");
        if (allowsLocation) {
            locationBridge = new ShellLocationBridge(this, webView);
            webView.addJavascriptInterface(locationBridge, "RposAndroidLocation");
        }

        webView.setWebViewClient(new WebViewClient() {
            @Override public void onPageStarted(WebView v, String url, android.graphics.Bitmap icon) {
                injectBridges(v);
            }
            @Override public void onPageFinished(WebView v, String url) {
                injectBridges(v);
            }
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                // Frames (the bookings widget preview) load in place; only a whole page leaving our
                // site is sent outside.
                if (!req.isForMainFrame() || isOwnHost(u)) return false;
                // Anything else (tel:, mailto:, a payment provider page, a link to a map) opens
                // outside the app so the app never becomes a general browser.
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) {}
                return true;
            }
            @Override public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                if (req != null && req.isForMainFrame()) showError(v, "No connection (" + err.getDescription() + ")");
            }
            @Override public void onReceivedHttpError(WebView v, WebResourceRequest req, WebResourceResponse res) {
                if (req != null && req.isForMainFrame() && res.getStatusCode() >= 500) showError(v, "The server answered " + res.getStatusCode());
            }
            @Override public void onReceivedSslError(WebView v, SslErrorHandler h, SslError e) {
                h.cancel();
                showError(v, "Secure connection failed (certificate error " + e.getPrimaryError() + "). Check the date and time on this device.");
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage msg) {
                if (msg.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                    Log.e(TAG, "JS line " + msg.lineNumber() + ": " + msg.message());
                }
                return true;
            }
            @Override public void onPermissionRequest(PermissionRequest request) {
                // No app on this shell uses the camera or microphone.
                request.deny();
            }
            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    Intent i = params.createIntent();
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    startActivityForResult(i, FILE_CHOOSER_REQUEST);
                    return true;
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
            }
        });

        webView.loadUrl(appUrl);

        // Self-update: check shortly after launch (throttled, no-op when already current).
        updateChecker = new ShellUpdateChecker(this, getString(R.string.shell_channel), getString(R.string.app_name));
        webView.postDelayed(() -> updateChecker.check(false), 8000);
    }

    /** window.RposAndroid, the native marker the web app checks (ClockCard.jsx inNativeApp). */
    private class ShellMarker {
        @JavascriptInterface public String platform() { return "android"; }
        @JavascriptInterface public String version() { return versionName; }
        @JavascriptInterface public boolean hasLocation() { return allowsLocation; }
        @JavascriptInterface public void reload() { runOnUiThread(() -> webView.loadUrl(appUrl)); }
    }

    /**
     * window.RposLocation.get(): the same promise shape as the iOS shell, built on the
     * RposAndroidLocation Java object. Safe to run more than once per page (it keeps the first).
     */
    private void injectBridges(WebView v) {
        if (!allowsLocation) return;
        String js = "(function(){if(window.RposLocation&&window.RposLocation.__android)return;"
            + "var seq=0,waiting={};"
            + "window.__rposLocationCallback=function(id,ok,json){var w=waiting[id];if(!w)return;delete waiting[id];"
            + "var d;try{d=JSON.parse(json);}catch(e){d={};}if(ok){w.resolve(d);}else{w.reject(new Error(d.error||'unavailable'));}};"
            + "window.RposLocation={__android:true,get:function(){return new Promise(function(resolve,reject){"
            + "var id='loc'+(++seq);waiting[id]={resolve:resolve,reject:reject};"
            + "try{window.RposAndroidLocation.request(id);}catch(e){delete waiting[id];reject(new Error('unavailable'));}"
            + "setTimeout(function(){if(waiting[id]){delete waiting[id];reject(new Error('timeout'));}},15000);});}};})();";
        v.evaluateJavascript(js, null);
    }

    private boolean isOwnHost(Uri u) {
        if (u == null || u.getHost() == null) return false;
        Uri own = Uri.parse(appUrl);
        return u.getHost().equalsIgnoreCase(own.getHost());
    }

    private void showError(WebView v, String what) {
        Log.e(TAG, "LOAD FAIL: " + what);
        String safe = what.replace("&", "&amp;").replace("<", "&lt;");
        String html = "<html><head><meta name=viewport content='width=device-width,initial-scale=1'></head>"
            + "<body style=\"margin:0;background:#0F1211;color:#F2F4F3;font:18px -apple-system,Roboto,sans-serif;"
            + "display:flex;align-items:center;justify-content:center;min-height:100vh\">"
            + "<div style='max-width:520px;padding:28px;text-align:center'>"
            + "<div style='font-size:28px;font-weight:800;margin-bottom:12px'>Can't reach Serv OS</div>"
            + "<div style='opacity:.8;line-height:1.5;margin-bottom:24px'>" + safe + "</div>"
            + "<button onclick='RposAndroid.reload()' style=\"font-size:20px;font-weight:800;padding:18px 36px;"
            + "border:0;border-radius:14px;background:#15C26A;color:#0F1211\">Try again</button>"
            + "<div style='opacity:.5;font-size:14px;margin-top:22px'>It also tries again by itself in 15 seconds.</div>"
            + "</div></body></html>";
        v.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
        v.postDelayed(() -> {
            // Only retry from the error page, never over a page that has since loaded.
            String cur = v.getUrl();
            if (cur == null || cur.startsWith("about:") || cur.startsWith("data:")) v.loadUrl(appUrl);
        }, 15000);
    }

    private void hideSystemBars() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && immersive) hideSystemBars();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_REQUEST && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (locationBridge != null) locationBridge.onPermissionResult(requestCode, grantResults);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        if (immersive) hideSystemBars();
        if (updateChecker != null) updateChecker.check(false);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) webView.onPause();
    }

    @Override
    public void onBackPressed() {
        if (lockBack) return;   // kiosk: a customer must not be able to leave the ordering screen
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (updateChecker != null) updateChecker.destroy();
        if (locationBridge != null) locationBridge.destroy();
        if (webView != null) webView.destroy();
    }
}
