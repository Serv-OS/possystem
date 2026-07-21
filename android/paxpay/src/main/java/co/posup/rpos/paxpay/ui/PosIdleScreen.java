package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * IDLE-FIRST (v5.5.841) — what a POS-DISPATCH-ONLY terminal shows when it is doing nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY IT IS ALMOST EMPTY, ON PURPOSE
 *
 * There used to be a WaitingForPosScreen here — a spinner, a "checked 4 times" status line and a
 * Back button — for a waiter who had tapped "Waiting for POS" and was standing there watching.
 * Both that screen and that button are gone (v5.5.841): receiving from the till is ambient, not a
 * mode somebody enters, so nobody is ever standing at a terminal waiting for it to start.
 *
 * A terminal in this state lives on a counter facing a customer. A spinner would imply something
 * is pending when nothing is; a Back button would lead to a home screen with nothing on it. So
 * what is left is the venue name, the word Ready, and a small status line for whoever is
 * debugging — and no way to navigate into a mode this terminal is not allowed to offer.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * It is usually covered by the venue's screensaver within a frame of being shown. It is what is
 * underneath, and what a venue with no screensaver configured sees instead. Polling is NOT done
 * here and is not tied to this screen at all — MainActivity.ensureAmbientPolling() owns the
 * JobPoller and runs it behind every idle surface, this one included.
 */
public final class PosIdleScreen extends LinearLayout {

    private final TextView status;

    public PosIdleScreen(Context c, String venueLabel) {
        super(c);
        setOrientation(VERTICAL);
        setGravity(Gravity.CENTER);
        setBackgroundColor(Ui.BG);
        setPadding(Ui.dp(c, 24), Ui.dp(c, 24), Ui.dp(c, 24), Ui.dp(c, 20));

        TextView venue = Ui.text(c, venueLabel == null ? "Serv OS terminal" : venueLabel,
                18f, Ui.MUTED, false);
        venue.setGravity(Gravity.CENTER);
        addView(venue);
        addView(Ui.spacer(c, 10));

        TextView ready = Ui.text(c, "Ready", 40f, Ui.TEXT, true);
        ready.setGravity(Gravity.CENTER);
        addView(ready);
        addView(Ui.spacer(c, 14));

        // Small and muted on purpose. It is here so an engineer can see the poll is alive
        // without attaching a cable; it is not information a customer needs to read.
        status = Ui.text(c, "Listening for payments from the till", 13f, Ui.MUTED, false);
        status.setGravity(Gravity.CENTER);
        addView(status);
    }

    /** Driven by {@link co.posup.rpos.paxpay.JobPoller}, same as the waiting screen. */
    public void setStatus(String s) {
        if (status != null && s != null) status.setText(s);
    }
}
