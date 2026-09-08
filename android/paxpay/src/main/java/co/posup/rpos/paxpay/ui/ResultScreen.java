package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.graphics.drawable.GradientDrawable;
import android.text.format.DateFormat;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.Date;

import co.posup.rpos.paxpay.BuildVersion;
import co.posup.rpos.paxpay.Money;
import co.posup.rpos.paxpay.g8.G8TransactionResult;

/**
 * The outcome screen — design screens 08 (Approved) and 09 (Declined), plus a third state the
 * design does not draw.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THREE OUTCOMES, NOT TWO
 *
 * The design has a green screen and a coral screen. This app can arrive here in a third state:
 * {@code result == null} — the flow handed back no outcome object at all. Painting that green
 * would claim money was taken; painting it coral would claim it was not. Both are assertions
 * about a customer's card that this device cannot support, so it gets its own AMBER treatment:
 * hollow amber pill, amber disc, the amount that MAY have been charged in amber, and copy that
 * says plainly that we do not know. Amber is already the design's "attention, not an error"
 * colour (the HELD pill, the sandbox banner), so this stays inside the language.
 *
 * Today PaymentFlow never actually calls onResult(null) — a failed result read becomes
 * Outcome.UNKNOWN, which routes to UnresolvedScreen and blocks the terminal instead. This branch
 * is therefore defensive, and deliberately kept that way: the one thing that must never happen is
 * a null result quietly rendering as a confident "Declined".
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT SHOWS AND WHY. This screen is also what makes the milestone TESTABLE: it shows exactly
 * what would have been charged — base, tip, total, and the identifiers that came back — so an
 * operator on a real terminal can confirm the tip maths and the STS/G8 handoff without a
 * debugger. The design's Approved meta block also lists ORDER / TABLE / TERMINAL; this
 * constructor is not given them, and inventing an order number on a payment receipt screen is
 * not a cosmetic sin. Only real fields are rendered; absent ones are omitted entirely.
 *
 * While the G8:Cloud call is stubbed an "approval" here is FABRICATED, and the screen says so in
 * as many words — a simulated approval that looks like a real one is worse than no screen.
 */
public final class ResultScreen extends ScrollView {

    public interface Listener { void onDone(); }

    /** 170px halo / 120px disc / 52px glyph in the 720px design space — halved for dp. */
    private static final int HALO_DP = 85, DISC_DP = 60, GLYPH_DP = 26;

    /**
     * The three states, each carrying its own accent, pill and headline.
     *
     * PILL_HELD is the hollow amber ring — the design's existing "needs a human, not an error"
     * token, which is precisely what an unread outcome is.
     */
    private enum Outcome {
        APPROVED   (Ui.SIGNAL, "APPROVED",      Ui.PILL_APPROVED, "Approved"),
        DECLINED   (Ui.CORAL,  "DECLINED",      Ui.PILL_DECLINED, "Declined"),
        UNCONFIRMED(Ui.AMBER,  "NOT CONFIRMED", Ui.PILL_HELD,     "Not confirmed");

        final int accent;
        final String pill;
        final int pillKind;
        final String title;

        Outcome(int accent, String pill, int pillKind, String title) {
            this.accent = accent;
            this.pill = pill;
            this.pillKind = pillKind;
            this.title = title;
        }
    }

    public ResultScreen(Context c, long baseMinor, long tipMinor,
                        G8TransactionResult result, Listener listener) {
        super(c);
        setBackgroundColor(Ui.INK);
        setFillViewport(true);          // lets the CTA sit at the foot of a short screen
        setClipToPadding(false);

        // ---- state, and ONLY state — no money is computed differently here -------------------
        final long total = baseMinor + tipMinor;
        final Outcome outcome = result == null
                ? Outcome.UNCONFIRMED
                : (result.approved ? Outcome.APPROVED : Outcome.DECLINED);
        // A fabricated approval must be labelled as one. Note this is NOT `result == null ||
        // result.simulated` as it once was: a missing result is unknown, not simulated, and
        // "no card was charged" is the exact claim we are not entitled to make in that state.
        final boolean simulated = result != null && result.simulated;

        LinearLayout root = Ui.panel(c);                 // nested root: panel(), not screen()
        root.setBackground(topGlow(c, outcome.accent));  // translucent, so the console grid shows
        root.setClipToPadding(false);
        root.setClipChildren(false);                     // the disc and CTA cast glows
        Ui.contentPadding(c, root);

        // ---- running head: "● APPROVED" / time ------------------------------------------------
        LinearLayout head = Ui.rowCentered(c);
        head.addView(Ui.statusPill(c, outcome.pill, outcome.pillKind),
                new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        String time = clockLabel(c);
        if (!time.isEmpty()) {
            head.addView(Ui.monoHead(c, time, Ui.ASH),
                    Ui.lp(LinearLayout.LayoutParams.WRAP_CONTENT,
                            LinearLayout.LayoutParams.WRAP_CONTENT));
        }
        root.addView(head, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        root.addView(Ui.spacer(c, 16));

        // ---- the disc, in its radial halo -----------------------------------------------------
        LinearLayout.LayoutParams discLp = Ui.lp(Ui.dp(c, HALO_DP), Ui.dp(c, HALO_DP));
        discLp.gravity = Gravity.CENTER_HORIZONTAL;
        root.addView(disc(c, outcome), discLp);

        root.addView(Ui.spacer(c, 12));

        // ---- headline -------------------------------------------------------------------------
        TextView title = Ui.text(c, outcome.title, Ui.SP_OUTCOME_TITLE, Ui.MIST, 700);
        title.setGravity(Gravity.CENTER);
        root.addView(title, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        root.addView(Ui.spacer(c, 6));

        // ---- the number, and what it means ------------------------------------------------------
        if (outcome == Outcome.APPROVED) {
            root.addView(Ui.outcomeAmount(c, Money.format(total)),
                    Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                            LinearLayout.LayoutParams.WRAP_CONTENT));

        } else if (outcome == Outcome.UNCONFIRMED) {
            // The amount at risk gets the same weight an approval gets, because the operator's
            // next decision — whether to charge again — turns entirely on this number.
            TextView atRisk = Ui.text(c, Money.format(total), Ui.SP_OUTCOME_AMOUNT, Ui.AMBER, 700);
            atRisk.setGravity(Gravity.CENTER);
            atRisk.setMaxLines(1);
            root.addView(atRisk, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT));

            TextView caption = Ui.mono(c, "MAY HAVE BEEN CHARGED", Ui.SP_PILL, Ui.AMBER, 1.5f, 20f);
            caption.setGravity(Gravity.CENTER);
            root.addView(caption, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT));

            root.addView(Ui.spacer(c, 10));
            root.addView(body(c, "The terminal could not read the outcome of this payment. "
                            + "It may or may not have gone through.\n\n"
                            + "Check the Ryft dashboard or the customer's receipt BEFORE taking "
                            + "payment again — charging a second time is the risk here."),
                    Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                            LinearLayout.LayoutParams.WRAP_CONTENT));

        } else {
            root.addView(Ui.spacer(c, 4));
            root.addView(body(c, "The card was declined by the issuer. No funds were taken."),
                    Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                            LinearLayout.LayoutParams.WRAP_CONTENT));
        }

        // ---- the sandbox truth ------------------------------------------------------------------
        if (simulated) {
            root.addView(Ui.spacer(c, 14));
            LinearLayout.LayoutParams pillLp = Ui.lp(LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT);
            pillLp.gravity = Gravity.CENTER_HORIZONTAL;
            root.addView(Ui.reassurancePill(c, "SIMULATED — NO CARD WAS CHARGED"), pillLp);
            root.addView(Ui.spacer(c, 7));
            TextView why = Ui.text(c, "The G8:Cloud call is a stub pending the vendor API.",
                    Ui.SP_META, Ui.ASH, 400);
            why.setGravity(Gravity.CENTER);
            root.addView(why, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT));
        }

        root.addView(Ui.spacer(c, 16));

        // ---- meta block: what we actually have, and nothing else -------------------------------
        root.addView(metaBlock(c, outcome, result, baseMinor, tipMinor, total),
                Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT));

        root.addView(Ui.flexSpacer(c));
        root.addView(Ui.spacer(c, 16));

        // ---- the single action -------------------------------------------------------------------
        // ONE callback exists (onDone), so one button. The design's Print / Email / Change method /
        // Try again have no wiring behind them — see the class report; "Try again" in particular
        // would be a re-dispatch, which is the double-charge.
        //
        // On the unconfirmed state the exit is a ghost, not the inviting green: this screen is not
        // an accomplishment to acknowledge, and the same reasoning already governs UnresolvedScreen.
        View cta = outcome == Outcome.UNCONFIRMED
                ? Ui.ghostButton(c, "Done", v -> listener.onDone())
                : Ui.primaryButton(c, "Done", v -> listener.onDone());
        root.addView(cta, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                Ui.dp(c, outcome == Outcome.UNCONFIRMED ? Ui.H_GHOST : Ui.H_PRIMARY)));

        addView(root, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT));
    }

    // ═══ PIECES ═══════════════════════════════════════════════════════════════════════════════

    /**
     * The outcome disc in its halo: a radial wash of the accent with the 120px disc centred in it.
     *
     * Approved is a solid Signal disc with a #04140B check and the design's green drop glow.
     * Declined and unconfirmed are soft-filled discs with a ringed edge — the design draws the
     * failure state as an outline, not a slab, and that difference is doing real work: only a
     * successful payment gets to look solid.
     */
    private static View disc(Context c, Outcome outcome) {
        FrameLayout halo = new FrameLayout(c);
        halo.setClipChildren(false);
        halo.setBackground(radial(c, outcome.accent, 0x40, HALO_DP / 2f, GradientDrawable.OVAL));

        FrameLayout face = new FrameLayout(c);
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.OVAL);
        if (outcome == Outcome.APPROVED) {
            g.setColor(Ui.SIGNAL);
        } else {
            g.setColor(outcome == Outcome.DECLINED ? Ui.CORAL_SOFT : Ui.AMBER_SOFT);
            g.setStroke(Math.max(1, Ui.dp(c, 1)), outcome.accent);
        }
        face.setBackground(g);

        FrameLayout.LayoutParams faceLp = new FrameLayout.LayoutParams(
                Ui.dp(c, DISC_DP), Ui.dp(c, DISC_DP), Gravity.CENTER);
        halo.addView(face, faceLp);
        if (outcome == Outcome.APPROVED) Ui.greenGlow(c, face, 9);

        View glyph;
        if (outcome == Outcome.UNCONFIRMED) {
            // There is no "unknown" glyph in the icon set, and a check or a cross would both be
            // lies. A question mark is the honest mark for a state whose answer we do not have.
            TextView q = Ui.text(c, "?", 30f, Ui.AMBER, 700);
            q.setGravity(Gravity.CENTER);
            glyph = q;
        } else {
            glyph = Ui.imageOf(c, outcome == Outcome.APPROVED
                    ? Icons.check(Ui.ON_SIGNAL) : Icons.cross(Ui.CORAL), GLYPH_DP);
        }
        face.addView(glyph, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
        return halo;
    }

    /**
     * The mono readout under the outcome.
     *
     * Every row here is a fact this screen was actually handed. The design's ORDER / TABLE /
     * TERMINAL rows are not in the constructor's arguments and are not fabricated; BASE and TIP
     * are, and they stay, because reading the tip split off a real terminal is the whole reason
     * this screen exists at this milestone.
     */
    private static LinearLayout metaBlock(Context c, Outcome outcome, G8TransactionResult result,
                                          long baseMinor, long tipMinor, long total) {
        LinearLayout meta = Ui.metaBlock(c);

        Ui.addMetaRow(c, meta, "Base", Money.format(baseMinor));
        Ui.addMetaRow(c, meta, "Tip", Money.format(tipMinor));
        // On Approved the total is already the big Signal number overhead; elsewhere it is not.
        if (outcome != Outcome.APPROVED) {
            Ui.addMetaRow(c, meta, "Amount", Money.format(total),
                    outcome == Outcome.UNCONFIRMED ? Ui.AMBER : Ui.MIST);
        }

        if (result != null && result.declineReason != null) {
            Ui.addMetaRow(c, meta, "Response", result.declineReason, Ui.CORAL);
        }
        if (result != null && result.authCode != null) {
            Ui.addMetaRow(c, meta, "Auth code", result.authCode);
        }
        String card = cardLabel(result);
        if (card != null) Ui.addMetaRow(c, meta, "Card", card);

        // Always present, even as an em dash: "there is no reference to quote" is itself the
        // answer somebody ringing the acquirer needs.
        Ui.addMetaRow(c, meta, "Transaction", result == null ? null : result.transactionId);
        Ui.addMetaRow(c, meta, "Build", BuildVersion.VERSION, Ui.ASH);
        return meta;
    }

    /** "VISA  •••• 4242" — whichever halves we were actually given, or null for none. */
    private static String cardLabel(G8TransactionResult result) {
        if (result == null) return null;
        if (result.scheme != null) {
            return result.scheme + (result.maskedPan == null ? "" : "  " + result.maskedPan);
        }
        return result.maskedPan;
    }

    /** Centred explanatory copy — 29px Ash in the design. */
    private static TextView body(Context c, String s) {
        TextView t = Ui.text(c, s, Ui.SP_BODY, Ui.ASH, 400);
        t.setGravity(Gravity.CENTER);
        t.setLineSpacing(Ui.dp(c, 3), 1f);   // spec line-height 1.3–1.5
        return t;
    }

    /**
     * The soft top glow behind the whole screen. Translucent on purpose: the chrome underneath
     * paints Ink and the console grid, and an opaque backdrop here would blank both.
     */
    private static GradientDrawable topGlow(Context c, int accent) {
        GradientDrawable g = radial(c, accent, 0x26, 150f, GradientDrawable.RECTANGLE);
        g.setGradientCenter(0.5f, 0f);
        return g;
    }

    /** Accent-coloured radial wash fading to fully transparent. */
    private static GradientDrawable radial(Context c, int accent, int centreAlpha,
                                           float radiusDp, int shape) {
        GradientDrawable g = new GradientDrawable();
        g.setShape(shape);
        g.setGradientType(GradientDrawable.RADIAL_GRADIENT);
        g.setGradientCenter(0.5f, 0.5f);
        g.setGradientRadius(Ui.dp(c, radiusDp));
        // Same RGB at both stops, only the alpha moves — interpolating between two different
        // colours would drift through a hue that is not in the palette.
        int rgb = accent & 0x00FFFFFF;
        g.setColors(new int[]{ (centreAlpha << 24) | rgb, rgb });
        return g;
    }

    /** Device-formatted wall clock — the design's right-hand running-head label. */
    private static String clockLabel(Context c) {
        try {
            return DateFormat.getTimeFormat(c).format(new Date());
        } catch (Throwable ignored) {
            return "";     // never fail constructing a payment screen over a timestamp
        }
    }
}
