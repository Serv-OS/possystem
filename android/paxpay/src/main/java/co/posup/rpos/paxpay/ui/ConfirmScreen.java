package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.graphics.drawable.Drawable;
import android.view.Gravity;
import android.widget.Button;
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
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * SERVOS REBUILD — design screen 03 (Table / Bill), and what of it we can honestly draw.
 *
 * The design draws a line-item list between the header and the totals block. {@link TerminalJob}
 * carries no line items — it has the three amounts, a display label, a currency and a tip config,
 * and that is all the POS hands the terminal. So the list is NOT rendered with invented rows. The
 * totals block is the whole body, and it grows the "Bill total / Already paid" pair only when the
 * two numbers genuinely differ, exactly as before.
 *
 * The design's header sub-line ("N COVERS · OPENED HH:MM") and its order-ref slot have no data
 * behind them here either. The sub-line is repurposed to say which KIND of payment this is, which
 * is real and is worth a waiter's glance — a keypad amount and a table bill are different things
 * to be handing over. The ref is left out rather than faked; the full job id already has a home on
 * UnresolvedScreen and in Diagnostics.
 *
 * Per the brief, the spec's "Split" and "Add tip" ghost buttons are omitted: this terminal has no
 * split payment, and tipping is {@link TipScreen}, the very next screen. Offering it twice would
 * be the bug, not the feature.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
public final class ConfirmScreen extends LinearLayout {

    public interface Listener {
        void onConfirm();
        void onCancel();
    }

    public ConfirmScreen(Context c, TerminalJob job, Listener listener) {
        super(c);
        setOrientation(VERTICAL);
        Ui.contentPadding(c, this);

        // The primary CTA carries a green drop shadow that sits outside its own bounds. Clipping
        // here would shave it off against the bottom inset.
        setClipToPadding(false);
        setClipChildren(false);

        final boolean isTable = job.source == TerminalJob.Source.TABLE_PAY;

        // ── Running head ──────────────────────────────────────────────────────────────────────
        // Both this and the ghost button at the foot call the SAME listener.onCancel(). The
        // labelled button is the affordance a waiter will actually reach for under pressure; the
        // chevron is there because every other ServOS screen has one and its absence would read as
        // "you are stuck here".
        addView(Ui.runningHead(c,
                isTable ? "TABLES" : "BACK",
                v -> listener.onCancel(),
                isTable ? "OPEN" : "READY",
                true));

        addView(Ui.spacer(c, 14));

        // ── Header: the table name, as large as the design allows ─────────────────────────────
        addView(Ui.title(c, job.displayLabel));
        addView(Ui.spacer(c, 5));
        addView(Ui.monoHead(c, isTable ? "Table payment" : "Manual amount", Ui.ASH));

        addView(Ui.spacer(c, 15));

        // ── Totals block ──────────────────────────────────────────────────────────────────────
        LinearLayout totals = Ui.card(c);

        // Only shown when the two numbers genuinely differ — i.e. a gift card or voucher has
        // already taken part of the bill. Showing it always would be noise on the common case.
        if (job.tipBasisMinor != job.dueMinor) {
            totals.addView(Ui.line(c, "Bill total",
                    Money.format(job.tipBasisMinor, job.currency),
                    Ui.SP_BODY, Ui.ASH, false));
            totals.addView(Ui.spacer(c, 7));
            totals.addView(Ui.line(c, "Already paid",
                    Money.format(job.tipBasisMinor - job.dueMinor, job.currency),
                    Ui.SP_BODY, Ui.ASH, false));
            totals.addView(Ui.spacer(c, 11));
            totals.addView(Ui.totalsRule(c));
            totals.addView(Ui.spacer(c, 11));
        }

        totals.addView(Ui.monoHead(c, "To pay by card", Ui.ASH));
        totals.addView(Ui.spacer(c, 4));

        TextView amount = Ui.amount(c, Money.format(job.dueMinor, job.currency));
        amount.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        totals.addView(amount, Ui.lp(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));

        addView(totals, Ui.lp(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));

        addView(Ui.spacer(c, 11));

        // Says what happens after the hand-over. With tipping on, the amount above is NOT the
        // final charge, and this line is the only thing on screen that says so.
        addView(Ui.text(c,
                job.tipConfig.enabled
                        ? "The customer will be asked about a tip next."
                        : "Tipping is off for this venue.",
                Ui.SP_BODY, Ui.MUTED, 400));

        addView(Ui.flexSpacer(c));

        // ── Actions ───────────────────────────────────────────────────────────────────────────
        Button confirm = Ui.primaryButton(c,
                "Hand to customer · " + Money.format(job.dueMinor, job.currency),
                v -> listener.onConfirm());
        chevron(c, confirm);
        addView(confirm, Ui.lp(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));

        addView(Ui.spacer(c, Ui.GAP_BUTTON_ROW));

        addView(Ui.secondaryButton(c,
                        isTable ? "Wrong table — go back" : "Go back",
                        v -> listener.onCancel()),
                Ui.lp(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));
    }

    /**
     * The design's trailing chevron on the primary CTA. A compound drawable rather than a nested
     * layout so the button stays a Button — {@link Ui#primaryButton} has already set its
     * background, padding and touch floor, and re-parenting it would throw all three away.
     */
    private static void chevron(Context c, Button b) {
        Drawable ch = Icons.size(c, Icons.chevronRight(Ui.ON_SIGNAL), 10);
        b.setCompoundDrawablesRelativeWithIntrinsicBounds(null, null, ch, null);
        b.setCompoundDrawablePadding(Ui.dp(c, 8));
    }
}
