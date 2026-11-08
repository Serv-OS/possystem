package co.posup.rpos.menuboard;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Opens the board when the stick starts (app 1.2). A Fire TV stick powered from the TV's USB
 * port starts every time the TV is turned on; without this the staff had to find the app in the
 * Fire TV menu each morning, and a stick that lost power in the day stayed on the home screen.
 *
 * Fire OS 7 (Android 9) lets a sideloaded app start on boot. Fire OS 8 (Android 11) blocks it
 * until the stick is given a one time grant over ADB (android/FIRE_TV_SETUP.md, section 2a).
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        String a = intent == null ? null : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(a) && !"android.intent.action.QUICKBOOT_POWERON".equals(a)) return;
        try {
            Intent open = new Intent(ctx, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
            ctx.startActivity(open);
        } catch (Exception e) {
            // Blocked (Fire OS 8 without the grant): try again through the alarm path, which the
            // system may allow, and give up quietly if not. Staff can still open the app by hand.
            Log.w("ServOSMenu", "could not open the board on boot: " + e.getMessage());
            StayOn.scheduleRelaunch(ctx, 3000L);
        }
    }
}
