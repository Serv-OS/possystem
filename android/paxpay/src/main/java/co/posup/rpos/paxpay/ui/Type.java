package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.content.res.AssetManager;
import android.graphics.Typeface;
import android.widget.TextView;

/**
 * The ServOS type stack, and the seam that lets the real fonts land later without touching a
 * single screen.
 *
 * ServOS specifies three families:
 *   Syne            — display (700/800). Board headlines. Barely used on-device.
 *   Space Grotesk   — every piece of UI text and every amount (400/500/600/700).
 *   JetBrains Mono  — running heads, status pills, meta rows, the debug footer (400/600).
 *
 * NONE OF THEM ARE BUNDLED YET. There is no src/main/assets directory in this module. So every
 * lookup here is best-effort: try Typeface.createFromAsset(), and if the file is not there fall
 * back to the closest thing the platform already has. Dropping the real .ttf files into
 * assets/fonts/ later is the whole migration — no screen changes, no API changes.
 *
 * ── WHY THIS NEVER THROWS ──────────────────────────────────────────────────────────────────
 * This is a card-payment terminal. A missing font file is a cosmetic problem; a font loader that
 * throws during view construction is a terminal that cannot take money. Every load is wrapped,
 * every failure degrades to a system face, and a face is cached either way so a missing asset is
 * looked up once rather than on every TextView.
 *
 * ── TRACKING ───────────────────────────────────────────────────────────────────────────────
 * The design specifies letter-spacing in PX at a given font size (mono running heads: 2px at
 * 19–22px). Android's setLetterSpacing() is in EM. trackingEm()/trackingPx() do that division so
 * screens can quote the design numbers directly instead of pre-computing ratios.
 */
public final class Type {
    private Type() {}

    // ---- asset paths (drop the real files here to upgrade) -----------------------------------
    private static final String DIR = "fonts/";
    private static final String SG_REGULAR  = DIR + "SpaceGrotesk-Regular.ttf";
    private static final String SG_MEDIUM   = DIR + "SpaceGrotesk-Medium.ttf";
    private static final String SG_SEMIBOLD = DIR + "SpaceGrotesk-SemiBold.ttf";
    private static final String SG_BOLD     = DIR + "SpaceGrotesk-Bold.ttf";
    private static final String SYNE_BOLD   = DIR + "Syne-Bold.ttf";
    private static final String SYNE_XBOLD  = DIR + "Syne-ExtraBold.ttf";
    private static final String JB_REGULAR  = DIR + "JetBrainsMono-Regular.ttf";
    private static final String JB_SEMIBOLD = DIR + "JetBrainsMono-SemiBold.ttf";

    private static volatile boolean initialised = false;
    private static boolean bundled = false;

    private static Typeface displayFace;
    private static Typeface ui400, ui500, ui600, ui700;
    private static Typeface mono400, mono600;

    /**
     * Prime the cache from an application context. Idempotent and cheap after the first call.
     *
     * Every Ui.* helper that takes a Context calls this, so in practice it is primed by the first
     * view built on any screen and no screen ever has to remember to call it. Calling it with a
     * null Context, or never calling it at all, is safe — the getters fall back to system faces.
     */
    public static void init(Context c) {
        if (initialised || c == null) return;
        synchronized (Type.class) {
            if (initialised) return;
            try {
                load(c.getApplicationContext());
            } catch (Throwable ignored) {
                // Deliberately swallowed — see the class comment. Fallbacks are already set.
            }
            fillGaps();
            initialised = true;
        }
    }

    private static void load(Context app) {
        AssetManager am = app.getAssets();
        displayFace = fromAsset(am, SYNE_XBOLD);
        if (displayFace == null) displayFace = fromAsset(am, SYNE_BOLD);

        ui400 = fromAsset(am, SG_REGULAR);
        ui500 = fromAsset(am, SG_MEDIUM);
        ui600 = fromAsset(am, SG_SEMIBOLD);
        ui700 = fromAsset(am, SG_BOLD);

        mono400 = fromAsset(am, JB_REGULAR);
        mono600 = fromAsset(am, JB_SEMIBOLD);

        bundled = ui400 != null || ui600 != null || mono400 != null;
    }

    private static Typeface fromAsset(AssetManager am, String path) {
        try {
            return Typeface.createFromAsset(am, path);
        } catch (Throwable t) {
            return null;   // asset absent (the normal case today) or unreadable
        }
    }

    /** Anything the assets did not supply falls back to the nearest platform face. */
    private static void fillGaps() {
        // Syne is a geometric display face; sans-serif-black is the closest stock weight, and
        // Typeface.create() silently returns the default family if that alias is unknown.
        if (displayFace == null) displayFace = safeCreate("sans-serif-black", Typeface.BOLD);

        if (ui400 == null) ui400 = safeCreate("sans-serif", Typeface.NORMAL);
        if (ui500 == null) ui500 = safeCreate("sans-serif-medium", Typeface.NORMAL);
        if (ui600 == null) ui600 = ui500 != null ? ui500 : safeCreate("sans-serif-medium", Typeface.NORMAL);
        if (ui700 == null) ui700 = safeCreate("sans-serif", Typeface.BOLD);

        if (mono400 == null) mono400 = Typeface.MONOSPACE;
        if (mono600 == null) mono600 = safeCreate(Typeface.MONOSPACE, Typeface.BOLD);
    }

    private static Typeface safeCreate(String family, int style) {
        try {
            Typeface t = Typeface.create(family, style);
            return t == null ? Typeface.DEFAULT : t;
        } catch (Throwable t) {
            return Typeface.DEFAULT;
        }
    }

    private static Typeface safeCreate(Typeface base, int style) {
        try {
            Typeface t = Typeface.create(base, style);
            return t == null ? base : t;
        } catch (Throwable t) {
            return base;
        }
    }

    // ---- the three families ------------------------------------------------------------------

    /** Syne — display only. Marketing/board headlines; not used on the payment screens. */
    public static Typeface display() {
        ensure();
        return displayFace;
    }

    /**
     * Space Grotesk at a nominal CSS weight. Everything on a payment screen that is not a mono
     * label is this face: screen titles, amounts, tile titles, buttons, bill lines.
     *
     * @param weight 400 regular · 500 medium · 600 semibold · 700 bold. Anything else is snapped
     *               to the nearest of those four rather than rejected.
     */
    public static Typeface ui(int weight) {
        ensure();
        if (weight >= 700) return ui700;
        if (weight >= 600) return ui600;
        if (weight >= 500) return ui500;
        return ui400;
    }

    /** JetBrains Mono 400 — running heads, status pills, meta rows, debug footer. */
    public static Typeface mono() {
        ensure();
        return mono400;
    }

    /** JetBrains Mono at 400 or 600 (600 is the sandbox banner). */
    public static Typeface mono(int weight) {
        ensure();
        return weight >= 600 ? mono600 : mono400;
    }

    /** True once the real .ttf files are in assets/fonts/. Surfaced in Diagnostics if wanted. */
    public static boolean bundled() {
        ensure();
        return bundled;
    }

    private static void ensure() {
        if (!initialised) {
            // init(Context) was never reached — still hand back usable faces rather than null.
            synchronized (Type.class) {
                if (!initialised) {
                    fillGaps();
                    initialised = true;
                }
            }
        }
    }

    // ---- tracking --------------------------------------------------------------------------

    /**
     * Convert the design's "Npx of tracking at an Mpx font" into Android's em-relative
     * letterSpacing. Both arguments are in the 720px DESIGN space — quote the spec numbers
     * directly, do not pre-halve them: the ratio is scale-invariant.
     */
    public static float trackingEm(float trackingDesignPx, float fontDesignPx) {
        if (fontDesignPx <= 0f) return 0f;
        return trackingDesignPx / fontDesignPx;
    }

    /** Apply an em letterSpacing straight through. */
    public static void tracking(TextView t, float em) {
        if (t == null) return;
        t.setLetterSpacing(em);
    }

    /** Apply the design's px tracking at the design's px font size. See trackingEm(). */
    public static void trackingPx(TextView t, float trackingDesignPx, float fontDesignPx) {
        tracking(t, trackingEm(trackingDesignPx, fontDesignPx));
    }

    /**
     * The mono running-head treatment in one call: JetBrains Mono, UPPERCASE, 2px tracking at
     * the given design size. Serves the eyebrow row on every screen (01–09).
     */
    public static TextView runningHeadStyle(TextView t, float fontDesignPx) {
        if (t == null) return null;
        t.setTypeface(mono());
        t.setAllCaps(true);
        trackingPx(t, 2f, fontDesignPx);
        return t;
    }
}
