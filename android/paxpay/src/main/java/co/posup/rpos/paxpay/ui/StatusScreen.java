package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.content.res.ColorStateList;
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
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * SERVOS REBUILD — a state screen, and the two strings it does not own.
 *
 * This class is used for TWO things. MainActivity constructs it with a real charge for a payment
 * (`new StatusScreen(this, charge)`), and with 0L for every other wait — boot, "Checking for
 * unfinished payments", "Opening Table 5…", "Recording the tip…". So the chrome adapts on
 * `totalMinor > 0`: a payment gets the PAYMENT running head and the "do not retry" caution, a
 * generic wait gets neither. That flag is cosmetic only and degrades safely — a hypothetical
 * zero-amount payment simply gets the calmer chrome, never wrong information.
 *
 * WHY THERE IS NO BIG AMOUNT, even though the design language puts money at 96–104px. The total
 * on this screen is not ours to render. `setStatus` is called by MainActivity with an already
 * formatted string — and on the job path that string is `Money.format(charge, job.currency)`,
 * currency-aware, while the constructor's `totalMinor` arrives with no currency at all. Drawing a
 * big amount from `totalMinor` would mean formatting the same money twice through two different
 * code paths, and on a non-default-currency job the two would disagree on screen. One number, one
 * source. The detail line is therefore sized up (Mist, button-scale) rather than demoted to Ash,
 * because on the payment path it is the total.
 *
 * The spec's amber "SIMULATED — NO CARD IS CHARGED" reassurance pill is omitted here: MainActivity
 * already adds {@code Ui.simulatedBanner} to the chrome above every screen, and two amber warnings
 * stacked on one screen dilute both.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
public final class StatusScreen extends LinearLayout {

    private final TextView headline;
    private final TextView detail;

    public StatusScreen(Context c, long totalMinor) {
        super(c);
        setOrientation(VERTICAL);
        Ui.contentPadding(c, this);

        // A payment in flight and a boot-time wait are different promises to the operator.
        final boolean isPayment = totalMinor > 0L;

        addView(Ui.runningHead(c,
                isPayment ? "PAYMENT" : "TERMINAL",
                isPayment ? "IN PROGRESS" : "WORKING",
                true));

        addView(Ui.flexSpacer(c));

        // ── The one moving thing on the screen ────────────────────────────────────────────────
        // The spinner is the whole point: it is what tells a waiter the terminal has not hung,
        // which is what stops the retry that double-charges. Graphite chip, Signal spinner —
        // motion in the accent colour, at icon-chip scale so it reads from arm's length.
        LinearLayout chip = Ui.rowCentered(c);
        chip.setBackground(Ui.surface(c, Ui.GRAPHITE, Ui.HAIRLINE_STRONG, Ui.R_CHIP));
        int chipPad = Ui.dp(c, 11);
        chip.setPadding(chipPad, chipPad, chipPad, chipPad);   // after the background
        chip.setGravity(Gravity.CENTER);

        ProgressBar spinner = new ProgressBar(c);
        spinner.setIndeterminateTintList(ColorStateList.valueOf(Ui.SIGNAL));
        chip.addView(spinner, Ui.lp(Ui.dp(c, 30), Ui.dp(c, 30)));

        LayoutParams chipLp = new LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT);
        chipLp.gravity = Gravity.CENTER_HORIZONTAL;
        addView(chip, chipLp);

        addView(Ui.spacer(c, 20));

        headline = Ui.stateTitle(c, "Connecting to the terminal…");
        addView(headline);

        addView(Ui.spacer(c, 8));

        // Mist, not Ash: on the payment path this line carries the amount, and contrast beats
        // hierarchy for the one number the customer is about to be charged.
        detail = Ui.text(c, "Total " + Money.format(totalMinor), Ui.SP_BUTTON, Ui.MIST, 400);
        detail.setGravity(Gravity.CENTER);
        addView(detail);

        addView(Ui.flexSpacer(c));

        if (isPayment) {
            // Ash, not Amber. This is a standing instruction for the whole of a normal payment,
            // not a fault — an amber line on every successful sale would teach the operator to
            // ignore amber on the one that matters.
            TextView caution = Ui.monoHead(c, "Payment in progress · do not retry", Ui.ASH);
            caution.setGravity(Gravity.CENTER);
            addView(caution);
        }
    }

    public void setStatus(String headlineText, String detailText) {
        headline.setText(headlineText);
        detail.setText(detailText);
        // MainActivity passes "" for waits that have no sub-line ("Checking…"). Collapsing the
        // view keeps the block optically centred instead of leaving a hole under the headline.
        detail.setVisibility(detailText == null || detailText.isEmpty() ? GONE : VISIBLE);
    }
}
