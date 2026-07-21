package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.graphics.Typeface;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * First run: the terminal has registered itself and is waiting for a manager to adopt it.
 *
 * UNTIL PAIRED THIS APP DOES NOTHING ELSE. Not "does less" — nothing. There is no skip, no
 * demo mode, no manual-amount escape hatch. An unpaired terminal has no venue, so it has no
 * tip rules, no staff list, and nowhere to write a closed check; a payment taken on one would
 * be money with no home. The home screen is unreachable from here by design.
 *
 * THE CODE. A manager reads it off this screen and types it into Back Office → Card Readers.
 * It is therefore rendered as large as the screen allows, monospaced and letter-spaced, because
 * it will be read across a bar in bad light and mis-typed codes are the whole failure mode.
 */
public final class PairingScreen extends ScrollView {

    public interface Listener {
        /** Re-run register_terminal_device — used both to retry a failure and to poll for adoption. */
        void onRefresh();
        void onDiagnostics();
    }

    public PairingScreen(Context c, String claimCode, String status, String errorMessage,
                         boolean busy, Listener listener) {
        super(c);
        setBackgroundColor(Ui.BG);

        LinearLayout root = Ui.screen(c);
        root.setPadding(Ui.dp(c, 20), Ui.dp(c, 22), Ui.dp(c, 20), Ui.dp(c, 20));
        root.setGravity(Gravity.CENTER_HORIZONTAL);

        root.addView(Ui.title(c, "Set up this terminal"));
        root.addView(Ui.spacer(c, 6));

        TextView sub = Ui.text(c,
                "Open Back Office → Card Readers and enter this code.",
                15f, Ui.MUTED, false);
        sub.setGravity(Gravity.CENTER);
        root.addView(sub);
        root.addView(Ui.spacer(c, 22));

        if (errorMessage != null) {
            root.addView(Ui.banner(c, errorMessage, Ui.DANGER, 0xFFFFFFFF),
                    Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                            LinearLayout.LayoutParams.WRAP_CONTENT));
            root.addView(Ui.spacer(c, 18));
        }

        // ---- the code -------------------------------------------------------------------
        LinearLayout codeCard = Ui.card(c);
        codeCard.setGravity(Gravity.CENTER);

        if (claimCode != null && !claimCode.isEmpty()) {
            TextView code = new TextView(c);
            code.setText(claimCode.toUpperCase(java.util.Locale.UK));
            code.setTextColor(Ui.TEXT);
            code.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
            // 40sp with generous letter spacing: legible from across a room, which is where the
            // manager with the laptop actually is.
            code.setTextSize(TypedValue.COMPLEX_UNIT_SP, 40f);
            code.setLetterSpacing(0.22f);
            code.setGravity(Gravity.CENTER);
            code.setTextIsSelectable(true);
            codeCard.addView(code);
        } else {
            TextView pending = Ui.text(c, busy ? "Registering…" : "No code yet", 22f, Ui.MUTED, true);
            pending.setGravity(Gravity.CENTER);
            codeCard.addView(pending);
        }

        root.addView(codeCard, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));
        root.addView(Ui.spacer(c, 16));

        TextView statusLine = Ui.text(c,
                "Status: " + (status == null ? "unknown" : status), 15f, Ui.MUTED, false);
        statusLine.setGravity(Gravity.CENTER);
        root.addView(statusLine);

        root.addView(Ui.spacer(c, 10));
        TextView hint = Ui.text(c,
                "This screen checks for itself every few seconds. "
                        + "Tap Check now if the code has just been entered.",
                13f, Ui.MUTED, false);
        hint.setGravity(Gravity.CENTER);
        root.addView(hint);

        root.addView(Ui.spacer(c, 24));
        root.addView(Ui.primaryButton(c, busy ? "Checking…" : "Check now", v -> listener.onRefresh()),
                Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(c, 68)));
        root.addView(Ui.spacer(c, 10));
        root.addView(Ui.secondaryButton(c, "Diagnostics", v -> listener.onDiagnostics()),
                Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(c, 60)));

        addView(root);
    }
}
