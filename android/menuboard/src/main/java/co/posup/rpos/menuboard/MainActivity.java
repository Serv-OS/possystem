package co.posup.rpos.menuboard;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/**
 * Serv OS Menu, the digital menu board for a TV / Fire TV stick.
 *
 * A display only WebView pointed at ?mode=menuboard. It boots straight to the board, keeps the
 * screen awake, runs fullscreen, and self heals after a network blip. Everything else (which menu
 * shows, layout, pairing, live updates) is the web app; this wrapper just hosts it on the TV.
 *
 * 1.2 (8 Nov 2026), "the menu boards keep quitting, they close down and dont re open": the page's
 * Chrome process is the first thing a 1 GB stick kills when memory runs short, and an app that does
 * not handle that is closed to the Fire TV home screen. Now the dead page is replaced in place
 * (onRenderProcessGone), the renderer is marked as important as the app while it is on screen, an
 * app crash relaunches the board (StayOn), and the board opens when the stick starts (BootReceiver).
 */
public class MainActivity extends Activity {
    private static final String TAG = "ServOSMenu";
    // To point at a different environment (e.g. production), change this and rebuild.
    private static final String MENUBOARD_URL = "https://dev.serv-os.app/?mode=menuboard";
    private FrameLayout root;
    private WebView webView;
    private UpdateChecker updateChecker;
    private final Handler ui = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        StayOn.install(this);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        applyImmersive();

        root = new FrameLayout(this);
        setContentView(root);
        mountWebView();

        // Self-update: check shortly after launch (throttled, no-op when already current).
        updateChecker = new UpdateChecker(this);
        ui.postDelayed(() -> { if (updateChecker != null) updateChecker.check(false); }, 8000);
    }

    /** Put a fresh page on the screen. Called at start and again after the renderer dies. */
    private void mountWebView() {
        if (isFinishing() || isDestroyed() || webView != null) return;
        webView = buildWebView();
        root.addView(webView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        webView.loadUrl(MENUBOARD_URL);
    }

    private WebView buildWebView() {
        final WebView v = new WebView(this);

        WebSettings s = v.getSettings();
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
            "Chrome/120.0.0.0 Safari/537.36 ServOS-MenuBoard/1.2"
        );

        // The page's renderer matters as much as the app while the board is on screen. Left at
        // the default, it is the first process Fire OS kills when memory runs short.
        v.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(v, true);

        v.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, int code, String desc, String url) {
                view.postDelayed(() -> view.loadUrl(MENUBOARD_URL), 5000);
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // The page's Chrome process was killed (out of memory) or crashed. Without this
                // method Android closes the whole app to the Fire TV home screen and nothing brings
                // it back. Drop the dead view and put a fresh one in its place, with a short wait
                // that grows if it keeps happening (StayOn).
                boolean crashed = detail != null && detail.didCrash();
                Log.w(TAG, "renderer gone (" + (crashed ? "crashed" : "killed by the system") + "), reloading the board");
                if (view == webView) webView = null;
                try { root.removeView(view); } catch (Exception ignored) { /* already gone */ }
                try { view.destroy(); } catch (Exception ignored) { /* already gone */ }
                long delay = StayOn.rendererGoneDelay(MainActivity.this, crashed);
                ui.postDelayed(MainActivity.this::mountWebView, delay);
                return true;   // handled: the app stays up
            }
        });
        v.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage msg) { return true; }
        });
        return v;
    }

    private void applyImmersive() {
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_FULLSCREEN |
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY |
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
        );
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        applyImmersive();
        if (updateChecker != null) updateChecker.check(false);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) webView.onPause();
    }

    @Override
    public void onBackPressed() {
        // A menu board has nowhere to go "back" to: don't let the remote exit it.
        if (webView != null && webView.canGoBack()) webView.goBack();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        ui.removeCallbacksAndMessages(null);
        if (updateChecker != null) updateChecker.destroy();
        if (webView != null) { webView.destroy(); webView = null; }
    }
}
