package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.text.format.DateUtils;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.List;

import co.posup.rpos.paxpay.Money;
import co.posup.rpos.paxpay.store.JobLog;

/**
 * The blocking screen for a payment whose outcome nobody knows.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS BLOCKS THE TERMINAL
 *
 * This screen appears when the app was killed after the card was presented and before the
 * outcome was read. There is no button on it that resolves the money, because this device
 * genuinely cannot know: until Ryft ship the G8:Cloud spec nothing can query the processor.
 *
 * So the only honest options are the two on offer — go and look at the Ryft dashboard, or take
 * it to a manager. What is NOT on offer is "retry", and that absence is the point. Retrying a
 * payment that may have succeeded is the double charge; dismissing it is the lost sale. The
 * terminal stops instead, because a warning nobody is forced to read is a warning nobody reads.
 *
 * Acknowledging clears the block on THIS DEVICE only. The server-side row stays `unknown` and
 * needs_human, for the back-office queue to settle properly.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
public final class UnresolvedScreen extends ScrollView {

    public interface Listener {
        /** A human has checked this one and is clearing the block on this terminal. */
        void onAcknowledge(JobLog.Entry entry);
        void onDiagnostics();
    }

    public UnresolvedScreen(Context c, List<JobLog.Entry> entries, Listener listener) {
        super(c);
        setBackgroundColor(Ui.BG);

        LinearLayout root = Ui.screen(c);
        root.setPadding(Ui.dp(c, 16), Ui.dp(c, 16), Ui.dp(c, 16), Ui.dp(c, 16));

        root.addView(Ui.banner(c, "PAYMENT NEEDS CHECKING", Ui.DANGER, 0xFFFFFFFF),
                Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT));
        root.addView(Ui.spacer(c, 16));

        TextView explain = Ui.text(c,
                "This terminal stopped while a card was being taken. "
                        + "The payment may or may not have gone through.\n\n"
                        + "Check the Ryft dashboard or the customer's receipt BEFORE taking "
                        + "payment again — charging a second time is the risk here.",
                15f, Ui.TEXT, false);
        root.addView(explain);
        root.addView(Ui.spacer(c, 18));

        for (JobLog.Entry e : entries) {
            root.addView(card(c, e, listener), Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT));
            root.addView(Ui.spacer(c, 14));
        }

        root.addView(Ui.spacer(c, 6));
        root.addView(Ui.secondaryButton(c, "Diagnostics", v -> listener.onDiagnostics()),
                Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(c, 60)));

        addView(root);
    }

    private LinearLayout card(Context c, JobLog.Entry e, Listener listener) {
        LinearLayout card = Ui.card(c);

        TextView label = Ui.text(c, e.label == null ? "Payment" : e.label, 20f, Ui.TEXT, true);
        card.addView(label);
        card.addView(Ui.spacer(c, 10));

        card.addView(Ui.line(c, "Amount due", Money.format(e.dueMinor, e.currency),
                16f, Ui.MUTED, false));
        card.addView(Ui.spacer(c, 6));
        card.addView(Ui.line(c, "Tip", Money.format(e.tipMinor, e.currency),
                16f, Ui.MUTED, false));
        card.addView(Ui.spacer(c, 8));
        card.addView(Ui.line(c, "May have been charged",
                Money.format(e.chargeMinor, e.currency), 21f, Ui.DANGER, true));

        card.addView(Ui.spacer(c, 10));
        String when = DateUtils.getRelativeTimeSpanString(
                e.createdAt, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS).toString();
        card.addView(Ui.line(c, "When", when, 13f, Ui.MUTED, false));
        if (e.jobId != null) {
            card.addView(Ui.spacer(c, 4));
            card.addView(Ui.line(c, "Reference", e.jobId, 12f, Ui.MUTED, false));
        }
        if (e.transactionId != null) {
            card.addView(Ui.spacer(c, 4));
            card.addView(Ui.line(c, "Transaction", e.transactionId, 12f, Ui.MUTED, false));
        }

        card.addView(Ui.spacer(c, 16));

        TextView warn = Ui.text(c,
                "Only clear this once someone has actually checked whether the card was charged.",
                13f, Ui.WARN, false);
        warn.setGravity(Gravity.CENTER);
        card.addView(warn);
        card.addView(Ui.spacer(c, 8));

        // Red, not green. This button does not fix anything — it acknowledges a problem, and it
        // should feel like it.
        card.addView(Ui.dangerButton(c, "I have checked this payment",
                        v -> listener.onAcknowledge(e)),
                Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(c, 66)));

        return card;
    }
}
