package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.graphics.Color;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import co.posup.rpos.paxpay.Money;

/**
 * Enter the base (pre-tip) amount to charge. ServOS design screen 04 — Manual payment.
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
 *
 * ═══ WHAT THE REDESIGN DID AND DID NOT TOUCH ════════════════════════════════════════════════
 * Rendering only. The pence accumulator is still {@link Keypad#pushDigit} / {@link Keypad#popDigit}
 * called with the same arguments and the same {@link #MAX_MINOR} cap, the click guard is still
 * {@code baseMinor > 0}, and the listener is still handed the same long. Nothing on this screen
 * computes money; it collects digits and passes them on.
 *
 * ═══ ONE THING THE DESIGN ASKS FOR THAT THIS SIGNATURE CANNOT GIVE ══════════════════════════
 * Screen 04 draws the running head as "‹ HOME" — a back affordance. {@link Listener} has exactly
 * one method, {@code onAmountEntered}, and MainActivity constructs this screen with a method
 * reference ({@code new AmountScreen(this, this::beginManual)}), so there is no callback to route
 * a back tap to and no signature change is permitted here. A chevron that does nothing when
 * pressed is worse on a payment terminal than no chevron at all — the operator taps it twice and
 * concludes the terminal has frozen — so the head reads "MANUAL PAYMENT" instead. See the handoff
 * note for the one-line fix if the back affordance is wanted.
 */
public final class AmountScreen extends LinearLayout {

    public interface Listener { void onAmountEntered(long baseMinor); }

    /** £9,999.99 — a deliberately low cap; this is a test harness, not a real till. */
    private static final long MAX_MINOR = 999_999L;

    /** The Signal entry bar under the amount. Spec 220px × 6px. */
    private static final int BAR_W = 110, BAR_H = 3;

    private long baseMinor = 0L;
    private final TextView readout;
    private final Button chargeButton;

    public AmountScreen(Context c, Listener listener) {
        super(c);
        setOrientation(VERTICAL);
        setBackgroundColor(Ui.INK);
        Ui.contentPadding(c, this);
        // The CTA's green glow is drawn outside its own bounds; without this it is clipped away.
        setClipToPadding(false);

        addView(Ui.runningHead(c, "MANUAL PAYMENT", "LIVE", true),
                Ui.lp(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));
        addView(Ui.spacer(c, 14));

        // ---- amount block -------------------------------------------------------------------
        // Currency comes from Money, not from a literal, so this label can never disagree with
        // the symbol Money.format() actually prints beside the digits.
        TextView label = Ui.monoHead(c, "AMOUNT · " + Money.DEFAULT_CURRENCY, Ui.ASH);
        label.setGravity(Gravity.CENTER);
        addView(label, Ui.lp(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));
        addView(Ui.spacer(c, 6));

        readout = Ui.amount(c, Money.format(0));
        addView(readout, Ui.lp(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));
        addView(Ui.spacer(c, 8));

        addView(entryBar(c));
        addView(Ui.spacer(c, 15));

        // ---- keypad -------------------------------------------------------------------------
        // Weighted, so the keys take everything left between the amount and the CTA. On this
        // panel (640dp tall, less the banner, footer, head, amount block and CTA) that lands the
        // rows at roughly 80dp each — comfortably above the 64dp floor they would otherwise sit at.
        Keypad keypad = new Keypad(c, Keypad.LAYOUT_MONEY, true, new Keypad.Listener() {
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
        addView(keypad, new LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f));

        addView(Ui.spacer(c, 13));

        chargeButton = Ui.primaryButton(c, chargeLabel(), v -> {
            if (baseMinor > 0) listener.onAmountEntered(baseMinor);
        });
        addView(chargeButton, Ui.lp(LayoutParams.MATCH_PARENT, Ui.dp(c, Ui.H_PRIMARY)));

        refresh();
    }

    /** The Signal bar under the amount — the design's "you are typing here" marker. */
    private View entryBar(Context c) {
        View bar = new View(c);
        bar.setBackground(Ui.surface(c, Ui.SIGNAL, Color.TRANSPARENT, BAR_H / 2f));
        LayoutParams lp = new LayoutParams(Ui.dp(c, BAR_W), Ui.dp(c, BAR_H));
        lp.gravity = Gravity.CENTER_HORIZONTAL;
        bar.setLayoutParams(lp);
        return bar;
    }

    private String chargeLabel() {
        return "Charge " + Money.format(baseMinor);
    }

    private void refresh() {
        readout.setText(Money.format(baseMinor));
        boolean valid = baseMinor > 0;
        chargeButton.setText(chargeLabel());
        chargeButton.setEnabled(valid);
        chargeButton.setAlpha(valid ? 1f : 0.4f);
        // Drop the glow with the button. A dimmed green slab still casting a live green shadow
        // reads as pressable, which at £0.00 it is not.
        Ui.greenGlow(getContext(), chargeButton, valid ? 7 : 0);
    }
}
