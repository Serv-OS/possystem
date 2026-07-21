package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.graphics.drawable.Drawable;
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
 *
 * SERVOS NOTE: the readout is now a row of drawn dots rather than a string of '●' characters, so
 * the digits are further from a View than they were before — there is no longer any CharSequence
 * on screen whose length is derived from the buffer by string building. The security posture is
 * unchanged in substance; it just got slightly harder to accidentally weaken.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * SERVOS REBUILD — an extension of the language, not a screen from the handoff.
 *
 * There is no PIN screen in the design pack, so this one is assembled from parts that ARE
 * specified, rather than invented:
 *   - the keypad is literally {@link Keypad}, the same instance type the Manual-payment amount
 *     screen builds, so the keys are Coal on a Graphite hairline at the 20px-space radius by
 *     construction. Not "matched" — the same class. It cannot drift.
 *   - the readout is the meta-block treatment (Coal, Graphite hairline, 20px-space corner) with
 *     Signal dots inside: filled Signal for a digit entered, Graphite for a slot still empty.
 *     Green here is legitimate — it is progress, and it is the only green above the fold.
 *   - the running head, title, ghost/primary pair and content inset are the house components.
 *
 * CORAL. A rejected PIN is a refusal, which is the one thing on this screen coral is for. It is
 * spent deliberately and briefly: the readout's hairline goes to the soft coral edge and one line
 * of coral sentence text appears beneath it. No coral fill, no shake, no full-bleed banner —
 * a waiter who fat-fingered a 7 should not be alarmed, only told. The moment they press any key
 * the coral is gone, because by then the message is about a PIN that no longer exists.
 *
 * ONE DEVIATION FROM THE HOUSE PATTERN, AND WHY. Every other ServOS screen carries a back chevron
 * in its running head. This one does not. The keypad is 272dp of fixed, unshrinkable height, and
 * the back-affordance variant of Ui.runningHead is 64dp tall by the touch floor — including it
 * costs a third of the screen's remaining slack and risks clipping the actions on the short A920
 * panel. The exit is the full-width 68dp "Cancel" button at thumb height, which is a better
 * target than a 22px glyph anyway, and it calls exactly the same listener.onCancel(). If the
 * design owner wants the chevron back, the subtitle line is the thing to trade for it.
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

    /** Dot 24px, gap 22px in the 720px design space. Twelve of them still fit the inset width. */
    private static final int DOT_SIZE = 12;
    private static final int DOT_GAP  = 11;

    private final char[] buffer = new char[MAX_PIN];
    private int length = 0;

    private final LinearLayout dots;
    private final TextView error;
    private final Button submit;

    private final Drawable readoutRest;
    private final Drawable readoutRefused;

    public PinScreen(Context c, String errorMessage, Listener listener) {
        super(c);
        setOrientation(VERTICAL);
        Ui.contentPadding(c, this);

        // The primary CTA's green drop shadow falls outside its own bounds; clipping here would
        // shave it off against the bottom inset.
        setClipToPadding(false);
        setClipChildren(false);

        // ── Running head ──────────────────────────────────────────────────────────────────────
        // Both halves are true rather than decorative: this gate exists only in front of Table
        // Pay, and the terminal genuinely is locked until the server says otherwise. No green dot
        // — nothing here is live yet.
        addView(Ui.runningHead(c, "TABLE PAY", "LOCKED", false));

        addView(Ui.spacer(c, 10));

        // ── Header ────────────────────────────────────────────────────────────────────────────
        addView(Ui.title(c, "Staff sign in"));
        addView(Ui.spacer(c, 4));
        addView(Ui.text(c, "Enter your PIN to open a table.", Ui.SP_BODY, Ui.ASH, 400));

        addView(Ui.spacer(c, 13));

        // ── Readout ───────────────────────────────────────────────────────────────────────────
        // Built by hand rather than with Ui.metaBlock() only because the hairline has to be
        // swapped for the refusal state; the fill, corner and padding are the meta-block values.
        readoutRest    = Ui.surface(c, Ui.COAL, Ui.GRAPHITE, Ui.R_KEY);
        readoutRefused = Ui.surface(c, Ui.COAL, Ui.CORAL_SOFT_EDGE, Ui.R_KEY);

        dots = Ui.rowCentered(c);
        dots.setGravity(Gravity.CENTER);
        dots.setMinimumHeight(Ui.dp(c, 52));
        skin(readoutRest);
        addView(dots, Ui.lp(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));

        addView(Ui.spacer(c, 8));

        // Always present, even when empty, so the keypad does not jump up the screen the moment a
        // PIN is refused. An empty TextView still reserves its line.
        error = Ui.text(c, "", Ui.SP_BODY, Ui.CORAL, 500);
        error.setGravity(Gravity.CENTER);
        addView(error, Ui.lp(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));

        addView(Ui.spacer(c, 8));

        // ── Keypad ────────────────────────────────────────────────────────────────────────────
        // The same class the Manual-payment screen uses. Digits shift in from the left here
        // because a PIN is a sequence, not a number — that is what push()/pop() below do, and it
        // is unchanged from before the rebuild.
        Keypad keypad = new Keypad(c, new Keypad.Listener() {
            @Override public void onDigit(int d) { push((char) ('0' + d)); }
            @Override public void onBackspace() { pop(); }
            @Override public void onClear() { clear(); }
        });
        addView(keypad, Ui.lp(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));

        addView(Ui.flexSpacer(c));

        // ── Actions ───────────────────────────────────────────────────────────────────────────
        LinearLayout actions = Ui.row(c);
        Button cancel = Ui.secondaryButton(c, "Cancel", v -> {
            wipe();
            listener.onCancel();
        });
        submit = Ui.primaryButton(c, "Sign in", v -> {
            if (length >= MIN_PIN) listener.onPinEntered(buffer, length);
        });
        // Both at the primary height so the row reads as one bar. H_GHOST would leave the ghost
        // 4dp shorter than the CTA beside it, which looks like a mistake rather than a hierarchy.
        actions.addView(cancel, new LayoutParams(0, Ui.dp(c, Ui.H_PRIMARY), 1f));
        LayoutParams lp = new LayoutParams(0, Ui.dp(c, Ui.H_PRIMARY), 1.4f);
        lp.leftMargin = Ui.dp(c, Ui.GAP_BUTTON_ROW);
        actions.addView(submit, lp);
        actions.setClipToPadding(false);
        actions.setClipChildren(false);
        addView(actions, Ui.lp(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));

        if (errorMessage != null && !errorMessage.isEmpty()) refuse(errorMessage);
        refresh();
    }

    private void push(char digit) {
        if (length >= MAX_PIN) return;
        buffer[length++] = digit;
        clearRefusal();
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
        if (dots != null) refresh();
    }

    private void refresh() {
        renderDots();
        boolean ok = length >= MIN_PIN;
        submit.setEnabled(ok);
        submit.setAlpha(ok ? 1f : 0.4f);
    }

    /**
     * One dot per slot: Signal for a digit that has been entered, Graphite for one still waiting.
     * Four slots are always shown — the minimum a PIN can be — and the row grows a slot at a time
     * beyond that, so a longer PIN is never silently truncated on screen.
     *
     * Rebuilt rather than recoloured because the slot COUNT changes with length, and rebuilding a
     * dozen 12dp views on a keypress is not something this device will notice.
     */
    private void renderDots() {
        Context c = getContext();
        dots.removeAllViews();
        int slots = Math.max(MIN_PIN, length);
        for (int i = 0; i < slots; i++) {
            if (i > 0) dots.addView(Ui.spacerH(c, DOT_GAP));
            dots.addView(Ui.dot(c, i < length ? Ui.SIGNAL : Ui.GRAPHITE, DOT_SIZE, false));
        }
    }

    /** Shows "incorrect PIN" without disclosing anything about what was typed. */
    public void showError(String message) {
        clear();
        refuse(message);
    }

    /** The refusal state: coral hairline on the readout, coral sentence beneath it. Nothing more. */
    private void refuse(String message) {
        error.setText(message == null ? "" : message);
        skin(readoutRefused);
    }

    /** Spent the moment the next key lands — by then the message describes a PIN that is gone. */
    private void clearRefusal() {
        if (error.getText().length() == 0) return;
        error.setText("");
        skin(readoutRest);
    }

    /**
     * Background then padding, in that order and for that reason: View.setBackground() re-reads
     * padding from the drawable, so padding applied first is silently discarded — the same trap
     * {@link Ui} documents on its buttons. The readout swaps background twice per refusal, so it
     * has to re-apply its inset every time.
     */
    private void skin(Drawable background) {
        Context c = getContext();
        dots.setBackground(background);
        dots.setPadding(Ui.dp(c, 13), Ui.dp(c, 15), Ui.dp(c, 13), Ui.dp(c, 15));
    }
}
