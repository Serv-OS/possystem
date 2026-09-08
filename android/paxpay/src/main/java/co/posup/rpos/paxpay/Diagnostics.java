package co.posup.rpos.paxpay;

import android.os.Build;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * On-screen diagnostics state.
 *
 * The whole point of milestone 1 is testing on a sealed terminal where attaching a debugger is
 * painful and `adb logcat` means finding a cable. So the app carries its own black box: every
 * screen shows a one-line summary, and a tap opens the full detail.
 *
 * Same reasoning as window.RPOS_VERSION in the web app (src/lib/version.js) — make the build
 * and its state legible from the device itself.
 */
public final class Diagnostics {

    /** Listener so the visible line updates the moment anything changes. */
    public interface Listener { void onDiagnosticsChanged(); }

    private Listener listener;

    // ---- resolved controller -------------------------------------------------------------
    public String controllerPackage = null;
    public boolean launchIntentFound = false;
    public String controllerProbeLog = "";

    // ---- pairing / session -------------------------------------------------------------------
    /** unpaired | paired | retired | (unknown) */
    public String pairingStatus = "unknown";
    public String deviceId = null;
    public String claimCode = null;
    public String venueLabel = null;
    public String serial = null;
    /** auth.uid() — the thing the pairing is tied to. Truncated on screen; never the token. */
    public String authUid = null;
    /** Name of the signed-in staff member, Table Pay only. NEVER their PIN. */
    public String staffName = null;
    /** Job currently being paid, if any. */
    public String currentJobId = null;
    /** Last RPC/transport failure, whatever screen it happened on. */
    public String lastRpcError = null;
    /** Rows in the write-ahead log that are not yet resolved. */
    public int unresolvedPayments = 0;

    // ---- flow -----------------------------------------------------------------------------
    public boolean deviceConnectedReceived = false;
    public String deviceConnectedExtras = "";
    public long launchedAtMs = 0L;
    public long deviceConnectedAtMs = 0L;
    public long resultAtMs = 0L;
    public String lastResultCode = "—";
    public String g8ClientDescription = "—";
    public String lastTransactionId = "—";
    public String lastError = null;

    private final List<String> events = new ArrayList<>();

    public void setListener(Listener l) { this.listener = l; }

    /** Timestamped event, newest last. Kept short — this is read on a 5" screen. */
    public synchronized void event(String message) {
        long since = launchedAtMs == 0 ? 0 : System.currentTimeMillis() - launchedAtMs;
        // v5.5.839: MIRROR TO LOGCAT. These events used to exist only on the device's
        // own diagnostics screen, which meant every silent failure was invisible to
        // anyone holding a laptop and an adb cable. Debugging a terminal you cannot
        // see is how a day gets lost. `adb logcat -s PaxPayDiag` now tails it.
        Log.i("PaxPayDiag", message);
        events.add(String.format(Locale.UK, "[%+.1fs] %s", since / 1000f, message));
        if (events.size() > 40) events.remove(0);
        notifyChanged();
    }

    public void notifyChanged() {
        if (listener != null) listener.onDiagnosticsChanged();
    }

    /** Milliseconds from launching the controller to the DEVICE_CONNECTED broadcast. */
    public long connectElapsedMs() {
        if (launchedAtMs == 0 || deviceConnectedAtMs == 0) return -1;
        return deviceConnectedAtMs - launchedAtMs;
    }

    /** Milliseconds from launching the controller to the final result. */
    public long totalElapsedMs() {
        if (launchedAtMs == 0 || resultAtMs == 0) return -1;
        return resultAtMs - launchedAtMs;
    }

    /** The single line shown in every screen footer. */
    public String summaryLine() {
        StringBuilder sb = new StringBuilder();
        sb.append("v").append(BuildVersion.VERSION);
        sb.append(BuildVersion.SIMULATED ? " · SIM" : " · LIVE");
        sb.append(" · ").append(pairingStatus);
        // Unresolved payments are the single most important thing an operator can be told, so
        // they get the footer of EVERY screen, not just the diagnostics report.
        if (unresolvedPayments > 0) sb.append(" · ⚠").append(unresolvedPayments).append(" unresolved");
        sb.append(" · ctrl ");
        if (controllerPackage == null) sb.append("NONE");
        else sb.append(controllerPackage.endsWith(".test") ? "sandbox" : "live");
        sb.append(" · intent ").append(launchIntentFound ? "ok" : "—");
        sb.append(" · conn ").append(deviceConnectedReceived ? "yes" : "—");
        long e = connectElapsedMs();
        if (e >= 0) sb.append(" ").append(e).append("ms");
        sb.append(" · rc ").append(lastResultCode);
        return sb.toString();
    }

    /** The full detail screen. */
    public String fullReport() {
        StringBuilder sb = new StringBuilder();
        sb.append("SERV OS PAXPAY ").append(BuildVersion.VERSION).append('\n');
        sb.append(BuildVersion.SIMULATED
                ? "MODE: SIMULATED — G8:Cloud call is a stub, no card is charged\n"
                : "MODE: LIVE\n");
        sb.append('\n');

        sb.append("— DEVICE —\n");
        sb.append(Build.MANUFACTURER).append(' ').append(Build.MODEL).append('\n');
        sb.append("Android ").append(Build.VERSION.RELEASE)
          .append(" (SDK ").append(Build.VERSION.SDK_INT).append(")\n");
        sb.append("Serial hint: ").append(Build.DEVICE).append('\n');
        sb.append('\n');

        sb.append("— PAIRING —\n");
        sb.append("status: ").append(pairingStatus).append('\n');
        sb.append("device id: ").append(deviceId == null ? "—" : deviceId).append('\n');
        sb.append("venue: ").append(venueLabel == null ? "—" : venueLabel).append('\n');
        if (claimCode != null) sb.append("claim code: ").append(claimCode).append('\n');
        sb.append("serial: ").append(serial == null ? "—" : serial).append('\n');
        // Truncated: enough to tell two identities apart, not enough to be useful if photographed.
        sb.append("auth uid: ").append(authUid == null ? "NONE"
                : (authUid.length() > 8 ? authUid.substring(0, 8) + "…" : authUid)).append('\n');
        sb.append("backend: ").append(Config.describe()).append('\n');
        sb.append('\n');

        sb.append("— SESSION —\n");
        sb.append("staff: ").append(staffName == null ? "(not signed in)" : staffName).append('\n');
        sb.append("current job: ").append(currentJobId == null ? "—" : currentJobId).append('\n');
        sb.append("unresolved payments: ").append(unresolvedPayments).append('\n');
        sb.append("last RPC error: ").append(lastRpcError == null ? "—" : lastRpcError).append('\n');
        sb.append('\n');

        sb.append("— STS CONTROLLER —\n");
        sb.append("resolved: ").append(controllerPackage == null ? "NOT FOUND" : controllerPackage).append('\n');
        sb.append("launch intent: ").append(launchIntentFound ? "found" : "NOT found").append('\n');
        sb.append("probe:\n").append(controllerProbeLog.isEmpty() ? "  (not run)\n" : indent(controllerProbeLog));
        sb.append('\n');

        sb.append("— FLOW —\n");
        sb.append("launch timeout: ").append(PaymentFlow.TENDER_TIMEOUT_MS).append("ms\n");
        sb.append("DEVICE_CONNECTED: ").append(deviceConnectedReceived ? "RECEIVED" : "not received").append('\n');
        if (!deviceConnectedExtras.isEmpty()) {
            sb.append("broadcast extras:\n").append(indent(deviceConnectedExtras));
        }
        sb.append("connect elapsed: ").append(fmtMs(connectElapsedMs())).append('\n');
        sb.append("total elapsed: ").append(fmtMs(totalElapsedMs())).append('\n');
        sb.append("last result code: ").append(lastResultCode).append('\n');
        sb.append("G8 client: ").append(g8ClientDescription).append('\n');
        sb.append("last txn id: ").append(lastTransactionId).append('\n');
        if (lastError != null) sb.append("last error: ").append(lastError).append('\n');
        sb.append('\n');

        sb.append("— EVENTS —\n");
        synchronized (this) {
            if (events.isEmpty()) sb.append("(none)\n");
            for (String e : events) sb.append(e).append('\n');
        }
        return sb.toString();
    }

    private static String fmtMs(long ms) { return ms < 0 ? "—" : ms + "ms"; }

    private static String indent(String block) {
        StringBuilder sb = new StringBuilder();
        for (String line : block.split("\n")) {
            if (!line.trim().isEmpty()) sb.append("  ").append(line).append('\n');
        }
        return sb.toString();
    }
}
