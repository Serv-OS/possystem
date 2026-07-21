package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

/**
 * Mode 3 — the terminal is standing by for the till to send it a payment.
 *
 * The screen is mostly reassurance. A waiter who taps Card on the POS and walks to a table needs
 * to see, at a glance, that this device is listening and how recently it checked; a bare spinner
 * on a payment terminal is how you get someone pressing Card a second time.
 *
 * The status line is driven by {@link co.posup.rpos.paxpay.JobPoller}, which also owns the
 * backoff — this screen never polls anything itself.
 */
public final class WaitingForPosScreen extends LinearLayout {

    public interface Listener {
        void onCancel();
    }

    private final TextView status;

    public WaitingForPosScreen(Context c, String venueLabel, Listener listener) {
        super(c);
        setOrientation(VERTICAL);
        setGravity(Gravity.CENTER);
        setPadding(Ui.dp(c, 22), Ui.dp(c, 22), Ui.dp(c, 22), Ui.dp(c, 18));

        ProgressBar spinner = new ProgressBar(c);
        addView(spinner, Ui.lp(Ui.dp(c, 52), Ui.dp(c, 52)));
        addView(Ui.spacer(c, 20));

        TextView headline = Ui.text(c, "Waiting for the till", 24f, Ui.TEXT, true);
        headline.setGravity(Gravity.CENTER);
        addView(headline);
        addView(Ui.spacer(c, 8));

        TextView sub = Ui.text(c,
                "Press Card on the POS and the payment will appear here.",
                15f, Ui.MUTED, false);
        sub.setGravity(Gravity.CENTER);
        addView(sub);
        addView(Ui.spacer(c, 16));

        status = Ui.text(c, "Checking…", 13f, Ui.MUTED, false);
        status.setGravity(Gravity.CENTER);
        addView(status);

        if (venueLabel != null) {
            addView(Ui.spacer(c, 6));
            TextView venue = Ui.text(c, venueLabel, 13f, Ui.MUTED, false);
            venue.setGravity(Gravity.CENTER);
            addView(venue);
        }

        addView(Ui.flexSpacer(c));
        addView(Ui.secondaryButton(c, "Back", v -> listener.onCancel()),
                Ui.lp(LayoutParams.MATCH_PARENT, Ui.dp(c, 64)));
    }

    public void setStatus(String s) {
        if (status != null) status.setText(s);
    }
}
