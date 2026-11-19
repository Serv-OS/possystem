package co.posup.rpos.menuboard;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Process;
import android.util.Log;

/**
 * Keeps the board on the screen (app 1.2, 8 Nov 2026).
 *
 * Peter: "the menu boards and a few stores keep quitting - they close down and dont re open".
 * Three things close a Fire TV app for good: the page's Chrome process is killed when the stick
 * runs out of memory (MainActivity handles that in place), the app itself throws (handled here:
 * the board is relaunched a moment later instead of leaving the Fire TV home screen), and the
 * stick losing power (BootReceiver opens the board when the stick starts).
 *
 * Every relaunch backs off, so a page or build that fails every time cannot spin the stick:
 * first time one second, then five seconds, then a minute between tries. Counts reset after
 * ten quiet minutes.
 */
public final class StayOn {
    private static final String TAG = "ServOSMenu";
    private static final String PREFS = "stay_on";
    private static final long QUIET_MS = 10L * 60 * 1000;
    private static final long[] DELAYS_MS = { 1000L, 5000L, 60000L };
    private static boolean installed = false;

    private StayOn() {}

    /** Relaunch the board when the app throws. Installed once per process. */
    public static synchronized void install(final Context app) {
        if (installed) return;
        installed = true;
        final Context ctx = app.getApplicationContext();
        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            try {
                Log.e(TAG, "the app threw, relaunching the board", error);
                scheduleRelaunch(ctx, nextDelay(ctx, "crash"));
            } catch (Throwable ignored) {
                // Nothing more we can do; fall through to the system handler below.
            }
            if (previous != null) {
                try { previous.uncaughtException(thread, error); } catch (Throwable ignored) { /* exit below */ }
            }
            Process.killProcess(Process.myPid());
            System.exit(2);
        });
    }

    /** How long to wait before a fresh page after the renderer died. Backs off on repeats. */
    public static long rendererGoneDelay(Context ctx, boolean crashed) {
        return nextDelay(ctx, crashed ? "renderer_crash" : "renderer_killed");
    }

    /** Start the board again after delayMs, whatever happens to this process meanwhile. */
    public static void scheduleRelaunch(Context ctx, long delayMs) {
        Intent open = new Intent(ctx, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        PendingIntent pi = PendingIntent.getActivity(ctx, 7, open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        // Inexact and allowed while idle: no exact alarm permission needed on Android 12+, and a
        // powered stick is never deep in doze. A few seconds late is fine for a menu board.
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, System.currentTimeMillis() + delayMs, pi);
    }

    /** Count one event of this kind and answer the delay before the next try. */
    static long nextDelay(Context ctx, String kind) {
        SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long now = System.currentTimeMillis();
        long last = sp.getLong(kind + "_at", 0L);
        int count = now - last < QUIET_MS ? sp.getInt(kind + "_count", 0) + 1 : 1;
        sp.edit().putLong(kind + "_at", now).putInt(kind + "_count", count).apply();
        return delayFor(count);
    }

    /** 1 s, 5 s, then a minute. Pure, so the rule can be read without a device. */
    static long delayFor(int countInWindow) {
        int i = Math.max(1, countInWindow) - 1;
        return DELAYS_MS[Math.min(i, DELAYS_MS.length - 1)];
    }
}
