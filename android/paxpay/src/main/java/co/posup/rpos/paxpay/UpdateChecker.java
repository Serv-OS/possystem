package co.posup.rpos.paxpay;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;

import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * In-app auto-updater for the sideloaded PaxPay APK (no Play Store).
 *
 * Flow (auto-download + one-tap install):
 *   on launch / resume (throttled)
 *     -> fetch latest-paxpay.json from Supabase Storage
 *     -> if its versionCode > the installed versionCode
 *        -> download the new APK via DownloadManager (background, with a notification)
 *        -> launch the system package installer (the ONE tap the user makes is "Install")
 *
 * First run on a device needs a one-time "allow install from this source" grant
 * (Android 8+). After that it's auto-download -> one tap, every release.
 *
 * IMPORTANT: in-place install only succeeds when every build is signed with the SAME
 * key (see android/RELEASING.md). The PaxPay CI builds a fixed-key RELEASE APK for exactly
 * this reason.
 *
 * latest-paxpay.json shape (hosted at MANIFEST_URL):
 *   { "versionCode": 2, "versionName": "1.1",
 *     "apkUrl": "https://.../storage/v1/object/public/app-releases/paxpay.apk",
 *     "mandatory": false, "notes": "what changed" }
 */
public class UpdateChecker {
    private static final String MANIFEST_URL =
        "https://tbetcegmszzotrwdtqhi.supabase.co/storage/v1/object/public/app-releases/latest-paxpay.json";
    private static final long THROTTLE_MS = 3L * 60 * 60 * 1000; // re-check at most every 3h
    private static final String PREFS = "paxpay_update";
    private static final String APK_NAME = "paxpay-update.apk";

    private final Activity activity;
    private BroadcastReceiver receiver;
    private long downloadId = -1;
    private volatile boolean busy = false;

    public UpdateChecker(Activity activity) { this.activity = activity; }

    /** Kick off a background check. Throttled to once per THROTTLE_MS unless force=true. */
    public void check(boolean force) {
        if (busy) return;
        final SharedPreferences sp = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long now = System.currentTimeMillis();
        if (!force && now - sp.getLong("lastCheck", 0) < THROTTLE_MS) return;

        new Thread(() -> {
            try {
                JSONObject m = fetchManifest();
                if (m == null) return;
                sp.edit().putLong("lastCheck", System.currentTimeMillis()).apply();
                int remote = m.optInt("versionCode", -1);
                if (remote <= installedVersionCode()) return;
                final String apkUrl = m.optString("apkUrl", "");
                if (apkUrl.isEmpty()) return;
                final String vName = m.optString("versionName", "");
                final boolean mandatory = m.optBoolean("mandatory", false);
                runOnUi(() -> beginUpdate(apkUrl, vName, mandatory));
            } catch (Exception ignored) {
                // offline / bad JSON — silently try again next launch
            }
        }).start();
    }

    private JSONObject fetchManifest() throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(MANIFEST_URL).openConnection();
        c.setConnectTimeout(8000);
        c.setReadTimeout(8000);
        c.setRequestProperty("Cache-Control", "no-cache");
        try {
            if (c.getResponseCode() != 200) return null;
            StringBuilder sb = new StringBuilder();
            BufferedReader br = new BufferedReader(new InputStreamReader(c.getInputStream()));
            for (String line; (line = br.readLine()) != null; ) sb.append(line);
            br.close();
            return new JSONObject(sb.toString());
        } finally {
            c.disconnect();
        }
    }

    private int installedVersionCode() {
        try {
            return activity.getPackageManager()
                .getPackageInfo(activity.getPackageName(), 0).versionCode;
        } catch (Exception e) {
            return Integer.MAX_VALUE; // unknown -> never treat as "needs update"
        }
    }

    private void beginUpdate(String apkUrl, String vName, boolean mandatory) {
        // Android 8+: the app needs one-time "allow install unknown apps" permission.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !activity.getPackageManager().canRequestPackageInstalls()) {
            AlertDialog.Builder b = new AlertDialog.Builder(activity)
                .setTitle("Allow updates")
                .setMessage("To keep Serv OS PaxPay up to date automatically, allow it to install "
                          + "app updates. Tap Settings, turn on \"Allow from this source\", "
                          + "then return — the update will continue.")
                .setCancelable(!mandatory)
                .setPositiveButton("Settings", (d, w) -> {
                    try {
                        activity.startActivity(new Intent(
                            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            Uri.parse("package:" + activity.getPackageName())));
                    } catch (Exception ignored) {}
                });
            if (!mandatory) b.setNegativeButton("Later", null);
            b.show();
            return;
        }
        download(apkUrl, vName);
    }

    private void download(String apkUrl, String vName) {
        try {
            busy = true;
            File out = new File(activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), APK_NAME);
            if (out.exists()) //noinspection ResultOfMethodCallIgnored
                out.delete();

            final DownloadManager dm =
                (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(apkUrl));
            req.setTitle("Serv OS PaxPay update" + (vName.isEmpty() ? "" : " " + vName));
            req.setDescription("Downloading…");
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE);
            req.setDestinationInExternalFilesDir(activity, Environment.DIRECTORY_DOWNLOADS, APK_NAME);
            req.setMimeType("application/vnd.android.package-archive");

            if (receiver != null) {
                try { activity.unregisterReceiver(receiver); } catch (Exception ignored) {}
            }
            receiver = new BroadcastReceiver() {
                @Override public void onReceive(Context ctx, Intent intent) {
                    long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                    if (id != downloadId) return;
                    try { activity.unregisterReceiver(this); } catch (Exception ignored) {}
                    receiver = null;
                    busy = false;
                    if (downloadSucceeded(dm, id)) launchInstaller(out);
                }
            };
            ContextCompat.registerReceiver(activity, receiver,
                new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),
                ContextCompat.RECEIVER_EXPORTED);

            downloadId = dm.enqueue(req);
        } catch (Exception e) {
            busy = false;
        }
    }

    private boolean downloadSucceeded(DownloadManager dm, long id) {
        Cursor cur = null;
        try {
            cur = dm.query(new DownloadManager.Query().setFilterById(id));
            if (cur != null && cur.moveToFirst()) {
                int status = cur.getInt(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                return status == DownloadManager.STATUS_SUCCESSFUL;
            }
        } catch (Exception ignored) {
        } finally {
            if (cur != null) cur.close();
        }
        return false;
    }

    private void launchInstaller(File apk) {
        try {
            Uri uri = FileProvider.getUriForFile(
                activity, activity.getPackageName() + ".fileprovider", apk);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(i);
        } catch (Exception ignored) {}
    }

    private void runOnUi(Runnable r) { new Handler(Looper.getMainLooper()).post(r); }

    /** Call from Activity.onDestroy(). */
    public void destroy() {
        if (receiver != null) {
            try { activity.unregisterReceiver(receiver); } catch (Exception ignored) {}
            receiver = null;
        }
    }
}
