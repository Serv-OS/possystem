package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.text.format.DateUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.List;

import co.posup.rpos.paxpay.Money;
import co.posup.rpos.paxpay.store.JobLog;

/**
 * The blocking screen for a payment whose outcome nobody knows.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS BLOCKS THE TERMINAL
 *
 * This screen appears when the app was killed after the card was presented and before the
 * outcome was read. There is no button on it that resolves the money, because this device
 * genuinely cannot know: until Ryft ship the G8:Cloud spec nothing can query the processor.
 *
 * So the only honest options are the two on offer — go and look at the Ryft dashboard, or take
 * it to a manager. What is NOT on offer is "retry", and that absence is the point. Retrying a
 * payment that may have succeeded is the double charge; dismissing it is the lost sale. The
 * terminal stops instead, because a warning nobody is forced to read is a warning nobody reads.
 *
 * Acknowledging clears the block on THIS DEVICE only. The server-side row stays `unknown` and
 * needs_human, for the back-office queue to settle properly.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS SCREEN IS AMBER AND NOT CORAL
 *
 * The ServOS palette reserves Coral for DECLINED and for genuine failure. Nothing here has
 * failed. These payments are *unresolved* — the machine simply never heard the answer — and
 * dressing an unresolved payment as an error is actively harmful: staff learn that red screens
 * on this terminal are noise, and the one card that really was charged twice gets waved through
 * with the rest. Amber is the palette's "attention, not error" token (it is what HELD tables
 * use), so amber is what carries this screen: a hollow amber ring per card, an amber caption
 * over the amount, an amber-labelled acknowledge button.
 *
 * The acknowledge button is deliberately the QUIETEST thing on each card — a ghost, never a
 * filled slab, and never Signal green. It resolves nothing; it only admits that a human looked.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
public final class UnresolvedScreen extends ScrollView {

    public interface Listener {
        /** A human has checked this one and is clearing the block on this terminal. */
        void onAcknowledge(JobLog.Entry entry);
        void onDiagnostics();
    }

    public UnresolvedScreen(Context c, List<JobLog.Entry> entries, Listener listener) {
        super(c);
        setBackgroundColor(Ui.INK);

        // panel(), not screen(): MainActivity's chrome is already the grid-painting root.
        LinearLayout root = Ui.panel(c);
        Ui.contentPadding(c, root);

        int count = entries == null ? 0 : entries.size();

        // ── running head: mono eyebrow left, hollow-amber count pill right ────────────────────
        LinearLayout head = Ui.rowCentered(c);
        head.addView(Ui.monoHead(c, "PAYMENT LOG", Ui.ASH),
                new LinearLayout.LayoutParams(0, -2, 1f));
        head.addView(Ui.statusPill(c, count + " UNRESOLVED", Ui.PILL_HELD),
                new LinearLayout.LayoutParams(-2, -2));
        root.addView(head, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        root.addView(Ui.spacer(c, 14));
        root.addView(Ui.title(c, "Outcome unknown"));
        root.addView(Ui.spacer(c, 12));

        // ── the honest headline, on soft amber rather than a full-bleed coral banner ──────────
        root.addView(callout(c,
                        "This terminal stopped while a card was being taken. "
                                + "The payment may or may not have gone through."),
                Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT));

        root.addView(Ui.spacer(c, 12));

        TextView explain = Ui.text(c,
                "Check the Ryft dashboard or the customer's receipt BEFORE taking "
                        + "payment again — charging a second time is the risk here.",
                Ui.SP_BODY, Ui.ASH, 400);
        explain.setLineSpacing(0f, 1.35f);
        root.addView(explain);
        root.addView(Ui.spacer(c, 18));

        if (entries != null) {
            for (JobLog.Entry e : entries) {
                root.addView(card(c, e, listener), Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT));
                root.addView(Ui.spacer(c, Ui.GAP_TILE));
            }
        }

        root.addView(Ui.spacer(c, 6));
        root.addView(Ui.secondaryButton(c, "Diagnostics", v -> listener.onDiagnostics()),
                Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(c, Ui.H_GHOST)));

        addView(root);
    }

    /** Soft-amber attention strip: hollow ring, then a sentence a human has to read. */
    private LinearLayout callout(Context c, String message) {
        LinearLayout box = Ui.row(c);
        box.setBackground(Ui.surface(c, Ui.AMBER_SOFT, Ui.AMBER_SOFT_EDGE, Ui.R_CARD));
        box.setPadding(Ui.dp(c, 14), Ui.dp(c, 13), Ui.dp(c, 14), Ui.dp(c, 13));  // after the bg

        View ring = Ui.dot(c, Ui.AMBER, 8, true);
        LinearLayout.LayoutParams rlp = (LinearLayout.LayoutParams) ring.getLayoutParams();
        rlp.topMargin = Ui.dp(c, 4);            // optically align the ring to the first line
        box.addView(ring);
        box.addView(Ui.spacerH(c, 11));

        TextView t = Ui.text(c, message, Ui.SP_TILE_SUB, Ui.MIST, 500);
        t.setLineSpacing(0f, 1.35f);
        box.addView(t, new LinearLayout.LayoutParams(0, -2, 1f));
        return box;
    }

    private LinearLayout card(Context c, JobLog.Entry e, Listener listener) {
        // Coal card, amber-tinted edge — the ServOS card, wearing the attention token.
        LinearLayout card = Ui.card(c, Ui.AMBER_SOFT_EDGE);

        // ── header: card-chip glyph, what it was, and the UNKNOWN pill ────────────────────────
        LinearLayout header = Ui.rowCentered(c);
        header.addView(Ui.iconChip(c, Icons.chip(Ui.AMBER), Ui.GRAPHITE, Ui.AMBER, 30, 9f));
        header.addView(Ui.spacerH(c, 11));

        TextView label = Ui.text(c, e.label == null ? "Payment" : e.label,
                Ui.SP_TILE_TITLE, Ui.MIST, 700);
        label.setLetterSpacing(-0.01f);
        label.setMaxLines(2);
        header.addView(label, new LinearLayout.LayoutParams(0, -2, 1f));

        header.addView(Ui.spacerH(c, 8));
        header.addView(Ui.statusPill(c, "UNKNOWN", Ui.PILL_HELD),
                new LinearLayout.LayoutParams(-2, -2));
        card.addView(header, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        card.addView(Ui.spacer(c, 14));

        // ── the number, under a caption that never claims more than we know ──────────────────
        card.addView(Ui.monoHead(c, "May have been charged", Ui.AMBER));
        card.addView(Ui.spacer(c, 5));
        TextView charged = Ui.text(c, Money.format(e.chargeMinor, e.currency),
                Ui.SP_TABLE_AMOUNT, Ui.AMBER, 700);
        charged.setLetterSpacing(-0.01f);
        card.addView(charged);

        card.addView(Ui.spacer(c, 14));

        // ── the facts, in mono, so a manager can read them straight onto the dashboard ───────
        LinearLayout meta = Ui.metaBlock(c);
        Ui.addMetaRow(c, meta, "Amount due", Money.format(e.dueMinor, e.currency));
        Ui.addMetaRow(c, meta, "Tip", Money.format(e.tipMinor, e.currency));

        String when = DateUtils.getRelativeTimeSpanString(
                e.createdAt, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS).toString();
        Ui.addMetaRow(c, meta, "When", when, Ui.ASH);

        if (e.jobId != null) Ui.addMetaRow(c, meta, "Reference", e.jobId, Ui.ASH);
        if (e.transactionId != null) Ui.addMetaRow(c, meta, "Transaction", e.transactionId, Ui.ASH);
        // Purely factual, straight off the write-ahead log row — it is the first thing anyone
        // reconciling this against the dashboard will be asked for.
        if (e.state != null) Ui.addMetaRow(c, meta, "Log state", e.state, Ui.ASH);

        card.addView(meta, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        card.addView(Ui.spacer(c, 16));

        TextView warn = Ui.text(c,
                "Only clear this once someone has actually checked whether the card was charged.",
                Ui.SP_TILE_SUB, Ui.AMBER, 400);
        warn.setGravity(Gravity.CENTER);
        warn.setLineSpacing(0f, 1.3f);
        card.addView(warn);
        card.addView(Ui.spacer(c, 10));

        // Ghost, amber-labelled. Not green — it fixes nothing. Not coral — nothing has failed.
        // The quietest control on the card, because pressing it should be a decision.
        Button ack = Ui.ghostButton(c, "I have checked this payment",
                v -> listener.onAcknowledge(e));
        ack.setTextColor(Ui.AMBER);
        card.addView(ack, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(c, Ui.H_GHOST)));

        return card;
    }
}
