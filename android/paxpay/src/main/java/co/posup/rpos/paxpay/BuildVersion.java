package co.posup.rpos.paxpay;

/**
 * Single source of truth for the on-screen version string.
 *
 * This is the native analogue of src/lib/version.js (which exposes window.RPOS_VERSION so a
 * build can be identified on a device you can't easily attach a debugger to). Same reasoning
 * here — the A920 Pro is a sealed terminal that gets sideloaded builds, so EVERY screen shows
 * this string in the footer. When someone says "it doesn't work", the first question is
 * answered by looking at the terminal.
 *
 * Keep this in step with versionCode / versionName in android/paxpay/build.gradle and in
 * android/release/latest-paxpay.json.
 */
public final class BuildVersion {
    private BuildVersion() {}

    /** Human-facing build id. "m1" = milestone 1 (G8:Cloud HTTP call still stubbed). */
    public static final String VERSION = "1.3-m2";   // v5.5.839: was stale at 1.0-m1 while
                                                  // build.gradle said 1.1-m2, so the version
                                                  // reported to Back Office was a lie.
                                                  // v5.5.841: 1.2-m2 = server-resolved tip
                                                  // config + idle-first + POS-dispatch flow
                                                  // order. versionCode is NOT bumped: no
                                                  // release is being published, and
                                                  // latest-paxpay.json still names code 2.

    /**
     * True while the G8:Cloud call is the stub rather than the real vendor API. Drives the
     * "SIMULATED — NO CARD CHARGED" banner. Flip to false in the same commit that lands a real
     * G8CloudClient implementation, so a real build can never quietly look like a fake one.
     */
    public static final boolean SIMULATED = true;
}
