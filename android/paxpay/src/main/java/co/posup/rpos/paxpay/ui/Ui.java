package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.content.res.ColorStateList;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Shared view helpers and the app's colour/type scale.
 *
 * Built programmatically rather than with XML layouts, matching the rest of android/ (:app,
 * :mpos and :menuboard all construct their views in code and ship no layout XML).
 *
 * DESIGN CONSTRAINTS — this runs on a PAX A920 Pro: a ~5" 720×1280 screen (roughly 393×700dp)
 * that is held out at arm's length and, on the tip screen, READ BY THE PAYING CUSTOMER, often
 * older, often in a dim restaurant, sometimes without their reading glasses. So:
 *   - minimum 64dp touch targets (the physical A920 screen is small and fingers are not)
 *   - large type: amounts are display-sized, nothing meaningful below 16sp
 *   - near-black background with white text for maximum contrast under venue lighting
 *   - one clear primary action per screen
 * Do not "tidy" these sizes down to phone-app defaults; the device is not a phone.
 */
public final class Ui {
    private Ui() {}

    // ---- palette -------------------------------------------------------------------------
    public static final int BG        = 0xFF0B0F14; // near black
    public static final int SURFACE   = 0xFF161C24; // raised card
    public static final int SURFACE_2 = 0xFF232C38; // keypad key
    public static final int TEXT      = 0xFFFFFFFF;
    public static final int MUTED     = 0xFF9AA6B2;
    public static final int ACCENT    = 0xFF16A34A; // green — primary / approved
    public static final int WARN      = 0xFFF59E0B; // amber — simulated-build banner
    public static final int DANGER    = 0xFFEF4444; // red — declined / error

    public static int dp(Context c, float v) {
        return Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, v, c.getResources().getDisplayMetrics()));
    }

    /** Root vertical container with the app background. */
    public static LinearLayout screen(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setBackgroundColor(BG);
        return l;
    }

    public static LinearLayout row(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.HORIZONTAL);
        return l;
    }

    public static TextView text(Context c, String s, float sizeSp, int colour, boolean bold) {
        TextView t = new TextView(c);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp);
        t.setTextColor(colour);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    /** Big money readout. */
    public static TextView amount(Context c, String s) {
        TextView t = text(c, s, 44f, TEXT, true);
        t.setGravity(Gravity.CENTER);
        return t;
    }

    /** Primary (filled) action button — the one thing the user should press. */
    public static Button primaryButton(Context c, String label, View.OnClickListener onClick) {
        return button(c, label, TEXT, ACCENT, 21f, onClick);
    }

    /** Secondary (outlined) action button. */
    public static Button secondaryButton(Context c, String label, View.OnClickListener onClick) {
        Button b = button(c, label, TEXT, SURFACE, 19f, onClick);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(SURFACE);
        bg.setCornerRadius(dp(c, 12));
        bg.setStroke(dp(c, 1.5f), SURFACE_2);
        b.setBackground(ripple(bg));
        return b;
    }

    public static Button button(Context c, String label, int fg, int bgColour,
                                float sizeSp, View.OnClickListener onClick) {
        Button b = new Button(c);
        b.setAllCaps(false);
        b.setText(label);
        b.setTextColor(fg);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setPadding(dp(c, 10), dp(c, 10), dp(c, 10), dp(c, 10));

        GradientDrawable bg = new GradientDrawable();
        bg.setColor(bgColour);
        bg.setCornerRadius(dp(c, 12));
        b.setBackground(ripple(bg));

        b.setOnClickListener(onClick);
        b.setMinHeight(dp(c, 64));   // see class comment — 64dp floor for touch targets
        return b;
    }

    /**
     * A home-screen mode button: title over a one-line explanation.
     *
     * Deliberately huge (see the class comment). The home screen is used at arm's length by
     * someone holding plates in the other hand; three targets filling the screen beats a tidy
     * list every time.
     */
    public static Button modeButton(Context c, String title, String subtitle, int accent,
                                    View.OnClickListener onClick) {
        Button b = new Button(c);
        b.setAllCaps(false);
        b.setText(title + "\n" + subtitle);
        b.setTextColor(TEXT);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 21f);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setLineSpacing(dp(c, 3), 1.0f);
        b.setPadding(dp(c, 14), dp(c, 10), dp(c, 14), dp(c, 10));

        GradientDrawable bg = new GradientDrawable();
        bg.setColor(SURFACE);
        bg.setCornerRadius(dp(c, 16));
        bg.setStroke(dp(c, 2f), accent);
        b.setBackground(ripple(bg));
        b.setOnClickListener(onClick);
        b.setMinHeight(dp(c, 92));
        return b;
    }

    /** Destructive / blocking action — red. Used only where a human must consciously decide. */
    public static Button dangerButton(Context c, String label, View.OnClickListener onClick) {
        return button(c, label, TEXT, DANGER, 19f, onClick);
    }

    /** A full-bleed coloured banner, e.g. the unresolved-payment warning. */
    public static TextView banner(Context c, String message, int background, int foreground) {
        TextView t = text(c, message, 13f, foreground, true);
        t.setGravity(Gravity.CENTER);
        t.setPadding(dp(c, 10), dp(c, 8), dp(c, 10), dp(c, 8));
        t.setBackgroundColor(background);
        return t;
    }

    /** Screen title, consistent across every screen added in milestone 2. */
    public static TextView title(Context c, String s) {
        TextView t = text(c, s, 22f, TEXT, true);
        t.setGravity(Gravity.CENTER);
        return t;
    }

    /** Touch feedback matters on a terminal — the customer needs to know the press registered. */
    private static RippleDrawable ripple(GradientDrawable content) {
        return new RippleDrawable(
                ColorStateList.valueOf(Color.argb(60, 255, 255, 255)), content, null);
    }

    /** Rounded panel used for cards / readouts. */
    public static LinearLayout card(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(SURFACE);
        bg.setCornerRadius(dp(c, 14));
        l.setBackground(bg);
        l.setPadding(dp(c, 16), dp(c, 14), dp(c, 16), dp(c, 14));
        return l;
    }

    /** A label/value line, e.g. "Tip            £1.05". */
    public static LinearLayout line(Context c, String label, String value,
                                    float sizeSp, int colour, boolean bold) {
        LinearLayout r = row(c);
        r.setGravity(Gravity.CENTER_VERTICAL);
        TextView l = text(c, label, sizeSp, colour, bold);
        TextView v = text(c, value, sizeSp, colour, true);
        r.addView(l, new LinearLayout.LayoutParams(0, -2, 1f));
        r.addView(v, new LinearLayout.LayoutParams(-2, -2));
        return r;
    }

    public static View spacer(Context c, int heightDp) {
        View v = new View(c);
        v.setLayoutParams(new LinearLayout.LayoutParams(-1, dp(c, heightDp)));
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

    /**
     * The amber "this build cannot charge a card" banner.
     *
     * Shown on every screen while BuildVersion.SIMULATED is true. It exists so that a stubbed
     * build can never be mistaken for a working one during a demo or a real service.
     */
    public static TextView simulatedBanner(Context c) {
        TextView t = text(c, "SIMULATED BUILD — NO CARD IS CHARGED", 13f, 0xFF1A1205, true);
        t.setGravity(Gravity.CENTER);
        t.setPadding(dp(c, 8), dp(c, 7), dp(c, 8), dp(c, 7));
        t.setBackgroundColor(WARN);
        return t;
    }

    /** The diagnostics footer line, present on every screen. Tap to open the full report. */
    public static TextView diagnosticsFooter(Context c, String summary, View.OnClickListener onClick) {
        TextView t = text(c, summary, 10.5f, MUTED, false);
        t.setPadding(dp(c, 12), dp(c, 8), dp(c, 12), dp(c, 10));
        t.setBackgroundColor(SURFACE);
        t.setGravity(Gravity.CENTER);
        t.setOnClickListener(onClick);
        return t;
    }
}
