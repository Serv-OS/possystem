package co.posup.rpos.paxpay;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Tip presentation rules.
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────────────┐
 * │  SEAM — BACK OFFICE                                                                      │
 * │                                                                                          │
 * │  For milestone 1 these values come from {@link #defaults()}, a local constant, so the    │
 * │  terminal needs no network and no pairing to be tested.                                  │
 * │                                                                                          │
 * │  They are per-VENUE settings and belong in Back Office alongside the existing service-   │
 * │  charge configuration. When that lands, the ONLY change needed here is to call           │
 * │  {@link #fromJson(JSONObject)} with the venue's config instead of {@link #defaults()}.   │
 * │  There is exactly one construction site — MainActivity — so nothing else moves.          │
 * │                                                                                          │
 * │  Expected Back Office shape (matches fromJson below):                                    │
 * │    { "enabled": true, "percentBands": [10, 12.5, 15],                                    │
 * │      "allowCustom": true, "allowNoTip": true }                                           │
 * │                                                                                          │
 * │  NOTE for whoever wires this: "tipping disabled" is a FIRST-CLASS state, not an empty    │
 * │  band list. enabled=false skips the tip screen entirely and charges the base amount.     │
 * │  UK context: tips taken this way are subject to the Tipping Act 2023 / HMRC E24 tronc    │
 * │  rules the rest of RPOS already models — the amount must be attributable to staff, so    │
 * │  the tip portion has to be reported separately even though ONE total goes to the card.   │
 * └──────────────────────────────────────────────────────────────────────────────────────────┘
 */
public final class TipConfig {

    /** First-class "this venue does not take tips on the terminal" state — skips the screen. */
    public final boolean enabled;
    /** Percentage bands, in tenths of a percent so 12.5% is representable as 125. */
    public final int[] bandsTenthPercent;
    /** Show a keypad for a custom cash amount. */
    public final boolean allowCustom;
    /** Show an explicit "No tip" button. Turning this off does NOT make tipping mandatory —
     *  it is illegal to trap a customer on this screen — the operator can still skip. */
    public final boolean allowNoTip;

    public TipConfig(boolean enabled, int[] bandsTenthPercent,
                     boolean allowCustom, boolean allowNoTip) {
        this.enabled = enabled;
        this.bandsTenthPercent = bandsTenthPercent;
        this.allowCustom = allowCustom;
        this.allowNoTip = allowNoTip;
    }

    /** Milestone-1 local defaults. Replace with the Back Office values when that seam is wired. */
    public static TipConfig defaults() {
        return new TipConfig(true, new int[]{100, 125, 150}, true, true);
    }

    /** Tipping switched off for this venue — the tip screen is skipped entirely. */
    public static TipConfig disabled() {
        return new TipConfig(false, new int[0], false, true);
    }

    /**
     * SEAM: parse the venue's Back Office tip settings.
     *
     * Already written so the future wiring is a one-line change at the call site. Percentages
     * arrive as numbers (10 or 12.5) and are stored internally as tenths of a percent.
     */
    public static TipConfig fromJson(JSONObject json) {
        if (json == null) return defaults();
        boolean enabled = json.optBoolean("enabled", true);
        if (!enabled) return disabled();

        JSONArray arr = json.optJSONArray("percentBands");
        int[] bands;
        if (arr == null || arr.length() == 0) {
            bands = defaults().bandsTenthPercent;
        } else {
            bands = new int[arr.length()];
            for (int i = 0; i < arr.length(); i++) {
                bands[i] = (int) Math.round(arr.optDouble(i, 0d) * 10d);
            }
        }
        return new TipConfig(
                true,
                bands,
                json.optBoolean("allowCustom", true),
                json.optBoolean("allowNoTip", true));
    }

    /**
     * Parse the tip_config FROZEN ONTO A JOB ROW — and FAIL CLOSED.
     *
     * ─────────────────────────────────────────────────────────────────────────────────────────
     * WHY THIS IS NOT {@link #fromJson}
     *
     * fromJson() falls back to {@link #defaults()} — sensible when a venue simply has not
     * configured tipping yet. On a JOB ROW it would be dangerous: the config was frozen at
     * dispatch precisely so the tip offered is auditable against the rules that applied. If we
     * cannot read it, we do not know what the venue's rules were, and inventing 10/12.5/15%
     * would put percentages in front of a customer that no one at the venue ever agreed to.
     *
     * So: absent, empty, or unparseable → TIPPING OFF. The customer is charged the due amount
     * and nobody is asked for a gratuity under a rule we made up. A missing tip screen is a
     * commercial disappointment; a fabricated one is a Tipping Act 2023 problem.
     *
     * Accepts BOTH shapes, because Back Office and this module grew separate vocabularies:
     *   { "enabled": true,         "percentBands":    [10, 12.5, 15], … }   ← this module
     *   { "tipping_enabled": true, "tip_percentages": [10, 12.5, 15], … }   ← Back Office
     * ─────────────────────────────────────────────────────────────────────────────────────────
     */
    public static TipConfig fromJobJson(JSONObject json) {
        if (json == null) return disabled();
        try {
            boolean enabled = json.has("enabled")
                    ? json.optBoolean("enabled", false)
                    : json.optBoolean("tipping_enabled", false);
            if (!enabled) return disabled();

            JSONArray arr = json.optJSONArray("percentBands");
            if (arr == null) arr = json.optJSONArray("tip_percentages");
            if (arr == null || arr.length() == 0) return disabled();

            java.util.ArrayList<Integer> valid = new java.util.ArrayList<>();
            for (int i = 0; i < arr.length(); i++) {
                double pct = arr.optDouble(i, -1d);
                // A band of 0%, a negative, or an absurd one is a broken row, not a tip option.
                if (pct <= 0d || pct > 100d) continue;
                valid.add((int) Math.round(pct * 10d));
            }
            if (valid.isEmpty()) return disabled();

            int[] bands = new int[valid.size()];
            for (int i = 0; i < bands.length; i++) bands[i] = valid.get(i);

            return new TipConfig(
                    true,
                    bands,
                    json.optBoolean("allowCustom", json.optBoolean("allow_custom", true)),
                    // allowNoTip defaults TRUE and stays true whatever the row says: trapping a
                    // customer on a tip screen is not a configurable option.
                    true);
        } catch (Throwable t) {
            return disabled();
        }
    }

    /** "12.5%" / "10%" — trailing ".0" trimmed so the common case stays short on a small screen. */
    public static String labelFor(int tenthPercent) {
        if (tenthPercent % 10 == 0) return (tenthPercent / 10) + "%";
        return (tenthPercent / 10) + "." + (tenthPercent % 10) + "%";
    }

    /** Tip amount in minor units for a band, rounded half up. */
    public static long tipFor(long baseMinor, int tenthPercent) {
        if (baseMinor <= 0 || tenthPercent <= 0) return 0L;
        return (baseMinor * (long) tenthPercent + 500L) / 1000L;
    }
}
