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

    /**
     * Human-facing build id. "2.0-rc1" = the first REAL-CHARGE candidate: ServerG8CloudClient
     * proxies every charge through the terminal-job-charge edge function, and SIMULATED is off.
     */
    public static final String VERSION = "2.0-rc12";

    /**
     * True while the G8:Cloud call is the stub rather than a real charge path. Drives the
     * "SIMULATED — NO CARD CHARGED" banner. Flip to false in the same commit that lands a real
     * G8CloudClient implementation, so a real build can never quietly look like a fake one.
     *
     * v2.0-rc1: FALSE — that commit is this one. ServerG8CloudClient is the real
     * implementation (charges via terminal-job-charge; the server refuses simulated jobs), and
     * MainActivity's construction seam is fenced on this flag, so flipping it back to true
     * restores the stub bench build in one line.
     */
    public static final boolean SIMULATED = false;
}
