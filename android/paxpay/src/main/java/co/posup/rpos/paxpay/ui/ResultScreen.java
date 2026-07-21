package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import co.posup.rpos.paxpay.BuildVersion;
import co.posup.rpos.paxpay.Money;
import co.posup.rpos.paxpay.g8.G8TransactionResult;

/**
 * The outcome screen — and the thing that makes milestone 1 TESTABLE.
 *
 * It shows exactly WHAT WOULD HAVE BEEN CHARGED: base, tip, total, and the transaction id that
 * came back. That is what lets an operator on a real terminal confirm two things without a
 * debugger: that the tip maths is right, and that the handoff to and from the STS controller
 * actually completed.
 *
 * While the G8:Cloud call is stubbed, an "approval" here is FABRICATED. The screen says so in
 * as many words — a simulated approval that looks like a real one is worse than no screen.
 */
public final class ResultScreen extends ScrollView {

    public interface Listener { void onDone(); }

    public ResultScreen(Context c, long baseMinor, long tipMinor,
                        G8TransactionResult result, Listener listener) {
        super(c);
        setBackgroundColor(Ui.BG);

        LinearLayout root = Ui.screen(c);
        root.setPadding(Ui.dp(c, 18), Ui.dp(c, 18), Ui.dp(c, 18), Ui.dp(c, 18));

        boolean approved = result != null && result.approved;
        boolean simulated = result == null || result.simulated;

        // ---- headline ---------------------------------------------------------------------
        TextView icon = Ui.text(c, approved ? "✓" : "✕", 54f,
                approved ? Ui.ACCENT : Ui.DANGER, true);
        icon.setGravity(Gravity.CENTER);
        root.addView(icon);

        TextView headline = Ui.text(c, approved ? "Approved" : "Declined", 27f,
                approved ? Ui.ACCENT : Ui.DANGER, true);
        headline.setGravity(Gravity.CENTER);
        root.addView(headline);

        if (simulated) {
            TextView fake = Ui.text(c,
                    "SIMULATED — no card was charged.\n"
                    + "The G8:Cloud call is a stub pending the vendor API.",
                    14f, Ui.WARN, true);
            fake.setGravity(Gravity.CENTER);
            fake.setPadding(0, Ui.dp(c, 8), 0, 0);
            root.addView(fake);
        }

        root.addView(Ui.spacer(c, 18));

        // ---- the maths, itemised ------------------------------------------------------------
        long total = baseMinor + tipMinor;
        LinearLayout amounts = Ui.card(c);
        amounts.addView(Ui.line(c, "Base", Money.format(baseMinor), 18f, Ui.MUTED, false));
        amounts.addView(Ui.spacer(c, 10));
        amounts.addView(Ui.line(c, "Tip", Money.format(tipMinor), 18f, Ui.MUTED, false));
        amounts.addView(Ui.spacer(c, 12));
        amounts.addView(Ui.line(c, "Total", Money.format(total), 25f, Ui.TEXT, true));
        root.addView(amounts, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        root.addView(Ui.spacer(c, 12));

        // ---- transaction detail ---------------------------------------------------------------
        LinearLayout detail = Ui.card(c);
        detail.addView(Ui.line(c, "Transaction",
                result == null || result.transactionId == null ? "—" : result.transactionId,
                13f, Ui.MUTED, false));
        if (result != null && result.authCode != null) {
            detail.addView(Ui.spacer(c, 8));
            detail.addView(Ui.line(c, "Auth code", result.authCode, 13f, Ui.MUTED, false));
        }
        if (result != null && result.scheme != null) {
            detail.addView(Ui.spacer(c, 8));
            detail.addView(Ui.line(c, "Card", result.scheme
                    + (result.maskedPan == null ? "" : "  " + result.maskedPan),
                    13f, Ui.MUTED, false));
        }
        if (result != null && result.declineReason != null) {
            detail.addView(Ui.spacer(c, 8));
            detail.addView(Ui.line(c, "Reason", result.declineReason, 13f, Ui.DANGER, false));
        }
        detail.addView(Ui.spacer(c, 8));
        detail.addView(Ui.line(c, "Build", BuildVersion.VERSION, 13f, Ui.MUTED, false));
        root.addView(detail, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        root.addView(Ui.spacer(c, 20));

        root.addView(Ui.primaryButton(c, "New payment", v -> listener.onDone()),
                Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(c, 70)));

        addView(root);
    }
}
