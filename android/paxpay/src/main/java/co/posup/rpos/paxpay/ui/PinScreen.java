package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.Arrays;

/**
 * Staff PIN entry. Table Pay only — nothing else in this app asks who you are.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * PIN HANDLING, AND ITS HONEST LIMITS
 *
 * What this screen guarantees:
 *   - the PIN is held in a char[], not a String, so it can actually be overwritten
 *   - it is NEVER rendered — the readout shows dots, one per digit
 *   - it is NEVER logged, never put in a Diagnostics field, never written to SharedPreferences
 *     or to the write-ahead log
 *   - {@link #wipe()} zeroes the buffer, and the coordinator calls it on EVERY exit from this
 *     screen: success, wrong PIN, cancel, and activity destruction
 *
 * What it CANNOT guarantee, stated rather than glossed over: org.json builds the request body as
 * a String, so between {@link Listener#onPinEntered} and the socket write the digits exist in an
 * immutable String that only the GC can reclaim. Http.request zeroes the encoded byte[] it
 * writes, which closes the largest window, but the String itself is out of our hands short of
 * hand-rolling a JSON encoder over a char[]. That was judged not worth it for a 4-digit staff
 * PIN validated server-side, and is written down here so the next person can revisit it with
 * the trade-off visible rather than discovering it.
 *
 * The PIN is validated by terminal_staff_login on the SERVER. Nothing on this device ever holds
 * the list of valid PINs, so a stolen terminal cannot be brute-forced offline.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
public final class PinScreen extends LinearLayout {

    public interface Listener {
        /**
         * The caller must use the array immediately and NOT retain it — {@link #wipe()} will
         * zero this exact buffer as soon as the screen goes away.
         */
        void onPinEntered(char[] pin, int length);
        void onCancel();
    }

    private static final int MAX_PIN = 12;
    private static final int MIN_PIN = 4;

    private final char[] buffer = new char[MAX_PIN];
    private int length = 0;

    private final TextView readout;
    private final TextView error;
    private final Button submit;

    public PinScreen(Context c, String errorMessage, Listener listener) {
        super(c);
        setOrientation(VERTICAL);
        setPadding(Ui.dp(c, 18), Ui.dp(c, 14), Ui.dp(c, 18), Ui.dp(c, 14));

        addView(Ui.title(c, "Staff sign in"));
        addView(Ui.spacer(c, 4));

        TextView sub = Ui.text(c, "Enter your PIN", 15f, Ui.MUTED, false);
        sub.setGravity(Gravity.CENTER);
        addView(sub);
        addView(Ui.spacer(c, 10));

        // Dots only. The digits never reach a View, so they can never be shoulder-surfed off
        // the screen or captured by a screenshot.
        readout = Ui.text(c, "", 40f, Ui.TEXT, true);
        readout.setGravity(Gravity.CENTER);
        readout.setLetterSpacing(0.3f);
        readout.setMinHeight(Ui.dp(c, 56));
        addView(readout);

        error = Ui.text(c, errorMessage == null ? "" : errorMessage, 14f, Ui.DANGER, true);
        error.setGravity(Gravity.CENTER);
        addView(error);
        addView(Ui.spacer(c, 8));

        Keypad keypad = new Keypad(c, new Keypad.Listener() {
            @Override public void onDigit(int d) { push((char) ('0' + d)); }
            @Override public void onBackspace() { pop(); }
            @Override public void onClear() { clear(); }
        });
        addView(keypad, Ui.lp(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));

        addView(Ui.flexSpacer(c));

        LinearLayout actions = Ui.row(c);
        Button cancel = Ui.secondaryButton(c, "Cancel", v -> {
            wipe();
            listener.onCancel();
        });
        submit = Ui.primaryButton(c, "Sign in", v -> {
            if (length >= MIN_PIN) listener.onPinEntered(buffer, length);
        });
        actions.addView(cancel, new LayoutParams(0, Ui.dp(c, 68), 1f));
        LayoutParams lp = new LayoutParams(0, Ui.dp(c, 68), 1.4f);
        lp.leftMargin = Ui.dp(c, 8);
        actions.addView(submit, lp);
        addView(actions, Ui.lp(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));

        refresh();
    }

    private void push(char digit) {
        if (length >= MAX_PIN) return;
        buffer[length++] = digit;
        error.setText("");
        refresh();
    }

    private void pop() {
        if (length == 0) return;
        buffer[--length] = 0;
        refresh();
    }

    private void clear() {
        Arrays.fill(buffer, (char) 0);
        length = 0;
        refresh();
    }

    /**
     * Zero the buffer. Called on every exit path from this screen — see the class comment.
     * Idempotent, so calling it from both a listener and onDestroy is fine.
     */
    public void wipe() {
        Arrays.fill(buffer, (char) 0);
        length = 0;
        if (readout != null) readout.setText("");
    }

    private void refresh() {
        StringBuilder dots = new StringBuilder();
        for (int i = 0; i < length; i++) dots.append('●');
        readout.setText(dots.toString());
        boolean ok = length >= MIN_PIN;
        submit.setEnabled(ok);
        submit.setAlpha(ok ? 1f : 0.4f);
    }

    /** Shows "incorrect PIN" without disclosing anything about what was typed. */
    public void showError(String message) {
        clear();
        error.setText(message);
    }
}
