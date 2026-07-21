package co.posup.rpos.paxpay.ui;

import android.animation.ObjectAnimator;
import android.animation.PropertyValuesHolder;
import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.LayerDrawable;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.animation.DecelerateInterpolator;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import co.posup.rpos.paxpay.BuildVersion;

/**
 * IDLE-FIRST (v5.5.841) — what a POS-DISPATCH-ONLY terminal shows when it is doing nothing.
 * ServOS design language, screen 05 "Waiting for POS" (redesign).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY IT IS ALMOST EMPTY, ON PURPOSE — AND WHY IT STILL HAS NO BUTTON
 *
 * There used to be a WaitingForPosScreen here — a spinner, a "checked 4 times" status line and a
 * Back button — for a waiter who had tapped "Waiting for POS" and was standing there watching.
 * Both that screen and that button are gone (v5.5.841): receiving from the till is ambient, not a
 * mode somebody enters, so nobody is ever standing at a terminal waiting for it to start.
 *
 * The ServOS spec for screen 05 draws a "Cancel" ghost button at the bottom. IT IS DELIBERATELY
 * NOT IMPLEMENTED HERE, because on THIS terminal there is nothing to cancel. This surface is the
 * resting state, not a pending operation: polling is owned by MainActivity.ensureAmbientPolling()
 * and runs behind every idle surface including this one, so a Cancel could only either (a) do
 * nothing, or (b) stop the terminal listening to the till — which is precisely the "terminal went
 * deaf" failure the owner asked us to eliminate. There is also nowhere to navigate TO: a
 * POS-dispatch-only terminal has no home screen with anything on it. So the screen carries no
 * interactive element at all, and MainActivity passes no listener to match.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * It is usually covered by the venue's screensaver within a frame of being shown. It is what is
 * underneath, and what a venue with no screensaver configured sees instead. Polling is NOT done
 * here and is not tied to this screen at all — MainActivity.ensureAmbientPolling() owns the
 * JobPoller and runs it behind every idle surface, this one included.
 *
 * THE PULSE. Two concentric Signal rings expand out of the disc (scale 1 → 2.3, alpha .55 → 0,
 * 2.6s ease-out, infinite, second ring phase-shifted by half a cycle). It is the only motion on a
 * screen that may sit lit for a whole service, so it is bound to the view lifecycle in three
 * places — attach, detach and window visibility — and it never runs while the window is not
 * visible. {@link #setPulsing(boolean)} is the manual brake for a caller that knows the surface is
 * covered (e.g. by the screensaver) while still attached; nothing calls it today.
 */
public final class PosIdleScreen extends LinearLayout {

    // ---- pulse geometry, in dp (design px halved: the 720px design space is 2× this panel) -----

    /** The Coal disc at the centre. Spec: 130px. */
    private static final int DISC_DP = 65;
    /** Inbound arrow inside the disc. Spec: 56px. */
    private static final int ICON_DP = 28;
    /** 65dp × 2.3 = 149.5dp at full expansion — the box must not clip the outer ring. */
    private static final int PULSE_BOX_DP = 150;
    private static final float PULSE_TO = 2.3f;
    private static final float PULSE_ALPHA_FROM = 0.55f;
    private static final long PULSE_MS = 2600L;
    /** Second ring enters half a cycle later, so there is always one ring mid-flight. */
    private static final long PULSE_STAGGER_MS = 1300L;

    /** Body copy max-width. Spec: 520px. */
    private static final int BODY_MAX_DP = 260;

    private final TextView status;
    private final View ringInner;
    private final View ringOuter;

    private ObjectAnimator animInner;
    private ObjectAnimator animOuter;
    /** The caller's intent. False parks the rings without touching the lifecycle hooks. */
    private boolean pulsingWanted = true;

    public PosIdleScreen(Context c, String venueLabel) {
        super(c);
        setOrientation(VERTICAL);
        setGravity(Gravity.CENTER);
        setBackground(inkWithGrid(c));
        Ui.contentPadding(c, this);     // 17/20/15dp = spec 34/40/30px

        // ---- venue identity ------------------------------------------------------------------
        // The terminal must always say which venue it belongs to; the original screen led with
        // this and it stays. Demoted from a headline to a running head, because the headline slot
        // now belongs to the thing the customer in front of it needs to understand.
        TextView venue = Ui.monoHead(c,
                venueLabel == null || venueLabel.trim().isEmpty() ? "Serv OS terminal" : venueLabel,
                Ui.ASH);
        venue.setGravity(Gravity.CENTER);
        venue.setMaxLines(1);
        venue.setEllipsize(TextUtils.TruncateAt.END);
        addView(venue, Ui.lp(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));
        addView(Ui.spacer(c, 15));

        // ---- the pulse ---------------------------------------------------------------------
        FrameLayout pulseBox = new FrameLayout(c);
        pulseBox.setClipChildren(false);
        pulseBox.setClipToPadding(false);

        ringOuter = ring(c);            // added first so it sits behind
        ringInner = ring(c);
        pulseBox.addView(ringOuter);
        pulseBox.addView(ringInner);
        pulseBox.addView(disc(c));
        pulseBox.addView(icon(c));

        LinearLayout.LayoutParams boxLp =
                Ui.lp(Ui.dp(c, PULSE_BOX_DP), Ui.dp(c, PULSE_BOX_DP));
        boxLp.gravity = Gravity.CENTER_HORIZONTAL;
        addView(pulseBox, boxLp);
        addView(Ui.spacer(c, 22));      // spec 44px

        // ---- headline ------------------------------------------------------------------------
        addView(Ui.stateTitle(c, "Waiting for the till"),
                Ui.lp(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));
        addView(Ui.spacer(c, 10));      // spec 20px

        // ---- body copy -----------------------------------------------------------------------
        TextView body = Ui.text(c, "A payment sent from the POS will appear here, ready to take.",
                Ui.SP_BODY, Ui.ASH, 400);
        body.setGravity(Gravity.CENTER);
        body.setLineSpacing(0f, 1.35f);
        body.setMaxWidth(Ui.dp(c, BODY_MAX_DP));
        LinearLayout.LayoutParams bodyLp =
                Ui.lp(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT);
        bodyLp.gravity = Gravity.CENTER_HORIZONTAL;
        addView(body, bodyLp);
        addView(Ui.spacer(c, 20));      // spec 40px

        // ---- the facts line ------------------------------------------------------------------
        // Static, and true by construction: if this screen is drawing at all the device is paired
        // (showPosIdle refuses to build it otherwise) and the poller is ambient. SANDBOX/LIVE is
        // read from BuildVersion, never hard-coded, so a stubbed build cannot look like a real one.
        LinearLayout facts = Ui.rowCentered(c);
        facts.setGravity(Gravity.CENTER);
        facts.addView(Ui.dot(c, Ui.SIGNAL, 5, false));
        facts.addView(Ui.spacerH(c, 7));
        TextView factsText = Ui.mono(c,
                "PAIRED · A920 · CTRL " + (BuildVersion.SIMULATED ? "SANDBOX" : "LIVE"),
                Ui.SP_META, Ui.ASH, 2f, 21f);
        factsText.setAllCaps(true);
        facts.addView(factsText);
        addView(facts, Ui.lp(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));
        addView(Ui.spacer(c, 7));       // spec 14px

        // ---- the live poll line --------------------------------------------------------------
        // Small and muted on purpose, exactly as before. It is here so an engineer can see the
        // poll is alive without attaching a cable; it is not information a customer needs to read.
        status = Ui.mono(c, "Listening for payments from the till",
                Ui.SP_META_SMALL, Ui.ASH, 1f, 19f);
        status.setGravity(Gravity.CENTER);
        addView(status, Ui.lp(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));
    }

    /** Driven by {@link co.posup.rpos.paxpay.JobPoller}, same as the waiting screen. */
    public void setStatus(String s) {
        if (status != null && s != null) status.setText(s);
    }

    /**
     * Park or resume the rings without detaching the view.
     *
     * ADDITIVE — nothing calls it today, and the screen is correct whether or not anything ever
     * does. It exists because the screensaver is an overlay added ABOVE this surface in the same
     * FrameLayout, so this view stays attached and window-visible underneath it and cannot detect
     * being covered on its own. A caller that knows (MainActivity, at its screensaver arm/dismiss
     * sites) could call setPulsing(false)/(true) to stop animating pixels nobody can see.
     */
    public void setPulsing(boolean on) {
        pulsingWanted = on;
        if (on) startPulse(); else stopPulse();
    }

    // ═══ lifecycle ════════════════════════════════════════════════════════════════════════════
    // A forever-running animator on a card terminal is a battery and jank problem, so the rings
    // are tied to attachment AND to window visibility: screen off, app backgrounded, or screen
    // torn down by setScreen() all stop the animation. All three paths are idempotent.

    @Override protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        startPulse();
    }

    @Override protected void onDetachedFromWindow() {
        stopPulse();
        super.onDetachedFromWindow();
    }

    @Override protected void onWindowVisibilityChanged(int visibility) {
        super.onWindowVisibilityChanged(visibility);
        if (visibility == VISIBLE) startPulse(); else stopPulse();
    }

    private void startPulse() {
        if (!pulsingWanted) return;
        if (!isAttachedToWindow() || getWindowVisibility() != VISIBLE) return;
        if (animInner != null) return;                       // already running

        // Animator duration scale can be 0 (developer options, or a power-saving OEM skin). An
        // INFINITE animator with a 0ms duration is a busy loop; draw the rings statically instead.
        if (!ValueAnimator.areAnimatorsEnabled()) {
            park(ringInner, 1.55f, 0.20f);
            park(ringOuter, 2.05f, 0.10f);
            return;
        }

        animInner = pulseAnimator(ringInner, 0L);
        animOuter = pulseAnimator(ringOuter, PULSE_STAGGER_MS);
        animInner.start();
        animOuter.start();
    }

    private void stopPulse() {
        animInner = cancel(animInner);
        animOuter = cancel(animOuter);
        park(ringInner, 1f, 0f);
        park(ringOuter, 1f, 0f);
    }

    private static ObjectAnimator cancel(ObjectAnimator a) {
        if (a != null) {
            a.removeAllListeners();
            a.cancel();
        }
        return null;
    }

    private static void park(View v, float scale, float alpha) {
        if (v == null) return;
        v.setScaleX(scale);
        v.setScaleY(scale);
        v.setAlpha(alpha);
    }

    private static ObjectAnimator pulseAnimator(View v, long startDelayMs) {
        ObjectAnimator a = ObjectAnimator.ofPropertyValuesHolder(v,
                PropertyValuesHolder.ofFloat(View.SCALE_X, 1f, PULSE_TO),
                PropertyValuesHolder.ofFloat(View.SCALE_Y, 1f, PULSE_TO),
                PropertyValuesHolder.ofFloat(View.ALPHA, PULSE_ALPHA_FROM, 0f));
        a.setDuration(PULSE_MS);
        // On a repeating animator the start delay applies to the first cycle only — which is
        // exactly the phase offset the spec asks for, not a delay on every repeat.
        a.setStartDelay(startDelayMs);
        a.setInterpolator(new DecelerateInterpolator(1.6f));   // spec: ease-out
        a.setRepeatCount(ValueAnimator.INFINITE);
        a.setRepeatMode(ValueAnimator.RESTART);
        return a;
    }

    // ═══ pieces ═══════════════════════════════════════════════════════════════════════════════

    /** A hairline Signal ring the size of the disc, invisible until the animator drives it. */
    private static View ring(Context c) {
        View v = new View(c);
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.OVAL);
        g.setColor(Color.TRANSPARENT);
        g.setStroke(Math.max(1, Ui.dp(c, 1.5f)), Ui.SIGNAL);
        v.setBackground(g);
        v.setAlpha(0f);
        v.setLayoutParams(centred(c, DISC_DP));
        return v;
    }

    /** The Coal disc the rings emanate from. */
    private static View disc(Context c) {
        View v = new View(c);
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.OVAL);
        g.setColor(Ui.COAL);
        g.setStroke(Math.max(1, Ui.dp(c, 1f)), Ui.GRAPHITE);
        v.setBackground(g);
        v.setLayoutParams(centred(c, DISC_DP));
        return v;
    }

    /** The Signal inbound arrow sitting on the disc. */
    private static ImageView icon(Context c) {
        ImageView v = new ImageView(c);
        v.setImageDrawable(Icons.size(c, Icons.inbound(Ui.SIGNAL), ICON_DP));
        v.setLayoutParams(centred(c, ICON_DP));
        return v;
    }

    private static FrameLayout.LayoutParams centred(Context c, int sizeDp) {
        FrameLayout.LayoutParams lp =
                new FrameLayout.LayoutParams(Ui.dp(c, sizeDp), Ui.dp(c, sizeDp));
        lp.gravity = Gravity.CENTER;
        return lp;
    }

    /**
     * Ink plus the ServOS console grid.
     *
     * This surface fills MainActivity's content frame edge to edge, so painting flat Ink would
     * cover the grid the chrome draws behind it and the screen would lose its texture entirely.
     * Drawing our own grid layer keeps it — and because this view is opaque over the chrome's,
     * the two can never show at once, so there is no double-draw to misalign. Honours
     * Chrome.showGrid like everything else.
     */
    private static Drawable inkWithGrid(Context c) {
        ColorDrawable ink = new ColorDrawable(Ui.INK);
        if (!Chrome.showGrid) return ink;
        return new LayerDrawable(new Drawable[]{ink, Chrome.gridOverlay(c)});
    }
}
