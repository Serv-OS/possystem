package co.posup.rpos.paxpay.ui;

import android.content.Context;
import android.graphics.Bitmap;
import android.view.MotionEvent;
import android.widget.FrameLayout;
import android.widget.ImageView;

/**
 * The venue's idle image, full screen, over the home screen.
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
 */
public final class ScreensaverScreen extends FrameLayout {

    public interface Listener {
        void onDismiss();
    }

    public ScreensaverScreen(Context c, Bitmap image, Listener listener) {
        super(c);
        // Opaque, so nothing of the screen underneath shows through at the edges of a photo
        // whose aspect ratio does not match the terminal.
        setBackgroundColor(Ui.BG);
        setClickable(true);
        setFocusable(true);

        ImageView iv = new ImageView(c);
        iv.setImageBitmap(image);
        // CENTER_CROP fills the screen without letterboxing. The Back Office copy tells the
        // operator this screen is tall and narrow, so cropping the sides of a landscape image
        // is the expected outcome rather than a surprise.
        iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
        addView(iv, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));

        setOnClickListener(v -> listener.onDismiss());
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
