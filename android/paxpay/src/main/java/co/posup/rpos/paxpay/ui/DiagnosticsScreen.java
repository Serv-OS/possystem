package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.Locale;

import co.posup.rpos.paxpay.BuildVersion;

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
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * SERVOS REBUILD — the one screen where small mono type is the correct answer.
 *
 * This is read by someone debugging, not by a customer, so density wins and the ServOS palette is
 * used for MEANING rather than decoration: Ash for keys, Mist for values, Signal only where a
 * field is genuinely healthy ("found", "RECEIVED", "paired", zero unresolved payments), Amber for
 * things that want attention but are not broken (a SIMULATED build, an unpaired terminal, a
 * non-zero unresolved count) and Coral only for genuine faults (NOT FOUND, not received, NONE, a
 * populated error field). Anything the classifier does not recognise stays Mist — an unrecognised
 * value is never guessed at, because a mis-coloured green on this screen is worse than no colour.
 *
 * THE REPORT IS A STRING, AND IT IS NOT OURS. {@link co.posup.rpos.paxpay.Diagnostics#fullReport()}
 * hands over pre-formatted text. This class parses it for presentation only, and the parser is
 * built to lose nothing: a line it does not recognise is rendered verbatim rather than dropped,
 * and if the report format changes wholesale every line simply falls through to verbatim. On top
 * of that the complete, untouched report is still rendered at the foot of the screen under RAW
 * REPORT, selectable exactly as before — so the copy-off-the-device path survives regardless of
 * what the parser makes of it, and no field can go missing on the way to the screen.
 *
 * The close affordance moved out of the scroll and into a pinned footer (hence LinearLayout rather
 * than ScrollView as the root — the constructor signature MainActivity calls is unchanged, and
 * `instanceof DiagnosticsScreen` in describeScreen is tested before its ScrollView branch). A
 * forty-event report is a long scroll, and "how do I get out of here" should not be one of the
 * things being debugged.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
public final class DiagnosticsScreen extends LinearLayout {

    public interface Listener { void onClose(); }

    /** The em dash Diagnostics wraps its section headers in, and uses for an absent value. */
    private static final String DASH = "—";

    public DiagnosticsScreen(Context c, String report, Listener listener) {
        super(c);
        setOrientation(VERTICAL);
        setBackgroundColor(Ui.INK);

        final int side = Ui.dp(c, Ui.PAD_SIDE);

        // ── Fixed header ──────────────────────────────────────────────────────────────────────
        // Build identity comes from BuildVersion, not from parsing the report: the header must be
        // right even if the report is empty or its format has moved on.
        LinearLayout head = Ui.rowCentered(c);
        head.setPadding(side, Ui.dp(c, Ui.PAD_TOP), side, Ui.dp(c, 12));
        head.addView(Ui.monoHead(c, "Diagnostics", Ui.ASH),
                new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f));
        // Not monoHead: a version string is quoted verbatim, never upper-cased.
        head.addView(Ui.mono(c, "v" + BuildVersion.VERSION, Ui.SP_META_SMALL, Ui.ASH, 1f, 19f));
        head.addView(Ui.spacerH(c, 9));
        head.addView(Ui.statusPill(c,
                BuildVersion.SIMULATED ? "Simulated" : "Live",
                BuildVersion.SIMULATED ? Ui.PILL_HELD : Ui.PILL_LIVE));
        addView(head, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));
        addView(Ui.divider(c));

        // ── Scrolling body ────────────────────────────────────────────────────────────────────
        ScrollView scroller = new ScrollView(c);
        LinearLayout body = Ui.panel(c);   // panel(), not screen() — the chrome already grids
        body.setPadding(side, Ui.dp(c, 14), side, Ui.dp(c, 16));
        render(c, body, report);
        scroller.addView(body, new ScrollView.LayoutParams(
                ScrollView.LayoutParams.MATCH_PARENT, ScrollView.LayoutParams.WRAP_CONTENT));
        addView(scroller, new LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f));

        // ── Pinned footer ─────────────────────────────────────────────────────────────────────
        LinearLayout foot = new LinearLayout(c);
        foot.setOrientation(VERTICAL);
        foot.setBackground(Ui.topHairline(c, Ui.INK));
        foot.setPadding(side, Ui.dp(c, 12), side, Ui.dp(c, Ui.PAD_BOTTOM));   // after the bg
        foot.addView(Ui.secondaryButton(c, "Close", v -> listener.onClose()),
                new LayoutParams(LayoutParams.MATCH_PARENT, Ui.dp(c, Ui.H_GHOST)));
        addView(foot, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));
    }

    // ═══ RENDERING ════════════════════════════════════════════════════════════════════════════

    /**
     * Walk the report line by line, grouping it into Coal blocks under mono section heads.
     *
     * Every branch here ends in a view. There is no path that discards a line.
     */
    private static void render(Context c, LinearLayout body, String report) {
        String text = report == null ? "" : report;
        LinearLayout block = null;

        for (String line : text.split("\n", -1)) {
            String trimmed = line.trim();
            if (trimmed.isEmpty()) continue;          // blank lines are the report's own spacing

            String section = sectionName(trimmed);
            if (section != null) {
                block = openSection(c, body, section);
                continue;
            }

            // Everything before the first "— SECTION —" is the build identity line and MODE.
            if (block == null) block = openSection(c, body, "Build");
            addLine(c, block, line);
        }

        // ── The untouched report, kept for copying off the device ─────────────────────────────
        LinearLayout raw = openSection(c, body, "Raw report · select to copy");
        TextView rawText = Ui.mono(c, text, Ui.SP_META_SMALL, Ui.ASH, 0f, 19f);
        rawText.setTextIsSelectable(true);
        raw.addView(rawText, new LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));
    }

    /** Mono head + an empty Coal block, appended to the body. Returns the block. */
    private static LinearLayout openSection(Context c, LinearLayout body, String name) {
        if (body.getChildCount() > 0) body.addView(Ui.spacer(c, 16));
        body.addView(Ui.monoHead(c, name, Ui.ASH));
        body.addView(Ui.spacer(c, 7));

        LinearLayout block = new LinearLayout(c);
        block.setOrientation(VERTICAL);
        block.setBackground(Ui.surface(c, Ui.COAL, Ui.GRAPHITE, Ui.R_KEY));
        int pad = Ui.dp(c, 13);
        block.setPadding(pad, pad, pad, pad);   // after the background
        body.addView(block, new LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));
        return block;
    }

    /** One report line, classified into the densest treatment that still shows all of it. */
    private static void addLine(Context c, LinearLayout block, String line) {
        String t = line.trim();

        // Indented continuation — the controller probe log and the DEVICE_CONNECTED extras.
        // Kept verbatim, indent and all: these are aligned dumps and re-flowing them loses
        // the alignment that makes them readable.
        if (line.startsWith("  ")) {
            addRow(c, block, 2, Ui.mono(c, line, Ui.SP_META_SMALL, Ui.ASH, 0f, 19f));
            return;
        }

        // Event log line: "[+1.4s] controller present: com.sts.…"
        if (t.startsWith("[")) {
            int close = t.indexOf("] ");
            if (close > 0) {
                addRow(c, block, 5, eventRow(c, t.substring(0, close + 1), t.substring(close + 2)));
                return;
            }
        }

        int split = t.indexOf(": ");
        if (split > 0) {
            addKeyValue(c, block, t.substring(0, split), t.substring(split + 2));
            return;
        }

        // A bare label introducing an indented block — "probe:", "broadcast extras:".
        if (t.endsWith(":") && t.length() > 1) {
            TextView label = Ui.mono(c, t.substring(0, t.length() - 1), Ui.SP_META_SMALL, Ui.ASH,
                    1f, 19f);
            label.setAllCaps(true);
            addRow(c, block, 6, label);
            return;
        }

        // Anything else — the build identity line, "Sunmi P2", "(none)". Parenthesised text is an
        // absence, so it reads as Ash; everything else is content.
        addRow(c, block, 6, Ui.mono(c, t, Ui.SP_META,
                t.startsWith("(") ? Ui.ASH : Ui.MIST, 0f, 21f));
    }

    /**
     * A key/value pair. Laid out on one line where it fits, stacked where it does not.
     *
     * The stacked form exists because a right-aligned value cannot be allowed to squeeze the key
     * off a 360dp panel: a backend URL, a controller package name or a stack-trace fragment must
     * wrap onto its own full-width lines rather than be clipped. Nothing here truncates.
     */
    private static void addKeyValue(Context c, LinearLayout block, String key, String value) {
        int colour = valueColour(key, value);
        String shown = value.isEmpty() ? DASH : value;

        if (key.length() + shown.length() <= 40 && shown.indexOf('\n') < 0) {
            LinearLayout row = Ui.rowCentered(c);
            TextView k = Ui.mono(c, key, Ui.SP_META, Ui.ASH, 1f, 21f);
            k.setAllCaps(true);
            TextView v = Ui.mono(c, shown, Ui.SP_META, colour, 0f, 21f);
            v.setGravity(Gravity.END);
            row.addView(k, new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f));
            row.addView(Ui.spacerH(c, 8));
            row.addView(v, new LayoutParams(
                    LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT));
            addRow(c, block, 6, row);
            return;
        }

        LinearLayout stack = new LinearLayout(c);
        stack.setOrientation(VERTICAL);
        TextView k = Ui.mono(c, key, Ui.SP_META_SMALL, Ui.ASH, 1f, 19f);
        k.setAllCaps(true);
        stack.addView(k);
        stack.addView(Ui.spacer(c, 2));
        stack.addView(Ui.mono(c, shown, Ui.SP_META, colour, 0f, 21f), new LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));
        addRow(c, block, 6, stack);
    }

    /** Timestamp in Ash, message hanging beside it so long events wrap under themselves. */
    private static LinearLayout eventRow(Context c, String stamp, String message) {
        LinearLayout row = Ui.row(c);
        row.addView(Ui.mono(c, stamp, Ui.SP_META_SMALL, Ui.ASH, 0f, 19f));
        row.addView(Ui.spacerH(c, 6));
        row.addView(Ui.mono(c, message, Ui.SP_META_SMALL,
                        looksLikeFailure(message) ? Ui.CORAL : Ui.MIST, 0f, 19f),
                new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f));
        return row;
    }

    /** Append with the inter-row gap, so the first row does not get a leading space. */
    private static void addRow(Context c, LinearLayout block, int gapDp, android.view.View v) {
        if (block.getChildCount() > 0) block.addView(Ui.spacer(c, gapDp));
        block.addView(v, new LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));
    }

    // ═══ CLASSIFIERS ══════════════════════════════════════════════════════════════════════════

    /** "— PAIRING —" → "PAIRING". Null for anything else. */
    private static String sectionName(String trimmed) {
        if (trimmed.length() > 3
                && trimmed.startsWith(DASH + " ")
                && trimmed.endsWith(" " + DASH)) {
            return trimmed.substring(2, trimmed.length() - 2).trim();
        }
        return null;
    }

    /**
     * The colour of a value. Deliberately conservative: exact matches only, and anything not
     * recognised stays Mist. Signal here is a claim that something is WORKING, so it is only
     * ever made against a word the report is known to emit.
     */
    private static int valueColour(String key, String value) {
        String k = key.toLowerCase(Locale.UK).trim();
        String v = value.trim();
        String lv = v.toLowerCase(Locale.UK);

        // Absent is not a fault — it is nothing to see.
        if (v.isEmpty() || v.equals(DASH) || lv.equals("(none)") || lv.equals("(not run)")
                || lv.equals("(not signed in)")) {
            return Ui.ASH;
        }
        // A populated error field is, by definition, the thing you came here to find.
        if (k.contains("error")) return Ui.CORAL;
        if (k.startsWith("mode")) return lv.startsWith("simulated") ? Ui.AMBER : Ui.SIGNAL;
        if (k.contains("unresolved")) return "0".equals(v) ? Ui.SIGNAL : Ui.AMBER;

        switch (lv) {
            case "found":
            case "received":
            case "paired":
            case "yes":
            case "ok":
            case "live":
                return Ui.SIGNAL;
            case "unpaired":
                return Ui.AMBER;      // expected before setup — attention, not breakage
            case "not found":
            case "not received":
            case "none":
            case "retired":
                return Ui.CORAL;
            default:
                return Ui.MIST;
        }
    }

    /** Substring match on event text — worth the odd false positive to make a failure findable. */
    private static boolean looksLikeFailure(String message) {
        String l = message.toLowerCase(Locale.UK);
        return l.contains("fail") || l.contains("error") || l.contains("denied")
                || l.contains("timeout") || l.contains("declin") || l.contains("abort")
                || l.contains("not present") || l.contains("cancel") || l.contains("unresolved");
    }
}
