package co.posup.rpos.paxpay.ui;

import android.content.Context;
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
 * DESIGN. This is the screen a member of staff sees a hundred times a shift, in a busy room,
 * holding the terminal one-handed. So it is a handful of targets and nothing else — no menu, no
 * settings, no icons to interpret. The venue name is shown because a terminal that has silently
 * paired itself to the wrong venue is otherwise invisible until money moves.
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
        setPadding(Ui.dp(c, 16), Ui.dp(c, 14), Ui.dp(c, 16), Ui.dp(c, 14));

        TerminalSettings s = settings == null ? TerminalSettings.allowAll() : settings;

        // An unresolved payment outranks everything else on this screen. It is not a badge
        // tucked in a corner; it is the first thing above the buttons.
        if (unresolvedCount > 0) {
            TextView warn = Ui.banner(c,
                    "⚠ " + unresolvedCount + " payment" + (unresolvedCount == 1 ? "" : "s")
                            + " need checking — tap to review",
                    Ui.DANGER, 0xFFFFFFFF);
            warn.setOnClickListener(v -> listener.onReviewUnresolved());
            addView(warn, Ui.lp(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));
            addView(Ui.spacer(c, 12));
        }

        TextView venue = Ui.text(c, venueLabel == null ? "Serv OS terminal" : venueLabel,
                17f, Ui.MUTED, false);
        venue.setGravity(Gravity.CENTER);
        addView(venue);
        addView(Ui.spacer(c, 14));

        boolean first = true;

        if (s.tablePay) {
            addFilling(Ui.modeButton(c, "Table Pay", "Pick an open table and take the bill",
                    Ui.ACCENT, v -> listener.onTablePay()));
            first = false;
        }

        if (s.manual) {
            if (!first) addView(Ui.spacer(c, 12));
            // The accent goes to whichever mode is on top, so the primary action is always the
            // green one even at a venue that does not use Table Pay.
            addFilling(Ui.modeButton(c, "Manual payment", "Type an amount",
                    first ? Ui.ACCENT : Ui.SURFACE_2, v -> listener.onManualPayment()));
            first = false;
        }

        // NO "Waiting for POS" BUTTON — see the class comment. Receiving a payment from the till
        // is ambient and needs no screen; s.posDispatch is honoured by MainActivity's poller.

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
                    15f, Ui.MUTED, false);
            none.setGravity(Gravity.CENTER);
            addView(none, Ui.lp(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));
            addView(Ui.flexSpacer(c));
        }
    }

    /** Equal weight, so the buttons share whatever height is left over. */
    private void addFilling(View v) {
        LayoutParams lp = new LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f);
        addView(v, lp);
    }
}
