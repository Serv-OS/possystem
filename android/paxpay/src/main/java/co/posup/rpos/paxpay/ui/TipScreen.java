package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import co.posup.rpos.paxpay.Money;
import co.posup.rpos.paxpay.TipConfig;

/**
 * THE TIP SCREEN — the commercially important part of this app.
 *
 * WHY IT EXISTS: Ryft's REST API has no tip field at all. The only reason tipping is possible
 * on a terminal carried to the table is that in the G8 hybrid flow WE make the HTTP call to
 * G8:Cloud, so WE decide the amount — and can therefore send (base + tip) as ONE total. If this
 * screen ever moves back to the vendor's side, the feature dies. See G8CloudClient.
 *
 * THIS SCREEN FACES THE PAYING CUSTOMER. It is not a developer screen:
 *   - the base amount is stated plainly BEFORE any tip is offered, so nobody is tricked
 *   - every band shows the CASH value as well as the percentage — "12.5%" means nothing to a
 *     customer holding a card, "£1.05" does
 *   - "No tip" is a full-size, equally prominent button, never a hidden or greyed-out escape.
 *     Tipping is voluntary; a dark pattern here is both wrong and, under the Tipping Act 2023
 *     scrutiny of how venues handle tips, a liability
 *   - the total is restated in the pay button, so what is being authorised is unambiguous
 *   - nothing meaningful is smaller than 16sp and every target is at least 64dp
 *
 * Bands come from {@link TipConfig} — a local constant today, Back Office settings later.
 * See the seam comment in that class.
 */
public final class TipScreen extends FrameLayout {

    public interface Listener {
        /** Customer chose; tipMinor may be 0. */
        void onTipChosen(long tipMinor);
    }

    private static final int NO_TIP = -1;
    private static final int CUSTOM = -2;
    /** Custom tips are capped at £500 — a mis-key on a customer-facing screen is a real risk. */
    private static final long MAX_CUSTOM_TIP_MINOR = 50_000L;

    private final Context ctx;
    /**
     * THE BILL — what tip percentages are calculated against. NOT what the card is charged.
     *
     * On a £50 meal part-paid by a £45 gift card this is 5000, so the 10% band correctly offers
     * £5.00. Using the card amount here instead would offer 50p and quietly halve every tip on
     * every gift-carded sale in the venue. See TerminalJob for the full worked example.
     */
    private final long tipBasisMinor;
    /** What the card must actually take, PRE-TIP. The pay button is due + tip, never basis + tip. */
    private final long dueMinor;
    private final TipConfig config;
    private final Listener listener;

    private int selected = NO_TIP;
    private long customTipMinor = 0L;

    private final LinearLayout mainPanel;
    private final LinearLayout bandRow;
    private final TextView totalValue;
    private final Button payButton;
    private final Button customButton;
    private final Button noTipButton;

    /**
     * The simple case: the whole bill is going on the card, so the tip basis and the amount due
     * are the same number. Used by the manual-amount path.
     */
    public TipScreen(Context c, long baseMinor, TipConfig config, Listener listener) {
        this(c, baseMinor, baseMinor, config, listener);
    }

    /**
     * The real case: a bill that may be part-paid already.
     *
     * @param tipBasisMinor the BILL — percentages are calculated on this
     * @param dueMinor      what the CARD takes pre-tip — the pay button is this plus the tip
     */
    public TipScreen(Context c, long tipBasisMinor, long dueMinor,
                     TipConfig config, Listener listener) {
        super(c);
        this.ctx = c;
        this.tipBasisMinor = tipBasisMinor;
        this.dueMinor = dueMinor;
        this.config = config;
        this.listener = listener;

        mainPanel = Ui.screen(c);
        mainPanel.setPadding(Ui.dp(c, 18), Ui.dp(c, 16), Ui.dp(c, 18), Ui.dp(c, 16));

        // ---- base amount, stated first and plainly ---------------------------------------
        LinearLayout baseCard = Ui.card(c);
        TextView baseLabel = Ui.text(c, "Your bill", 15f, Ui.MUTED, false);
        baseLabel.setGravity(Gravity.CENTER);
        TextView baseValue = Ui.text(c, Money.format(tipBasisMinor), 38f, Ui.TEXT, true);
        baseValue.setGravity(Gravity.CENTER);
        baseCard.addView(baseLabel);
        baseCard.addView(baseValue);
        // When part of the bill is already settled, say so HERE — before any tip is offered.
        // A customer shown "Your bill £50" and then asked to pay £5 deserves the sentence that
        // explains it, on the same screen, not a surprise on the pay button.
        if (dueMinor != tipBasisMinor) {
            TextView already = Ui.text(ctx,
                    Money.format(tipBasisMinor - dueMinor) + " already paid · "
                            + Money.format(dueMinor) + " left on card",
                    14f, Ui.MUTED, false);
            already.setGravity(Gravity.CENTER);
            already.setPadding(0, Ui.dp(ctx, 6), 0, 0);
            baseCard.addView(already);
        }
        mainPanel.addView(baseCard, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        mainPanel.addView(Ui.spacer(c, 18));

        TextView prompt = Ui.text(c, "Would you like to add a tip?", 19f, Ui.TEXT, true);
        prompt.setGravity(Gravity.CENTER);
        mainPanel.addView(prompt);
        mainPanel.addView(Ui.spacer(c, 12));

        // ---- percentage bands -------------------------------------------------------------
        bandRow = Ui.row(c);
        for (int i = 0; i < config.bandsTenthPercent.length; i++) {
            final int index = i;
            int tenth = config.bandsTenthPercent[i];
            long tip = TipConfig.tipFor(tipBasisMinor, tenth);   // BASIS, never `due`
            Button b = bandButton(c, TipConfig.labelFor(tenth), Money.format(tip),
                    v -> select(index));
            LinearLayout.LayoutParams lp =
                    new LinearLayout.LayoutParams(0, Ui.dp(c, 88), 1f);
            if (i > 0) lp.leftMargin = Ui.dp(c, 8);
            bandRow.addView(b, lp);
        }
        mainPanel.addView(bandRow, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        mainPanel.addView(Ui.spacer(c, 10));

        // ---- custom + no tip, side by side and equally weighted --------------------------
        LinearLayout altRow = Ui.row(c);
        customButton = Ui.secondaryButton(c, "Other amount", v -> showCustomPanel());
        noTipButton = Ui.secondaryButton(c, "No tip", v -> select(NO_TIP));

        if (config.allowCustom) {
            altRow.addView(customButton, new LinearLayout.LayoutParams(0, Ui.dp(c, 66), 1f));
        }
        if (config.allowNoTip) {
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, Ui.dp(c, 66), 1f);
            if (config.allowCustom) lp.leftMargin = Ui.dp(c, 8);
            altRow.addView(noTipButton, lp);
        }
        mainPanel.addView(altRow, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        mainPanel.addView(Ui.flexSpacer(c));

        // ---- running total ----------------------------------------------------------------
        LinearLayout totalCard = Ui.card(c);
        totalValue = Ui.text(c, "", 16f, Ui.MUTED, false);
        totalValue.setGravity(Gravity.CENTER);
        totalCard.addView(totalValue);
        mainPanel.addView(totalCard, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        mainPanel.addView(Ui.spacer(c, 10));

        // ---- the single confirming action --------------------------------------------------
        payButton = Ui.primaryButton(c, "", v -> listener.onTipChosen(currentTip()));
        mainPanel.addView(payButton, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(c, 74)));

        addView(mainPanel, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
        refresh();
    }

    /** A band key: big percentage over its cash value. */
    private Button bandButton(Context c, String pct, String cash, OnClickListener onClick) {
        Button b = Ui.button(c, pct + "\n" + cash, Ui.TEXT, Ui.SURFACE_2, 22f, onClick);
        b.setLineSpacing(0f, 1.05f);
        return b;
    }

    private void select(int index) {
        selected = index;
        refresh();
    }

    private long currentTip() {
        if (selected == NO_TIP) return 0L;
        if (selected == CUSTOM) return customTipMinor;
        if (selected >= 0 && selected < config.bandsTenthPercent.length) {
            return TipConfig.tipFor(tipBasisMinor, config.bandsTenthPercent[selected]);
        }
        return 0L;
    }

    private void refresh() {
        long tip = currentTip();
        // due + tip. NOT basis + tip — that would charge the gift-carded portion a second time.
        long total = dueMinor + tip;

        for (int i = 0; i < bandRow.getChildCount(); i++) {
            highlight(bandRow.getChildAt(i), selected == i);
        }
        highlight(noTipButton, selected == NO_TIP);
        highlight(customButton, selected == CUSTOM);

        if (tip > 0) {
            totalValue.setText(Money.format(dueMinor) + "  +  " + Money.format(tip) + " tip");
        } else {
            totalValue.setText("No tip added");
        }
        payButton.setText("Pay " + Money.format(total));
    }

    /** Selected state = accent fill. Contrast, not a subtle border — this is read at a distance. */
    private void highlight(View v, boolean on) {
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(on ? Ui.ACCENT : Ui.SURFACE_2);
        bg.setCornerRadius(Ui.dp(ctx, 12));
        if (!on) bg.setStroke(Ui.dp(ctx, 1.5f), Ui.SURFACE_2);
        v.setBackground(bg);
    }

    // -----------------------------------------------------------------------------------------
    // Custom amount
    // -----------------------------------------------------------------------------------------

    private void showCustomPanel() {
        final long[] entry = { 0L };

        LinearLayout panel = Ui.screen(ctx);
        panel.setPadding(Ui.dp(ctx, 18), Ui.dp(ctx, 16), Ui.dp(ctx, 18), Ui.dp(ctx, 16));

        TextView title = Ui.text(ctx, "Tip amount", 17f, Ui.MUTED, false);
        title.setGravity(Gravity.CENTER);
        panel.addView(title);
        panel.addView(Ui.spacer(ctx, 4));

        final TextView readout = Ui.amount(ctx, Money.format(0));
        panel.addView(readout);
        panel.addView(Ui.spacer(ctx, 12));

        Keypad keypad = new Keypad(ctx, new Keypad.Listener() {
            @Override public void onDigit(int d) {
                entry[0] = Keypad.pushDigit(entry[0], d, MAX_CUSTOM_TIP_MINOR);
                readout.setText(Money.format(entry[0]));
            }
            @Override public void onBackspace() {
                entry[0] = Keypad.popDigit(entry[0]);
                readout.setText(Money.format(entry[0]));
            }
            @Override public void onClear() {
                entry[0] = 0L;
                readout.setText(Money.format(entry[0]));
            }
        });
        panel.addView(keypad, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        panel.addView(Ui.flexSpacer(ctx));

        LinearLayout actions = Ui.row(ctx);
        Button back = Ui.secondaryButton(ctx, "Back", v -> removeView(panel));
        Button ok = Ui.primaryButton(ctx, "Add tip", v -> {
            customTipMinor = entry[0];
            selected = customTipMinor > 0 ? CUSTOM : NO_TIP;
            removeView(panel);
            refresh();
        });
        actions.addView(back, new LinearLayout.LayoutParams(0, Ui.dp(ctx, 68), 1f));
        LinearLayout.LayoutParams okLp = new LinearLayout.LayoutParams(0, Ui.dp(ctx, 68), 1.4f);
        okLp.leftMargin = Ui.dp(ctx, 8);
        actions.addView(ok, okLp);
        panel.addView(actions, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        addView(panel, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
    }
}
