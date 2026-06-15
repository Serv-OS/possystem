package co.posup.rpos.mpos

import android.app.Activity
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject

/**
 * JS ↔ native bridge for Tap to Pay, exposed to the web POS as window.RposTapToPay.
 *
 * Mirrors the existing window.RposPrinter idiom: synchronous isAvailable(), async methods
 * that take a JSON request + a callbackId, and results delivered back via a single global
 * JS callback window.__rposTapCallback(callbackId, resultJson). The web layer feature-detects
 * the bridge and falls back to the WisePOS REST reader path when it's absent (browser/non-MPOS).
 *
 * Threading: @JavascriptInterface methods run on a WebView-owned thread; SDK calls are
 * marshalled to the UI thread, and results are posted back to JS on the UI thread.
 */
class TapToPayBridge(private val activity: Activity, private val webView: WebView) {

    @JavascriptInterface
    fun isAvailable(): String = "true"

    @JavascriptInterface
    fun init(configJson: String, callbackId: String) {
        val config = try { JSONObject(configJson) } catch (e: Exception) {
            return reply(callbackId, fail("BAD_CONFIG", "Invalid init JSON"))
        }
        activity.runOnUiThread {
            TerminalManager.init(activity, config) { result -> reply(callbackId, result) }
        }
    }

    @JavascriptInterface
    fun collectPayment(requestJson: String, callbackId: String) {
        val req = try { JSONObject(requestJson) } catch (e: Exception) {
            return reply(callbackId, fail("BAD_REQUEST", "Invalid collectPayment JSON"))
        }
        val clientSecret = req.optString("clientSecret")
        if (clientSecret.isBlank()) {
            return reply(callbackId, fail("NO_CLIENT_SECRET", "clientSecret is required"))
        }
        activity.runOnUiThread {
            TerminalManager.collectPayment(clientSecret) { result -> reply(callbackId, result) }
        }
    }

    @JavascriptInterface
    fun cancel(callbackId: String) {
        activity.runOnUiThread { TerminalManager.cancel { result -> reply(callbackId, result) } }
    }

    @JavascriptInterface
    fun status(callbackId: String) {
        activity.runOnUiThread { TerminalManager.status { result -> reply(callbackId, result) } }
    }

    private fun reply(callbackId: String, resultJson: String) {
        // Pass the result as a JSON string; the web side JSON.parses it (matches PrinterBridge).
        val escaped = JSONObject.quote(resultJson)
        val js = "window.__rposTapCallback && window.__rposTapCallback(${JSONObject.quote(callbackId)}, $escaped);"
        webView.post { webView.evaluateJavascript(js, null) }
    }

    private fun fail(code: String, message: String): String =
        JSONObject().put("ok", false).put("code", code).put("message", message).toString()
}
