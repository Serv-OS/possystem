// Compiled ONLY into the Staff and Manager targets (SWIFT_ACTIVE_COMPILATION_CONDITIONS includes
// RPOS_PUSH), which carry the aps-environment entitlement. No Firebase: the device token goes to the
// web app, which hands it to the team-chat edge function (push.register); the server sends straight to
// Apple with our .p8 key (supabase/functions/_shared/push.ts).
#if RPOS_PUSH
import UIKit
import UserNotifications
import WebKit

/// App push for the ServOS Staff and ServOS Manager apps (5.11.102).
///
///   web    → window.webkit.messageHandlers.rposPush.postMessage({ action: 'register' })
///            (window.RposPush.register() wraps it; only ever started by a tap in the web app)
///   native → window.__rposPushToken({ token, environment })  or  ({ error: 'denied' | 'failed' })
///   tap    → window.__rposPushOpen({ conversation_id, ... }) (the push's data)
///
/// environment is 'sandbox' for an Xcode debug build and 'production' for TestFlight and the App
/// Store: the server picks Apple's host by it, and a token is only valid on its own host.
final class PushBridge: NSObject, WKScriptMessageHandler {

    static let handlerName = "rposPush"
    static let shared = PushBridge()

    static let injectionScript = WKUserScript(
        source: "window.RposPush = { available: true, register: function () { window.webkit.messageHandlers.rposPush.postMessage({ action: 'register' }); } };",
        injectionTime: .atDocumentStart,
        forMainFrameOnly: true
    )

    weak var webView: WKWebView?
    /// Set while the web app is waiting for a token (a tap asked for it).
    private var waiting = false
    /// A notification tapped before the page was ready.
    private var pendingOpen: [String: Any]?

    static var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    // MARK: Web → native

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.handlerName else { return }
        waiting = true
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            DispatchQueue.main.async {
                guard granted else { return self.reply(["error": "denied"]) }
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    // MARK: From the app delegate

    func didRegister(token: Data) {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        UserDefaults.standard.set(hex, forKey: "rposPushToken")
        if waiting { reply(["token": hex, "environment": Self.environment]) }
    }

    func didFail() {
        if waiting { reply(["error": "failed"]) }
    }

    func opened(_ userInfo: [AnyHashable: Any]) {
        var data: [String: Any] = [:]
        for (k, v) in userInfo { if let key = k as? String, key != "aps" { data[key] = v } }
        guard webView != nil else { pendingOpen = data; return }
        send("__rposPushOpen", data)
    }

    /// The page loaded: hand over a tap that arrived before it.
    func pageReady() {
        if let data = pendingOpen { pendingOpen = nil; send("__rposPushOpen", data) }
    }

    // MARK: Native → web

    private func reply(_ payload: [String: Any]) {
        waiting = false
        send("__rposPushToken", payload)
    }

    private func send(_ fn: String, _ payload: [String: Any]) {
        guard let webView = webView,
              let json = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: json, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.\(fn) && window.\(fn)(\(text));", completionHandler: nil)
    }
}

/// The app delegate the SwiftUI app adopts in push builds (App.swift): device tokens and taps.
final class PushAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushBridge.shared.didRegister(token: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        PushBridge.shared.didFail()
    }

    // Show the banner even with the app open (a chat the person is not looking at).
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .list])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        PushBridge.shared.opened(response.notification.request.content.userInfo)
        completionHandler()
    }
}
#endif
