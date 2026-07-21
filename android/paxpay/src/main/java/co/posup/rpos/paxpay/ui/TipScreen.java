package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.graphics.Color;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

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
 *
 * ═══ THE SERVOS SKIN (visual rebuild — no logic moved) ══════════════════════════════════════
 * Rebuilt against the ServOS foundation in {@link Ui}. Every number the customer sees, every
 * call into TipConfig, and the whole selection state machine are byte-for-byte what they were;
 * only the rendering changed. Four decisions worth knowing about:
 *
 *   1. GREEN MEANS "YOU ADDED A TIP". A selected band and a selected "Other amount" get the
 *      Signal fill; "No tip" selected gets a bright MIST-edged Graphite state instead. Both are
 *      unmistakable at arm's length, but the colour that means gratuity is never used to
 *      congratulate somebody for declining one, and — just as importantly — the screen does not
 *      open with a green "No tip" button shouting at a customer who has not chosen anything yet.
 *      NO_TIP is the initial state (it always was), so its resting look has to be quiet.
 *
 *   2. NEVER CORAL. Not one pixel. Being asked for a tip is not an error, declining is not a
 *      failure, and this screen has no state that warrants the refusal colour.
 *
 *   3. THE BANDS SCROLL, THE TOTAL AND THE CTA DO NOT. Band counts come from Back Office, so
 *      this screen cannot assume three. The bill, the bands and the alternatives sit in a
 *      scroller; the running total and the pay button are pinned below it. A venue configuring
 *      six bands gets a scrollable band list, never a pay button pushed off the bottom of a
 *      customer-facing payment screen.
 *
 *   4. BANDS ARE 98dp TALL. Above the 64dp floor in {@link Ui} on purpose: this is the target a
 *      stranger presses once, quickly, on a device somebody else is holding.
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

    /** Band height. Deliberately above the 64dp floor — see note 4 in the class comment. */
    private static final int BAND_H = 98;
    /** Bands per row before wrapping. Three is what fits legibly across a 360dp panel. */
    private static final int BANDS_PER_ROW = 3;

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
    /** Band cards in CONFIG ORDER — index i is config.bandsTenthPercent[i]. */
    private final List<BandCell> bandCells = new ArrayList<>();
    private final TextView totalAmount;
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

        // panel(), not screen(): MainActivity's chrome is already a screen() and owns the grid.
        mainPanel = Ui.panel(c);
        Ui.contentPadding(c, mainPanel);
        mainPanel.setClipToPadding(false);   // the CTA's green glow must not be clipped away

        mainPanel.addView(Ui.runningHead(c, "PAYMENT", "TIP", false));
        mainPanel.addView(Ui.spacer(c, 12));

        // ---- the scrolling half: bill, prompt, bands, alternatives -------------------------
        ScrollView scroll = new ScrollView(c);
        scroll.setClipToPadding(false);
        scroll.setVerticalScrollBarEnabled(true);

        LinearLayout body = new LinearLayout(c);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setClipToPadding(false);
        body.setClipChildren(false);         // selected bands cast a green glow
        scroll.addView(body, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT));

        body.addView(billCard(c), Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        body.addView(Ui.spacer(c, 16));

        TextView prompt = Ui.text(c, "Would you like to add a tip?", 20f, Ui.MIST, 600);
        prompt.setLetterSpacing(-0.01f);
        body.addView(prompt);
        body.addView(Ui.spacer(c, 12));

        addBands(c, body);

        // ---- custom + no tip, side by side and equally weighted --------------------------
        LinearLayout altRow = Ui.row(c);
        altRow.setClipChildren(false);
        customButton = Ui.ghostButton(c, "Other amount", v -> showCustomPanel());
        noTipButton = Ui.ghostButton(c, "No tip", v -> select(NO_TIP));

        if (config.allowCustom) {
            altRow.addView(customButton,
                    new LinearLayout.LayoutParams(0, Ui.dp(c, Ui.H_GHOST), 1f));
        }
        if (config.allowNoTip) {
            LinearLayout.LayoutParams lp =
                    new LinearLayout.LayoutParams(0, Ui.dp(c, Ui.H_GHOST), 1f);
            if (config.allowCustom) lp.leftMargin = Ui.dp(c, Ui.GAP_BUTTON_ROW);
            altRow.addView(noTipButton, lp);
        }
        mainPanel.addView(scroll, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        // DECLINING MUST BE AT LEAST AS EASY AS ACCEPTING.
        //
        // This row is PINNED below the scroll, not inside it. "Pay" is pinned, so if "No tip" sat
        // in the scrolling half then at four or more bands the customer would find accepting a tip
        // one tap away and refusing one a scroll away. That asymmetry is exactly what the Tipping
        // Act 2023 and the accompanying code of practice are aimed at, and it is not something to
        // leave to whether a venue happens to configure three bands or five.
        //
        // Only the bands scroll. The bill, the prompt and the bands are the scrolling half; the
        // way OUT is always on screen.
        LinearLayout.LayoutParams altLp = Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        altLp.topMargin = Ui.dp(c, 14);
        mainPanel.addView(altRow, altLp);

        // ---- pinned: running total, then the single confirming action ----------------------
        mainPanel.addView(Ui.spacer(c, 14));
        mainPanel.addView(Ui.totalsRule(c));
        mainPanel.addView(Ui.spacer(c, 12));

        LinearLayout totalRow = Ui.rowCentered(c);
        totalRow.addView(Ui.monoHead(c, "Total to pay", Ui.ASH),
                new LinearLayout.LayoutParams(0, -2, 1f));
        totalAmount = Ui.text(c, "", 26f, Ui.SIGNAL, 700);   // 52px design
        totalAmount.setLetterSpacing(-0.02f);
        totalAmount.setMaxLines(1);
        totalAmount.setGravity(Gravity.END);
        autoSize(totalAmount, 18, 26);
        totalRow.addView(totalAmount, new LinearLayout.LayoutParams(-2, -2));
        mainPanel.addView(totalRow, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        // The breakdown under the total — the sentence that explains the number above it.
        totalValue = Ui.mono(c, "", Ui.SP_META, Ui.ASH, 1f, 21f);
        totalValue.setGravity(Gravity.END);
        LinearLayout.LayoutParams brkLp = Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        brkLp.topMargin = Ui.dp(c, 5);
        mainPanel.addView(totalValue, brkLp);

        mainPanel.addView(Ui.spacer(c, 14));

        payButton = Ui.primaryButton(c, "", v -> listener.onTipChosen(currentTip()));
        mainPanel.addView(payButton, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                Ui.dp(c, Ui.H_PRIMARY)));

        addView(mainPanel, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
        refresh();
    }

    /**
     * The bill, stated first and plainly — mono label, then the amount at display size.
     *
     * Nothing here is a control. It exists so that the first thing the customer reads is what
     * they owe, before a single tip option is offered.
     */
    private LinearLayout billCard(Context c) {
        LinearLayout billCard = Ui.card(c);
        billCard.addView(Ui.monoHead(c, "Your bill", Ui.ASH));
        billCard.addView(Ui.spacer(c, 6));

        TextView baseValue = Ui.text(c, Money.format(tipBasisMinor), 34f, Ui.MIST, 700);
        baseValue.setLetterSpacing(-0.02f);
        baseValue.setMaxLines(1);
        autoSize(baseValue, 22, 34);
        billCard.addView(baseValue, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        // When part of the bill is already settled, say so HERE — before any tip is offered.
        // A customer shown "Your bill £50" and then asked to pay £5 deserves the sentence that
        // explains it, on the same screen, not a surprise on the pay button.
        if (dueMinor != tipBasisMinor) {
            billCard.addView(Ui.spacer(c, 12));
            billCard.addView(Ui.divider(c));
            billCard.addView(Ui.spacer(c, 12));
            TextView already = Ui.text(ctx,
                    Money.format(tipBasisMinor - dueMinor) + " already paid · "
                            + Money.format(dueMinor) + " left on card",
                    Ui.SP_TILE_SUB, Ui.ASH, 400);
            already.setLineSpacing(0f, 1.35f);
            billCard.addView(already);
        }
        return billCard;
    }

    /**
     * The percentage bands, wrapped {@value #BANDS_PER_ROW} to a row.
     *
     * The band COUNT is a Back Office setting, so this lays out whatever it is given rather than
     * assuming the default three. A short final row is padded with invisible fillers so every
     * card on the screen is the same width — an odd-width card reads as a different KIND of
     * button, which on this screen it is not.
     */
    private void addBands(Context c, LinearLayout body) {
        final int n = config.bandsTenthPercent.length;
        if (n == 0) return;
        final int perRow = Math.min(n, BANDS_PER_ROW);

        LinearLayout currentRow = null;
        for (int i = 0; i < n; i++) {
            if (i % perRow == 0) {
                currentRow = Ui.row(c);
                currentRow.setClipChildren(false);
                LinearLayout.LayoutParams rowLp = Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT);
                if (i > 0) rowLp.topMargin = Ui.dp(c, Ui.GAP_GRID);
                body.addView(currentRow, rowLp);
            }

            final int index = i;
            int tenth = config.bandsTenthPercent[i];
            long tip = TipConfig.tipFor(tipBasisMinor, tenth);   // BASIS, never `due`

            BandCell cell = new BandCell(c, TipConfig.labelFor(tenth), Money.format(tip));
            cell.setOnClickListener(v -> select(index));

            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, Ui.dp(c, BAND_H), 1f);
            if (i % perRow != 0) lp.leftMargin = Ui.dp(c, Ui.GAP_GRID);
            currentRow.addView(cell, lp);
            bandCells.add(cell);
        }

        // Pad the last row so the cards stay on the same grid.
        int remainder = n % perRow;
        if (remainder != 0 && currentRow != null) {
            for (int i = remainder; i < perRow; i++) {
                View filler = new View(c);
                LinearLayout.LayoutParams lp =
                        new LinearLayout.LayoutParams(0, Ui.dp(c, BAND_H), 1f);
                lp.leftMargin = Ui.dp(c, Ui.GAP_GRID);
                currentRow.addView(filler, lp);
            }
        }
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

        for (int i = 0; i < bandCells.size(); i++) {
            bandCells.get(i).setSelectedLook(selected == i);
        }
        // A custom amount IS a tip, so it lights up green like a band. "No tip" never does —
        // see note 1 in the class comment.
        styleChoice(customButton, selected == CUSTOM, true);
        styleChoice(noTipButton, selected == NO_TIP, false);
        customButton.setText(selected == CUSTOM
                ? "Other · " + Money.format(customTipMinor)
                : "Other amount");

        if (tip > 0) {
            totalValue.setText(Money.format(dueMinor) + "  +  " + Money.format(tip) + " tip");
        } else {
            totalValue.setText("No tip added");
        }
        totalAmount.setText(Money.format(total));
        payButton.setText("Pay " + Money.format(total));
    }

    /**
     * Selected state for the two ghost choices.
     *
     * Contrast, not a subtle border — this is read at a distance, by somebody who may not have
     * their glasses on. `greenWhenOn` is what separates "you added something" from "you chose
     * not to": both are loud, only one is Signal.
     */
    private void styleChoice(Button b, boolean on, boolean greenWhenOn) {
        if (on && greenWhenOn) {
            b.setBackground(Ui.pressableOnGreen(
                    Ui.surface(ctx, Ui.SIGNAL, Color.TRANSPARENT, Ui.R_BUTTON)));
            b.setTextColor(Ui.ON_SIGNAL);
            Ui.greenGlow(ctx, b, 6);
        } else if (on) {
            b.setBackground(Ui.pressable(Ui.surface(ctx, Ui.GRAPHITE, Ui.MIST, Ui.R_BUTTON)));
            b.setTextColor(Ui.MIST);
            b.setElevation(0f);
        } else {
            b.setBackground(Ui.pressable(
                    Ui.surface(ctx, Color.TRANSPARENT, Ui.GRAPHITE, Ui.R_BUTTON)));
            b.setTextColor(Ui.MIST);
            b.setElevation(0f);
        }
        // Padding AFTER the background: setBackground() re-reads padding from the drawable and
        // would otherwise throw it away. Same rule as Ui.styleButton().
        b.setPadding(Ui.dp(ctx, 10), Ui.dp(ctx, 8), Ui.dp(ctx, 10), Ui.dp(ctx, 8));
    }

    /** Shrink-to-fit rather than truncate. A clipped amount is worse than a smaller one. */
    private static void autoSize(TextView t, int minSp, int maxSp) {
        try {
            // API 26+. setTextSize must not be called after this, so it goes last.
            t.setAutoSizeTextTypeUniformWithConfiguration(
                    minSp, maxSp, 1, TypedValue.COMPLEX_UNIT_SP);
        } catch (Throwable ignored) {
            // Fixed size is a perfectly good fallback; never fail constructing a payment screen.
        }
    }

    // -----------------------------------------------------------------------------------------
    // Band card
    // -----------------------------------------------------------------------------------------

    /**
     * One tip band: the percentage over its cash value.
     *
     * A real ViewGroup rather than a two-line Button so that BOTH lines can be recoloured when
     * the band is selected — on a Signal fill the subtitle has to become ON_SIGNAL_MUTED or it
     * disappears into the green.
     */
    private static final class BandCell extends LinearLayout {
        private final TextView pct;
        private final TextView cash;

        BandCell(Context c, String pctLabel, String cashLabel) {
            super(c);
            setOrientation(VERTICAL);
            setGravity(Gravity.CENTER);

            pct = Ui.text(c, pctLabel, 21f, Ui.MIST, 700);   // 42px design
            pct.setGravity(Gravity.CENTER);
            pct.setMaxLines(1);
            pct.setLetterSpacing(-0.01f);
            autoSize(pct, 15, 21);
            addView(pct, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));

            addView(Ui.spacer(c, 3));

            // The number a customer actually reasons about. Never smaller than the floor set by
            // autoSize, whatever the bill.
            cash = Ui.text(c, cashLabel, 15f, Ui.ASH, 500);   // 30px design
            cash.setGravity(Gravity.CENTER);
            cash.setMaxLines(1);
            autoSize(cash, 11, 15);
            addView(cash, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));

            setMinimumHeight(Ui.dp(c, BAND_H));
            setSelectedLook(false);
        }

        void setSelectedLook(boolean on) {
            Context c = getContext();
            if (on) {
                setBackground(Ui.pressableOnGreen(
                        Ui.surface(c, Ui.SIGNAL, Color.TRANSPARENT, Ui.R_TILE)));
                pct.setTextColor(Ui.ON_SIGNAL);
                cash.setTextColor(Ui.ON_SIGNAL_MUTED);
                Ui.greenGlow(c, this, 6);
            } else {
                setBackground(Ui.pressable(Ui.surface(c, Ui.COAL, Ui.GRAPHITE, Ui.R_TILE)));
                pct.setTextColor(Ui.MIST);
                cash.setTextColor(Ui.ASH);
                setElevation(0f);
            }
            // Padding after the background — see styleChoice().
            setPadding(Ui.dp(c, 6), Ui.dp(c, 8), Ui.dp(c, 6), Ui.dp(c, 8));
        }
    }

    // -----------------------------------------------------------------------------------------
    // Custom amount
    // -----------------------------------------------------------------------------------------

    private void showCustomPanel() {
        final long[] entry = { 0L };

        // panel(), not screen() — this is mounted INSIDE the TipScreen frame, over mainPanel.
        LinearLayout panel = Ui.panel(ctx);
        Ui.contentPadding(ctx, panel);
        panel.setClipToPadding(false);
        // Swallow touches. Without this a tap landing in a gap between this panel's controls
        // falls through to the tip bands still sitting live underneath it.
        panel.setClickable(true);

        panel.addView(Ui.runningHead(ctx, "Tip amount", "OPTIONAL", false));
        panel.addView(Ui.spacer(ctx, 14));

        final TextView readout = Ui.amount(ctx, Money.format(0));
        panel.addView(readout, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));
        panel.addView(Ui.spacer(ctx, 6));

        // Context while typing: what the tip is being added to.
        TextView on = Ui.monoHead(ctx, "on a bill of " + Money.format(tipBasisMinor), Ui.ASH);
        on.setGravity(Gravity.CENTER);
        panel.addView(on, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));
        panel.addView(Ui.spacer(ctx, 16));

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
        actions.setClipChildren(false);
        Button back = Ui.ghostButton(ctx, "Back", v -> removeView(panel));
        Button ok = Ui.primaryButton(ctx, "Add tip", v -> {
            customTipMinor = entry[0];
            selected = customTipMinor > 0 ? CUSTOM : NO_TIP;
            removeView(panel);
            refresh();
        });
        actions.addView(back,
                new LinearLayout.LayoutParams(0, Ui.dp(ctx, Ui.H_PRIMARY), 1f));
        LinearLayout.LayoutParams okLp =
                new LinearLayout.LayoutParams(0, Ui.dp(ctx, Ui.H_PRIMARY), 1.4f);
        okLp.leftMargin = Ui.dp(ctx, Ui.GAP_BUTTON_ROW);
        actions.addView(ok, okLp);
        panel.addView(actions, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        addView(panel, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
    }
}
