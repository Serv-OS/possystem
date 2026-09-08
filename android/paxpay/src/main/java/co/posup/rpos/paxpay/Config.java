package co.posup.rpos.paxpay;

/**
 * Build-time configuration, read from BuildConfig — never from a literal in a .java file.
 *
 * The two values come from android/paxpay/build.gradle, which resolves them from a Gradle
 * property, then an environment variable, then a fallback. See the comment block there.
 *
 * The anon key has NO fallback on purpose. A build with no key must announce itself on the
 * terminal's first screen rather than fail later with an opaque 401 in front of a customer.
 */
public final class Config {

    private Config() {}

    public static String url() {
        String u = BuildConfig.SUPABASE_URL;
        // Trailing slash + our "/rest/v1/…" would produce a double slash; PostgREST tolerates it
        // but the logs become unreadable. Normalise once, here.
        while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        return u;
    }

    public static String anonKey() {
        return BuildConfig.SUPABASE_ANON_KEY;
    }

    public static boolean isConfigured() {
        return !url().isEmpty() && !anonKey().isEmpty();
    }

    public static void requireConfigured() throws Exception {
        if (!isConfigured()) throw new Exception(explainMisconfiguration());
    }

    /** Shown verbatim on the terminal, so it must be actionable by whoever built the APK. */
    public static String explainMisconfiguration() {
        return "This build has no Supabase configuration.\n\n"
                + "URL: " + (url().isEmpty() ? "MISSING" : url()) + "\n"
                + "Anon key: " + (anonKey().isEmpty() ? "MISSING" : "set") + "\n\n"
                + "Rebuild with:\n"
                + "  -Ppaxpay.supabaseUrl=… -Ppaxpay.supabaseAnonKey=…\n"
                + "or set PAXPAY_SUPABASE_URL / PAXPAY_SUPABASE_ANON_KEY in the build "
                + "environment.";
    }

    /** For the diagnostics screen — host only, and the key's length, never the key. */
    public static String describe() {
        String u = url();
        String host = u;
        int i = u.indexOf("://");
        if (i > 0) host = u.substring(i + 3);
        return host + " · key " + (anonKey().isEmpty() ? "MISSING" : anonKey().length() + " chars");
    }
}
