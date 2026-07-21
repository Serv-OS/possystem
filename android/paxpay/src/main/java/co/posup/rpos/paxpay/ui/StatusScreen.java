package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import co.posup.rpos.paxpay.Money;

/**
 * "Waiting" screen — shown while the STS controller is being launched, while we wait for
 * DEVICE_CONNECTED, and while the transaction is in flight.
 *
 * The controller takes over the screen for the card-present part, so in practice this is what
 * the operator sees on either side of that handoff. It always states the total, because a
 * silent spinner on a payment terminal is how you get a double-charge from an impatient retry.
 */
public final class StatusScreen extends LinearLayout {

    private final TextView headline;
    private final TextView detail;

    public StatusScreen(Context c, long totalMinor) {
        super(c);
        setOrientation(VERTICAL);
        setGravity(Gravity.CENTER);
        setPadding(Ui.dp(c, 24), Ui.dp(c, 24), Ui.dp(c, 24), Ui.dp(c, 24));

        ProgressBar spinner = new ProgressBar(c);
        addView(spinner, Ui.lp(Ui.dp(c, 56), Ui.dp(c, 56)));
        addView(Ui.spacer(c, 22));

        headline = Ui.text(c, "Connecting to the terminal…", 21f, Ui.TEXT, true);
        headline.setGravity(Gravity.CENTER);
        addView(headline);
        addView(Ui.spacer(c, 10));

        detail = Ui.text(c, "Total " + Money.format(totalMinor), 17f, Ui.MUTED, false);
        detail.setGravity(Gravity.CENTER);
        addView(detail);
    }

    public void setStatus(String headlineText, String detailText) {
        headline.setText(headlineText);
        detail.setText(detailText);
    }
}
