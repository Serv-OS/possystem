package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;

/**
 * Numeric keypad, POS-style: digits shift in from the right, so typing 1-2-3-4 gives £12.34.
 *
 * Shared by three screens — the manual amount screen, the custom-tip panel and the staff PIN pad —
 * which is why the accumulator itself ({@link #pushDigit} / {@link #popDigit}) lives here as
 * static maths with no view state anywhere near it. Those two methods are UNCHANGED by the ServOS
 * rebuild and must stay that way: every amount this terminal charges is built by them.
 *
 * ═══ TWO BOTTOM ROWS, ONE KEYPAD ════════════════════════════════════════════════════════════
 * {@link #LAYOUT_CLEAR} — C / 0 / ⌫. The original bottom row, and still the default, so the two
 *                         screens this file does not own (PinScreen, TipScreen) keep the exact
 *                         key set and the exact callbacks they had before.
 * {@link #LAYOUT_MONEY} — ·00 / 0 / ⌫. The ServOS money pad from design screen 04. "·00" is two
 *                         taps of zero pushed through the same frozen accumulator, not a second
 *                         code path; long-pressing backspace still reaches onClear(), so dropping
 *                         the C key costs the operator nothing.
 *
 * ═══ SIZING ═════════════════════════════════════════════════════════════════════════════════
 * Keys are Coal with a Graphite border and a 20px-space corner, digits at 48px/500 Mist — the
 * spec's key, which {@link Ui#keyButton} draws. Never below the 64dp touch floor: this is a 5"
 * terminal held at arm's length, and a mis-keyed amount is a mis-keyed charge.
 */
public final class Keypad extends LinearLayout {

    public interface Listener {
        void onDigit(int digit);
        void onBackspace();
        void onClear();
    }

    /** Bottom row C / 0 / ⌫ — the PIN pad. The default; unchanged from before the rebuild. */
    public static final int LAYOUT_CLEAR = 0;
    /** Bottom row ·00 / 0 / ⌫ — the money pad (design screen 04). */
    public static final int LAYOUT_MONEY = 1;

    /** Key height when the keypad is measured WRAP_CONTENT. The 64dp touch floor, exactly. */
    private static final int KEY_H = 64;
    /** Gap between keys and between rows. Spec 18px. */
    private static final int GAP = 9;
    /** The backspace glyph, at roughly the optical weight of a 48px digit. */
    private static final int ICON = 22;

    // Sentinels, not labels — buildKey() decides what each one is actually drawn as.
    private static final String CLEAR = "C";
    private static final String DOUBLE_ZERO = "·00";
    private static final String BACKSPACE = "⌫";

    private final boolean fill;
    private final int layout;

    /** The original keypad: C / 0 / ⌫, sized to its content. */
    public Keypad(Context c, Listener listener) {
        this(c, LAYOUT_CLEAR, false, listener);
    }

    /**
     * @param layout {@link #LAYOUT_CLEAR} or {@link #LAYOUT_MONEY}.
     * @param fill   true makes the four rows share the keypad's height by weight, for a caller
     *               that gives this view a weighted height and wants the keys to fill the space
     *               under the amount (design screen 04). false keeps the original fixed-height
     *               rows, which is what a WRAP_CONTENT caller needs — weighted rows measured
     *               WRAP_CONTENT would collapse to nothing.
     */
    public Keypad(Context c, int layout, boolean fill, Listener listener) {
        super(c);
        this.fill = fill;
        this.layout = layout;
        setOrientation(VERTICAL);

        addRow(c, listener, "1", "2", "3");
        addView(Ui.spacer(c, GAP));
        addRow(c, listener, "4", "5", "6");
        addView(Ui.spacer(c, GAP));
        addRow(c, listener, "7", "8", "9");
        addView(Ui.spacer(c, GAP));
        addRow(c, listener, layout == LAYOUT_MONEY ? DOUBLE_ZERO : CLEAR, "0", BACKSPACE);
    }

    private void addRow(Context c, Listener listener, String... keys) {
        LinearLayout row = Ui.row(c);
        for (int i = 0; i < keys.length; i++) {
            View k = buildKey(c, listener, keys[i]);
            LayoutParams lp = new LayoutParams(0, fill ? LayoutParams.MATCH_PARENT : Ui.dp(c, KEY_H), 1f);
            if (i > 0) lp.leftMargin = Ui.dp(c, GAP);
            row.addView(k, lp);
        }
        addView(row, fill
                ? new LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f)
                : new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));
    }

    private View buildKey(Context c, Listener listener, String key) {
        if (BACKSPACE.equals(key)) return backspaceKey(c, listener);

        if (CLEAR.equals(key)) {
            // Ash rather than Mist: the two non-digit keys are secondary to the digits.
            return Ui.button(c, CLEAR, Ui.ASH, Ui.GRAPHITE, Ui.SP_KEYPAD, v -> listener.onClear());
        }
        if (DOUBLE_ZERO.equals(key)) {
            return Ui.button(c, DOUBLE_ZERO, Ui.ASH, Ui.GRAPHITE, Ui.SP_KEYPAD, v -> {
                // Two taps of "0" down the SAME accumulator the 0 key uses. No second path, and
                // the cap in pushDigit is applied to each one, so "00" near the ceiling behaves
                // exactly as pressing 0 twice would.
                listener.onDigit(0);
                listener.onDigit(0);
            });
        }

        final int digit = Integer.parseInt(key);
        return Ui.keyButton(c, key, v -> listener.onDigit(digit));
    }

    /**
     * The delete key: the spec's drawn glyph rather than a "⌫" character, in Ash.
     *
     * A plain View with the key background, not a Button, because a Button centres a compound
     * drawable against its text box and there is no text here to centre it against.
     */
    private View backspaceKey(Context c, Listener listener) {
        LinearLayout k = Ui.row(c);
        k.setGravity(Gravity.CENTER);
        k.setBackground(Ui.pressable(Ui.surface(c, Ui.COAL, Ui.GRAPHITE, Ui.R_KEY)));
        k.addView(Ui.imageOf(c, Icons.backspace(Ui.ASH), ICON));
        k.setOnClickListener(v -> listener.onBackspace());
        k.setMinimumHeight(Ui.dp(c, KEY_H));

        if (layout == LAYOUT_MONEY) {
            // The money row has no C key. Long-press restores clear-all rather than leaving the
            // operator to tap backspace six times to correct a mis-keyed amount.
            k.setOnLongClickListener(v -> { listener.onClear(); return true; });
            k.setContentDescription("Backspace. Press and hold to clear.");
        } else {
            k.setContentDescription("Backspace");
        }
        return k;
    }

    /** Shift a digit into a minor-unit amount, capped so a mis-key can't produce a silly total. */
    public static long pushDigit(long currentMinor, int digit, long maxMinor) {
        long next = currentMinor * 10 + digit;
        return next > maxMinor ? currentMinor : next;
    }

    public static long popDigit(long currentMinor) {
        return currentMinor / 10;
    }
}
