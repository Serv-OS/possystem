package co.posup.rpos.biometric;

import android.app.Activity;
import android.content.Context;
import android.hardware.fingerprint.FingerprintManager;
import android.os.Build;
import android.os.CancellationSignal;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

/**
 * BiometricBridge — exposes window.RposBiometric to the React web app (Sunmi D3 Pro fingerprint).
 * Mirrors PrinterBridge. Native → web callback: window.__rposBiometricCallback(id, ok, payloadJson).
 *
 * Two routes (see docs/FINGERPRINT-INTEGRATION.md):
 *   • verify()  — 1:1 confirm the device-enrolled user. REAL here via the framework BiometricPrompt
 *                 (API 28+, works on the D3 Pro / Android 13, no extra dependency). Cannot tell
 *                 WHICH staff — only that an enrolled fingerprint matched. Use for step-up confirm.
 *   • identify()/enroll() — 1:N true staff login. Needs SUNMI's fingerprint SDK (capture + template
 *                 match), downloaded from the SUNMI developer portal. Wire it into the marked TODOs
 *                 and set SUNMI_SDK_WIRED = true so isAvailable() reports identify/enroll.
 *
 * Until the SUNMI SDK is wired, isAvailable() reports identify:false → the web app shows NO
 * fingerprint-login button and falls back to PIN (zero behaviour change).
 */
public class BiometricBridge {

    private static final String TAG = "BiometricBridge";

    // Flip to true once the SUNMI fingerprint SDK enroll/identify is wired into the TODOs below.
    private static final boolean SUNMI_SDK_WIRED = false;

    private final WebView webView;
    private final Activity activity;

    public BiometricBridge(WebView webView, Activity activity) {
        this.webView = webView;
        this.activity = activity;
    }

    /** window.RposBiometric.isAvailable() → JSON capability string (parsed by src/lib/biometric.js). */
    @JavascriptInterface
    public String isAvailable() {
        boolean verify = false;
        try {
            FingerprintManager fm = (FingerprintManager) activity.getSystemService(Context.FINGERPRINT_SERVICE);
            verify = fm != null && fm.isHardwareDetected() && fm.hasEnrolledFingerprints();
        } catch (Throwable t) {
            Log.w(TAG, "isAvailable check failed: " + t.getMessage());
        }
        boolean available = verify || SUNMI_SDK_WIRED;
        return "{\"available\":" + available
            + ",\"identify\":" + SUNMI_SDK_WIRED
            + ",\"verify\":" + verify
            + ",\"enroll\":" + SUNMI_SDK_WIRED + "}";
    }

    /**
     * window.RposBiometric.verify(reason, callbackId) — 1:1 confirm the device-enrolled user.
     * REAL: framework BiometricPrompt. Callback ok=true on a match.
     */
    @JavascriptInterface
    public void verify(final String reason, final String callbackId) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) { notifyJS(callbackId, false, "{\"error\":\"unsupported\"}"); return; }
        activity.runOnUiThread(() -> {
            try {
                android.hardware.biometrics.BiometricPrompt prompt =
                    new android.hardware.biometrics.BiometricPrompt.Builder(activity)
                        .setTitle(reason != null && !reason.isEmpty() ? reason : "Confirm")
                        .setNegativeButton("Use PIN instead", activity.getMainExecutor(), (d, w) ->
                            notifyJS(callbackId, false, "{\"error\":\"canceled\"}"))
                        .build();
                prompt.authenticate(new CancellationSignal(), activity.getMainExecutor(),
                    new android.hardware.biometrics.BiometricPrompt.AuthenticationCallback() {
                        @Override public void onAuthenticationSucceeded(android.hardware.biometrics.BiometricPrompt.AuthenticationResult result) {
                            notifyJS(callbackId, true, null);
                        }
                        @Override public void onAuthenticationError(int code, CharSequence errString) {
                            boolean canceled = code == android.hardware.biometrics.BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED
                                || code == android.hardware.biometrics.BiometricPrompt.BIOMETRIC_ERROR_CANCELED
                                || code == android.hardware.biometrics.BiometricPrompt.BIOMETRIC_ERROR_NEGATIVE_BUTTON;
                            notifyJS(callbackId, false, "{\"error\":\"" + (canceled ? "canceled" : "auth_error") + "\"}");
                        }
                        // onAuthenticationFailed() = one bad read; the prompt keeps going. No callback.
                    });
            } catch (Throwable t) {
                Log.w(TAG, "verify failed: " + t.getMessage());
                notifyJS(callbackId, false, "{\"error\":\"verify_failed\"}");
            }
        });
    }

    /**
     * window.RposBiometric.identify(callbackId) — 1:N: which staff tapped (true fingerprint login).
     * TODO(SUNMI SDK): capture a fingerprint and match it 1:N against enrolled templates; return the
     * staff id the template was enrolled with. On success: notifyJS(callbackId, true, "{\"staffRef\":\"<id>\"}").
     * On no match: notifyJS(callbackId, false, "{\"error\":\"no_match\"}").
     */
    @JavascriptInterface
    public void identify(final String callbackId) {
        if (!SUNMI_SDK_WIRED) { notifyJS(callbackId, false, "{\"error\":\"not_implemented\"}"); return; }
        // TODO: SUNMI fingerprint SDK 1:N identify here.
        notifyJS(callbackId, false, "{\"error\":\"not_implemented\"}");
    }

    /**
     * window.RposBiometric.enroll(staffRef, label, callbackId) — register a staff member's
     * fingerprint, keyed by their staff id (so identify() can return it). The raw print/template
     * stays in the device's secure store; the web only learns success + an optional templateId.
     * TODO(SUNMI SDK): run the enrolment flow associated with staffRef.
     */
    @JavascriptInterface
    public void enroll(final String staffRef, final String label, final String callbackId) {
        if (!SUNMI_SDK_WIRED) { notifyJS(callbackId, false, "{\"error\":\"not_implemented\"}"); return; }
        // TODO: SUNMI fingerprint SDK enrolment here, associated with staffRef.
        notifyJS(callbackId, false, "{\"error\":\"not_implemented\"}");
    }

    /** Fire window.__rposBiometricCallback(callbackId, success, payloadJson) on the UI thread.
     *  payloadJson is a JSON string the web side JSON.parses (or null). */
    private void notifyJS(String callbackId, boolean success, String payloadJson) {
        if (callbackId == null || callbackId.isEmpty()) return;
        String arg = (payloadJson != null) ? quote(payloadJson) : "null";
        final String js = "window.__rposBiometricCallback && window.__rposBiometricCallback('"
            + callbackId + "'," + success + "," + arg + ")";
        webView.post(() -> webView.evaluateJavascript(js, null));
    }

    /** Wrap a JSON string as a JS string literal (the web side JSON.parses it). */
    private static String quote(String s) {
        return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'";
    }
}
