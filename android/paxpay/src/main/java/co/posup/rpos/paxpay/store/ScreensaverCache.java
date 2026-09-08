package co.posup.rpos.paxpay.store;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * The idle-screen image, on disk.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS FETCH IS UNAUTHENTICATED, ON PURPOSE
 *
 * The image lives in the `kiosk-assets` Supabase bucket, which is PUBLIC. Public buckets serve
 * objects from /storage/v1/object/public/… and that path does NOT consult storage RLS. So this
 * is a plain HTTPS GET with no Authorization header and no Supabase session involved.
 *
 * Do NOT route it through SupabaseClient. Attaching the terminal's session to a decoration
 * download would couple the screensaver to auth — and then a token blip would start throwing
 * errors on a code path whose entire job is to be invisible.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * CACHED BY URL. The file is re-downloaded only when Back Office points at a different URL
 * (uploads are timestamped, so a replacement image is always a new URL). That means:
 *   * no re-download every time the terminal goes idle, and
 *   * the screensaver still works with the network down, which on a busy floor is exactly when
 *     a terminal sits untouched long enough to go idle.
 *
 * Everything here is best-effort. A failure returns null and the caller shows the ordinary home
 * screen — a missing screensaver is not an error worth telling a member of staff about.
 */
public final class ScreensaverCache {

    private static final String FILE_NAME = "screensaver.img";
    /** A screensaver is decoration; do not hold a socket open for it. */
    private static final int CONNECT_TIMEOUT_MS = 8_000;
    private static final int READ_TIMEOUT_MS = 12_000;
    /** Sanity bound. Back Office caps uploads at 2 MB; this stops a bad URL filling the disk. */
    private static final int MAX_BYTES = 4 * 1024 * 1024;

    private final Context ctx;
    private final Prefs prefs;
    /** Decoded once and kept — the home screen may arm and disarm this many times a shift. */
    private Bitmap decoded;
    private String decodedUrl;

    public ScreensaverCache(Context ctx, Prefs prefs) {
        this.ctx = ctx.getApplicationContext();
        this.prefs = prefs;
    }

    private File file() {
        return new File(ctx.getFilesDir(), FILE_NAME);
    }

    /** True when the given URL is already on disk and can be shown without a network call. */
    public boolean isCached(String url) {
        if (url == null || url.isEmpty()) return false;
        return url.equals(prefs.screensaverUrl()) && file().exists();
    }

    /**
     * Make sure {@code url} is on disk. BLOCKING — call on a background thread.
     * Returns true if the image is available afterwards (already cached, or just downloaded).
     */
    public boolean ensure(String url) {
        if (url == null || url.trim().isEmpty()) return false;
        if (isCached(url)) return true;
        return download(url);
    }

    private boolean download(String url) {
        HttpURLConnection conn = null;
        File tmp = new File(ctx.getFilesDir(), FILE_NAME + ".tmp");
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setInstanceFollowRedirects(true);
            // Deliberately NO Authorization / apikey header — see the class comment.
            conn.connect();
            if (conn.getResponseCode() / 100 != 2) return false;

            int total = 0;
            try (InputStream in = conn.getInputStream();
                 OutputStream out = new FileOutputStream(tmp)) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) {
                    total += n;
                    if (total > MAX_BYTES) return false;
                    out.write(buf, 0, n);
                }
            }
            if (total <= 0) return false;

            // Write to a temp file and rename, so a download killed half way through can never
            // leave a truncated image that decodes to a grey rectangle on the terminal.
            File dest = file();
            if (dest.exists() && !dest.delete()) return false;
            if (!tmp.renameTo(dest)) return false;

            prefs.saveScreensaverUrl(url);
            synchronized (this) { decoded = null; decodedUrl = null; }
            return true;
        } catch (Throwable t) {
            return false;
        } finally {
            if (conn != null) try { conn.disconnect(); } catch (Throwable ignored) { }
            if (tmp.exists()) //noinspection ResultOfMethodCallIgnored
                tmp.delete();
        }
    }

    /**
     * The cached image, decoded, or null. Safe to call on the UI thread once {@link #ensure} has
     * run — the file is small and the result is memoised.
     */
    public synchronized Bitmap bitmap(String url) {
        if (!isCached(url)) return null;
        if (decoded != null && url.equals(decodedUrl) && !decoded.isRecycled()) return decoded;
        try {
            BitmapFactory.Options o = new BitmapFactory.Options();
            // The A920 Pro screen is 480x800-class. Full-resolution decoding of a 2 MB photo is
            // both pointless and a plausible OOM on a device that must not die mid-shift.
            o.inSampleSize = sampleSizeFor(file());
            Bitmap b = BitmapFactory.decodeFile(file().getAbsolutePath(), o);
            if (b == null) return null;
            decoded = b;
            decodedUrl = url;
            return b;
        } catch (Throwable t) {
            return null;
        }
    }

    private int sampleSizeFor(File f) {
        try {
            BitmapFactory.Options probe = new BitmapFactory.Options();
            probe.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(f.getAbsolutePath(), probe);
            int longest = Math.max(probe.outWidth, probe.outHeight);
            int sample = 1;
            while (longest / sample > 1600) sample *= 2;
            return sample;
        } catch (Throwable t) {
            return 1;
        }
    }
}
