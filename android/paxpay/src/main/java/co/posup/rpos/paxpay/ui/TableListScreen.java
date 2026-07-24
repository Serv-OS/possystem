package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Locale;

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
 * Each card states the table, who is serving it, and the total — enough for a waiter to be sure
 * they picked the right one before they hand the terminal over. The amount is repeated on the
 * confirm screen for exactly that reason.
 *
 * ═══ WHAT THIS SCREEN CAN AND CANNOT SHOW ═══════════════════════════════════════════════════
 * ServOS design screen 02 draws each card's footer as "N COVERS · HH:MM" and gives the cards two
 * status pills, OPEN and HELD. terminal_open_tables() returns neither a cover count nor a status:
 * {@link OpenTable} carries tableId, label, sessionId, totalMinor, serverName and openedAt, and
 * that is the whole of it. Nothing here is invented to fill a slot in the drawing:
 *
 *   - COVERS → the SERVER'S NAME, which is real, is what the old list showed, and is what a
 *     waiter actually uses to recognise their own table across a busy floor.
 *   - HELD  → a table whose total we could not read. That is a genuine second state and it is
 *     genuine "attention, not an error": OpenTable's own note says such a table is NOT payable
 *     and the confirm screen refuses it. Showing it in amber here means the waiter finds out at
 *     the terminal instead of at the table, with the customer waiting.
 *
 * If a cover count or a real held/locked flag is ever added to the RPC, both map onto the pills
 * already in place with no layout change.
 */
public final class TableListScreen extends SwipeRefreshLayout {

    public interface Listener {
        void onTableChosen(OpenTable table);
        void onRefresh();
        void onBack();
    }

    /** Two columns, as the design draws it. */
    private static final int COLUMNS = 2;
    /** Card floor. Well above the 64dp touch minimum — these are hit on a moving terminal. */
    private static final int CARD_MIN_H = 112;

    private final Context ctx;
    private final Listener listener;

    private final LinearLayout headHolder;    // running head — rebuilt so the clock is current
    private final LinearLayout countHolder;   // "N OPEN" beside the title
    private final LinearLayout list;

    public TableListScreen(Context c, String staffName, Listener listener) {
        super(c);
        this.ctx = c;
        this.listener = listener;
        setBackgroundColor(Ui.INK);
        setColorSchemeColors(Ui.SIGNAL);
        setProgressBackgroundColorSchemeColor(Ui.COAL);

        // panel(), not screen(): MainActivity's chrome is already a screen() and owns the console
        // grid. See the note on Ui.screen().
        LinearLayout root = Ui.panel(c);
        Ui.contentPadding(c, root);

        // ── running head: "‹ HOME" / "● LIVE · 21:45" ────────────────────────────────────────
        headHolder = Ui.row(c);
        root.addView(headHolder, Ui.lp(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));
        refreshHead();

        root.addView(Ui.spacer(c, 14));

        // ── title row: "Open tables"  +  "N OPEN" ────────────────────────────────────────────
        LinearLayout titleRow = Ui.rowCentered(c);
        titleRow.addView(Ui.title(c, "Open tables"),
                new LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f));
        countHolder = Ui.rowCentered(c);
        titleRow.addView(countHolder, Ui.lp(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT));
        root.addView(titleRow, Ui.lp(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));

        root.addView(Ui.spacer(c, 6));

        // ── hint ─────────────────────────────────────────────────────────────────────────────
        root.addView(Ui.text(c, "Tap a table to take the bill.", Ui.SP_TILE_SUB, Ui.ASH, 400));

        // Who is signed in stays on the screen — a terminal passed between staff mid-service is
        // the normal case, and the previous design said so. It is just quieter now.
        if (staffName != null && !staffName.isEmpty()) {
            root.addView(Ui.spacer(c, 5));
            TextView who = Ui.mono(c, "SIGNED IN · " + staffName,
                    Ui.SP_META_SMALL, Ui.ASH, 1.5f, 19f);
            who.setAllCaps(true);
            who.setMaxLines(1);
            who.setEllipsize(TextUtils.TruncateAt.END);
            root.addView(who);
        }

        root.addView(Ui.spacer(c, 14));

        // ── the grid, filling the remaining height ───────────────────────────────────────────
        list = new LinearLayout(c);
        list.setOrientation(LinearLayout.VERTICAL);
        // The selected card carries a green drop glow; a clipping ancestor would eat it.
        list.setClipChildren(false);
        list.setClipToPadding(false);

        ScrollView scroller = new ScrollView(c);
        scroller.setClipChildren(false);
        scroller.setClipToPadding(false);
        scroller.setFillViewport(true);
        scroller.addView(list, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));
        root.addView(scroller, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        // Structure preserved deliberately: SwipeRefreshLayout takes the non-scrolling root as its
        // target, exactly as before, so pull-to-refresh behaves identically to the old screen.
        addView(root, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
        setOnRefreshListener(listener::onRefresh);
    }

    /** Replace the list. Null tables = still loading; empty = genuinely nothing open. */
    public void setTables(List<OpenTable> tables, String errorMessage) {
        setRefreshing(false);
        list.removeAllViews();
        refreshHead();
        setCount(errorMessage == null && tables != null && !tables.isEmpty() ? tables.size() : -1);

        if (errorMessage != null) {
            list.addView(errorCard(errorMessage), Ui.lp(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT));
            // Deliberately no "no open tables" underneath. We did not read the floor, so we must
            // not report it as empty — an empty floor and an unreadable one are different facts
            // and only one of them means "stop looking for your table".
            if (tables == null || tables.isEmpty()) return;
            list.addView(Ui.spacer(ctx, Ui.GAP_GRID));
        }

        if (tables == null) {
            list.addView(emptyState("Loading…", "Reading the open tables from the till."));
            return;
        }
        if (tables.isEmpty()) {
            list.addView(emptyState("No open tables",
                    "Nothing is open on the floor right now.\nPull down to refresh."));
            return;
        }

        for (int i = 0; i < tables.size(); i += COLUMNS) {
            if (i > 0) list.addView(Ui.spacer(ctx, Ui.GAP_GRID));
            list.addView(gridRow(tables, i), Ui.lp(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT));
        }
    }

    // ═══ HEAD ════════════════════════════════════════════════════════════════════════════════

    /** "‹ HOME" on the left, "● LIVE · 21:45" on the right. The clock is rebuilt on every load. */
    private void refreshHead() {
        headHolder.removeAllViews();
        String clock = nowHhMm();
        headHolder.addView(Ui.runningHead(ctx, "Home", v -> listener.onBack(),
                        clock == null ? "LIVE" : "LIVE · " + clock, true),
                Ui.lp(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));
    }

    /** -1 clears the counter. */
    private void setCount(int n) {
        countHolder.removeAllViews();
        if (n < 0) return;
        countHolder.addView(Ui.monoHead(ctx, n + " OPEN", Ui.ASH));
    }

    // ═══ GRID ════════════════════════════════════════════════════════════════════════════════

    /** One row of the 2-column grid, starting at {@code from}. */
    private LinearLayout gridRow(List<OpenTable> tables, int from) {
        LinearLayout r = Ui.row(ctx);
        r.setClipChildren(false);
        r.setClipToPadding(false);
        for (int col = 0; col < COLUMNS; col++) {
            if (col > 0) r.addView(Ui.spacerH(ctx, Ui.GAP_GRID));
            int idx = from + col;
            // A trailing odd table keeps its column width — a lone full-bleed card at the bottom
            // of a grid reads as a different kind of thing, which it is not.
            View cell = idx < tables.size() ? tableCard(tables.get(idx)) : new View(ctx);
            // HEIGHT IS WRAP_CONTENT, NOT MATCH_PARENT.
            //
            // These cards live inside a ScrollView, which measures its content with an UNBOUNDED
            // height so the content can be taller than the screen and scroll. A child asking for
            // MATCH_PARENT height against an unbounded parent resolves to ZERO — and because the
            // resolution forces an exact 0/1px spec on the card, even its own setMinimumHeight(112)
            // floor is overridden. The result was 9 cards, all one pixel tall: "9 OPEN" with a
            // blank floor. Same failure as the home tiles — a weighted/MATCH_PARENT height with no
            // bounded parent to resolve against.
            //
            // WRAP_CONTENT lets each card measure to its own content, and the 112dp minimum then
            // applies as intended. The width weight is untouched, so the two columns still split
            // evenly. Cards in a row size independently; with uniform card content their heights
            // match anyway.
            r.addView(cell, new LinearLayout.LayoutParams(
                    0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        }
        return r;
    }

    /**
     * One table card: Coal, Graphite border, mono label + status pill, the amount, then the
     * server and the time it opened.
     */
    private View tableCard(final OpenTable t) {
        final boolean payable = t.totalMinor > 0;

        final LinearLayout card = new LinearLayout(ctx);
        card.setOrientation(LinearLayout.VERTICAL);
        applyCardSkin(card, false);
        card.setMinimumHeight(Ui.dp(ctx, CARD_MIN_H));

        // ── top row: "T12" + pill ────────────────────────────────────────────────────────────
        // v2.0-rc10: the table label IS what a waiter scans the grid for — it was 9.5sp micro
        // mono (unreadable at arm's length on an A50, owner-reported). Now tile-title size,
        // bold, high-contrast; the amount stays big below it.
        LinearLayout top = Ui.rowCentered(ctx);
        TextView label = Ui.text(ctx, t.label, Ui.SP_TILE_TITLE, Ui.MIST, 800);
        label.setMaxLines(1);
        label.setEllipsize(TextUtils.TruncateAt.END);
        top.addView(label, new LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f));
        top.addView(Ui.spacerH(ctx, 4));
        top.addView(payable
                ? Ui.statusPill(ctx, "Open", Ui.PILL_OPEN)
                : Ui.statusPill(ctx, "No total", Ui.PILL_HELD));
        card.addView(top, Ui.lp(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));

        card.addView(Ui.spacer(ctx, 10));

        // A table whose total we could not read shows a dash, not "£0.00" — a zero on a bill is
        // a number a waiter might believe.
        TextView amount = Ui.text(ctx, payable ? Money.format(t.totalMinor) : "—",
                Ui.SP_TABLE_AMOUNT, payable ? Ui.MIST : Ui.ASH, 600);
        amount.setMaxLines(1);
        try {
            // Two columns is not much room for a four-figure bill. The type gives way before the
            // digits do — same rule as Ui.amount(). setTextSize must not follow this call.
            amount.setAutoSizeTextTypeUniformWithConfiguration(
                    15, (int) Ui.SP_TABLE_AMOUNT, 1, android.util.TypedValue.COMPLEX_UNIT_SP);
        } catch (Throwable ignored) {
            // A fixed size is a fine fallback; never fail constructing a payment screen.
        }
        card.addView(amount, Ui.lp(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));

        // ── footer: "JANE · 21:45" — whichever halves we actually have ───────────────────────
        String footer = footerFor(t);
        if (footer != null) {
            card.addView(Ui.spacer(ctx, 8));
            // v2.0-rc10: 9.5sp → 13sp — the server + time were as unreadable as the label was.
            TextView meta = Ui.mono(ctx, footer, 13f, Ui.ASH, 1f, 19f);
            meta.setAllCaps(true);
            meta.setMaxLines(1);
            meta.setEllipsize(TextUtils.TruncateAt.END);
            card.addView(meta);
        }

        card.setOnClickListener(v -> {
            // Visual acknowledgement only — the design's selected state. It is applied before the
            // dispatch so the press is confirmed even in the instant before MainActivity swaps
            // the screen; it latches nothing and gates nothing.
            applyCardSkin(card, true);
            listener.onTableChosen(t);
        });
        return card;
    }

    /**
     * Card background + padding. Selected is the design's Signal border and green glow.
     *
     * Order matters: setBackground() re-reads padding from the drawable, so padding must follow
     * it or the card silently loses its inset. Same reason as Ui.styleButton().
     */
    private void applyCardSkin(LinearLayout card, boolean selected) {
        card.setBackground(Ui.pressable(
                Ui.surface(ctx, Ui.COAL, selected ? Ui.SIGNAL : Ui.GRAPHITE, Ui.R_CARD)));
        int p = Ui.dp(ctx, Ui.PAD_CARD);
        card.setPadding(p, p, p, p);
        if (selected) Ui.greenGlow(ctx, card, 9);
    }

    // ═══ STATES ══════════════════════════════════════════════════════════════════════════════

    /** Loading and empty share one calm, centred treatment. */
    private View emptyState(String title, String body) {
        LinearLayout l = new LinearLayout(ctx);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setGravity(Gravity.CENTER);
        l.setPadding(0, Ui.dp(ctx, 30), 0, Ui.dp(ctx, 30));

        l.addView(Ui.iconChip(ctx, Icons.table(Ui.SIGNAL), false));
        l.addView(Ui.spacer(ctx, 16));
        l.addView(Ui.stateTitle(ctx, title));
        l.addView(Ui.spacer(ctx, 8));

        TextView b = Ui.text(ctx, body, Ui.SP_TILE_SUB, Ui.ASH, 400);
        b.setGravity(Gravity.CENTER);
        b.setLineSpacing(0f, 1.4f);
        l.addView(b);

        LinearLayout wrap = new LinearLayout(ctx);
        wrap.setOrientation(LinearLayout.VERTICAL);
        wrap.setGravity(Gravity.CENTER);
        wrap.addView(l, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        wrap.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT));
        return wrap;
    }

    /**
     * A failed read of the floor. Coral, because a waiter standing at a table who cannot see the
     * bill is stuck — this is the one thing on the screen that has genuinely gone wrong.
     */
    private View errorCard(String message) {
        LinearLayout l = new LinearLayout(ctx);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setBackground(Ui.surface(ctx, Ui.CORAL_SOFT, Ui.CORAL_SOFT_EDGE, Ui.R_CARD));
        int p = Ui.dp(ctx, Ui.PAD_CARD);
        l.setPadding(p, p, p, p);   // after the background — see applyCardSkin()

        TextView head = Ui.mono(ctx, "Could not read the floor", Ui.SP_PILL, Ui.CORAL, 1.2f, 19f);
        head.setAllCaps(true);
        l.addView(head);
        l.addView(Ui.spacer(ctx, 7));
        l.addView(Ui.text(ctx, message, Ui.SP_TILE_SUB, Ui.MIST, 400));
        l.addView(Ui.spacer(ctx, 7));
        l.addView(Ui.text(ctx, "Pull down to try again.", Ui.SP_TILE_SUB, Ui.ASH, 400));
        return l;
    }

    // ═══ TIME ════════════════════════════════════════════════════════════════════════════════

    private static final DateTimeFormatter HH_MM =
            DateTimeFormatter.ofPattern("HH:mm", Locale.UK);

    /** "JANE · 21:45", or whichever half exists, or null when neither does. */
    private static String footerFor(OpenTable t) {
        String server = (t.serverName == null || t.serverName.isEmpty()) ? null : t.serverName;
        String opened = hhMm(t.openedAt);
        if (server != null && opened != null) return server + " · " + opened;
        if (server != null) return server;
        return opened;
    }

    /**
     * HH:MM from whatever opened_at turns out to be, in the terminal's own timezone.
     *
     * PostgREST sends a timestamptz with an offset, which is converted to local time here — a
     * table shown as opening an hour ago because the column is UTC would be worse than no time
     * at all. An offset-LESS timestamp is read as a wall clock, the only honest reading of one.
     * Anything unparseable returns null and the card simply omits the time.
     */
    private static String hhMm(String iso) {
        if (iso == null || iso.isEmpty()) return null;
        try {
            return OffsetDateTime.parse(iso)
                    .atZoneSameInstant(ZoneId.systemDefault()).format(HH_MM);
        } catch (Throwable ignored) { /* not offset-bearing; try the next shape */ }
        try {
            return Instant.parse(iso).atZone(ZoneId.systemDefault()).format(HH_MM);
        } catch (Throwable ignored) { /* not an instant; try the next shape */ }
        try {
            return LocalDateTime.parse(iso).format(HH_MM);
        } catch (Throwable ignored) { /* unreadable — the card drops the time */ }
        return null;
    }

    private static String nowHhMm() {
        try {
            return LocalDateTime.now().format(HH_MM);
        } catch (Throwable ignored) {
            return null;   // a clock is never worth failing a payment screen for
        }
    }
}
