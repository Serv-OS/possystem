package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

import co.posup.rpos.paxpay.model.TerminalSettings;

/**
 * The terminal's home screen: the ways a PERSON can start a payment on this device.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ★ BUTTONS ARE FOR THINGS A HUMAN STARTS. RECEIVING FROM THE TILL IS NOT ONE. ★  (v5.5.841)
 *
 * There used to be a third button, "Waiting for POS", which put the terminal into a listening
 * state. That was the wrong model. A paired card reader does not have a "now start listening"
 * state — it just listens, the way a card machine on a counter has always just worked. Making it
 * a mode meant a payment dispatched from the till landed on a terminal that was not polling
 * because nobody had tapped anything, and simply never appeared.
 *
 * So POS dispatch is now AMBIENT: MainActivity polls continuously whenever `modes.pos_dispatch`
 * is on, behind whatever is showing — this screen, the idle screen, the screensaver. It is a
 * capability, not a screen, and it has no button.
 *
 * What is left here is exactly the two things a member of staff initiates:
 *   1. Table Pay       — the product. PIN, pick a table, take the whole bill.
 *   2. Manual payment  — the fallback for anything the POS cannot express.
 *
 * When BOTH of those are off there is nothing on this screen worth showing, and MainActivity
 * routes to PosIdleScreen instead (isIdleFirst()) rather than rendering an empty home screen.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * ★ THE POS LINK IS STATUS, NOT A TARGET ★
 *
 * The ServOS design sheet still draws "Waiting for POS" as a third tile. That drawing is STALE —
 * it predates the decision above. What the operator does need is to SEE that the ambient link is
 * alive, because a listening terminal and a dead one look identical until money fails to arrive.
 * So the link is rendered as a non-tappable status row beneath the tiles: "● LINKED" and a mono
 * line saying where the money is coming from. Deliberately no card, no ripple and no chevron —
 * everything that would read as pressable is absent, because pressing it must do nothing. It is
 * drawn only when `pos_dispatch` is on, so it never claims a link the poller is not maintaining.
 *
 * DESIGN (ServOS language, v5.5.842). This is the screen a member of staff sees a hundred times a
 * shift, in a busy room, holding the terminal one-handed. So it is a handful of targets and
 * nothing else — no menu, no settings, no icons to interpret. The venue name is shown because a
 * terminal that has silently paired itself to the wrong venue is otherwise invisible until money
 * moves; it sits beside the brand lockup rather than centred above the actions.
 *
 * v5.5.838 — each mode can be switched off per terminal in Back Office. A mode that is off is
 * HIDDEN rather than greyed: a disabled button on a payment terminal invites staff to keep
 * pressing it with a customer waiting. Settings that could not be read leave everything visible
 * (see TerminalSettings) — this screen never fails towards "cannot take payment".
 */
public final class HomeScreen extends LinearLayout {

    public interface Listener {
        void onTablePay();
        void onManualPayment();
        /** Only reachable when the write-ahead log has something a human must resolve. */
        void onReviewUnresolved();
    }

    public HomeScreen(Context c, String venueLabel, int unresolvedCount,
                      TerminalSettings settings, Listener listener) {
        super(c);
        setOrientation(VERTICAL);
        // No background: MainActivity's root is Ui.screen(), so the Ink fill and the console grid
        // are painted underneath and show through. Painting Ink again here would hide the grid.
        Ui.contentPadding(c, this);

        TerminalSettings s = settings == null ? TerminalSettings.allowAll() : settings;

        // ---- running head ---------------------------------------------------------------------
        // Label with the ACTUAL device model (A920, A50, …) — this app ships to more than one PAX
        // model now, so a hardcoded "A920" mislabels an A50.
        String deviceLabel = (android.os.Build.MODEL == null ? "TERMINAL"
                : android.os.Build.MODEL.trim().toUpperCase()) + " · TERMINAL";
        addView(Ui.runningHead(c, deviceLabel, "LIVE", true),
                Ui.lp(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));
        addView(Ui.spacer(c, 12));

        // ---- unresolved payments --------------------------------------------------------------
        // An unresolved payment outranks everything else on this screen. It is not a badge tucked
        // in a corner; it is the first thing under the head, above the brand and the actions.
        // Coral is reserved for declined/critical — an unfinished payment is exactly that.
        if (unresolvedCount > 0) {
            addView(unresolvedCard(c, unresolvedCount, listener),
                    Ui.lp(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));
            addView(Ui.spacer(c, 12));
        }

        // ---- brand lockup + venue -------------------------------------------------------------
        LinearLayout brandRow = Ui.rowCentered(c);
        brandRow.addView(Ui.brandLockup(c, "PAYMENTS"), Ui.lp(LayoutParams.WRAP_CONTENT,
                LayoutParams.WRAP_CONTENT));
        brandRow.addView(Ui.spacerH(c, 10));

        TextView venue = Ui.text(c, venueLabel == null ? "Serv OS terminal" : venueLabel,
                Ui.SP_BODY, Ui.ASH, 400);
        venue.setGravity(Gravity.END);
        venue.setMaxLines(2);
        venue.setEllipsize(TextUtils.TruncateAt.END);
        brandRow.addView(venue, new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f));

        addView(brandRow, Ui.lp(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));
        addView(Ui.spacer(c, 14));

        boolean first = true;

        if (s.tablePay) {
            addFilling(Ui.tile(c, Icons.table(Ui.ON_SIGNAL), "Table Pay",
                    "Pick an open table and take the bill", true, v -> listener.onTablePay()));
            first = false;
        }

        if (s.manual) {
            if (!first) addView(Ui.spacer(c, Ui.GAP_TILE));
            // The hero green goes to whichever mode is on top, so the primary action is always the
            // green one even at a venue that does not use Table Pay. At most one hero per screen.
            boolean hero = first;
            addFilling(Ui.tile(c, Icons.keypad(hero ? Ui.ON_SIGNAL : Ui.SIGNAL), "Manual payment",
                    "Type an amount", hero, v -> listener.onManualPayment()));
            first = false;
        }

        // NO "Waiting for POS" TILE — see the class comment. Receiving a payment from the till is
        // ambient and needs no target; s.posDispatch is honoured by MainActivity's poller. What
        // follows is the read-only proof that the poller is running.
        if (!first && s.posDispatch) {
            addView(Ui.spacer(c, 12));
            // Add it bare. Ui.divider() already carries its own (MATCH_PARENT, hairlinePx) params;
            // passing WRAP_CONTENT here REPLACED them, and an unbounded plain View in a vertical
            // LinearLayout that also holds weighted children swallowed the whole content area —
            // which is what collapsed both tiles to zero height and pushed this row off the screen.
            // Every other screen calls it bare; this was the only site that did not.
            addView(Ui.divider(c));
            addView(Ui.spacer(c, 10));
            addView(posLinkRow(c), Ui.lp(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));
        }

        // Nothing a human can start here. Reachable only when table_pay and manual are BOTH off
        // AND pos_dispatch is off too — if pos_dispatch were on, MainActivity would have routed
        // to PosIdleScreen instead of building this screen at all. Say so plainly and name where
        // to fix it, rather than showing a blank screen that reads as a crash.
        if (first) {
            addView(Ui.spacer(c, 20));
            TextView none = Ui.text(c,
                    "This terminal cannot take a payment.\n\n"
                            + "Table Pay, Manual payment and payments sent from the till are all\n"
                            + "switched off. A manager can turn them back on in Back Office →\n"
                            + "Card readers → PAX card terminals → Settings.",
                    Ui.SP_BODY, Ui.ASH, 400);
            none.setGravity(Gravity.CENTER);
            none.setLineSpacing(0f, 1.4f);
            addView(none, Ui.lp(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));
            addView(Ui.flexSpacer(c));
        }
    }

    /**
     * The ambient POS link, as a thing to READ. No background, no ripple, no click listener and no
     * chevron — a status row that looked pressable would be worse than no row at all, because a
     * waiter would press it and conclude the terminal was broken when nothing happened.
     */
    private static LinearLayout posLinkRow(Context c) {
        LinearLayout r = Ui.rowCentered(c);

        LinearLayout left = Ui.rowCentered(c);
        left.addView(Ui.imageOf(c, Icons.inbound(Ui.ASH), 9));
        left.addView(Ui.spacerH(c, 6));
        TextView line = Ui.mono(c, "Taking payments from the till", Ui.SP_META_SMALL, Ui.ASH,
                1.2f, 19f);
        line.setAllCaps(true);
        left.addView(line);
        r.addView(left, new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f));

        r.addView(Ui.spacerH(c, 8));
        r.addView(Ui.statusPill(c, "Linked", Ui.PILL_LINKED),
                new LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT));
        return r;
    }

    /** Tappable coral alert — the one place on this screen that is not a payment action. */
    private static LinearLayout unresolvedCard(Context c, int count, Listener listener) {
        LinearLayout a = Ui.rowCentered(c);
        a.setBackground(Ui.pressable(Ui.surface(c, Ui.CORAL_SOFT, Ui.CORAL_SOFT_EDGE, Ui.R_CARD)));
        a.setPadding(Ui.dp(c, 14), Ui.dp(c, 11), Ui.dp(c, 14), Ui.dp(c, 11));   // after the bg
        a.setMinimumHeight(Ui.dp(c, 64));                                        // touch floor
        a.setOnClickListener(v -> listener.onReviewUnresolved());

        LinearLayout stack = new LinearLayout(c);
        stack.setOrientation(LinearLayout.VERTICAL);
        TextView head = Ui.mono(c, "Needs checking", Ui.SP_PILL, Ui.CORAL, 1.2f, 19f);
        head.setAllCaps(true);
        stack.addView(head);
        stack.addView(Ui.spacer(c, 4));
        stack.addView(Ui.text(c,
                count + " payment" + (count == 1 ? "" : "s") + " — tap to review",
                Ui.SP_BODY, Ui.MIST, 600));
        a.addView(stack, new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f));

        a.addView(Ui.spacerH(c, 10));
        a.addView(Ui.imageOf(c, Icons.chevronRight(Ui.CORAL), 15));
        return a;
    }

    /** Equal weight, so the tiles share whatever height is left over. */
    /**
     * A tile that fills the space left over, but is NEVER smaller than its natural height.
     *
     * WRAP_CONTENT rather than 0 is deliberate. With height 0 a weighted child is entirely at the
     * mercy of the leftover-space pass: if anything upstream consumes the content area, the child
     * measures to nothing and the tile silently disappears — a home screen with no way to take a
     * payment, which is exactly what happened. WRAP_CONTENT floors it at Ui.tile's 92dp minimum,
     * so the worst case is a tile that does not stretch, not a tile that is not there.
     */
    private void addFilling(View v) {
        LayoutParams lp = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, 1f);
        addView(v, lp);
    }
}
