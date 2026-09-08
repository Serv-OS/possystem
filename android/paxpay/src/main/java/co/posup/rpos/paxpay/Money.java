package co.posup.rpos.paxpay;

import java.util.Locale;

/**
 * Money in MINOR UNITS (pence) as a long — never a double.
 *
 * Every amount that crosses the G8:Cloud boundary is an integer of minor units. Card schemes,
 * Ryft's REST API and the STS/G8 stack all work this way, and float arithmetic on money is how
 * you end up a penny out on a tip calculation that a customer is staring at.
 */
public final class Money {
    private Money() {}

    /** Default trading currency. SEAM: comes from the venue's Back Office settings later. */
    public static final String DEFAULT_CURRENCY = "GBP";

    /** "£12.34" — symbol chosen from the ISO currency code, falling back to the code itself. */
    public static String format(long minor, String currency) {
        String sym = symbolFor(currency);
        long abs = Math.abs(minor);
        String body = String.format(Locale.UK, "%d.%02d", abs / 100, abs % 100);
        return (minor < 0 ? "-" : "") + sym + body;
    }

    public static String format(long minor) {
        return format(minor, DEFAULT_CURRENCY);
    }

    private static String symbolFor(String currency) {
        if (currency == null) return "";
        switch (currency.toUpperCase(Locale.ROOT)) {
            case "GBP": return "£";
            case "EUR": return "€";
            case "USD": return "$";
            default:    return currency.toUpperCase(Locale.ROOT) + " ";
        }
    }

    /**
     * Percentage tip on a base amount, rounded HALF UP to the nearest minor unit.
     *
     * Half-up (not banker's rounding) because that is what the customer expects when they see
     * "12% of £8.75" and it matches the rounding used elsewhere in RPOS for service charge.
     */
    public static long percentOf(long baseMinor, int percent) {
        if (baseMinor <= 0 || percent <= 0) return 0L;
        return (baseMinor * (long) percent + 50L) / 100L;
    }
}
