package co.posup.rpos.payments

import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import com.stripe.stripeterminal.Terminal
import com.stripe.stripeterminal.external.callable.BluetoothReaderListener
import com.stripe.stripeterminal.external.callable.Callback
import com.stripe.stripeterminal.external.callable.Cancelable
import com.stripe.stripeterminal.external.callable.ConnectionTokenCallback
import com.stripe.stripeterminal.external.callable.ConnectionTokenProvider
import com.stripe.stripeterminal.external.callable.DiscoveryListener
import com.stripe.stripeterminal.external.callable.PaymentIntentCallback
import com.stripe.stripeterminal.external.callable.ReaderCallback
import com.stripe.stripeterminal.external.callable.TerminalListener
import com.stripe.stripeterminal.external.models.ConnectionConfiguration
import com.stripe.stripeterminal.external.models.ConnectionStatus
import com.stripe.stripeterminal.external.models.ConnectionTokenException
import com.stripe.stripeterminal.external.models.DiscoveryConfiguration
import com.stripe.stripeterminal.external.models.PaymentIntent
import com.stripe.stripeterminal.external.models.PaymentStatus
import com.stripe.stripeterminal.external.models.Reader
import com.stripe.stripeterminal.external.models.TerminalException
import com.stripe.stripeterminal.log.LogLevel
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicReference

/**
 * StripeTerminalBridge — exposes window.RposStripeTerminal to the React POS.
 *
 * Lifecycle is asynchronous: every method that does work returns immediately and
 * the result is dispatched back to JS via:
 *
 *   webView.evaluateJavascript("window.dispatchPosTerminalCallback('<callbackId>', <jsonStr>)")
 *
 * The web side wraps each call in a Promise that resolves when the callback fires
 * (see src/lib/stripeTerminal.js).
 *
 * Auth: the web app must call setAuthToken(jwt) once on login (and on token
 * refresh) — this jwt is passed as Authorization on every connection-token fetch.
 */
class StripeTerminalBridge(
    private val activity: Activity,
    private val webView: WebView,
) {
    companion object {
        private const val TAG = "StripeTerminalBridge"
        private const val CONNECTION_TOKEN_URL =
            "https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/stripe-terminal-connection-token"
        private const val PAYMENT_INTENT_URL =
            "https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/stripe-create-payment-intent"
        // 30 second timeout on Edge Function requests
        private const val HTTP_TIMEOUT_MS = 30_000
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val authToken = AtomicReference<String?>(null)
    private var discoveryCancelable: Cancelable? = null

    // ────────────────────────────────────────────────────────────────────────
    // PUBLIC JS API
    // ────────────────────────────────────────────────────────────────────────

    @JavascriptInterface
    fun isAvailable(): String = "true"

    /**
     * window.RposStripeTerminal.setAuthToken(supabaseJwt)
     * Call once on login and any time the supabase session refreshes.
     */
    @JavascriptInterface
    fun setAuthToken(token: String?) {
        authToken.set(if (token.isNullOrBlank()) null else token)
        Log.d(TAG, "Auth token ${if (token.isNullOrBlank()) "cleared" else "set"}")
    }

    /**
     * window.RposStripeTerminal.initialize(callbackId)
     * Initialises the Stripe Terminal singleton if not already initialised.
     * Safe to call multiple times.
     */
    @JavascriptInterface
    fun initialize(callbackId: String) {
        try {
            if (!Terminal.isInitialized()) {
                Terminal.initTerminal(
                    activity.applicationContext,
                    LogLevel.INFO,
                    posUpTokenProvider,
                    posUpTerminalListener,
                )
                Log.d(TAG, "Terminal initialised")
            }
            postCallback(callbackId, true, JSONObject().put("initialized", true))
        } catch (e: Throwable) {
            postCallback(callbackId, false, JSONObject().put("error", e.message ?: e::class.simpleName))
        }
    }

    /**
     * window.RposStripeTerminal.checkPermissions(callbackId)
     * Returns whether all Bluetooth + location permissions are granted.
     */
    @JavascriptInterface
    fun checkPermissions(callbackId: String) {
        val missing = missingPermissions()
        val payload = JSONObject()
            .put("granted", missing.isEmpty())
            .put("missing", JSONArray(missing.toList()))
        postCallback(callbackId, true, payload)
    }

    /**
     * window.RposStripeTerminal.requestPermissions(callbackId)
     * Triggers the system permission dialog for any missing perms.
     * Result is delivered when the host activity resumes — caller should
     * re-check via checkPermissions afterwards.
     */
    @JavascriptInterface
    fun requestPermissions(callbackId: String) {
        val missing = missingPermissions()
        if (missing.isEmpty()) {
            postCallback(callbackId, true, JSONObject().put("granted", true))
            return
        }
        mainHandler.post {
            ActivityCompat.requestPermissions(activity, missing, 4242)
            // We can't wait for the user — caller must re-check after.
            postCallback(callbackId, true, JSONObject().put("requested", true))
        }
    }

    /**
     * window.RposStripeTerminal.discoverReaders(callbackId)
     * Starts a Bluetooth scan for nearby Stripe readers (M2, WisePOS E, …).
     * Streams discovered readers back as `{ event: "reader", reader: {...} }`.
     * Sends a final `{ event: "complete" }` when discovery times out (60s default).
     */
    @JavascriptInterface
    fun discoverReaders(callbackId: String) {
        if (!Terminal.isInitialized()) {
            postCallback(callbackId, false, JSONObject().put("error", "Terminal not initialised"))
            return
        }
        val missing = missingPermissions()
        if (missing.isNotEmpty()) {
            postCallback(callbackId, false, JSONObject().put("error", "Missing permissions").put("missing", JSONArray(missing.toList())))
            return
        }

        // Cancel any in-flight discovery first
        discoveryCancelable?.cancel(object : Callback {
            override fun onSuccess() {}
            override fun onFailure(e: TerminalException) {}
        })

        val config = DiscoveryConfiguration.BluetoothDiscoveryConfiguration(
            timeout = 0,                       // 0 = continuous until cancelled
            isSimulated = false,
        )

        discoveryCancelable = Terminal.getInstance().discoverReaders(
            config,
            object : DiscoveryListener {
                override fun onUpdateDiscoveredReaders(readers: List<Reader>) {
                    val arr = JSONArray()
                    readers.forEach { arr.put(readerToJson(it)) }
                    postCallback(
                        callbackId, true,
                        JSONObject().put("event", "readers").put("readers", arr),
                    )
                }
            },
            object : Callback {
                override fun onSuccess() {
                    postCallback(callbackId, true, JSONObject().put("event", "complete"))
                }

                override fun onFailure(e: TerminalException) {
                    postCallback(callbackId, false, JSONObject()
                        .put("event", "error")
                        .put("error", e.errorMessage)
                        .put("code", e.errorCode.name))
                }
            },
        )
    }

    /**
     * window.RposStripeTerminal.cancelDiscovery(callbackId)
     */
    @JavascriptInterface
    fun cancelDiscovery(callbackId: String) {
        discoveryCancelable?.cancel(object : Callback {
            override fun onSuccess() {
                discoveryCancelable = null
                postCallback(callbackId, true, JSONObject().put("cancelled", true))
            }

            override fun onFailure(e: TerminalException) {
                postCallback(callbackId, false, JSONObject().put("error", e.errorMessage))
            }
        }) ?: postCallback(callbackId, true, JSONObject().put("cancelled", false))
    }

    /**
     * window.RposStripeTerminal.connectReader(serialNumber, locationId, callbackId)
     * Connects to a reader previously surfaced by discoverReaders.
     */
    @JavascriptInterface
    fun connectReader(serialNumber: String, locationId: String, callbackId: String) {
        if (!Terminal.isInitialized()) {
            postCallback(callbackId, false, JSONObject().put("error", "Terminal not initialised"))
            return
        }

        // We rediscover briefly so the SDK knows the reader's MAC, then connect.
        // (SDK requires a Reader object surfaced from discovery — can't bind by serial alone.)
        val discoveryConfig = DiscoveryConfiguration.BluetoothDiscoveryConfiguration(
            timeout = 15,
            isSimulated = false,
        )
        var foundReader: Reader? = null
        var connectAttempted = false

        Terminal.getInstance().discoverReaders(
            discoveryConfig,
            object : DiscoveryListener {
                override fun onUpdateDiscoveredReaders(readers: List<Reader>) {
                    val match = readers.firstOrNull { it.serialNumber == serialNumber }
                    if (match != null && !connectAttempted) {
                        connectAttempted = true
                        foundReader = match
                    }
                }
            },
            object : Callback {
                override fun onSuccess() {
                    val reader = foundReader
                    if (reader == null) {
                        postCallback(callbackId, false, JSONObject().put("error", "Reader $serialNumber not found within 15s. Is it powered on and in range?"))
                        return
                    }
                    val connConfig = ConnectionConfiguration.BluetoothConnectionConfiguration(
                        locationId = locationId,
                    )
                    Terminal.getInstance().connectBluetoothReader(
                        reader, connConfig,
                        object : BluetoothReaderListener {},
                        object : ReaderCallback {
                            override fun onSuccess(connectedReader: Reader) {
                                postCallback(callbackId, true, JSONObject()
                                    .put("connected", true)
                                    .put("reader", readerToJson(connectedReader)))
                            }

                            override fun onFailure(e: TerminalException) {
                                postCallback(callbackId, false, JSONObject()
                                    .put("error", e.errorMessage)
                                    .put("code", e.errorCode.name))
                            }
                        },
                    )
                }

                override fun onFailure(e: TerminalException) {
                    postCallback(callbackId, false, JSONObject().put("error", e.errorMessage))
                }
            },
        )
    }

    /**
     * window.RposStripeTerminal.disconnectReader(callbackId)
     */
    @JavascriptInterface
    fun disconnectReader(callbackId: String) {
        if (!Terminal.isInitialized()) {
            postCallback(callbackId, true, JSONObject().put("disconnected", true))
            return
        }
        Terminal.getInstance().disconnectReader(object : Callback {
            override fun onSuccess() {
                postCallback(callbackId, true, JSONObject().put("disconnected", true))
            }

            override fun onFailure(e: TerminalException) {
                postCallback(callbackId, false, JSONObject().put("error", e.errorMessage))
            }
        })
    }

    /**
     * window.RposStripeTerminal.getStatus()
     * Synchronous — returns JSON: { initialized, hasAuthToken, connection, reader }
     */
    @JavascriptInterface
    fun getStatus(): String {
        val obj = JSONObject()
            .put("initialized", Terminal.isInitialized())
            .put("hasAuthToken", authToken.get() != null)
        if (Terminal.isInitialized()) {
            val term = Terminal.getInstance()
            obj.put("connection", term.connectionStatus.name)
            term.connectedReader?.let { obj.put("reader", readerToJson(it)) }
        }
        return obj.toString()
    }

    /**
     * window.RposStripeTerminal.collectPayment(amountMinor, currency, locationId, channel, closedCheckId, callbackId)
     *
     * End-to-end card-present collect:
     *   1. Hit our stripe-create-payment-intent edge function (server creates PI on connected account)
     *   2. Retrieve PI on-device by client_secret
     *   3. Collect payment method via the connected reader
     *   4. Confirm
     *   5. Return final PaymentIntent JSON to JS
     */
    @JavascriptInterface
    fun collectPayment(
        amountMinor: Long,
        currency: String,
        locationId: String,
        channel: String,
        closedCheckId: String?,
        callbackId: String,
    ) {
        if (!Terminal.isInitialized()) {
            postCallback(callbackId, false, JSONObject().put("error", "Terminal not initialised"))
            return
        }
        val term = Terminal.getInstance()
        if (term.connectedReader == null) {
            postCallback(callbackId, false, JSONObject().put("error", "No reader connected"))
            return
        }

        // Run network IO off the main thread
        Thread {
            try {
                val piResult = createPaymentIntentOnServer(
                    amountMinor = amountMinor,
                    currency = currency,
                    locationId = locationId,
                    channel = channel,
                    closedCheckId = closedCheckId,
                )
                val clientSecret = piResult.optString("client_secret", "")
                if (clientSecret.isEmpty()) {
                    postCallback(callbackId, false, JSONObject()
                        .put("error", piResult.optString("error", "no client_secret in PaymentIntent response"))
                        .put("step", "create"))
                    return@Thread
                }

                term.retrievePaymentIntent(clientSecret, object : PaymentIntentCallback {
                    override fun onSuccess(intent: PaymentIntent) {
                        // Collect from the reader
                        term.collectPaymentMethod(intent, object : PaymentIntentCallback {
                            override fun onSuccess(intentAfterCollect: PaymentIntent) {
                                // Confirm
                                term.confirmPaymentIntent(intentAfterCollect, object : PaymentIntentCallback {
                                    override fun onSuccess(intentAfterConfirm: PaymentIntent) {
                                        postCallback(callbackId, true, JSONObject()
                                            .put("status", intentAfterConfirm.status?.name ?: "unknown")
                                            .put("paymentIntentId", intentAfterConfirm.id)
                                            .put("amount", intentAfterConfirm.amount)
                                            .put("markup_percent", piResult.optDouble("markup_percent", 0.0))
                                            .put("application_fee_minor", piResult.optLong("application_fee_minor", 0L)))
                                    }
                                    override fun onFailure(e: TerminalException) {
                                        postCallback(callbackId, false, JSONObject()
                                            .put("error", e.errorMessage).put("code", e.errorCode.name)
                                            .put("step", "confirm"))
                                    }
                                })
                            }
                            override fun onFailure(e: TerminalException) {
                                postCallback(callbackId, false, JSONObject()
                                    .put("error", e.errorMessage).put("code", e.errorCode.name)
                                    .put("step", "collect"))
                            }
                        })
                    }
                    override fun onFailure(e: TerminalException) {
                        postCallback(callbackId, false, JSONObject()
                            .put("error", e.errorMessage).put("code", e.errorCode.name)
                            .put("step", "retrieve"))
                    }
                })
            } catch (e: Throwable) {
                Log.e(TAG, "collectPayment failed", e)
                postCallback(callbackId, false, JSONObject()
                    .put("error", e.message ?: e::class.simpleName ?: "unknown")
                    .put("step", "create"))
            }
        }.start()
    }

    // ────────────────────────────────────────────────────────────────────────
    // INTERNAL — token provider, terminal listener, helpers
    // ────────────────────────────────────────────────────────────────────────

    private val posUpTokenProvider = object : ConnectionTokenProvider {
        override fun fetchConnectionToken(callback: ConnectionTokenCallback) {
            val jwt = authToken.get()
            if (jwt == null) {
                callback.onFailure(ConnectionTokenException("No auth token set on bridge"))
                return
            }
            Thread {
                try {
                    val resp = httpPostJson(
                        url = CONNECTION_TOKEN_URL,
                        bearer = jwt,
                        body = JSONObject(),
                    )
                    val secret = resp.optString("secret", "")
                    if (secret.isEmpty()) {
                        callback.onFailure(ConnectionTokenException(
                            "no 'secret' in response: ${resp.optString("error", resp.toString().take(200))}"
                        ))
                    } else {
                        callback.onSuccess(secret)
                    }
                } catch (e: Throwable) {
                    callback.onFailure(ConnectionTokenException(e.message ?: e::class.simpleName ?: "unknown"))
                }
            }.start()
        }
    }

    private val posUpTerminalListener = object : TerminalListener {
        override fun onConnectionStatusChange(status: ConnectionStatus) {
            postEvent("connectionStatus", JSONObject().put("status", status.name))
        }

        override fun onPaymentStatusChange(status: PaymentStatus) {
            postEvent("paymentStatus", JSONObject().put("status", status.name))
        }

        override fun onUnexpectedReaderDisconnect(reader: Reader) {
            postEvent("readerDisconnected", JSONObject().put("reader", readerToJson(reader)))
        }
    }

    private fun createPaymentIntentOnServer(
        amountMinor: Long,
        currency: String,
        locationId: String,
        channel: String,
        closedCheckId: String?,
    ): JSONObject {
        val jwt = authToken.get() ?: throw IllegalStateException("No auth token")
        val body = JSONObject()
            .put("location_id", locationId)
            .put("amount_minor", amountMinor)
            .put("currency", currency)
            .put("channel", channel)
            .put("payment_method_types", JSONArray().put("card_present"))
            .put("capture_method", "automatic")
        if (!closedCheckId.isNullOrEmpty()) body.put("closed_check_id", closedCheckId)
        return httpPostJson(PAYMENT_INTENT_URL, jwt, body)
    }

    private fun httpPostJson(url: String, bearer: String, body: JSONObject): JSONObject {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = HTTP_TIMEOUT_MS
            readTimeout = HTTP_TIMEOUT_MS
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("Authorization", "Bearer $bearer")
        }
        try {
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            return try { JSONObject(text) } catch (_: Throwable) { JSONObject().put("error", "non-json response: ${text.take(200)}") }
        } finally {
            conn.disconnect()
        }
    }

    private fun missingPermissions(): Array<String> {
        val needed = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            needed += android.Manifest.permission.BLUETOOTH_SCAN
            needed += android.Manifest.permission.BLUETOOTH_CONNECT
        } else {
            needed += android.Manifest.permission.ACCESS_FINE_LOCATION
            needed += android.Manifest.permission.BLUETOOTH
            needed += android.Manifest.permission.BLUETOOTH_ADMIN
        }
        return needed.filter {
            ActivityCompat.checkSelfPermission(activity, it) != PackageManager.PERMISSION_GRANTED
        }.toTypedArray()
    }

    private fun readerToJson(r: Reader): JSONObject = JSONObject().apply {
        put("serialNumber", r.serialNumber ?: "")
        put("deviceType", r.deviceType?.name ?: "")
        put("locationId", r.location?.id ?: "")
        put("batteryLevel", r.batteryLevel ?: JSONObject.NULL)
        put("label", r.label ?: r.serialNumber ?: "")
        put("status", r.networkStatus?.name ?: "")
    }

    private fun postCallback(callbackId: String, ok: Boolean, payload: JSONObject) {
        val outer = JSONObject().put("ok", ok).put("data", payload)
        val js = "window.dispatchPosTerminalCallback(${jsonStr(callbackId)}, $outer)"
        mainHandler.post { webView.evaluateJavascript(js, null) }
    }

    private fun postEvent(name: String, payload: JSONObject) {
        val outer = JSONObject().put("event", name).put("data", payload)
        val js = "window.dispatchPosTerminalEvent($outer)"
        mainHandler.post { webView.evaluateJavascript(js, null) }
    }

    private fun jsonStr(s: String): String = JSONObject.quote(s)
}
