package co.posup.rpos.mpos

import android.app.Application
import com.stripe.stripeterminal.TerminalApplicationDelegate

/**
 * The Stripe Terminal SDK requires its lifecycle delegate to be installed from
 * Application.onCreate(), before any Activity is created. Tap to Pay also spins up a
 * dedicated sub-process; TerminalApplicationDelegate.onCreate() is safe to call there.
 */
class MposApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        TerminalApplicationDelegate.onCreate(this)
    }
}
