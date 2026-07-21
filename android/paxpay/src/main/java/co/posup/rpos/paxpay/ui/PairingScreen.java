package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.Locale;

/**
 * First run: the terminal has registered itself and is waiting for a manager to adopt it.
 *
 * UNTIL PAIRED THIS APP DOES NOTHING ELSE. Not "does less" — nothing. There is no skip, no
 * demo mode, no manual-amount escape hatch. An unpaired terminal has no venue, so it has no
 * tip rules, no staff list, and nowhere to write a closed check; a payment taken on one would
 * be money with no home. The home screen is unreachable from here by design.
 *
 * THE CODE. A manager reads it off this screen and types it into Back Office → Card Readers.
 * It is therefore rendered as large as the screen allows and generously letter-spaced, because
 * it will be read across a bar in bad light and mis-typed codes are the whole failure mode.
 *
 * ═══ SERVOS TREATMENT ═══════════════════════════════════════════════════════════════════════
 * Not in the ServOS handoff — this screen extends the language rather than reproducing a frame.
 * Where it borrows, it borrows deliberately:
 *
 *   - THE CODE IS THE HERO, drawn exactly the way the design draws the big amount on screen 04:
 *     Space Grotesk 700 at 96px-space (48sp) in Mist, centred on a Coal card, auto-shrinking
 *     rather than truncating. A clipped pairing code is a mis-typed pairing code.
 *   - SIGNAL IS RESERVED FOR THE ONE THING TO PRESS. "Check now" is the only green on the
 *     screen; the waiting state is AMBER, which the design defines as "attention, not an error"
 *     — a manager has to do something, but nothing has gone wrong. There is no green "● LIVE"
 *     eyebrow here because the terminal is, truthfully, not live yet.
 *   - CORAL ONLY FOR THE FAILURE, and in the soft form the design uses for Declined
 *     (CORAL_SOFT fill, CORAL_SOFT_EDGE border, Coral text) rather than a full-bleed slab.
 *
 * ═══ UNITS ═════════════════════════════════════════════════════════════════════════════════
 * Design px ÷ 2 = dp/sp, per the note at the top of Ui.java. The design number is kept in the
 * comment beside every conversion.
 */
public final class PairingScreen extends ScrollView {

    /** The hero code. 96px in the 720px design space. */
    private static final float SP_CODE = 48f;
    /** Auto-shrink floor. A long code gives up type size before it gives up a character. */
    private static final int SP_CODE_MIN = 24;
    /**
     * Generous tracking, per the design note. The code is NOT re-grouped with spaces: a manager
     * transcribing "AB7 K92" into Back Office has to decide whether the space is part of it,
     * and that is exactly the class of mistake this screen exists to prevent.
     */
    private static final float CODE_TRACKING = 0.18f;

    public interface Listener {
        /** Re-run register_terminal_device — used both to retry a failure and to poll for adoption. */
        void onRefresh();
        void onDiagnostics();
    }

    public PairingScreen(Context c, String claimCode, String status, String errorMessage,
                         boolean busy, Listener listener) {
        super(c);
        setBackgroundColor(Ui.INK);
        // Lets the flex spacer below actually flex, so the buttons sit at the bottom of a short
        // screen and scroll away on a tall one (an error message can push past the panel).
        setFillViewport(true);

        final boolean hasCode = claimCode != null && !claimCode.isEmpty();

        // panel(), not screen(): MainActivity's chrome is already a screen() and owns the grid.
        LinearLayout root = Ui.panel(c);
        Ui.contentPadding(c, root);   // 34px top / 40px sides / 30px bottom
        // The card and the primary button both carry a drop shadow; a clipping parent eats it.
        root.setClipToPadding(false);

        // ---- running head ---------------------------------------------------------------------
        // Ash, never green. This terminal is not live and the eyebrow must not imply that it is.
        // MATCH_PARENT, or the weighted left label has no slack to push the status to the edge.
        root.addView(Ui.runningHead(c, "SERVOS PAY · SETUP", headStatus(errorMessage, busy), false),
                Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT));
        root.addView(Ui.spacer(c, 14));   // 28px

        // ---- instruction --------------------------------------------------------------------
        root.addView(Ui.title(c, "Set up this terminal"));
        root.addView(Ui.spacer(c, 5));   // 10px

        TextView sub = Ui.text(c,
                "Open Back Office → Card Readers and enter this code.",
                Ui.SP_TILE_SUB, Ui.ASH, 400);
        sub.setLineSpacing(0f, 1.4f);
        root.addView(sub);
        root.addView(Ui.spacer(c, 16));   // 32px

        // ---- failure ---------------------------------------------------------------------------
        if (errorMessage != null) {
            root.addView(errorPanel(c, errorMessage), Ui.lp(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT));
            root.addView(Ui.spacer(c, 14));   // 28px
        }

        // ---- the code ---------------------------------------------------------------------------
        LinearLayout codeCard = Ui.card(c);

        TextView eyebrow = Ui.monoHead(c, "Pairing code", Ui.ASH);
        eyebrow.setGravity(Gravity.CENTER);
        codeCard.addView(eyebrow, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));
        codeCard.addView(Ui.spacer(c, 10));   // 20px

        if (hasCode) {
            codeCard.addView(codeView(c, claimCode), Ui.lp(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT));
        } else {
            // Same two strings as before — "Registering…" while a call is in flight, otherwise
            // the honest "No code yet".
            TextView pending = Ui.text(c, busy ? "Registering…" : "No code yet",
                    Ui.SP_STATE_TITLE, Ui.ASH, 600);
            pending.setGravity(Gravity.CENTER);
            codeCard.addView(pending, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT));
        }

        codeCard.addView(Ui.spacer(c, 12));   // 24px
        codeCard.addView(Ui.divider(c));
        codeCard.addView(Ui.spacer(c, 11));   // 22px

        // Pill on the left says what is happening in words; the raw server status sits on the
        // right, unedited, because that is the string a manager will be asked to read out.
        LinearLayout foot = Ui.rowCentered(c);
        foot.addView(Ui.statusPill(c, pillLabel(hasCode, busy), Ui.PILL_HELD),
                new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        TextView raw = Ui.mono(c, status == null ? "unknown" : status,
                Ui.SP_META_SMALL, Ui.ASH, 1f, 19f);
        raw.setAllCaps(true);
        raw.setGravity(Gravity.END);
        foot.addView(raw, Ui.lp(LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        codeCard.addView(foot, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        root.addView(codeCard, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));
        root.addView(Ui.spacer(c, 14));   // 28px

        // ---- what happens next ------------------------------------------------------------------
        TextView hint = Ui.text(c,
                "This screen checks by itself every few seconds. "
                        + "Tap Check now if the code has just been entered.",
                Ui.SP_TILE_SUB, Ui.ASH, 400);
        hint.setLineSpacing(0f, 1.4f);
        root.addView(hint);

        root.addView(Ui.flexSpacer(c));
        root.addView(Ui.spacer(c, 14));   // 28px

        // ---- actions ----------------------------------------------------------------------------
        // Not disabled while busy, only relabelled — same as before. A manager who taps twice
        // re-fires an idempotent registration call, which is harmless and better than a dead
        // button on a screen whose whole job is "poke it again".
        root.addView(Ui.primaryButton(c, busy ? "Checking…" : "Check now", v -> listener.onRefresh()),
                Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT));
        root.addView(Ui.spacer(c, Ui.GAP_BUTTON_ROW));   // 16px
        root.addView(Ui.secondaryButton(c, "Diagnostics", v -> listener.onDiagnostics()),
                Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT));

        addView(root, new ScrollView.LayoutParams(
                ScrollView.LayoutParams.MATCH_PARENT, ScrollView.LayoutParams.WRAP_CONTENT));
    }

    /**
     * The hero. Space Grotesk 700 at 96px-space, Mist, uppercase, generously tracked.
     *
     * Auto-shrinks exactly like {@link Ui#amount}: the claim code is server-generated and this
     * screen must not assume its length. Type gives way before a character does.
     */
    private static TextView codeView(Context c, String claimCode) {
        TextView code = Ui.text(c, claimCode.toUpperCase(Locale.UK), SP_CODE, Ui.MIST, 700);
        code.setGravity(Gravity.CENTER);
        code.setMaxLines(1);
        code.setLetterSpacing(CODE_TRACKING);
        // Kept from the original: lets a manager select the code on the panel.
        code.setTextIsSelectable(true);
        try {
            // API 26+. setTextSize must not be called after this, so it goes last.
            code.setAutoSizeTextTypeUniformWithConfiguration(
                    SP_CODE_MIN, (int) SP_CODE, 1, TypedValue.COMPLEX_UNIT_SP);
        } catch (Throwable ignored) {
            // A fixed size is a perfectly good fallback; never fail constructing this screen.
        }
        return code;
    }

    /**
     * The registration failure, in the soft-coral form the design uses for Declined.
     *
     * The server's message is rendered verbatim underneath a mono eyebrow — this device is
     * commissioned without a debugger attached and that raw string is often the only clue.
     */
    private static View errorPanel(Context c, String message) {
        LinearLayout p = new LinearLayout(c);
        p.setOrientation(LinearLayout.VERTICAL);
        p.setBackground(Ui.surface(c, Ui.CORAL_SOFT, Ui.CORAL_SOFT_EDGE, Ui.R_CARD));
        p.setPadding(Ui.dp(c, Ui.PAD_CARD), Ui.dp(c, 12),
                Ui.dp(c, Ui.PAD_CARD), Ui.dp(c, 12));   // after the background — see Ui.styleButton

        TextView head = Ui.mono(c, "Could not register", Ui.SP_PILL, Ui.CORAL, 1.5f, 20f);
        head.setAllCaps(true);
        p.addView(head);
        p.addView(Ui.spacer(c, 6));   // 12px

        TextView body = Ui.text(c, message, Ui.SP_TILE_SUB, Ui.MIST, 400);
        body.setLineSpacing(0f, 1.35f);
        p.addView(body);
        return p;
    }

    /** Right-hand eyebrow label. Never green — see the class comment. */
    private static String headStatus(String errorMessage, boolean busy) {
        if (errorMessage != null) return "Offline";
        if (busy) return "Checking…";
        return "Not paired";
    }

    /** Amber throughout: waiting on a human is attention, not an error. */
    private static String pillLabel(boolean hasCode, boolean busy) {
        if (hasCode) return "Waiting for a manager";
        return busy ? "Registering" : "No code yet";
    }
}
