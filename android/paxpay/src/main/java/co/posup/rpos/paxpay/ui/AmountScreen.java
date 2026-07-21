package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import co.posup.rpos.paxpay.Money;

/**
 * Enter the base (pre-tip) amount to charge.
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────────────┐
 * │  SEAM — RPOS                                                                             │
 * │                                                                                          │
 * │  This screen is a MILESTONE-1 TEST HARNESS, not the final product flow. In production the │
 * │  base amount arrives from the RPOS check being paid, and this screen is skipped:          │
 * │  MainActivity already reads EXTRA_BASE_MINOR / EXTRA_REFERENCE from its launch intent, so │
 * │  whoever wires RPOS → PaxPay only has to send those extras. It exists now because there   │
 * │  is no RPOS integration yet and the operator still has to be able to test the maths and   │
 * │  the terminal handoff on real hardware.                                                   │
 * └──────────────────────────────────────────────────────────────────────────────────────────┘
 */
public final class AmountScreen extends LinearLayout {

    public interface Listener { void onAmountEntered(long baseMinor); }

    /** £9,999.99 — a deliberately low cap; this is a test harness, not a real till. */
    private static final long MAX_MINOR = 999_999L;

    private long baseMinor = 0L;
    private final TextView readout;
    private final Button chargeButton;

    public AmountScreen(Context c, Listener listener) {
        super(c);
        setOrientation(VERTICAL);
        setPadding(Ui.dp(c, 18), Ui.dp(c, 14), Ui.dp(c, 18), Ui.dp(c, 14));

        TextView title = Ui.text(c, "Amount to charge", 15f, Ui.MUTED, false);
        title.setGravity(Gravity.CENTER);
        addView(title);
        addView(Ui.spacer(c, 6));

        readout = Ui.amount(c, Money.format(0));
        addView(readout);
        addView(Ui.spacer(c, 14));

        Keypad keypad = new Keypad(c, new Keypad.Listener() {
            @Override public void onDigit(int d) {
                baseMinor = Keypad.pushDigit(baseMinor, d, MAX_MINOR);
                refresh();
            }
            @Override public void onBackspace() {
                baseMinor = Keypad.popDigit(baseMinor);
                refresh();
            }
            @Override public void onClear() {
                baseMinor = 0L;
                refresh();
            }
        });
        addView(keypad, Ui.lp(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));

        addView(Ui.flexSpacer(c));

        chargeButton = Ui.primaryButton(c, "Continue", v -> {
            if (baseMinor > 0) listener.onAmountEntered(baseMinor);
        });
        addView(chargeButton, Ui.lp(LayoutParams.MATCH_PARENT, Ui.dp(c, 68)));

        refresh();
    }

    private void refresh() {
        readout.setText(Money.format(baseMinor));
        boolean valid = baseMinor > 0;
        chargeButton.setEnabled(valid);
        chargeButton.setAlpha(valid ? 1f : 0.4f);
    }
}
