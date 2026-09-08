package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.drawable.Drawable;
import android.view.Gravity;
import android.view.View;
import android.widget.TextView;

import co.posup.rpos.paxpay.BuildVersion;

/**
 * The three pieces of ServOS chrome that repeat on every screen: the sandbox banner, the debug
 * footer, and the console grid.
 *
 * These are OURS. The Android status bar (clock, wifi, battery) and the gesture/nav bar in the
 * design mockups are the real operating system — we do not paint them, and nothing in this file
 * tries to. The mockups draw them only so the designer could see how much room is left.
 *
 * ── THE FLAGS ───────────────────────────────────────────────────────────────────────────────
 * The design calls out three dev toggles — showSandboxBanner, showDebugFooter, showGrid — and
 * they are here as plain static booleans so a build, a diagnostics screen or a long-press easter
 * egg can flip them without threading config through nine screens.
 *
 * They are read AT VIEW-CONSTRUCTION TIME. Flipping one mid-session takes effect on the next
 * screen build, not instantly. That is deliberate: a payment screen that reflows underneath a
 * customer's finger is worse than a flag that lands a beat late.
 *
 * showSandboxBanner does NOT override BuildVersion.SIMULATED. The banner is suppressed when the
 * flag is off, but it can never be *forced on* for a real-money build, and it can never be
 * skipped for a simulated one by accident — see sandboxBanner().
 *
 * ── UNITS ───────────────────────────────────────────────────────────────────────────────────
 * The design is drawn in a 720px-wide space and this panel is 720px at ~2× density, so every
 * spec measurement is halved into dp here. 54px banner → 27dp. 46px footer → 23dp. 56px grid
 * pitch → 28dp. The px numbers are kept in the comments so the spec stays checkable.
 */
public final class Chrome {
    private Chrome() {}

    // ---- toggles -----------------------------------------------------------------------------

    /**
     * Show the amber sandbox banner. Defaults to the behaviour this app already had: the banner
     * appears whenever the build is simulated. Setting this false hides it; setting it true on a
     * real-money build still shows nothing, because sandboxBanner() also requires
     * BuildVersion.SIMULATED.
     */
    public static boolean showSandboxBanner = true;

    /** Show the mono diagnostics line at the bottom of every screen. Defaults on, as today. */
    public static boolean showDebugFooter = true;

    /**
     * Paint the faint console grid behind content. Defaults ON: it is part of the ServOS surface
     * language, not a debug affordance, and at 2.8% alpha it is texture rather than decoration.
     * Turn it off if a venue's screen protector makes it moire.
     */
    public static boolean showGrid = true;

    // ---- sizes (design px → dp) ---------------------------------------------------------------

    /** 54px in design space. */
    public static final int BANNER_H_DP = 27;
    /** 46px in design space. */
    public static final int FOOTER_H_DP = 23;
    /** Grid pitch: a line every 56px in design space. */
    public static final int GRID_PITCH_DP = 28;

    /** The banner's own ink colour — dark enough to read on Amber, per the spec. */
    public static final int BANNER_INK = 0xFF1A1204;

    public static final String SANDBOX_TEXT = "SIMULATED BUILD — NO CARD IS CHARGED";

    // ---- components ---------------------------------------------------------------------------

    /**
     * The amber "this build cannot charge a card" bar. Sits directly under the OS status bar on
     * every screen (all nine in the design).
     *
     * Returns a view in every case rather than null, so a caller can add it unconditionally; when
     * it should not be seen it comes back GONE and occupies no height. That matters because
     * MainActivity adds this once at chrome-build time and must not have to re-lay-out to hide it.
     */
    public static TextView sandboxBanner(Context c) {
        Type.init(c);
        TextView t = new TextView(c);
        t.setText(SANDBOX_TEXT);
        t.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, Ui.SP_BANNER);   // 22px design
        t.setTextColor(BANNER_INK);
        t.setTypeface(Type.mono(600));
        Type.trackingPx(t, 1.5f, 22f);
        t.setAllCaps(true);
        t.setGravity(Gravity.CENTER);
        t.setBackgroundColor(Ui.AMBER);
        // Padding AFTER the background: setBackground()/setBackgroundColor() re-read padding from
        // the drawable and can discard what was set before it.
        t.setPadding(Ui.dp(c, 8), Ui.dp(c, 4), Ui.dp(c, 8), Ui.dp(c, 4));
        t.setMinHeight(Ui.dp(c, BANNER_H_DP));
        // Both conditions, deliberately. See the class comment.
        if (!(showSandboxBanner && BuildVersion.SIMULATED)) t.setVisibility(View.GONE);
        return t;
    }

    /**
     * The diagnostics line: Ink, a hairline above it, centred mono Ash. Present on every screen so
     * that "it doesn't work" can be answered by looking at the terminal rather than attaching a
     * debugger — the reason this footer exists at all.
     *
     * Like the banner, returns a GONE view rather than null when switched off.
     */
    public static TextView debugFooter(Context c, String line) {
        Type.init(c);
        TextView t = new TextView(c);
        t.setText(line == null ? "" : line);
        t.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, Ui.SP_META_SMALL);  // 19px design
        t.setTextColor(Ui.ASH);
        t.setTypeface(Type.mono());
        Type.trackingPx(t, 0.5f, 19f);
        t.setGravity(Gravity.CENTER);
        t.setBackground(Ui.topHairline(c, Ui.INK));
        t.setPadding(Ui.dp(c, 10), Ui.dp(c, 4), Ui.dp(c, 10), Ui.dp(c, 5));   // after the bg
        t.setMinHeight(Ui.dp(c, FOOTER_H_DP));
        if (!showDebugFooter) t.setVisibility(View.GONE);
        return t;
    }

    /**
     * The console grid: 1px lines every 28dp (56px design) on both axes at 2.8% Mist.
     *
     * A Drawable, not an image — it has to tile to any panel size, it has to sit behind content
     * without an extra view in the hierarchy, and at this alpha a bitmap would band.
     *
     * Ui.screen() already installs this behind every root, and only on the OUTERMOST root, so
     * nesting a screen inside the chrome does not double the lines. Use this directly only if you
     * are building a surface that does not go through Ui.screen().
     */
    public static Drawable gridOverlay(Context c) {
        return new GridDrawable(Ui.dp(c, GRID_PITCH_DP));
    }

    /** True when the sandbox banner will actually be visible — for layout maths and diagnostics. */
    public static boolean sandboxBannerVisible() {
        return showSandboxBanner && BuildVersion.SIMULATED;
    }

    // ---- the grid ------------------------------------------------------------------------------

    static final class GridDrawable extends Drawable {
        private final Paint paint = new Paint();
        private final int pitch;

        GridDrawable(int pitchPx) {
            this.pitch = Math.max(2, pitchPx);
            paint.setColor(Ui.GRID_LINE);
            paint.setStrokeWidth(1f);      // 1 design px == 1 device px on this panel
            paint.setAntiAlias(false);     // a hairline grid should not be smeared across 2 rows
        }

        @Override public void draw(Canvas canvas) {
            Rect b = getBounds();
            if (b.width() <= 0 || b.height() <= 0) return;
            for (int y = b.top + pitch; y < b.bottom; y += pitch) {
                canvas.drawLine(b.left, y, b.right, y, paint);
            }
            for (int x = b.left + pitch; x < b.right; x += pitch) {
                canvas.drawLine(x, b.top, x, b.bottom, paint);
            }
        }

        @Override public void setAlpha(int alpha) { paint.setAlpha(alpha); invalidateSelf(); }
        @Override public void setColorFilter(ColorFilter cf) { paint.setColorFilter(cf); }
        // Deprecated on Drawable but still abstract — it has to be implemented.
        @SuppressWarnings("deprecation")
        @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
    }
}
