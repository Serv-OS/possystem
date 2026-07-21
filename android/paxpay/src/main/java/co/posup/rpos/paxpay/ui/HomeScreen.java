package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * The terminal's home screen: three ways to take a payment.
 *
 * DESIGN. This is the screen a member of staff sees a hundred times a shift, in a busy room,
 * holding the terminal one-handed. So it is three targets and nothing else — no menu, no
 * settings, no icons to interpret. The venue name is shown because a terminal that has silently
 * paired itself to the wrong venue is otherwise invisible until money moves.
 *
 * Modes, in the order staff will use them:
 *   1. Table Pay       — the product. PIN, pick a table, take the whole bill.
 *   2. Manual payment  — the fallback for anything the POS cannot express.
 *   3. Waiting for POS — the till pushed a payment at this terminal; stand by for it.
 */
public final class HomeScreen extends LinearLayout {

    public interface Listener {
        void onTablePay();
        void onManualPayment();
        void onWaitForPos();
        /** Only reachable when the write-ahead log has something a human must resolve. */
        void onReviewUnresolved();
    }

    public HomeScreen(Context c, String venueLabel, int unresolvedCount, Listener listener) {
        super(c);
        setOrientation(VERTICAL);
        setPadding(Ui.dp(c, 16), Ui.dp(c, 14), Ui.dp(c, 16), Ui.dp(c, 14));

        // An unresolved payment outranks everything else on this screen. It is not a badge
        // tucked in a corner; it is the first thing above the three buttons.
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

        addFilling(Ui.modeButton(c, "Table Pay", "Pick an open table and take the bill",
                Ui.ACCENT, v -> listener.onTablePay()));
        addView(Ui.spacer(c, 12));

        addFilling(Ui.modeButton(c, "Manual payment", "Type an amount",
                Ui.SURFACE_2, v -> listener.onManualPayment()));
        addView(Ui.spacer(c, 12));

        addFilling(Ui.modeButton(c, "Waiting for POS", "Take a payment sent from the till",
                Ui.SURFACE_2, v -> listener.onWaitForPos()));
    }

    /** Equal weight, so the three buttons share whatever height is left over. */
    private void addFilling(View v) {
        LayoutParams lp = new LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f);
        addView(v, lp);
    }
}
