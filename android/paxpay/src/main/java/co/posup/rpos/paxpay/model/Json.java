package co.posup.rpos.paxpay.model;

import org.json.JSONObject;

/**
 * org.json helpers that behave the way we need at a payment boundary.
 *
 * org.json's optString(key, null) returns the STRING "null" for a JSON null, which then sails
 * through every null check and turns up on screen. And optLong() silently returns a default for
 * a missing money field — which on this device would mean charging the wrong amount. Both are
 * fixed here rather than in forty call sites.
 */
public final class Json {

    private Json() {}

    /** Null-safe string: a JSON null, a missing key, or "" all come back as null. */
    public static String str(JSONObject j, String key) {
        if (j == null || j.isNull(key)) return null;
        String v = j.optString(key, null);
        return (v == null || v.isEmpty()) ? null : v;
    }

    /**
     * A money field that MUST be present. Throws rather than defaulting.
     *
     * Money is never guessed. A missing due_minor is a broken job row, and the terminal must
     * refuse it loudly instead of charging 0 or charging a default.
     */
    public static long requireMinor(JSONObject j, String key) throws Exception {
        if (j == null || j.isNull(key)) {
            throw new Exception("Job is missing a required amount: " + key);
        }
        // PostgREST sends bigint as a JSON number; optLong handles it. A string would come from
        // a numeric column, so parse defensively rather than assume.
        Object raw = j.opt(key);
        long v;
        if (raw instanceof Number) v = ((Number) raw).longValue();
        else {
            try {
                v = Long.parseLong(String.valueOf(raw).trim());
            } catch (NumberFormatException e) {
                throw new Exception("Amount " + key + " is not an integer: " + raw);
            }
        }
        if (v < 0) throw new Exception("Amount " + key + " is negative: " + v);
        return v;
    }

    /** Optional money field, absent → the supplied default. */
    public static long optMinor(JSONObject j, String key, long dflt) {
        if (j == null || j.isNull(key)) return dflt;
        try {
            return requireMinor(j, key);
        } catch (Exception e) {
            return dflt;
        }
    }
}
