package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.LayerDrawable;
import android.graphics.drawable.RippleDrawable;
import android.os.Build;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.TextPaint;
import android.text.style.AbsoluteSizeSpan;
import android.text.style.ForegroundColorSpan;
import android.text.style.MetricAffectingSpan;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * The ServOS design foundation for the PAX terminal: colour, type scale, and every shared
 * component the payment screens are built from.
 *
 * Built programmatically rather than with XML layouts, matching the rest of android/ (:app,
 * :mpos and :menuboard all construct their views in code and ship no layout XML).
 *
 * ═══ UNITS: THE ONE THING TO GET RIGHT ═══════════════════════════════════════════════════════
 * The ServOS handoff is drawn in a 720px-wide design space. The A920 Pro panel is 720px wide at
 * ~2× density, so DESIGN PX ÷ 2 = DP. 40px padding → 20dp. A 104px icon chip → 52dp. A 104px
 * amount → 52sp. Every conversion in this file is done once, here, and the design number is kept
 * in the comment beside it so the spec stays checkable. Never pass a raw spec px into dp().
 *
 * ═══ DESIGN CONSTRAINTS ═════════════════════════════════════════════════════════════════════
 * This runs on a PAX A920 Pro: a ~5" 720×1280 screen (roughly 360×640dp) held out at arm's
 * length and, on the tip and outcome screens, READ BY THE PAYING CUSTOMER — often older, often in
 * a dim restaurant, sometimes without their reading glasses. So:
 *   - minimum 64dp touch targets (the physical A920 screen is small and fingers are not)
 *   - large type: amounts are display-sized, nothing meaningful shrinks to phone defaults
 *   - Ink surfaces with Mist text for maximum contrast under venue lighting
 *   - ONE Signal-green element per screen — the thing to press. Green means "go", never "info".
 * Do not "tidy" these sizes down; the device is not a phone.
 *
 * ONE DELIBERATE DEVIATION FROM THE SPEC, AND WHY. The handoff draws ghost buttons at 98px and
 * primary CTAs at 110px, which halve to 49dp and 55dp — both under the 64dp touch floor above.
 * The floor wins: H_GHOST is 64dp and H_PRIMARY is 68dp, keeping the primary visibly taller than
 * the secondary as the design intends. A slightly taller button is a cosmetic difference; a
 * mis-tap on a payment terminal with a customer waiting is not.
 *
 * ═══ COMPATIBILITY ═════════════════════════════════════════════════════════════════════════
 * Every public name that existed before the ServOS rebuild still exists with the same signature.
 * BG, SURFACE, ACCENT and friends now resolve to ServOS tokens (Ink, Coal, Signal), so screens
 * that were never touched still render in the new language. What they draw changed; what they
 * are called did not.
 */
public final class Ui {
    private Ui() {}

    // ═══ COLOUR ═══════════════════════════════════════════════════════════════════════════════
    // ServOS tokens. Use these names in new code.

    /** App background. Everything sits on this. */
    public static final int INK       = 0xFF0F1211;
    /** Cards, tiles, keypad keys, meta blocks. */
    public static final int COAL      = 0xFF161A18;
    /** Borders, icon chips, secondary surfaces. */
    public static final int GRAPHITE  = 0xFF232826;
    /** Secondary / meta text, mono labels. */
    public static final int ASH       = 0xFF8C938C;
    /** Primary text on dark. */
    public static final int MIST      = 0xFFE9ECEA;
    /** The one spark: primary buttons, live dots, positive states, the green hero tile. */
    public static final int SIGNAL    = 0xFF15C26A;
    /** Green highlight — pressed/hover states on green. */
    public static final int GLOW      = 0xFF46E08C;
    /** Attention: the sandbox banner, HELD tables. Never an error. */
    public static final int AMBER     = 0xFFF5A623;
    /** Declined / critical ONLY. If it is not a refusal or a failure, it is not this colour. */
    public static final int CORAL     = 0xFFFF5A4A;
    /** Text and icons sitting ON a Signal fill. */
    public static final int ON_SIGNAL = 0xFF04140B;

    /**
     * Brand pop colour. Declared for completeness and NEVER used in payment UI — ServOS reserves
     * it for marketing surfaces, and a colour with no system meaning must not appear on a screen
     * where every other colour means something. Present so nobody has to go looking for it.
     */
    public static final int ULTRAVIOLET = 0xFF7C5CFF;

    // Alpha derivations from the spec, precomputed so screens never hand-roll them.
    /** rgba(233,236,234,0.06) — dividers, card borders. */
    public static final int HAIRLINE        = 0x0FE9ECEA;
    /** rgba(233,236,234,0.09) — panel edge. */
    public static final int HAIRLINE_STRONG = 0x17E9ECEA;
    /** rgba(233,236,234,0.12) — the rule above a totals block. */
    public static final int RULE_TOTALS     = 0x1FE9ECEA;
    /** rgba(233,236,234,0.028) — the console grid. */
    public static final int GRID_LINE       = 0x07E9ECEA;
    /** rgba(21,194,106,0.55) — primary green button shadow. */
    public static final int SIGNAL_SHADOW   = 0x8C15C26A;
    /** rgba(4,20,11,0.74) — subtitle on a green hero tile. */
    public static final int ON_SIGNAL_MUTED = 0xBD04140B;
    /** rgba(4,20,11,0.15) — icon chip inside a green hero tile. */
    public static final int ON_SIGNAL_CHIP  = 0x2604140B;
    /** rgba(245,166,35,0.10) / 0.30 — the amber reassurance pill on Present card. */
    public static final int AMBER_SOFT      = 0x1AF5A623;
    public static final int AMBER_SOFT_EDGE = 0x4DF5A623;
    /** rgba(255,90,74,0.12) / 0.50 — the Declined disc. */
    public static final int CORAL_SOFT      = 0x1FFF5A4A;
    public static final int CORAL_SOFT_EDGE = 0x80FF5A4A;

    // ---- legacy names, remapped onto ServOS -------------------------------------------------
    // Kept so every pre-rebuild screen still compiles and still looks right. Prefer the ServOS
    // tokens above in new code. NOT marked @Deprecated on purpose — these are still correct, they
    // are just older names, and annotating them would bury the module in warnings from ~100 call
    // sites that have nothing wrong with them.
    /** Legacy alias for {@link #INK}. */      public static final int BG        = INK;
    /** Legacy alias for {@link #COAL}. */     public static final int SURFACE   = COAL;
    /** Legacy alias for {@link #GRAPHITE}. */ public static final int SURFACE_2 = GRAPHITE;
    /** Legacy alias for {@link #MIST}. */     public static final int TEXT      = MIST;
    /** Legacy alias for {@link #ASH}. */      public static final int MUTED     = ASH;
    /** Legacy alias for {@link #SIGNAL}. */   public static final int ACCENT    = SIGNAL;
    /** Legacy alias for {@link #AMBER}. */    public static final int WARN      = AMBER;
    /** Legacy alias for {@link #CORAL}. */    public static final int DANGER    = CORAL;

    // ═══ TYPE SCALE (design px ÷ 2 = sp) ══════════════════════════════════════════════════════

    /** Screen title, e.g. "Open tables". Space Grotesk 600. 54px. */
    public static final float SP_SCREEN_TITLE   = 27f;
    /** The big keypad / bill amount. Space Grotesk 700. 104px. */
    public static final float SP_BIG_AMOUNT     = 52f;
    /** The Approved amount, in Signal. Space Grotesk 700. 80px. */
    public static final float SP_OUTCOME_AMOUNT = 40f;
    /** "Approved" / "Declined". Space Grotesk 700. 56px. */
    public static final float SP_OUTCOME_TITLE  = 28f;
    /** Centred state headline, e.g. "Authorising…". Space Grotesk 600. 50px. */
    public static final float SP_STATE_TITLE    = 25f;
    /** Tile title. Space Grotesk 700. 44px. */
    public static final float SP_TILE_TITLE     = 22f;
    /** Tile subtitle / body copy. Space Grotesk 400. 27–29px. */
    public static final float SP_TILE_SUB       = 13.5f;
    /** Body copy under a state headline. 28–29px. */
    public static final float SP_BODY           = 14.5f;
    /** Button label. Space Grotesk 500/600. 28–33px. */
    public static final float SP_BUTTON         = 16f;
    /** Bill line item. Space Grotesk 400. 29px. */
    public static final float SP_LINE_ITEM      = 14.5f;
    /** The mono qty prefix on a bill line. 23px. */
    public static final float SP_LINE_QTY       = 11.5f;
    /** Table card amount. Space Grotesk 600. 46px. */
    public static final float SP_TABLE_AMOUNT   = 23f;
    /** Keypad digit. Space Grotesk 500. 48px. */
    public static final float SP_KEYPAD         = 24f;
    /** Running head / eyebrow. JetBrains Mono, UPPERCASE, 2px tracking. 22px. */
    public static final float SP_RUNNING_HEAD   = 11f;
    /** Status pill. JetBrains Mono, UPPERCASE. 19–20px. */
    public static final float SP_PILL           = 9.5f;
    /** Meta rows. JetBrains Mono. 21px. */
    public static final float SP_META           = 10.5f;
    /** The smallest mono in the system — footer, table card covers line. 18–19px. */
    public static final float SP_META_SMALL     = 9.5f;
    /** Sandbox banner. JetBrains Mono 600. 22px. */
    public static final float SP_BANNER         = 11f;

    // ═══ SPACING / RADII / HEIGHTS (design px ÷ 2 = dp) ═══════════════════════════════════════

    /** Tile corner. 30px. */                  public static final float R_TILE   = 15f;
    /** Card corner. 26–28px. */               public static final float R_CARD   = 14f;
    /** Button corner. 22px. */                public static final float R_BUTTON = 11f;
    /** Keypad key + meta block corner. 20px. */ public static final float R_KEY  = 10f;
    /** Icon chip corner. 26px. */             public static final float R_CHIP   = 13f;

    /** Content padding: 34px top, 40px sides, 30px bottom. */
    public static final int PAD_TOP = 17, PAD_SIDE = 20, PAD_BOTTOM = 15;
    /** Gaps: tile stack 26px, grid 22px, button row 16px. */
    public static final int GAP_TILE = 13, GAP_GRID = 11, GAP_BUTTON_ROW = 8;

    /**
     * Primary CTA height. Spec draws 110px (55dp); raised to 68dp by the 64dp touch floor — see
     * the class comment.
     */
    public static final int H_PRIMARY = 68;
    /** Ghost/secondary height. Spec draws 98px (49dp); raised to the 64dp floor. */
    public static final int H_GHOST = 64;
    /** Icon chip. 104px. */
    public static final int ICON_CHIP = 52;
    /** Card padding. 28px. */
    public static final int PAD_CARD = 14;

    // ═══ PRIMITIVES ═══════════════════════════════════════════════════════════════════════════

    public static int dp(Context c, float v) {
        Type.init(c);   // the cheapest place to guarantee the font cache is primed
        return Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, v, c.getResources().getDisplayMetrics()));
    }

    /** sp → px. Needed where a span wants absolute pixels (see modeButton). */
    public static int sp(Context c, float v) {
        return Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_SP, v, c.getResources().getDisplayMetrics()));
    }

    /** One physical hairline. 1px in the 720px design space is 1px on this panel. */
    public static int hairlinePx(Context c) {
        return Math.max(1, dp(c, 0.5f));
    }

    /**
     * Root vertical container: Ink, with the ServOS console grid behind content.
     *
     * The grid is drawn by the OUTERMOST screen() in the tree only. MainActivity builds its
     * chrome from screen() and individual screens use screen() for their own root, so without
     * that rule every screen would draw the grid twice, misaligned by the banner height. The
     * returned view is a LinearLayout in every way that matters to callers.
     */
    public static LinearLayout screen(Context c) {
        Type.init(c);
        GridRoot l = new GridRoot(c);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setBackgroundColor(INK);
        return l;
    }

    /** Ink container with NO grid — for a root nested inside another screen(). */
    public static LinearLayout panel(Context c) {
        Type.init(c);
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setBackgroundColor(INK);
        return l;
    }

    public static LinearLayout row(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.HORIZONTAL);
        return l;
    }

    /** A horizontal row with its children vertically centred — the common case. */
    public static LinearLayout rowCentered(Context c) {
        LinearLayout l = row(c);
        l.setGravity(Gravity.CENTER_VERTICAL);
        return l;
    }

    /** Space Grotesk text. bold=true is weight 700, false is 400. */
    public static TextView text(Context c, String s, float sizeSp, int colour, boolean bold) {
        Type.init(c);
        TextView t = new TextView(c);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp);
        t.setTextColor(colour);
        t.setTypeface(Type.ui(bold ? 700 : 400));
        return t;
    }

    /** Space Grotesk at an explicit CSS weight (400/500/600/700). */
    public static TextView text(Context c, String s, float sizeSp, int colour, int weight) {
        TextView t = text(c, s, sizeSp, colour, false);
        t.setTypeface(Type.ui(weight));
        return t;
    }

    /**
     * A JetBrains Mono label — running heads, meta rows, pill text, covers lines.
     *
     * @param trackingDesignPx tracking in the 720px design space (2px for running heads, 1–1.5px
     *                         for pills). Converted to em against the design font size.
     * @param fontDesignPx     the design's px size for this role — i.e. sizeSp × 2.
     */
    public static TextView mono(Context c, String s, float sizeSp, int colour,
                                float trackingDesignPx, float fontDesignPx) {
        Type.init(c);
        TextView t = new TextView(c);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp);
        t.setTextColor(colour);
        t.setTypeface(Type.mono());
        Type.trackingPx(t, trackingDesignPx, fontDesignPx);
        return t;
    }

    /** The mono running-head/eyebrow treatment: UPPERCASE, 2px tracking at 22px. */
    public static TextView monoHead(Context c, String s, int colour) {
        TextView t = mono(c, s, SP_RUNNING_HEAD, colour, 2f, 22f);
        t.setAllCaps(true);
        return t;
    }

    /**
     * Big money readout.
     *
     * Auto-shrinks rather than truncating. A four-figure total on a small panel is exactly when a
     * clipped amount would be most expensive, so the type gives way before the digits do.
     */
    public static TextView amount(Context c, String s) {
        TextView t = text(c, s, SP_BIG_AMOUNT, MIST, 700);
        t.setGravity(Gravity.CENTER);
        t.setMaxLines(1);
        t.setLetterSpacing(-0.02f);   // spec: -0.02em on the big amount
        try {
            // API 26+. setTextSize must not be called after this, so it goes last.
            t.setAutoSizeTextTypeUniformWithConfiguration(
                    24, (int) SP_BIG_AMOUNT, 1, TypedValue.COMPLEX_UNIT_SP);
        } catch (Throwable ignored) {
            // Fixed size is a perfectly good fallback; never fail constructing a payment screen.
        }
        return t;
    }

    /** The outcome amount on Approved — 80px, Signal. */
    public static TextView outcomeAmount(Context c, String s) {
        TextView t = text(c, s, SP_OUTCOME_AMOUNT, SIGNAL, 700);
        t.setGravity(Gravity.CENTER);
        t.setMaxLines(1);
        return t;
    }

    /** Screen title — "Open tables", "Table 02". Left-aligned, as the design draws it. */
    public static TextView title(Context c, String s) {
        TextView t = text(c, s, SP_SCREEN_TITLE, MIST, 600);
        t.setLetterSpacing(-0.01f);
        t.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        return t;
    }

    /** Centred state headline — "Waiting for the till", "Authorising…", "Tap, insert or swipe". */
    public static TextView stateTitle(Context c, String s) {
        TextView t = text(c, s, SP_STATE_TITLE, MIST, 600);
        t.setGravity(Gravity.CENTER);
        return t;
    }

    // ═══ SURFACES ═════════════════════════════════════════════════════════════════════════════

    /** A rounded fill with an optional 1px border — the base of every ServOS surface. */
    public static GradientDrawable surface(Context c, int fill, int strokeColour, float radiusDp) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        g.setCornerRadius(dp(c, radiusDp));
        if (strokeColour != Color.TRANSPARENT) g.setStroke(hairlinePx(c), strokeColour);
        return g;
    }

    /**
     * Touch feedback matters on a terminal — the customer needs to know the press registered.
     * Public so screens can build their own pressable surfaces on the same feel.
     */
    public static Drawable pressable(Drawable content) {
        return new RippleDrawable(
                ColorStateList.valueOf(Color.argb(46, 233, 236, 234)), content, null);
    }

    /** Ripple tuned for a Signal-green fill, where a white ripple would read as a flash. */
    public static Drawable pressableOnGreen(Drawable content) {
        return new RippleDrawable(
                ColorStateList.valueOf(Color.argb(52, 4, 20, 11)), content, null);
    }

    /** A background that is a flat fill with a single hairline along its top edge. */
    public static Drawable topHairline(Context c, int fill) {
        LayerDrawable l = new LayerDrawable(new Drawable[]{
                new ColorDrawable(HAIRLINE), new ColorDrawable(fill)});
        l.setLayerInset(1, 0, hairlinePx(c), 0, 0);
        return l;
    }

    /**
     * Rounded panel used for cards and readouts: Coal fill, Graphite border, 28px-space corner.
     * Serves the table cards (02), the totals block (03) and every grouped readout.
     */
    public static LinearLayout card(Context c) {
        return card(c, GRAPHITE);
    }

    /**
     * Card with an explicit border colour.
     *
     * Pass SIGNAL for the selected-table state on screen 02 — the design also puts a green glow
     * behind it, which {@link #selectedCard(Context)} adds.
     */
    public static LinearLayout card(Context c, int borderColour) {
        Type.init(c);
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setBackground(surface(c, COAL, borderColour, R_CARD));
        l.setPadding(dp(c, PAD_CARD), dp(c, PAD_CARD), dp(c, PAD_CARD), dp(c, PAD_CARD));
        return l;
    }

    /** The selected table card (screen 02): Signal border plus the green drop glow. */
    public static LinearLayout selectedCard(Context c) {
        LinearLayout l = card(c, SIGNAL);
        greenGlow(c, l, 9);
        return l;
    }

    /** 1px hairline divider — between bill lines, above a totals block. */
    public static View divider(Context c) {
        View v = new View(c);
        v.setBackgroundColor(HAIRLINE);
        v.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, hairlinePx(c)));
        return v;
    }

    /** The heavier rule above a totals block — rgba(233,236,234,0.12) in the spec. */
    public static View totalsRule(Context c) {
        View v = divider(c);
        v.setBackgroundColor(RULE_TOTALS);
        return v;
    }

    // ═══ BUTTONS ══════════════════════════════════════════════════════════════════════════════

    /**
     * Primary (Signal-filled) action — the one thing the user should press on this screen.
     * Serves "Take payment · £87.75" (03), "Charge" (04), "Done" (08), "Try again" (09).
     */
    public static Button primaryButton(Context c, String label, View.OnClickListener onClick) {
        Button b = baseButton(c, label, ON_SIGNAL, SP_BUTTON, 600, onClick);
        styleButton(c, b, pressableOnGreen(surface(c, SIGNAL, Color.TRANSPARENT, R_BUTTON)),
                H_PRIMARY);
        greenGlow(c, b, 7);
        return b;
    }

    /**
     * Secondary action — Graphite-bordered ghost on Ink.
     * Identical to {@link #ghostButton}; kept so pre-rebuild screens compile unchanged.
     */
    public static Button secondaryButton(Context c, String label, View.OnClickListener onClick) {
        return ghostButton(c, label, onClick);
    }

    /**
     * The ServOS ghost button: transparent fill, Graphite border, Mist label.
     * Serves "Split" / "Add tip" (03), "Cancel" (05), "Print" / "Email" (08),
     * "Change method" (09).
     */
    public static Button ghostButton(Context c, String label, View.OnClickListener onClick) {
        Button b = baseButton(c, label, MIST, SP_BUTTON, 500, onClick);
        styleButton(c, b, pressable(surface(c, Color.TRANSPARENT, GRAPHITE, R_BUTTON)), H_GHOST);
        return b;
    }

    /**
     * Generic button, kept at its original signature.
     *
     * ONE PIECE OF MAPPING WORTH KNOWING: a caller asking for a SURFACE_2 (Graphite) fill is,
     * in every existing call site, building a keypad key or a tip preset. The ServOS spec draws
     * those as COAL with a Graphite BORDER, not as a Graphite slab. So that one colour is
     * translated here rather than in each caller — which is how Keypad.java and TipScreen.java
     * get the new look without their signatures or logic being touched.
     */
    public static Button button(Context c, String label, int fg, int bgColour,
                                float sizeSp, View.OnClickListener onClick) {
        Button b = baseButton(c, label, fg, sizeSp, 500, onClick);
        Drawable bg;
        if (bgColour == GRAPHITE) {
            bg = pressable(surface(c, COAL, GRAPHITE, R_KEY));
        } else if (bgColour == SIGNAL) {
            bg = pressableOnGreen(surface(c, SIGNAL, Color.TRANSPARENT, R_BUTTON));
        } else {
            bg = pressable(surface(c, bgColour, Color.TRANSPARENT, R_BUTTON));
        }
        styleButton(c, b, bg, H_GHOST);   // see the 64dp floor in the class comment
        return b;
    }

    /** A keypad key: Coal, Graphite border, 20px-space corner, 48px digit. Screen 04. */
    public static Button keyButton(Context c, String label, View.OnClickListener onClick) {
        Button b = baseButton(c, label, MIST, SP_KEYPAD, 500, onClick);
        styleButton(c, b, pressable(surface(c, COAL, GRAPHITE, R_KEY)), H_GHOST);
        return b;
    }

    /** Destructive / blocking action — Coral. Used only where a human must consciously decide. */
    public static Button dangerButton(Context c, String label, View.OnClickListener onClick) {
        Button b = baseButton(c, label, MIST, SP_BUTTON, 600, onClick);
        styleButton(c, b, pressable(surface(c, CORAL, Color.TRANSPARENT, R_BUTTON)), H_GHOST);
        return b;
    }

    private static Button baseButton(Context c, String label, int fg, float sizeSp, int weight,
                                     View.OnClickListener onClick) {
        Type.init(c);
        Button b = new Button(c);
        b.setAllCaps(false);
        b.setText(label);
        b.setTextColor(fg);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp);
        b.setTypeface(Type.ui(weight));
        b.setStateListAnimator(null);   // we own elevation; the stock lift fights the green glow
        b.setOnClickListener(onClick);
        return b;
    }

    /**
     * Background, then padding, then the touch floor — in that order and for that reason.
     * View.setBackground() re-reads padding from the drawable, so padding applied first can be
     * silently thrown away. A button that loses its padding is one that loses its height.
     */
    private static void styleButton(Context c, Button b, Drawable bg, int minHeightDp) {
        b.setBackground(bg);
        b.setPadding(dp(c, 10), dp(c, 8), dp(c, 10), dp(c, 8));
        b.setMinHeight(dp(c, minHeightDp));
        b.setMinimumHeight(dp(c, minHeightDp));
    }

    /**
     * The spec's green shadow — 0 18px 44px -14px rgba(21,194,106,0.55) — as far as Android can
     * express it: an elevation with a tinted spot/ambient shadow.
     *
     * Shadow tinting is API 28+; below that the view simply gets a neutral shadow, which is a
     * cosmetic difference on a device (A920 Pro, API 29) that has the API anyway. The parent must
     * not clip children for this to be visible — screens set clipToPadding(false) where it counts.
     */
    public static void greenGlow(Context c, View v, int elevationDp) {
        v.setElevation(dp(c, elevationDp));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            v.setOutlineSpotShadowColor(SIGNAL_SHADOW);
            v.setOutlineAmbientShadowColor(SIGNAL_SHADOW);
        }
    }

    /**
     * A home-screen mode button: title over a one-line explanation.
     *
     * Renders as the ServOS action tile from screen 01 — icon chip, 44px title, 27px subtitle,
     * right chevron — while staying a Button with the original signature, because HomeScreen
     * weights these to fill the screen and must keep compiling untouched.
     *
     * The green hero variant is selected by passing ACCENT/SIGNAL as `accent`, matching how
     * HomeScreen already marks its primary mode. Any other accent gets the Coal + Graphite
     * treatment. The icon is inferred from the title; use the 6-argument overload to be explicit.
     */
    public static Button modeButton(Context c, String title, String subtitle, int accent,
                                    View.OnClickListener onClick) {
        return modeButton(c, title, subtitle, accent, iconForTitle(title, accent == SIGNAL), onClick);
    }

    /** modeButton with an explicit icon. Prefer this in new code. */
    public static Button modeButton(Context c, String title, String subtitle, int accent,
                                    Drawable icon, View.OnClickListener onClick) {
        Type.init(c);
        boolean hero = accent == SIGNAL;
        int fg = hero ? ON_SIGNAL : MIST;
        int subFg = hero ? ON_SIGNAL_MUTED : ASH;

        Button b = new Button(c);
        b.setAllCaps(false);
        b.setTextColor(fg);
        b.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        b.setStateListAnimator(null);
        b.setLineSpacing(dp(c, 3), 1.0f);
        b.setCompoundDrawablePadding(dp(c, 14));   // spec gap 28px

        SpannableStringBuilder sb = new SpannableStringBuilder();
        appendSpan(c, sb, title, SP_TILE_TITLE, fg, Type.ui(700));
        sb.append('\n');
        appendSpan(c, sb, subtitle == null ? "" : subtitle, SP_TILE_SUB, subFg, Type.ui(400));
        b.setText(sb);

        Drawable chip = icon == null ? null
                : iconChipDrawable(c, icon, hero ? ON_SIGNAL_CHIP : GRAPHITE,
                                   hero ? ON_SIGNAL : SIGNAL, ICON_CHIP, R_CHIP);
        Drawable chev = Icons.size(c, Icons.chevronRight(hero ? ON_SIGNAL : ASH), 15);
        b.setCompoundDrawablesWithIntrinsicBounds(chip, null, chev, null);

        if (hero) {
            b.setBackground(pressableOnGreen(surface(c, SIGNAL, Color.TRANSPARENT, R_TILE)));
            greenGlow(c, b, 9);
        } else {
            b.setBackground(pressable(surface(c, COAL, GRAPHITE, R_TILE)));
        }
        // After the background — see styleButton().
        b.setPadding(dp(c, PAD_SIDE), dp(c, 10), dp(c, PAD_SIDE), dp(c, 10));
        b.setOnClickListener(onClick);
        b.setMinHeight(dp(c, 92));
        b.setMinimumHeight(dp(c, 92));
        return b;
    }

    /**
     * Best-effort icon for a mode title. Cosmetic only — an unmatched title simply gets no icon
     * rather than a wrong one, and nothing about the payment depends on which glyph shows.
     */
    private static Drawable iconForTitle(String title, boolean hero) {
        if (title == null) return null;
        String t = title.toLowerCase();
        int tint = hero ? ON_SIGNAL : SIGNAL;
        if (t.contains("table")) return Icons.table(tint);
        if (t.contains("manual") || t.contains("amount") || t.contains("keypad")) return Icons.keypad(tint);
        if (t.contains("pos") || t.contains("till") || t.contains("waiting")) return Icons.inbound(tint);
        return null;
    }

    private static void appendSpan(Context c, SpannableStringBuilder sb, String s,
                                   float sizeSp, int colour, Typeface face) {
        int start = sb.length();
        sb.append(s);
        int end = sb.length();
        sb.setSpan(new AbsoluteSizeSpan(sp(c, sizeSp)), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        sb.setSpan(new ForegroundColorSpan(colour), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        sb.setSpan(new FaceSpan(face), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
    }

    // ═══ COMPONENTS ═══════════════════════════════════════════════════════════════════════════

    /**
     * The mono eyebrow row at the top of every screen: a label on the left, a status on the right.
     *
     * Screen 01 "A920 · TERMINAL" / "● LIVE" · 02 "‹ HOME" / "● LIVE · 21:45" · 06 "PAYMENT" /
     * "● READY" · 08 "● APPROVED" / "21:47".
     *
     * @param rightIsGreen true draws a filled Signal dot before the right label and colours it
     *                     Signal; false leaves it Ash with no dot.
     */
    public static LinearLayout runningHead(Context c, String leftLabel, String rightLabel,
                                           boolean rightIsGreen) {
        LinearLayout r = rowCentered(c);
        TextView left = monoHead(c, leftLabel == null ? "" : leftLabel, ASH);
        r.addView(left, new LinearLayout.LayoutParams(0, -2, 1f));

        if (rightLabel != null && !rightLabel.isEmpty()) {
            LinearLayout right = rowCentered(c);
            if (rightIsGreen) {
                right.addView(dot(c, SIGNAL, 6, false));
                right.addView(spacerH(c, 5));
            }
            right.addView(monoHead(c, rightLabel, rightIsGreen ? SIGNAL : ASH));
            r.addView(right, new LinearLayout.LayoutParams(-2, -2));
        }
        return r;
    }

    /**
     * Running head whose left label is the back affordance ("‹ HOME", "‹ TABLES").
     *
     * The chevron is drawn rather than typed, and the whole left group is the touch target at the
     * 64dp floor — a 22px glyph is not something to ask a thumb to find on a moving terminal.
     */
    public static LinearLayout runningHead(Context c, String leftLabel,
                                           View.OnClickListener onBack,
                                           String rightLabel, boolean rightIsGreen) {
        LinearLayout r = rowCentered(c);

        LinearLayout back = rowCentered(c);
        back.addView(imageOf(c, Icons.chevronLeft(ASH), 9));
        back.addView(spacerH(c, 5));
        back.addView(monoHead(c, leftLabel == null ? "" : leftLabel, ASH));
        if (onBack != null) {
            back.setOnClickListener(onBack);
            back.setBackground(pressable(surface(c, Color.TRANSPARENT, Color.TRANSPARENT, R_KEY)));
            back.setPadding(0, 0, dp(c, 12), 0);   // after the bg — see styleButton()
            back.setMinimumHeight(dp(c, H_GHOST));
        }
        r.addView(back, new LinearLayout.LayoutParams(0, -2, 1f));

        if (rightLabel != null && !rightLabel.isEmpty()) {
            LinearLayout right = rowCentered(c);
            if (rightIsGreen) {
                right.addView(dot(c, SIGNAL, 6, false));
                right.addView(spacerH(c, 5));
            }
            right.addView(monoHead(c, rightLabel, rightIsGreen ? SIGNAL : ASH));
            r.addView(right, new LinearLayout.LayoutParams(-2, -2));
        }
        return r;
    }

    // ---- status pills -------------------------------------------------------------------------

    /** Filled Signal dot + green label. Terminal is up. */
    public static final int PILL_LIVE     = 0;
    /** Filled Signal dot + green label. Table is open. */
    public static final int PILL_OPEN     = 1;
    /** HOLLOW Amber ring + amber label. A held table — attention, not an error. */
    public static final int PILL_HELD     = 2;
    /** Filled Signal dot + green label. Paired to the till. */
    public static final int PILL_LINKED   = 3;
    /** Filled Coral dot + coral label. The only place coral is allowed. */
    public static final int PILL_DECLINED = 4;
    /** Filled Signal dot + green label — the Approved running head. */
    public static final int PILL_APPROVED = 5;

    /**
     * The mono status pill: a dot and an uppercase label, no chip behind it.
     * Serves the table cards (02), the tile affordance on "Waiting for POS" (01), and the outcome
     * running heads (08, 09).
     */
    public static LinearLayout statusPill(Context c, String label, int kind) {
        int colour;
        boolean hollow = false;
        switch (kind) {
            case PILL_HELD:     colour = AMBER; hollow = true; break;
            case PILL_DECLINED: colour = CORAL; break;
            default:            colour = SIGNAL; break;   // LIVE / OPEN / LINKED / APPROVED
        }
        LinearLayout p = rowCentered(c);
        p.addView(dot(c, colour, 5, hollow));
        p.addView(spacerH(c, 4));
        TextView t = mono(c, label == null ? "" : label, SP_PILL, colour, 1.2f, 19f);
        t.setAllCaps(true);
        p.addView(t);
        return p;
    }

    /**
     * The amber reassurance pill on Present card (06): "SIMULATED — NO CARD IS CHARGED".
     * Soft amber fill, amber border, amber mono. Distinct from the hard sandbox banner at the top
     * of the screen — this one reassures the CUSTOMER, that one warns the OPERATOR.
     */
    public static TextView reassurancePill(Context c, String label) {
        TextView t = mono(c, label, SP_PILL, AMBER, 1.5f, 20f);
        t.setAllCaps(true);
        t.setGravity(Gravity.CENTER);
        t.setBackground(surface(c, AMBER_SOFT, AMBER_SOFT_EDGE, R_BUTTON));
        t.setPadding(dp(c, 14), dp(c, 9), dp(c, 14), dp(c, 9));
        return t;
    }

    /** A ServOS dot. hollow=true draws the ring used for HELD. */
    public static View dot(Context c, int colour, int sizeDp, boolean hollow) {
        View v = new View(c);
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.OVAL);
        if (hollow) {
            g.setColor(Color.TRANSPARENT);
            g.setStroke(Math.max(1, dp(c, 1)), colour);
        } else {
            g.setColor(colour);
        }
        v.setBackground(g);
        v.setLayoutParams(new LinearLayout.LayoutParams(dp(c, sizeDp), dp(c, sizeDp)));
        return v;
    }

    // ---- tiles --------------------------------------------------------------------------------

    /**
     * The Home action tile (screen 01) as a real ViewGroup: icon chip, title, subtitle, and a
     * right affordance.
     *
     * Prefer this over modeButton when you control the layout — it takes an arbitrary right
     * affordance (a chevron, or a "● LINKED" status pill as the design does on the third tile)
     * and it is a LinearLayout, so children can be measured and restyled after construction.
     *
     * @param heroGreen Signal fill with #04140B text — at most ONE per screen.
     * @param right     the affordance view, or null for the default chevron.
     */
    public static LinearLayout tile(Context c, Drawable icon, String title, String subtitle,
                                    boolean heroGreen, View right, View.OnClickListener onClick) {
        Type.init(c);
        int fg = heroGreen ? ON_SIGNAL : MIST;
        int subFg = heroGreen ? ON_SIGNAL_MUTED : ASH;

        LinearLayout t = rowCentered(c);
        if (heroGreen) {
            t.setBackground(pressableOnGreen(surface(c, SIGNAL, Color.TRANSPARENT, R_TILE)));
            greenGlow(c, t, 9);
        } else {
            t.setBackground(pressable(surface(c, COAL, GRAPHITE, R_TILE)));
        }
        t.setPadding(dp(c, PAD_SIDE), dp(c, 12), dp(c, PAD_SIDE), dp(c, 12));   // after the bg
        if (onClick != null) t.setOnClickListener(onClick);

        if (icon != null) {
            t.addView(iconChip(c, icon, heroGreen));
            t.addView(spacerH(c, 14));   // spec gap 28px
        }

        LinearLayout stack = new LinearLayout(c);
        stack.setOrientation(LinearLayout.VERTICAL);
        TextView ttl = text(c, title, SP_TILE_TITLE, fg, 700);
        ttl.setLetterSpacing(-0.01f);
        stack.addView(ttl);
        if (subtitle != null && !subtitle.isEmpty()) {
            stack.addView(spacer(c, 4));
            TextView sub = text(c, subtitle, SP_TILE_SUB, subFg, 400);
            sub.setLineSpacing(0f, 1.3f);
            stack.addView(sub);
        }
        t.addView(stack, new LinearLayout.LayoutParams(0, -2, 1f));

        t.addView(spacerH(c, 10));
        t.addView(right != null ? right
                : imageOf(c, Icons.chevronRight(heroGreen ? ON_SIGNAL : ASH), 15));
        t.setMinimumHeight(dp(c, 92));
        return t;
    }

    /** Tile with the default chevron affordance. */
    public static LinearLayout tile(Context c, Drawable icon, String title, String subtitle,
                                    boolean heroGreen, View.OnClickListener onClick) {
        return tile(c, icon, title, subtitle, heroGreen, null, onClick);
    }

    // ---- icon chips ---------------------------------------------------------------------------

    /**
     * The rounded-square chip an icon sits in: 104px-space square, 26px-space corner, Graphite
     * fill with a Signal icon — or, inside a green hero tile, a translucent dark fill with a
     * #04140B icon.
     */
    public static ImageView iconChip(Context c, Drawable icon, boolean hero) {
        return iconChip(c, icon, hero ? ON_SIGNAL_CHIP : GRAPHITE, hero ? ON_SIGNAL : SIGNAL,
                ICON_CHIP, R_CHIP);
    }

    public static ImageView iconChip(Context c, Drawable icon, int chipFill, int iconTint,
                                     int sizeDp, float radiusDp) {
        ImageView v = new ImageView(c);
        v.setImageDrawable(iconChipDrawable(c, icon, chipFill, iconTint, sizeDp, radiusDp));
        v.setLayoutParams(new LinearLayout.LayoutParams(dp(c, sizeDp), dp(c, sizeDp)));
        return v;
    }

    /**
     * The same chip as a Drawable, so it can be used as a compound drawable on a Button —
     * which is how modeButton() keeps its original signature and still gets the ServOS tile look.
     */
    public static Drawable iconChipDrawable(Context c, Drawable icon, int chipFill, int iconTint,
                                            int sizeDp, float radiusDp) {
        int px = dp(c, sizeDp);
        int pad = px / 4;                    // spec: 52px icon inside a 104px chip
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(chipFill);
        bg.setCornerRadius(dp(c, radiusDp));
        bg.setSize(px, px);
        if (icon == null) return bg;
        Icons.tint(icon, iconTint);
        // LayerDrawable takes its intrinsic size from the chip layer, which setSize() just fixed
        // at px — that is what makes this usable as a compound drawable on a Button.
        LayerDrawable l = new LayerDrawable(new Drawable[]{bg, icon});
        l.setLayerInset(1, pad, pad, pad, pad);
        return l;
    }

    /** A bare icon in an ImageView at a given dp size — no chip. */
    public static ImageView imageOf(Context c, Drawable icon, int sizeDp) {
        ImageView v = new ImageView(c);
        v.setImageDrawable(icon);
        v.setLayoutParams(new LinearLayout.LayoutParams(dp(c, sizeDp), dp(c, sizeDp)));
        return v;
    }

    // ---- meta blocks --------------------------------------------------------------------------

    /**
     * The Coal block of mono key/value rows under an outcome: AUTH CODE / CARD / ORDER / TABLE /
     * TERMINAL on Approved (08), RESPONSE / CARD / AMOUNT on Declined (09).
     *
     * Returns the container; add rows with {@link #addMetaRow}, which handles the 14px-space gap.
     */
    public static LinearLayout metaBlock(Context c) {
        Type.init(c);
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setBackground(surface(c, COAL, GRAPHITE, R_KEY));
        l.setPadding(dp(c, 13), dp(c, 13), dp(c, 13), dp(c, 13));
        return l;
    }

    /** A single mono key/value row. Key in Ash, value in the colour you pass. */
    public static LinearLayout metaRow(Context c, String key, String value, int valueColour) {
        LinearLayout r = rowCentered(c);
        TextView k = mono(c, key == null ? "" : key, SP_META, ASH, 1f, 21f);
        k.setAllCaps(true);
        TextView v = mono(c, value == null ? "—" : value, SP_META, valueColour, 1f, 21f);
        v.setGravity(Gravity.END);
        r.addView(k, new LinearLayout.LayoutParams(0, -2, 1f));
        r.addView(v, new LinearLayout.LayoutParams(-2, -2));
        return r;
    }

    /** Meta row with the default Mist value. */
    public static LinearLayout metaRow(Context c, String key, String value) {
        return metaRow(c, key, value, MIST);
    }

    /** Append a row to a metaBlock, inserting the spec's 14px-space gap after the first. */
    public static LinearLayout addMetaRow(Context c, LinearLayout block, String key, String value,
                                          int valueColour) {
        if (block.getChildCount() > 0) block.addView(spacer(c, 7));
        LinearLayout r = metaRow(c, key, value, valueColour);
        block.addView(r, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        return r;
    }

    public static LinearLayout addMetaRow(Context c, LinearLayout block, String key, String value) {
        return addMetaRow(c, block, key, value, MIST);
    }

    // ---- bill lines ---------------------------------------------------------------------------

    /**
     * A bill line item (screen 03): mono qty prefix in Ash, name in Mist, price right-aligned.
     *
     * The 13px-space vertical padding is what makes five lines fit on the panel — the design note
     * is explicit that it must not grow. Callers add {@link #divider} between rows.
     */
    public static LinearLayout billRow(Context c, String qty, String name, String price) {
        LinearLayout r = rowCentered(c);
        r.setPadding(0, dp(c, 7), 0, dp(c, 7));
        if (qty != null && !qty.isEmpty()) {
            r.addView(mono(c, qty, SP_LINE_QTY, ASH, 0.5f, 23f));
            r.addView(spacerH(c, 7));
        }
        r.addView(text(c, name, SP_LINE_ITEM, MIST, 400), new LinearLayout.LayoutParams(0, -2, 1f));
        TextView p = text(c, price, SP_LINE_ITEM, MIST, 400);
        p.setGravity(Gravity.END);
        r.addView(p, new LinearLayout.LayoutParams(-2, -2));
        return r;
    }

    /** A label/value line, e.g. "Tip            £1.05". */
    public static LinearLayout line(Context c, String label, String value,
                                    float sizeSp, int colour, boolean bold) {
        LinearLayout r = rowCentered(c);
        TextView l = text(c, label, sizeSp, colour, bold ? 600 : 400);
        TextView v = text(c, value, sizeSp, colour, bold ? 700 : 500);
        v.setGravity(Gravity.END);
        r.addView(l, new LinearLayout.LayoutParams(0, -2, 1f));
        r.addView(v, new LinearLayout.LayoutParams(-2, -2));
        return r;
    }

    // ---- brand --------------------------------------------------------------------------------

    /**
     * The ServOS lockup on Home (01): monogram chip, "ServOS" wordmark with its trailing Signal
     * dot, and a "PAYMENTS" mono eyebrow beneath.
     *
     * Brand rule the design is explicit about: the mark stays monochrome, upright and unstretched
     * — only the dot is green, and the dot is always a perfect circle.
     */
    public static LinearLayout brandLockup(Context c, String eyebrow) {
        LinearLayout r = rowCentered(c);
        r.addView(iconChip(c, Icons.monogram(MIST), GRAPHITE, MIST, 33, 10f));  // 66px chip
        r.addView(spacerH(c, 10));

        LinearLayout stack = new LinearLayout(c);
        stack.setOrientation(LinearLayout.VERTICAL);

        LinearLayout word = row(c);
        word.setGravity(Gravity.BOTTOM);
        TextView mark = text(c, "ServOS", 20f, MIST, 600);   // 40px design
        mark.setLetterSpacing(-0.02f);
        word.addView(mark);
        word.addView(spacerH(c, 4));
        View d = dot(c, SIGNAL, 5, false);
        LinearLayout.LayoutParams dlp = (LinearLayout.LayoutParams) d.getLayoutParams();
        dlp.bottomMargin = dp(c, 3);
        word.addView(d);
        stack.addView(word);

        if (eyebrow != null && !eyebrow.isEmpty()) {
            stack.addView(spacer(c, 3));
            TextView eb = mono(c, eyebrow, SP_META_SMALL, ASH, 3f, 19f);
            eb.setAllCaps(true);
            stack.addView(eb);
        }
        r.addView(stack);
        return r;
    }

    // ═══ CHROME (delegates to Chrome.java) ═════════════════════════════════════════════════════

    /**
     * The amber "this build cannot charge a card" banner.
     *
     * Shown on every screen while BuildVersion.SIMULATED is true. It exists so that a stubbed
     * build can never be mistaken for a working one during a demo or a real service.
     * Honours Chrome.showSandboxBanner by returning a GONE view rather than null, so a caller can
     * add it unconditionally.
     */
    public static TextView simulatedBanner(Context c) {
        return Chrome.sandboxBanner(c);
    }

    /** The diagnostics footer line, present on every screen. Tap to open the full report. */
    public static TextView diagnosticsFooter(Context c, String summary, View.OnClickListener onClick) {
        TextView t = Chrome.debugFooter(c, summary);
        t.setOnClickListener(onClick);
        return t;
    }

    /**
     * A full-bleed coloured banner, e.g. the unresolved-payment warning.
     * Deliberately NOT mono/uppercase: this one carries a sentence a human has to read and act
     * on, not a status token.
     */
    public static TextView banner(Context c, String message, int background, int foreground) {
        TextView t = text(c, message, SP_TILE_SUB, foreground, 600);
        t.setGravity(Gravity.CENTER);
        t.setBackgroundColor(background);
        t.setPadding(dp(c, 12), dp(c, 10), dp(c, 12), dp(c, 10));   // after the bg
        return t;
    }

    // ═══ LAYOUT HELPERS ═══════════════════════════════════════════════════════════════════════

    public static View spacer(Context c, int heightDp) {
        View v = new View(c);
        v.setLayoutParams(new LinearLayout.LayoutParams(-1, dp(c, heightDp)));
        return v;
    }

    /** Horizontal gap, for use inside a horizontal row. */
    public static View spacerH(Context c, int widthDp) {
        View v = new View(c);
        v.setLayoutParams(new LinearLayout.LayoutParams(dp(c, widthDp), 1));
        return v;
    }

    /** Flexible gap that pushes what follows to the bottom. */
    public static View flexSpacer(Context c) {
        View v = new View(c);
        v.setLayoutParams(new LinearLayout.LayoutParams(-1, 0, 1f));
        return v;
    }

    public static LinearLayout.LayoutParams lp(int w, int h) {
        return new LinearLayout.LayoutParams(w, h);
    }

    public static LinearLayout.LayoutParams lpWeight(float weight) {
        return new LinearLayout.LayoutParams(0, -1, weight);
    }

    /** The ServOS content inset: 34px top, 40px sides, 30px bottom. */
    public static void contentPadding(Context c, View v) {
        v.setPadding(dp(c, PAD_SIDE), dp(c, PAD_TOP), dp(c, PAD_SIDE), dp(c, PAD_BOTTOM));
    }

    // ═══ INTERNALS ════════════════════════════════════════════════════════════════════════════

    /**
     * A screen root that paints the console grid — but only if no ancestor is already doing it.
     *
     * MainActivity builds its chrome from screen() and then mounts a screen that also uses
     * screen(), so without this check the grid would be drawn twice at different origins and
     * read as noise. The parent walk happens once per draw and stops at the first GridRoot.
     */
    private static final class GridRoot extends LinearLayout {
        private final Drawable grid;

        GridRoot(Context c) {
            super(c);
            grid = Chrome.gridOverlay(c);
            setWillNotDraw(false);
        }

        @Override protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            if (!Chrome.showGrid || !outermost()) return;
            grid.setBounds(0, 0, getWidth(), getHeight());
            grid.draw(canvas);
        }

        private boolean outermost() {
            ViewParent p = getParent();
            while (p instanceof ViewGroup) {
                if (p instanceof GridRoot) return false;
                p = p.getParent();
            }
            return true;
        }
    }

    /** Applies a Typeface to a span range. TypefaceSpan(Typeface) is API 28; this is API 26-safe. */
    private static final class FaceSpan extends MetricAffectingSpan {
        private final Typeface face;
        FaceSpan(Typeface face) { this.face = face; }
        @Override public void updateDrawState(TextPaint p) { apply(p); }
        @Override public void updateMeasureState(TextPaint p) { apply(p); }
        private void apply(TextPaint p) { if (face != null) p.setTypeface(face); }
    }
}
