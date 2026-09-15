package co.posup.rpos.webshell;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

/**
 * Native location for the geofenced staff clock in (Staff app only), the Android twin of
 * ios/ServOSPOS/LocationBridge.swift:
 *   web  -> window.RposAndroidLocation.request(id)
 *   back -> window.__rposLocationCallback(id, ok, jsonString)
 * JSON on success: { lat, lng, accuracy, age_ms, mocked }. On failure: { error } where error is
 * one of denied | unavailable | timeout | off.
 *
 * mocked is Android's isFromMockProvider / isMock. The server treats mocked:true as NO reading
 * (staff-portal judgeFence), so a fake GPS app cannot clock anyone in. The server is the only judge;
 * this class only collects a reading.
 */
public class ShellLocationBridge {
    static final int PERMISSION_REQUEST = 4102;
    private static final long TIMEOUT_MS = 10000;

    private final Activity activity;
    private final WebView webView;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<String> pending = new ArrayList<>();
    private LocationListener listener;
    private Runnable timeout;

    ShellLocationBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
    }

    @JavascriptInterface
    public void request(String id) {
        main.post(() -> start(id == null ? "" : id));
    }

    private void start(String id) {
        LocationManager lm = (LocationManager) activity.getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) { reply(id, false, error("unavailable")); return; }
        boolean on = lm.isProviderEnabled(LocationManager.GPS_PROVIDER) || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        if (!on) { reply(id, false, error("off")); return; }
        pending.add(id);
        if (!hasPermission()) {
            activity.requestPermissions(new String[] {
                Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION
            }, PERMISSION_REQUEST);
            return;
        }
        startFix(lm);
    }

    private boolean hasPermission() {
        return activity.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || activity.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    void onPermissionResult(int requestCode, int[] grantResults) {
        if (requestCode != PERMISSION_REQUEST || pending.isEmpty()) return;
        if (hasPermission()) {
            LocationManager lm = (LocationManager) activity.getSystemService(Context.LOCATION_SERVICE);
            if (lm != null) { startFix(lm); return; }
        }
        flush(false, error("denied"));
    }

    @SuppressWarnings("MissingPermission")
    private void startFix(LocationManager lm) {
        if (listener != null) return;   // a fix is already on its way; it answers every request
        String provider = lm.isProviderEnabled(LocationManager.GPS_PROVIDER)
            ? LocationManager.GPS_PROVIDER : LocationManager.NETWORK_PROVIDER;
        listener = new LocationListener() {
            @Override public void onLocationChanged(Location loc) { answer(loc); }
            @Override public void onProviderDisabled(String p) {}
            @Override public void onProviderEnabled(String p) {}
            @Override public void onStatusChanged(String p, int status, Bundle extras) {}
        };
        try {
            lm.requestLocationUpdates(provider, 0L, 0f, listener, Looper.getMainLooper());
        } catch (Exception e) {
            stopUpdates();
            flush(false, error("unavailable"));
            return;
        }
        timeout = () -> { stopUpdates(); flush(false, error("timeout")); };
        main.postDelayed(timeout, TIMEOUT_MS);
    }

    private void answer(Location loc) {
        stopUpdates();
        if (loc == null) { flush(false, error("unavailable")); return; }
        try {
            JSONObject o = new JSONObject();
            o.put("lat", loc.getLatitude());
            o.put("lng", loc.getLongitude());
            o.put("accuracy", Math.max(0, loc.getAccuracy()));
            long ageMs = Math.max(0, (SystemClock.elapsedRealtimeNanos() - loc.getElapsedRealtimeNanos()) / 1000000L);
            o.put("age_ms", ageMs);
            boolean mocked = Build.VERSION.SDK_INT >= 31 ? loc.isMock() : loc.isFromMockProvider();
            o.put("mocked", mocked);
            flush(true, o.toString());
        } catch (Exception e) {
            flush(false, error("unavailable"));
        }
    }

    private void stopUpdates() {
        if (timeout != null) { main.removeCallbacks(timeout); timeout = null; }
        if (listener != null) {
            try {
                LocationManager lm = (LocationManager) activity.getSystemService(Context.LOCATION_SERVICE);
                if (lm != null) lm.removeUpdates(listener);
            } catch (Exception ignored) {}
            listener = null;
        }
    }

    private void flush(boolean ok, String json) {
        List<String> ids = new ArrayList<>(pending);
        pending.clear();
        for (String id : ids) reply(id, ok, json);
    }

    private static String error(String code) {
        return "{\"error\":\"" + code + "\"}";
    }

    private void reply(String id, boolean ok, String json) {
        String safeId = id.replace("\\", "\\\\").replace("'", "\\'");
        String safeJson = json.replace("\\", "\\\\").replace("'", "\\'");
        String js = "window.__rposLocationCallback && window.__rposLocationCallback('" + safeId + "', " + ok + ", '" + safeJson + "');";
        main.post(() -> webView.evaluateJavascript(js, null));
    }

    void destroy() {
        stopUpdates();
        pending.clear();
    }
}
