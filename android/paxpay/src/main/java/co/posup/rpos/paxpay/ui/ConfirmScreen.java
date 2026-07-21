package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.TextView;

import co.posup.rpos.paxpay.Money;
import co.posup.rpos.paxpay.model.TerminalJob;

/**
 * "Is this the right bill?" — the last screen the WAITER sees before the terminal changes hands.
 *
 * WHY IT EXISTS. Everything after this point is customer-facing: the tip screen, then the card.
 * Once the terminal is in someone else's hand, a wrong table is not a mis-tap any more, it is a
 * stranger being shown another party's bill and then charged for it. So the check happens here,
 * in the hands of the person who knows which table they are standing at, with the table name and
 * the amount as the two largest things on the screen.
 *
 * It also states the split of the money when there IS one. A bill part-paid by a gift card shows
 * both numbers, because "Table 12 · £5.00" on a £50 meal looks like a mistake unless the screen
 * explains itself.
 */
public final class ConfirmScreen extends LinearLayout {

    public interface Listener {
        void onConfirm();
        void onCancel();
    }

    public ConfirmScreen(Context c, TerminalJob job, Listener listener) {
        super(c);
        setOrientation(VERTICAL);
        setPadding(Ui.dp(c, 18), Ui.dp(c, 18), Ui.dp(c, 18), Ui.dp(c, 16));

        TextView label = Ui.text(c, job.displayLabel, 30f, Ui.TEXT, true);
        label.setGravity(Gravity.CENTER);
        addView(label);
        addView(Ui.spacer(c, 18));

        LinearLayout card = Ui.card(c);
        card.setGravity(Gravity.CENTER);

        TextView cap = Ui.text(c, "To pay by card", 15f, Ui.MUTED, false);
        cap.setGravity(Gravity.CENTER);
        card.addView(cap);

        TextView amount = Ui.text(c, Money.format(job.dueMinor, job.currency), 46f, Ui.TEXT, true);
        amount.setGravity(Gravity.CENTER);
        card.addView(amount);

        // Only shown when the two numbers genuinely differ — i.e. a gift card or voucher has
        // already taken part of the bill. Showing it always would be noise on the common case.
        if (job.tipBasisMinor != job.dueMinor) {
            card.addView(Ui.spacer(c, 12));
            card.addView(Ui.line(c, "Bill total",
                    Money.format(job.tipBasisMinor, job.currency), 15f, Ui.MUTED, false));
            card.addView(Ui.spacer(c, 4));
            card.addView(Ui.line(c, "Already paid",
                    Money.format(job.tipBasisMinor - job.dueMinor, job.currency),
                    15f, Ui.MUTED, false));
        }

        addView(card, Ui.lp(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));

        addView(Ui.spacer(c, 14));
        TextView note = Ui.text(c,
                job.tipConfig.enabled
                        ? "The customer will be asked about a tip next."
                        : "Tipping is off for this venue.",
                14f, Ui.MUTED, false);
        note.setGravity(Gravity.CENTER);
        addView(note);

        addView(Ui.flexSpacer(c));

        addView(Ui.primaryButton(c, "Hand to customer", v -> listener.onConfirm()),
                Ui.lp(LayoutParams.MATCH_PARENT, Ui.dp(c, 76)));
        addView(Ui.spacer(c, 10));
        addView(Ui.secondaryButton(c, "Wrong table — go back", v -> listener.onCancel()),
                Ui.lp(LayoutParams.MATCH_PARENT, Ui.dp(c, 62)));
    }
}
