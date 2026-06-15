package co.posup.rpos.mpos

import android.content.Context
import com.stripe.stripeterminal.Terminal
import com.stripe.stripeterminal.external.callable.Callback
import com.stripe.stripeterminal.external.callable.Cancelable
import com.stripe.stripeterminal.external.callable.ConnectionTokenCallback
import com.stripe.stripeterminal.external.callable.ConnectionTokenProvider
import com.stripe.stripeterminal.external.callable.DiscoveryListener
import com.stripe.stripeterminal.external.callable.PaymentIntentCallback
import com.stripe.stripeterminal.external.callable.ReaderCallback
import com.stripe.stripeterminal.external.callable.TapToPayReaderListener
import com.stripe.stripeterminal.external.callable.TerminalListener
import com.stripe.stripeterminal.external.models.ConnectionConfiguration.TapToPayConnectionConfiguration
import com.stripe.stripeterminal.external.models.ConnectionStatus
import com.stripe.stripeterminal.external.models.ConnectionTokenException
import com.stripe.stripeterminal.external.models.DisconnectReason
import com.stripe.stripeterminal.external.models.DiscoveryConfiguration.TapToPayDiscoveryConfiguration
import com.stripe.stripeterminal.external.models.PaymentIntent
import com.stripe.stripeterminal.external.models.PaymentStatus
import com.stripe.stripeterminal.external.models.Reader
import com.stripe.stripeterminal.external.models.TerminalException
import com.stripe.stripeterminal.log.LogLevel
import org.json.JSONObject
import java.io.BufferedReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

/**
 * Drives the Stripe Terminal / Tap to Pay SDK for the MPOS app.
 *
 * Responsibilities:
 *  - init the SDK once (with a ConnectionTokenProvider that calls our edge function),
 *  - discover + connect the phone's built-in Tap to Pay reader,
 *  - run a tap for a server-created PaymentIntent (collect → confirm), leaving capture
 *    to the server so the money path stays auditable.
 *
 * Everything is configured at runtime from the web layer (via TapToPayBridge.init) so the
 * native code never hardcodes a location or key — honouring "always resolve the real
 * locationId / keys from the resolved session".
 *
 * Results are delivered back as JSON strings to a supplied callback; the bridge forwards
 * them to the web via window.__rposTapCallback.
 */
object TerminalManager {

    // Runtime config, set by init() from the web session.
    private var rposLocationId: String = ""        // RPOS location_id (for token + PI calls)
    private var supabaseUrl: String = ""
    private var supabaseAnonKey: String = ""
    private var accessToken: String = ""           // Supabase user JWT, forwarded as Bearer
    private var stripeTerminalLocationId: String = "" // Stripe Terminal Location (tml_...) for connectReader

    private var connectedReader: Reader? = null
    private var collectCancelable: Cancelable? = null

    fun isReaderConnected(): Boolean = connectedReader != null &&
        Terminal.isInitialized() &&
        Terminal.getInstance().connectionStatus == ConnectionStatus.CONNECTED

    /**
     * One-time setup: store config, init the SDK if needed, then discover + connect the
     * Tap to Pay reader. [onResult] receives a JSON string.
     */
    fun init(context: Context, config: JSONObject, onResult: (String) -> Unit) {
        rposLocationId = config.optString("locationId")
        supabaseUrl = config.optString("supabaseUrl").trimEnd('/')
        supabaseAnonKey = config.optString("supabaseAnonKey")
        accessToken = config.optString("accessToken")
        stripeTerminalLocationId = config.optString("stripeTerminalLocationId")

        if (rposLocationId.isBlank() || supabaseUrl.isBlank()) {
            onResult(err("BAD_CONFIG", "Missing locationId or supabaseUrl"))
            return
        }
        if (stripeTerminalLocationId.isBlank()) {
            onResult(err("NO_TERMINAL_LOCATION", "No Stripe Terminal location configured for this venue"))
            return
        }

        try {
            if (!Terminal.isInitialized()) {
                Terminal.init(
                    context.applicationContext,
                    LogLevel.ERROR,
                    PosupTokenProvider(),
                    object : TerminalListener {
                        override fun onConnectionStatusChange(status: ConnectionStatus) {
                            if (status == ConnectionStatus.NOT_CONNECTED) connectedReader = null
                        }
                        override fun onPaymentStatusChange(status: PaymentStatus) {}
                    },
                    null
                )
            }
        } catch (e: Throwable) {
            onResult(err("INIT_FAILED", e.message ?: "Terminal init failed"))
            return
        }

        if (isReaderConnected()) {
            onResult(okReader())
            return
        }
        discoverAndConnect(onResult)
    }

    private fun discoverAndConnect(onResult: (String) -> Unit) {
        // isSimulated in debug → fake reader (no real money, no cert registration needed).
        val discoveryConfig = TapToPayDiscoveryConfiguration(isSimulated = BuildConfig.DEBUG)
        var connectAttempted = false

        Terminal.getInstance().discoverReaders(
            discoveryConfig,
            object : DiscoveryListener {
                override fun onUpdateDiscoveredReaders(readers: List<Reader>) {
                    val reader = readers.firstOrNull() ?: return
                    if (connectAttempted) return
                    connectAttempted = true
                    connect(reader, onResult)
                }
            },
            object : Callback {
                override fun onSuccess() { /* discovery completes after connect */ }
                override fun onFailure(e: TerminalException) {
                    onResult(err("DISCOVER_FAILED", e.errorMessage))
                }
            }
        )
    }

    private fun connect(reader: Reader, onResult: (String) -> Unit) {
        val connConfig = TapToPayConnectionConfiguration(
            stripeTerminalLocationId,
            true, // autoReconnectOnUnexpectedDisconnect
            object : TapToPayReaderListener {
                override fun onReaderReconnectFailed(reader: Reader) { connectedReader = null }
                override fun onReaderReconnectStarted(reader: Reader, cancelReconnect: Cancelable, reason: DisconnectReason) {}
                override fun onReaderReconnectSucceeded(reader: Reader) {}
                override fun onDisconnect(reason: DisconnectReason) { connectedReader = null }
            }
        )
        Terminal.getInstance().connectReader(
            reader,
            connConfig,
            object : ReaderCallback {
                override fun onSuccess(reader: Reader) {
                    connectedReader = reader
                    onResult(okReader())
                }
                override fun onFailure(e: TerminalException) {
                    onResult(err("CONNECT_FAILED", e.errorMessage))
                }
            }
        )
    }

    /**
     * Run a tap for a server-created PaymentIntent: retrieve → collect (the tap) → confirm.
     * On success the PI is authorised (requires_capture for manual capture); the web layer
     * then captures server-side.
     */
    fun collectPayment(clientSecret: String, onResult: (String) -> Unit) {
        if (!isReaderConnected()) {
            onResult(err("NOT_CONNECTED", "Tap to Pay reader is not connected", "collect"))
            return
        }
        Terminal.getInstance().retrievePaymentIntent(clientSecret, object : PaymentIntentCallback {
            override fun onSuccess(paymentIntent: PaymentIntent) {
                collectCancelable = Terminal.getInstance().collectPaymentMethod(
                    paymentIntent,
                    object : PaymentIntentCallback {
                        override fun onSuccess(collected: PaymentIntent) {
                            collectCancelable = null
                            confirm(collected, onResult)
                        }
                        override fun onFailure(e: TerminalException) {
                            collectCancelable = null
                            onResult(declineOrErr(e, "collect"))
                        }
                    }
                )
            }
            override fun onFailure(e: TerminalException) {
                onResult(declineOrErr(e, "retrieve"))
            }
        })
    }

    private fun confirm(paymentIntent: PaymentIntent, onResult: (String) -> Unit) {
        Terminal.getInstance().confirmPaymentIntent(paymentIntent, object : PaymentIntentCallback {
            override fun onSuccess(confirmed: PaymentIntent) {
                onResult(okPayment(confirmed))
            }
            override fun onFailure(e: TerminalException) {
                onResult(declineOrErr(e, "confirm"))
            }
        })
    }

    fun cancel(onResult: (String) -> Unit) {
        val c = collectCancelable
        if (c == null) {
            onResult(ok())
            return
        }
        c.cancel(object : Callback {
            override fun onSuccess() { collectCancelable = null; onResult(ok()) }
            override fun onFailure(e: TerminalException) { onResult(err("CANCEL_FAILED", e.errorMessage)) }
        })
    }

    fun status(onResult: (String) -> Unit) {
        val o = JSONObject()
        o.put("ok", true)
        o.put("initialized", Terminal.isInitialized())
        o.put("readerConnected", isReaderConnected())
        o.put("simulated", BuildConfig.DEBUG)
        onResult(o.toString())
    }

    // ---- ConnectionTokenProvider: fetch a token from our edge function ----
    private class PosupTokenProvider : ConnectionTokenProvider {
        override fun fetchConnectionToken(callback: ConnectionTokenCallback) {
            try {
                val url = URL("$supabaseUrl/functions/v1/stripe-terminal-connection-token")
                val conn = (url.openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    doOutput = true
                    connectTimeout = 15000
                    readTimeout = 15000
                    setRequestProperty("Content-Type", "application/json")
                    setRequestProperty("apikey", supabaseAnonKey)
                    setRequestProperty("Authorization", "Bearer $accessToken")
                }
                OutputStreamWriter(conn.outputStream).use { it.write(JSONObject().put("location_id", rposLocationId).toString()) }
                val code = conn.responseCode
                val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                val body = stream.bufferedReader().use(BufferedReader::readText)
                if (code !in 200..299) {
                    callback.onFailure(ConnectionTokenException("Token endpoint $code: $body"))
                    return
                }
                val secret = JSONObject(body).optString("secret")
                if (secret.isBlank()) callback.onFailure(ConnectionTokenException("No secret in token response"))
                else callback.onSuccess(secret)
            } catch (e: Exception) {
                callback.onFailure(ConnectionTokenException("Failed to fetch connection token", e))
            }
        }
    }

    // ---- result builders ----
    private fun ok(): String = JSONObject().put("ok", true).toString()

    private fun okReader(): String = JSONObject().apply {
        put("ok", true)
        put("readerConnected", true)
        put("simulated", BuildConfig.DEBUG)
        connectedReader?.serialNumber?.let { put("readerSerial", it) }
    }.toString()

    private fun okPayment(pi: PaymentIntent): String = JSONObject().apply {
        put("ok", true)
        put("paymentIntentId", pi.id ?: "")
        put("status", pi.status?.toString()?.lowercase() ?: "")
    }.toString()

    private fun err(code: String, message: String?, stage: String? = null): String = JSONObject().apply {
        put("ok", false)
        put("code", code)
        put("message", message ?: code)
        stage?.let { put("stage", it) }
    }.toString()

    private fun declineOrErr(e: TerminalException, stage: String): String = JSONObject().apply {
        put("ok", false)
        put("stage", stage)
        put("code", e.errorCode.toString())
        put("message", e.errorMessage)
    }.toString()
}
