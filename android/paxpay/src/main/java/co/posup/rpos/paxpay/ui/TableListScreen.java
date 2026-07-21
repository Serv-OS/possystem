package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import java.util.List;

import co.posup.rpos.paxpay.Money;
import co.posup.rpos.paxpay.model.OpenTable;

/**
 * The open tables, from terminal_open_tables(). Pick one, take the WHOLE bill.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * NO SPLITS. This is a settled product decision, not an omission.
 *
 * Splitting stays on the POS, where there is screen space to show items and a keyboard to argue
 * about them with. A 5" terminal held at a table is the wrong place to divide a bill six ways,
 * and the server-side mutex (one live job per check_key) assumes one payment per check anyway.
 * If a table wants to split, the waiter splits it on the till and the terminal takes each leg.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Each row states the table, who is serving it, and the total — enough for a waiter to be sure
 * they picked the right one before they hand the terminal over. The amount is repeated on the
 * confirm screen for exactly that reason.
 */
public final class TableListScreen extends SwipeRefreshLayout {

    public interface Listener {
        void onTableChosen(OpenTable table);
        void onRefresh();
        void onBack();
    }

    private final Context ctx;
    private final LinearLayout list;
    private final Listener listener;

    public TableListScreen(Context c, String staffName, Listener listener) {
        super(c);
        this.ctx = c;
        this.listener = listener;
        setBackgroundColor(Ui.BG);
        setColorSchemeColors(Ui.ACCENT);
        setProgressBackgroundColorSchemeColor(Ui.SURFACE);

        LinearLayout root = Ui.screen(c);
        root.setPadding(Ui.dp(c, 14), Ui.dp(c, 12), Ui.dp(c, 14), Ui.dp(c, 12));

        root.addView(Ui.title(c, "Open tables"));
        TextView who = Ui.text(c,
                staffName == null ? "" : "Signed in as " + staffName, 14f, Ui.MUTED, false);
        who.setGravity(Gravity.CENTER);
        root.addView(who);
        root.addView(Ui.spacer(c, 10));

        list = Ui.screen(c);
        ScrollView scroller = new ScrollView(c);
        scroller.addView(list, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));
        root.addView(scroller, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        root.addView(Ui.spacer(c, 10));
        root.addView(Ui.secondaryButton(c, "Back", v -> listener.onBack()),
                Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(c, 62)));

        addView(root, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
        setOnRefreshListener(listener::onRefresh);
    }

    /** Replace the list. Null tables = still loading; empty = genuinely nothing open. */
    public void setTables(List<OpenTable> tables, String errorMessage) {
        setRefreshing(false);
        list.removeAllViews();

        if (errorMessage != null) {
            list.addView(Ui.banner(ctx, errorMessage, Ui.DANGER, 0xFFFFFFFF),
                    Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                            LinearLayout.LayoutParams.WRAP_CONTENT));
            list.addView(Ui.spacer(ctx, 12));
        }

        if (tables == null) {
            list.addView(centred("Loading…"));
            return;
        }
        if (tables.isEmpty()) {
            list.addView(centred("No open tables.\nPull down to refresh."));
            return;
        }

        for (OpenTable t : tables) {
            list.addView(row(t), Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT));
            list.addView(Ui.spacer(ctx, 8));
        }
    }

    private TextView centred(String s) {
        TextView t = Ui.text(ctx, s, 16f, Ui.MUTED, false);
        t.setGravity(Gravity.CENTER);
        t.setPadding(0, Ui.dp(ctx, 40), 0, 0);
        return t;
    }

    private View row(OpenTable t) {
        LinearLayout card = Ui.card(ctx);
        card.setOrientation(LinearLayout.HORIZONTAL);
        card.setGravity(Gravity.CENTER_VERTICAL);
        card.setMinimumHeight(Ui.dp(ctx, 78));   // comfortably above the 64dp touch floor

        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Ui.SURFACE);
        bg.setCornerRadius(Ui.dp(ctx, 14));
        card.setBackground(bg);

        LinearLayout left = Ui.screen(ctx);
        left.setBackgroundColor(0x00000000);
        left.addView(Ui.text(ctx, t.label, 22f, Ui.TEXT, true));
        String meta = t.serverName == null ? "" : t.serverName;
        if (!meta.isEmpty()) left.addView(Ui.text(ctx, meta, 14f, Ui.MUTED, false));
        card.addView(left, new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        // A table whose total we could not read shows a dash, not "£0.00" — a zero on a bill is
        // a number a waiter might believe.
        String amount = t.totalMinor > 0 ? Money.format(t.totalMinor) : "—";
        card.addView(Ui.text(ctx, amount, 24f, t.totalMinor > 0 ? Ui.TEXT : Ui.MUTED, true));

        card.setOnClickListener(v -> listener.onTableChosen(t));
        return card;
    }
}
