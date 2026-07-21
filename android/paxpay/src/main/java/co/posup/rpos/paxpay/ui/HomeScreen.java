package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

import co.posup.rpos.paxpay.model.TerminalSettings;

/**
 * The terminal's home screen: the ways to take a payment this terminal is allowed to offer.
 *
 * DESIGN. This is the screen a member of staff sees a hundred times a shift, in a busy room,
 * holding the terminal one-handed. So it is a handful of targets and nothing else — no menu, no
 * settings, no icons to interpret. The venue name is shown because a terminal that has silently
 * paired itself to the wrong venue is otherwise invisible until money moves.
 *
 * Modes, in the order staff will use them:
 *   1. Table Pay       — the product. PIN, pick a table, take the whole bill.
 *   2. Manual payment  — the fallback for anything the POS cannot express.
 *   3. Waiting for POS — the till pushed a payment at this terminal; stand by for it.
 *
 * v5.5.838 — each mode can be switched off per terminal in Back Office. A mode that is off is
 * HIDDEN rather than greyed: a disabled button on a payment terminal invites staff to keep
 * pressing it with a customer waiting. Settings that could not be read leave all three visible
 * (see TerminalSettings) — this screen never fails towards "cannot take payment".
 */
public final class HomeScreen extends LinearLayout {

    public interface Listener {
        void onTablePay();
        void onManualPayment();
        void onWaitForPos();
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

        if (s.posDispatch) {
            if (!first) addView(Ui.spacer(c, 12));
            addFilling(Ui.modeButton(c, "Waiting for POS", "Take a payment sent from the till",
                    first ? Ui.ACCENT : Ui.SURFACE_2, v -> listener.onWaitForPos()));
            first = false;
        }

        // Every mode switched off. Say so plainly and name where to fix it, rather than showing
        // a blank screen that reads as a crash.
        if (first) {
            addView(Ui.spacer(c, 20));
            TextView none = Ui.text(c,
                    "No payment modes are switched on for this terminal.\n\n"
                            + "A manager can turn them back on in Back Office →\n"
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
