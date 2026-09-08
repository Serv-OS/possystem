package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.drawable.Drawable;

import java.util.ArrayList;
import java.util.List;

/**
 * The ServOS Pay icon set, recreated from the inline SVGs in the design reference.
 *
 * No vector XML, no image assets, no icon font — each icon is an android.graphics.Path drawn by a
 * tiny Drawable. That keeps them consistent with the rest of android/ (views are built in code),
 * makes them recolourable at runtime the way `currentColor` works in the spec, and means they
 * stay crisp at the sizes this device actually uses (52dp icon chips, 60dp outcome glyphs).
 *
 * ── COORDINATE SPACE ────────────────────────────────────────────────────────────────────────
 * Every path below is authored in a 48×48 box, matching the spec's dominant SVG viewBox. Icons
 * the designer drew in another viewBox (chevrons at 24×24, the ServOS monogram at 100×100) have
 * been rescaled into 48×48 here, stroke widths included, so callers never have to care. The
 * Drawable scales that 48×48 box to whatever bounds it is given, and because the canvas is scaled
 * the stroke scales with it — a 3.2 stroke reads the same at 24dp as at 60dp.
 *
 * ── COLOUR ──────────────────────────────────────────────────────────────────────────────────
 * Each factory takes the colour directly (Icons.table(Ui.SIGNAL)). setTint()/setTintList() also
 * work, which is what Ui.tile() uses to flip an icon to #04140B when it lands on a green hero
 * tile. Nothing here allocates per frame.
 */
public final class Icons {
    private Icons() {}

    /** The authoring box every path below is expressed in. */
    private static final float VB = 48f;

    // ---- factories ---------------------------------------------------------------------------

    /** Floor-plan 2×2 — Table Pay tile (screen 01), and the Tables running head. */
    public static Drawable table(int colour) {
        VectorIcon i = new VectorIcon(colour);
        i.stroke(roundRect(6, 6, 15, 15, 4), 3.2f);
        i.stroke(roundRect(27, 6, 15, 15, 4), 3.2f);
        i.stroke(roundRect(6, 27, 15, 15, 4), 3.2f);
        i.stroke(roundRect(27, 27, 15, 15, 4), 3.2f);
        return i;
    }

    /** Keypad 3×3 dots (filled) — Manual payment tile (screen 01). */
    public static Drawable keypad(int colour) {
        VectorIcon i = new VectorIcon(colour);
        Path p = new Path();
        float[] at = {12f, 24f, 36f};
        for (float y : at) for (float x : at) p.addCircle(x, y, 3.4f, Path.Direction.CW);
        i.fill(p);
        return i;
    }

    /** Inbound arrow onto a line — "Waiting for POS" tile + the waiting disc (screens 01, 05). */
    public static Drawable inbound(int colour) {
        VectorIcon i = new VectorIcon(colour);
        Path p = new Path();
        p.moveTo(24, 7);  p.rLineTo(0, 21);
        p.moveTo(15, 21); p.rLineTo(9, 9); p.rLineTo(9, -9);
        p.moveTo(9, 39);  p.rLineTo(30, 0);
        i.stroke(p, 3.2f);
        return i;
    }

    /** Contactless waves — the Present-card hero and the TAP method chip (screen 06). */
    public static Drawable contactless(int colour) {
        VectorIcon i = new VectorIcon(colour);
        Path p = new Path();
        p.moveTo(15, 15); p.rCubicTo(5.5f, 4.5f, 5.5f, 13.5f, 0f, 18f);
        p.moveTo(23, 10); p.rCubicTo(9f, 6.5f, 9f, 21.5f, 0f, 28f);
        p.moveTo(31, 5);  p.rCubicTo(12f, 8.5f, 12f, 29.5f, 0f, 38f);
        i.stroke(p, 3.4f);
        return i;
    }

    /** EMV chip — the CHIP method chip (screen 06). */
    public static Drawable chip(int colour) {
        VectorIcon i = new VectorIcon(colour);
        Path p = roundRect(12, 14, 24, 20, 4);
        p.moveTo(12, 22); p.rLineTo(6, 0);
        p.moveTo(30, 22); p.rLineTo(6, 0);
        p.moveTo(12, 26); p.rLineTo(6, 0);
        p.moveTo(30, 26); p.rLineTo(6, 0);
        p.moveTo(20, 14); p.rLineTo(0, 6);
        p.moveTo(28, 14); p.rLineTo(0, 6);
        p.moveTo(20, 28); p.rLineTo(0, 6);
        p.moveTo(28, 28); p.rLineTo(0, 6);
        i.stroke(p, 2.6f);
        return i;
    }

    /** Magstripe card — the SWIPE method chip (screen 06). */
    public static Drawable magstripe(int colour) {
        VectorIcon i = new VectorIcon(colour);
        Path p = roundRect(6, 13, 36, 22, 4);
        p.moveTo(6, 21); p.rLineTo(36, 0);
        i.stroke(p, 2.6f);
        return i;
    }

    /** Tick — the Approved disc (screen 08). Drawn heavy so it reads across a room. */
    public static Drawable check(int colour) {
        VectorIcon i = new VectorIcon(colour);
        Path p = new Path();
        p.moveTo(12, 25); p.rLineTo(8, 8); p.rLineTo(16, -18);
        i.stroke(p, 5f);
        return i;
    }

    /** Cross — the Declined disc (screen 09). Coral, and only ever coral. */
    public static Drawable cross(int colour) {
        VectorIcon i = new VectorIcon(colour);
        Path p = new Path();
        p.moveTo(15, 15); p.rLineTo(18, 18);
        p.moveTo(33, 15); p.rLineTo(-18, 18);
        i.stroke(p, 5f);
        return i;
    }

    /** Chevron right — the tile affordance and the primary CTA (screens 01, 03, 04). */
    public static Drawable chevronRight(int colour) {
        VectorIcon i = new VectorIcon(colour);
        Path p = new Path();
        p.moveTo(18, 12); p.rLineTo(12, 12); p.rLineTo(-12, 12);
        i.stroke(p, 5.2f);       // spec 2.6 in a 24-box → 5.2 in this 48-box
        return i;
    }

    /** Chevron left — the "‹ HOME" / "‹ TABLES" back affordance in every running head. */
    public static Drawable chevronLeft(int colour) {
        VectorIcon i = new VectorIcon(colour);
        Path p = new Path();
        p.moveTo(30, 12); p.rLineTo(-12, 12); p.rLineTo(12, 12);
        i.stroke(p, 5.2f);
        return i;
    }

    /** Backspace — the keypad delete key (screen 04). */
    public static Drawable backspace(int colour) {
        VectorIcon i = new VectorIcon(colour);
        Path p = new Path();
        p.moveTo(42, 14); p.lineTo(18, 14); p.lineTo(7, 24); p.lineTo(18, 34); p.lineTo(42, 34);
        p.close();
        p.moveTo(33, 20); p.rLineTo(-8, 8);
        p.moveTo(25, 20); p.rLineTo(8, 8);
        i.stroke(p, 3f);
        return i;
    }

    /**
     * The ServOS "S" monogram, rescaled from the 100×100 vector recreation in the design.
     *
     * NOTE FOR SHIPPING: the design bundle says this path is a recreation, NOT the official
     * asset. Swap it for the real ServOS logo before this goes in front of customers. The green
     * trailing dot is drawn by Ui.brandLockup(), not here — brand rules keep the mark monochrome.
     */
    public static Drawable monogram(int colour) {
        VectorIcon i = new VectorIcon(colour);
        final float k = 0.48f;   // 100-box → 48-box
        Path p = new Path();
        p.moveTo(78 * k, 31 * k);
        p.cubicTo(78 * k, 20 * k, 66 * k, 15 * k, 52 * k, 15 * k);
        p.cubicTo(35 * k, 15 * k, 25 * k, 24 * k, 25 * k, 36 * k);
        p.cubicTo(25 * k, 48 * k, 38 * k, 52 * k, 52 * k, 54 * k);
        p.cubicTo(69 * k, 56 * k, 80 * k, 61 * k, 80 * k, 73 * k);
        p.cubicTo(80 * k, 86 * k, 66 * k, 91 * k, 50 * k, 91 * k);
        p.cubicTo(36 * k, 91 * k, 26 * k, 86 * k, 22 * k, 77 * k);
        i.stroke(p, 16f * k);
        return i;
    }

    // ---- sizing ------------------------------------------------------------------------------

    /**
     * Give an icon an intrinsic size in dp, so it can be used as a compound drawable or dropped
     * into an ImageView without further layout work. Returns the same instance for chaining.
     */
    public static Drawable size(Context c, Drawable icon, int sizeDp) {
        if (icon == null || c == null) return icon;
        int px = Ui.dp(c, sizeDp);
        if (icon instanceof VectorIcon) ((VectorIcon) icon).setIntrinsicSize(px);
        icon.setBounds(0, 0, px, px);
        return icon;
    }

    /** Recolour any icon from this class in place. Returns the same instance for chaining. */
    public static Drawable tint(Drawable icon, int colour) {
        if (icon instanceof VectorIcon) ((VectorIcon) icon).setColour(colour);
        else if (icon != null) icon.setTint(colour);
        return icon;
    }

    // ---- helpers -----------------------------------------------------------------------------

    private static Path roundRect(float x, float y, float w, float h, float r) {
        Path p = new Path();
        p.addRoundRect(new RectF(x, y, x + w, y + h), r, r, Path.Direction.CW);
        return p;
    }

    // ---- the drawable -------------------------------------------------------------------------

    /**
     * A stack of stroked/filled paths in a 48×48 box, scaled to bounds at draw time.
     *
     * Kept private: callers work in Drawables, which keeps the door open to swapping any single
     * icon for a real asset later without a signature change anywhere.
     */
    private static final class VectorIcon extends Drawable {
        private final List<Path> paths = new ArrayList<>(4);
        private final List<Float> widths = new ArrayList<>(4);   // <= 0 means fill
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private int colour;
        private int tint = 0;
        private boolean tinted = false;
        private int intrinsic = -1;
        private int alphaMul = 255;

        VectorIcon(int colour) {
            this.colour = colour;
            paint.setStrokeCap(Paint.Cap.ROUND);
            paint.setStrokeJoin(Paint.Join.ROUND);
        }

        void stroke(Path p, float width) { paths.add(p); widths.add(width); }
        void fill(Path p)                { paths.add(p); widths.add(0f); }

        void setColour(int c) { colour = c; tinted = false; invalidateSelf(); }
        void setIntrinsicSize(int px) { intrinsic = px; invalidateSelf(); }

        @Override public int getIntrinsicWidth()  { return intrinsic; }
        @Override public int getIntrinsicHeight() { return intrinsic; }

        @Override public void draw(Canvas canvas) {
            Rect b = getBounds();
            if (b.width() <= 0 || b.height() <= 0) return;
            int save = canvas.save();
            canvas.translate(b.left, b.top);
            canvas.scale(b.width() / VB, b.height() / VB);
            int c = tinted ? tint : colour;
            paint.setColor(c);
            if (alphaMul < 255) paint.setAlpha(((c >>> 24) * alphaMul) / 255);
            for (int i = 0; i < paths.size(); i++) {
                float w = widths.get(i);
                if (w > 0f) {
                    paint.setStyle(Paint.Style.STROKE);
                    paint.setStrokeWidth(w);
                } else {
                    paint.setStyle(Paint.Style.FILL);
                }
                canvas.drawPath(paths.get(i), paint);
            }
            canvas.restoreToCount(save);
        }

        @Override public void setAlpha(int alpha) { alphaMul = alpha; invalidateSelf(); }
        @Override public void setColorFilter(ColorFilter cf) { paint.setColorFilter(cf); }
        // Deprecated on Drawable but still abstract — it has to be implemented.
        @SuppressWarnings("deprecation")
        @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }

        @Override public void setTint(int t) { tint = t; tinted = true; invalidateSelf(); }

        @Override public void setTintList(ColorStateList list) {
            if (list == null) { tinted = false; }
            else { tint = list.getDefaultColor(); tinted = true; }
            invalidateSelf();
        }
    }
}
