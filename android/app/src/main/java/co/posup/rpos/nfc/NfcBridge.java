package co.posup.rpos.nfc;

import android.app.Activity;
import android.nfc.NfcAdapter;
import android.nfc.Tag;
import android.os.Bundle;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

/**
 * NfcBridge — exposes window.RposNfc to the React web app. Reads NFC card/fob UIDs via the
 * standard Android NfcAdapter reader mode (no vendor SDK). On each tap it pushes the UID to the
 * web: window.__rposNfcTap('<hex uid>'). Used for tap-to-sign-in (match UID → staff_members.nfc_card_id).
 *
 * Reader mode (vs foreground dispatch) suits a kiosk POS: it reads the tag's UID directly without
 * launching intents. We only read the UID — no NDEF, no secure data.
 */
public class NfcBridge implements NfcAdapter.ReaderCallback {

    private static final String TAG = "NfcBridge";
    // Read passive tag types + skip NDEF check (we only want the UID → faster, fewer beeps).
    private static final int READER_FLAGS =
        NfcAdapter.FLAG_READER_NFC_A | NfcAdapter.FLAG_READER_NFC_B |
        NfcAdapter.FLAG_READER_NFC_F | NfcAdapter.FLAG_READER_NFC_V |
        NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK;

    private final WebView webView;
    private final Activity activity;
    private final NfcAdapter adapter;
    private boolean scanning = false;

    public NfcBridge(WebView webView, Activity activity) {
        this.webView = webView;
        this.activity = activity;
        NfcAdapter a = null;
        try { a = NfcAdapter.getDefaultAdapter(activity); } catch (Throwable t) { Log.w(TAG, "no NFC adapter: " + t.getMessage()); }
        this.adapter = a;
    }

    /** window.RposNfc.isAvailable() → "true" only when NFC hardware is present + enabled. */
    @JavascriptInterface
    public String isAvailable() {
        try { return (adapter != null && adapter.isEnabled()) ? "true" : "false"; }
        catch (Throwable t) { return "false"; }
    }

    /** window.RposNfc.startScan() — begin reader mode (idempotent). */
    @JavascriptInterface
    public void startScan() {
        if (adapter == null || scanning) return;
        activity.runOnUiThread(() -> {
            try {
                Bundle extras = new Bundle();
                adapter.enableReaderMode(activity, this, READER_FLAGS, extras);
                scanning = true;
            } catch (Throwable t) { Log.w(TAG, "startScan failed: " + t.getMessage()); }
        });
    }

    /** window.RposNfc.stopScan() — end reader mode (idempotent). */
    @JavascriptInterface
    public void stopScan() {
        if (adapter == null || !scanning) return;
        activity.runOnUiThread(() -> {
            try { adapter.disableReaderMode(activity); } catch (Throwable t) { Log.w(TAG, "stopScan failed: " + t.getMessage()); }
            scanning = false;
        });
    }

    /** NfcAdapter.ReaderCallback — a tag entered the field. Push its UID to the web. */
    @Override
    public void onTagDiscovered(Tag tag) {
        try {
            String uid = bytesToHex(tag.getId());
            if (uid.isEmpty()) return;
            final String js = "window.__rposNfcTap && window.__rposNfcTap('" + uid + "')";
            webView.post(() -> webView.evaluateJavascript(js, null));
        } catch (Throwable t) {
            Log.w(TAG, "onTagDiscovered failed: " + t.getMessage());
        }
    }

    private static String bytesToHex(byte[] bytes) {
        if (bytes == null) return "";
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(String.format("%02X", b));
        return sb.toString();
    }
}
