package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;

/**
 * Numeric keypad, POS-style: digits shift in from the right, so typing 1-2-3-4 gives £12.34.
 *
 * Shared by the amount screen and the custom-tip screen. Keys are deliberately large — see the
 * sizing note in {@link Ui}; this is a 5" terminal, not a phone.
 */
public final class Keypad extends LinearLayout {

    public interface Listener {
        void onDigit(int digit);
        void onBackspace();
        void onClear();
    }

    public Keypad(Context c, Listener listener) {
        super(c);
        setOrientation(VERTICAL);

        addRow(c, listener, new String[]{"1", "2", "3"});
        addView(Ui.spacer(c, 8));
        addRow(c, listener, new String[]{"4", "5", "6"});
        addView(Ui.spacer(c, 8));
        addRow(c, listener, new String[]{"7", "8", "9"});
        addView(Ui.spacer(c, 8));
        addRow(c, listener, new String[]{"C", "0", "⌫"});
    }

    private void addRow(Context c, Listener listener, String[] keys) {
        LinearLayout row = Ui.row(c);
        for (int i = 0; i < keys.length; i++) {
            final String key = keys[i];
            Button b = Ui.button(c, key, Ui.TEXT, Ui.SURFACE_2, 26f, new OnClickListener() {
                @Override public void onClick(View v) {
                    switch (key) {
                        case "C":  listener.onClear();     break;
                        case "⌫": listener.onBackspace(); break;
                        default:   listener.onDigit(Integer.parseInt(key)); break;
                    }
                }
            });
            LayoutParams lp = new LayoutParams(0, Ui.dp(c, 62), 1f);
            if (i > 0) lp.leftMargin = Ui.dp(c, 8);
            row.addView(b, lp);
        }
        addView(row, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));
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
