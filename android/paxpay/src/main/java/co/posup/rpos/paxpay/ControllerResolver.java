package co.posup.rpos.paxpay;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.util.Log;

/**
 * Finds the STS Payments "G8" controller app on this terminal.
 *
 * There is no Ryft app on a PAX A920 Pro. Ryft's in-person stack is white-labelled STS Payments
 * and the on-terminal controller ships under TWO package names:
 *
 *   com.stspayments.pax.v2       — LIVE build (the name in Ryft's "G8-Hybrid Intents and Cloud")
 *   com.stspayments.pax.v2.test  — SANDBOX build, which is what is on OUR test unit
 *
 * Hardcoding either one guarantees a failure on half the estate, so we probe in order and
 * remember which one answered. Both names are also declared in <queries> in the manifest —
 * without that, getLaunchIntentForPackage returns null on Android 11+ even when installed.
 */
public final class ControllerResolver {

    private static final String TAG = "PaxPayCtrl";

    /** Live first: a terminal with BOTH installed should transact against live, not sandbox. */
    public static final String PKG_LIVE = "com.stspayments.pax.v2";
    public static final String PKG_TEST = "com.stspayments.pax.v2.test";

    private static final String[] CANDIDATES = { PKG_LIVE, PKG_TEST };

    /** Outcome of a resolution attempt — deliberately explicit so the UI can explain itself. */
    public static final class Resolution {
        /** Package that was found, or null if none. */
        public final String packageName;
        /** Launch intent for that package, or null. */
        public final Intent launchIntent;
        /** Human-readable app label for that package, or null. */
        public final String appLabel;
        /** Every candidate we tried and what happened, for the diagnostics screen. */
        public final String probeLog;

        Resolution(String packageName, Intent launchIntent, String appLabel, String probeLog) {
            this.packageName = packageName;
            this.launchIntent = launchIntent;
            this.appLabel = appLabel;
            this.probeLog = probeLog;
        }

        public boolean found() { return packageName != null; }
        /** Installed but with no launchable activity — a distinct, confusing failure worth naming. */
        public boolean foundButNotLaunchable() { return packageName != null && launchIntent == null; }
        public boolean isSandbox() { return PKG_TEST.equals(packageName); }
    }

    private ControllerResolver() {}

    public static Resolution resolve(Context context) {
        PackageManager pm = context.getPackageManager();
        StringBuilder probe = new StringBuilder();

        for (String candidate : CANDIDATES) {
            boolean installed;
            String label = null;
            try {
                label = String.valueOf(pm.getApplicationLabel(pm.getApplicationInfo(candidate, 0)));
                installed = true;
            } catch (PackageManager.NameNotFoundException e) {
                installed = false;
            }

            if (!installed) {
                probe.append(candidate).append(" — not installed\n");
                Log.i(TAG, "candidate not installed: " + candidate);
                continue;
            }

            Intent launch = pm.getLaunchIntentForPackage(candidate);
            if (launch == null) {
                // Installed but no LAUNCHER activity (or <queries> is wrong). Keep looking, but
                // report it — "installed yet unlaunchable" is otherwise baffling on-device.
                probe.append(candidate).append(" — installed, NO launch intent\n");
                Log.w(TAG, "installed but no launch intent: " + candidate);
                return new Resolution(candidate, null, label, probe.toString());
            }

            probe.append(candidate).append(" — FOUND (").append(label).append(")\n");
            Log.i(TAG, "resolved controller package: " + candidate + " (" + label + ")");
            return new Resolution(candidate, launch, label, probe.toString());
        }

        Log.e(TAG, "no STS controller package found on this device");
        return new Resolution(null, null, null, probe.toString());
    }
}
