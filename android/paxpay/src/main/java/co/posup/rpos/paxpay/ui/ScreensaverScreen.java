package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.LayerDrawable;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import co.posup.rpos.paxpay.store.Prefs;

/**
 * The terminal's resting face — the venue's idle image, full screen, over the home screen.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THIS VIEW HAS NO IDEA WHEN IT IS ALLOWED TO EXIST, AND THAT IS THE POINT.
 *
 * It is a dumb image with a touch listener. Every decision about WHETHER a screensaver may be
 * shown lives in exactly one place — MainActivity's idle timer, which is armed only at the end
 * of showHome() and disarmed by setScreen() on every other transition. Putting a second opinion
 * in here would mean two things could disagree about whether a payment is in flight, and the
 * losing case is a screensaver appearing over a live tip prompt.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * ANY touch dismisses it — down, not up, and the event is consumed so the dismissing tap cannot
 * fall through onto a payment button underneath. Staff pick the terminal up and it wakes; they
 * do not have to find a target.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * TWO FACES, AND ONLY ONE OF THEM IS OURS TO DESIGN
 *
 * WITH AN IMAGE: the operator's artwork fills the panel edge to edge and we put NOTHING on top
 * of it. No grid, no monogram, no status line. A venue that uploaded a picture bought the whole
 * screen; overlaying our chrome on it would be us signing someone else's poster.
 *
 * WITHOUT ONE (image == null): we draw the ServOS resting face instead — Ink, the console grid,
 * the monogram, the venue name, and a quiet mono line saying the terminal is awake and listening.
 * That line is the entire job of this state. A dark rectangle and a terminal that has crashed
 * look identical from across a room, and the difference matters to whoever is deciding whether
 * to walk over and poke it.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ MainActivity CANNOT CURRENTLY REACH THE FALLBACK FACE. Both armScreensaver() (no image URL →
 * never armed) and showScreensaver() (decode returned null → return) bail out before constructing
 * this view, so today `image` is always non-null in production and the fallback is dead on
 * arrival. It is built, correct and ready anyway; wiring it up is a MainActivity change and
 * MainActivity is not this file's to edit. See the note in the handover.
 *
 * NOTHING HERE ANIMATES. This view is designed to sit untouched for hours on a panel that is
 * never switched off, so a pulsing dot would buy a little life at the cost of a repeating
 * animator running all shift. The dot is a static Signal circle.
 */
public final class ScreensaverScreen extends FrameLayout {

    public interface Listener {
        void onDismiss();
    }

    /** Shown when the venue has no name on file. Never blank — a blank line reads as broken. */
    private static final String FALLBACK_VENUE = "ServOS terminal";
    /** The whole point of the fallback face: this terminal is awake and can take a payment. */
    private static final String READY_LINE = "READY · TAKING PAYMENTS";

    /**
     * The signature MainActivity calls. UNCHANGED.
     *
     * @param image the decoded idle image, or null to draw the ServOS resting face instead.
     */
    public ScreensaverScreen(Context c, Bitmap image, Listener listener) {
        this(c, image, venueLabelOf(c), listener);
    }

    /**
     * Additive overload — the venue name passed in explicitly rather than read from Prefs.
     *
     * MainActivity already holds `prefs` and hands `prefs.label()` to PosIdleScreen; when someone
     * owns that file this is the constructor to move to, so the resting face and the idle surface
     * underneath it cannot disagree about the venue's name.
     */
    public ScreensaverScreen(Context c, Bitmap image, String venueLabel, Listener listener) {
        super(c);
        // Opaque, so nothing of the screen underneath shows through at the edges of a photo
        // whose aspect ratio does not match the terminal.
        setBackgroundColor(Ui.INK);
        setClickable(true);
        setFocusable(true);

        if (image != null) {
            addImage(c, image);
        } else {
            addRestingFace(c, venueLabel);
        }

        setOnClickListener(v -> listener.onDismiss());
    }

    // ---- the operator's artwork ----------------------------------------------------------------

    private void addImage(Context c, Bitmap image) {
        ImageView iv = new ImageView(c);
        iv.setImageBitmap(image);
        // CENTER_CROP fills the screen without letterboxing. The Back Office copy tells the
        // operator this screen is tall and narrow, so cropping the sides of a landscape image
        // is the expected outcome rather than a surprise.
        iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
        addView(iv, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
        // No grid and no lockup on top — see the class comment.
    }

    // ---- the ServOS resting face ---------------------------------------------------------------

    private void addRestingFace(Context c, String venueLabel) {
        setBackground(inkWithGrid(c));

        LinearLayout stack = new LinearLayout(c);
        stack.setOrientation(LinearLayout.VERTICAL);
        stack.setGravity(Gravity.CENTER);
        // Spec content padding is 40px sides in the 720px design space → 20dp. Generous top and
        // bottom because this stack is centred and never scrolls.
        stack.setPadding(Ui.dp(c, Ui.PAD_SIDE), Ui.dp(c, 28),
                Ui.dp(c, Ui.PAD_SIDE), Ui.dp(c, 28));

        // Monogram, on a Graphite chip. 88dp = 176px design — far larger than the 66px lockup
        // chip on Home, because this is read from across a room rather than at arm's length.
        // Radius scales with it (88dp chip : 26dp radius holds the lockup's 66:20 proportion,
        // and lands inside the spec's 20–26px icon-chip range once doubled back to design px).
        ImageView mark = Ui.iconChip(c, Icons.monogram(Ui.MIST), Ui.GRAPHITE, Ui.MIST, 88, 26f);
        centre(mark);
        stack.addView(mark);
        stack.addView(Ui.spacer(c, 22));

        // Venue name at screen-title weight: Space Grotesk 54px 600, tracking -0.01em.
        TextView venue = Ui.text(c, labelOrDefault(venueLabel),
                Ui.SP_SCREEN_TITLE, Ui.MIST, 600);
        venue.setLetterSpacing(-0.01f);
        venue.setGravity(Gravity.CENTER);
        venue.setMaxLines(2);
        stack.addView(venue);
        stack.addView(Ui.spacer(c, 16));

        stack.addView(readyLine(c));

        addView(stack, new LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT, Gravity.CENTER));
    }

    /**
     * "● READY · TAKING PAYMENTS" — a real Signal dot plus a mono running head, not a bullet
     * glyph. The glyph would inherit JetBrains Mono's own baseline and optical size and sit
     * slightly wrong next to uppercase; Ui.dot() is the same circle the live pills use, and it
     * is guaranteed round at any density.
     */
    private LinearLayout readyLine(Context c) {
        LinearLayout row = Ui.rowCentered(c);
        row.setGravity(Gravity.CENTER);
        row.addView(Ui.dot(c, Ui.SIGNAL, 5, false));
        row.addView(Ui.spacerH(c, 7));
        // Ash, not Signal: the dot carries the colour and the words stay quiet. A full green line
        // on a resting terminal would read as an alert rather than as a state.
        row.addView(Ui.monoHead(c, READY_LINE, Ui.ASH));
        centre(row);
        return row;
    }

    // ---- helpers -------------------------------------------------------------------------------

    /**
     * Ink with the console grid on top: 1px at 2.8% Mist every 28dp (56px design), both axes.
     *
     * Drawn here rather than via Ui.screen() because this view is a FrameLayout overlay added
     * straight into MainActivity's content stack, not a screen root — which is the case
     * Chrome.gridOverlay() documents itself for. Chrome.showGrid is honoured so the dev toggle
     * still means something on this surface.
     */
    private static Drawable inkWithGrid(Context c) {
        ColorDrawable ink = new ColorDrawable(Ui.INK);
        if (!Chrome.showGrid) return ink;
        return new LayerDrawable(new Drawable[]{ink, Chrome.gridOverlay(c)});
    }

    /** Widen a child to full width and centre it — the stack is a vertical LinearLayout. */
    private static void centre(View v) {
        LinearLayout.LayoutParams lp = v.getLayoutParams() instanceof LinearLayout.LayoutParams
                ? (LinearLayout.LayoutParams) v.getLayoutParams()
                : new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.gravity = Gravity.CENTER_HORIZONTAL;
        v.setLayoutParams(lp);
    }

    private static String labelOrDefault(String label) {
        return (label == null || label.trim().isEmpty()) ? FALLBACK_VENUE : label.trim();
    }

    /**
     * The venue name, best-effort.
     *
     * Same source PosIdleScreen is fed from (Prefs.label()), so the resting face and the surface
     * underneath it agree. Wrapped because this is a decoration path: a screensaver that threw on
     * the way up would take out a terminal that is otherwise perfectly able to take a payment.
     */
    private static String venueLabelOf(Context c) {
        try {
            return new Prefs(c).label();
        } catch (Throwable t) {
            return null;
        }
    }

    @Override
    public boolean onTouchEvent(MotionEvent event) {
        if (event.getActionMasked() == MotionEvent.ACTION_DOWN) {
            performClick();
            return true;   // consumed: the waking tap must not also press something
        }
        return true;
    }

    @Override
    public boolean performClick() {
        super.performClick();
        return true;
    }
}
