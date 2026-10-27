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
///   open   → window.RposPush.setOpen(id): the chat on screen gets no banner (review fix A5)
///   launch → permission already given: the token is re-sent quietly as window.__rposPushLast and
///            window.__rposPushQuiet(...) (a token can change), and window.RposPush.permission says
///            'granted', 'denied' or 'notDetermined' (review fix A7)
///
/// environment is 'sandbox' for an Xcode debug build and 'production' for TestFlight and the App
/// Store: the server picks Apple's host by it, and a token is only valid on its own host.
final class PushBridge: NSObject, WKScriptMessageHandler {

    static let handlerName = "rposPush"
    static let shared = PushBridge()

    static let injectionScript = WKUserScript(
        source: "window.RposPush = { available: true, permission: 'notDetermined', register: function () { window.webkit.messageHandlers.rposPush.postMessage({ action: 'register' }); }, setOpen: function (id) { window.webkit.messageHandlers.rposPush.postMessage({ action: 'open', id: id || '' }); } };",
        injectionTime: .atDocumentStart,
        forMainFrameOnly: true
    )

    weak var webView: WKWebView?
    /// Set while the web app is waiting for a token (a tap asked for it).
    private var waiting = false
    /// A notification tapped before the page was ready.
    private var pendingOpen: [String: Any]?
    /// The chat on screen (no banner for it), and the last token and permission for the page.
    var openConversationId: String?
    private var lastToken: String?
    private var permission = "notDetermined"

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
        let body = message.body as? [String: Any]
        if (body?["action"] as? String) == "open" {
            let id = body?["id"] as? String ?? ""
            openConversationId = id.isEmpty ? nil : id
            return
        }
        waiting = true
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            DispatchQueue.main.async {
                self.permission = granted ? "granted" : "denied"
                self.sendPermission()
                guard granted else { return self.reply(["error": "denied"]) }
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    // MARK: From the app delegate

    func didRegister(token: Data) {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        UserDefaults.standard.set(hex, forKey: "rposPushToken")
        lastToken = hex
        if waiting { reply(["token": hex, "environment": Self.environment]) } else { sendQuiet() }
    }

    /// At launch: iOS's own answer, and the token again when permission was given before.
    func refreshAtLaunch() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            DispatchQueue.main.async {
                switch settings.authorizationStatus {
                case .authorized, .provisional, .ephemeral:
                    self.permission = "granted"
                    UIApplication.shared.registerForRemoteNotifications()
                case .denied:
                    self.permission = "denied"
                default:
                    self.permission = "notDetermined"
                }
                self.sendPermission()
            }
        }
    }

    private func sendPermission() {
        webView?.evaluateJavaScript("window.RposPush && (window.RposPush.permission = '\(permission)');", completionHandler: nil)
    }

    private func sendQuiet() {
        guard let token = lastToken else { return }
        let payload: [String: Any] = ["token": token, "environment": Self.environment]
        guard let webView = webView,
              let json = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: json, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__rposPushLast = \(text); window.__rposPushQuiet && window.__rposPushQuiet(\(text));", completionHandler: nil)
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
        sendPermission()
        sendQuiet()
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
        PushBridge.shared.refreshAtLaunch()
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
        // ...but not for the chat already on screen (review fix A5).
        let chat = notification.request.content.userInfo["conversation_id"] as? String
        if let chat = chat, chat == PushBridge.shared.openConversationId { return completionHandler([]) }
        completionHandler([.banner, .sound, .list])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        PushBridge.shared.opened(response.notification.request.content.userInfo)
        completionHandler()
    }
}
#endif
