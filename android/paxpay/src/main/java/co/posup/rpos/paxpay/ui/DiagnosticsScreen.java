package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.graphics.Typeface;
import android.util.TypedValue;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * Full diagnostics report — the reason milestone 1 can be tested on a sealed terminal.
 *
 * Reached by tapping the footer line on any screen. Shows everything needed to tell WHY a run
 * behaved as it did: which controller package resolved, whether the launch intent was found,
 * whether DEVICE_CONNECTED arrived (and what extras came with it), elapsed timings, the last
 * activity result code, and a timestamped event log.
 *
 * This is the native counterpart of window.RPOS_VERSION + on-screen diagnostics in the web app:
 * you should never need `adb logcat` to find out what happened on a terminal.
 */
public final class DiagnosticsScreen extends ScrollView {

    public interface Listener { void onClose(); }

    public DiagnosticsScreen(Context c, String report, Listener listener) {
        super(c);
        setBackgroundColor(Ui.BG);

        LinearLayout root = Ui.screen(c);
        root.setPadding(Ui.dp(c, 14), Ui.dp(c, 14), Ui.dp(c, 14), Ui.dp(c, 14));

        TextView title = Ui.text(c, "Diagnostics", 21f, Ui.TEXT, true);
        root.addView(title);
        root.addView(Ui.spacer(c, 10));

        // Monospace: the report is aligned key/value text and a log, not prose.
        TextView body = new TextView(c);
        body.setText(report);
        body.setTextColor(Ui.TEXT);
        body.setTypeface(Typeface.MONOSPACE);
        body.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f);
        body.setTextIsSelectable(true);   // so it can be copied off the device
        root.addView(body);

        root.addView(Ui.spacer(c, 18));
        root.addView(Ui.secondaryButton(c, "Close", v -> listener.onClose()),
                Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(c, 64)));

        addView(root);
    }
}
