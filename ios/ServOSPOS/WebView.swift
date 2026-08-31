import SwiftUI
import WebKit

/// Published connection state shared between the WebView coordinator and
/// SwiftUI. `isReconnecting` drives the native ReconnectingView overlay.
final class ConnectionState: ObservableObject {
    @Published var isReconnecting: Bool = false
}

/// The WKWebView shell. Mirrors the Android wrapper's WebView setup:
/// no zoom, no bounce, no selection callouts, inline media without a user
/// gesture (order chime), internal hosts stay in-app, external links go to
/// Safari, and a 5 second retry loop on navigation failure.
///
/// Hardware bridges are intentionally ABSENT in v1. The Android app injects
/// RposPrinter / RposBiometric / RposNfc; here `window.RposPrinter` stays
/// undefined so src/lib/printer.js's isNativeBridgeAvailable() returns false
/// and every print falls back to the Supabase print_jobs queue (LAN print
/// agent, transport 'queued'). Do NOT stub a fake RposPrinter object: the
/// web app feature-detects the bridge by truthiness.
struct POSWebView: UIViewRepresentable {
    @ObservedObject var connection: ConnectionState

    // MARK: Injected user scripts

    /// Lets the web app detect the iOS shell (window.RposIOS marker).
    private static let shellMarkerScript = WKUserScript(
        source: "window.RposIOS = { platform: 'ios', version: '\(Config.marketingVersion)'"
              + ", hasLocation: \(Config.allowsLocation) };",
        injectionTime: .atDocumentStart,
        forMainFrameOnly: true
    )

    /// window.RposLocation.get() -> Promise<{lat,lng,accuracy,age_ms}>
    /// Rejects with an Error whose message is one of:
    /// denied | restricted | unavailable | timeout | off.
    private static let locationBridgeScript = WKUserScript(
        source: """
        (function () {
          var seq = 0, waiting = {};
          window.__rposLocationCallback = function (id, ok, json) {
            var w = waiting[id]; if (!w) return; delete waiting[id];
            var data; try { data = JSON.parse(json); } catch (e) { data = {}; }
            if (ok) { w.resolve(data); } else { w.reject(new Error(data.error || 'unavailable')); }
          };
          window.RposLocation = {
            get: function () {
              return new Promise(function (resolve, reject) {
                var id = 'loc' + (++seq);
                waiting[id] = { resolve: resolve, reject: reject };
                try {
                  window.webkit.messageHandlers.rposLocation.postMessage({ id: id });
                } catch (e) { delete waiting[id]; reject(new Error('unavailable')); }
                setTimeout(function () {
                  if (waiting[id]) { delete waiting[id]; reject(new Error('timeout')); }
                }, 15000);
              });
            }
          };
        })();
        """,
        injectionTime: .atDocumentStart,
        forMainFrameOnly: true
    )

    /// Kills long-press text-selection callouts everywhere except real
    /// text inputs, which keep their caret and selection behaviour.
    private static let selectionSuppressionScript = WKUserScript(
        source: """
        (function () {
          var style = document.createElement('style');
          style.textContent = 'body, body * { -webkit-touch-callout: none; -webkit-user-select: none; } ' +
                              'input, textarea, [contenteditable="true"] { -webkit-user-select: auto; }';
          document.documentElement.appendChild(style);
        })();
        """,
        injectionTime: .atDocumentEnd,
        forMainFrameOnly: true
    )

    // MARK: UIViewRepresentable

    func makeCoordinator() -> Coordinator {
        Coordinator(connection: connection)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()

        // Order chime and any embedded media must play inline with no tap.
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []

        // Persistent store: cookies + localStorage survive relaunch, so the
        // device pairing sticks (parity with Android CookieManager + DOM storage).
        configuration.websiteDataStore = .default()

        // Appends "RposIOS/<version>" to the user agent as a second detection seam.
        configuration.applicationNameForUserAgent = "RposIOS/\(Config.marketingVersion)"

        let userContent = WKUserContentController()
        userContent.addUserScript(Self.shellMarkerScript)
        userContent.addUserScript(Self.selectionSuppressionScript)
        if Config.allowsLocation { userContent.addUserScript(Self.locationBridgeScript) }
        configuration.userContentController = userContent

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        webView.isOpaque = true
        webView.backgroundColor = UIColor(red: 0x0F / 255, green: 0x12 / 255, blue: 0x11 / 255, alpha: 1)

        // No scroll bounce, no pinch zoom, no automatic safe-area insetting.
        // The page runs edge to edge; the web app's own chrome handles safe
        // areas via viewport-fit / env(safe-area-inset-*).
        let scrollView = webView.scrollView
        scrollView.bounces = false
        scrollView.alwaysBounceVertical = false
        scrollView.alwaysBounceHorizontal = false
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.delegate = context.coordinator  // viewForZooming -> nil blocks pinch zoom

        context.coordinator.webView = webView

        // Native location for the geofenced clock-in (Staff target only).
        // Registered after the WKWebView exists because the bridge replies by
        // evaluating JS on it.
        if Config.allowsLocation {
            let bridge = LocationBridge(webView: webView)
            context.coordinator.locationBridge = bridge
            userContent.add(bridge, name: LocationBridge.handlerName)
        }

        webView.load(URLRequest(url: Config.appURL))
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        // Nothing dynamic flows from SwiftUI into the WebView.
    }

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        coordinator.cancelRetry()
    }

    // MARK: Coordinator

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, UIScrollViewDelegate {
        private let connection: ConnectionState
        weak var webView: WKWebView?
        /// Retained for the app's lifetime: WKUserContentController holds the
        /// handler weakly, so without this the bridge deallocates and every
        /// location request silently never answers.
        var locationBridge: LocationBridge?
        private var retryTimer: Timer?

        init(connection: ConnectionState) {
            self.connection = connection
            super.init()
        }

        // MARK: Navigation policy (internal stays in-app, external -> Safari)

        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }
            let scheme = url.scheme?.lowercased() ?? ""

            // In-page pseudo navigations must not be blocked.
            if scheme == "about" || scheme == "blob" || scheme == "data" {
                decisionHandler(.allow)
                return
            }

            // tel:, mailto:, etc. hand off to the system.
            guard scheme == "https" || scheme == "http" else {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }

            if Config.isInternalHost(url) {
                if navigationAction.targetFrame == nil {
                    // target=_blank on our own hosts: keep it in the shell.
                    webView.load(navigationAction.request)
                    decisionHandler(.cancel)
                } else {
                    decisionHandler(.allow)
                }
            } else if navigationAction.targetFrame == nil || navigationAction.targetFrame?.isMainFrame == true {
                // Off-host top-level navigations open in Safari, never inside the POS.
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
            } else {
                // Off-host SUBframes stay embedded — an <iframe> (widget preview,
                // payment frame) must never rip the user out to Safari on load.
                decisionHandler(.allow)
            }
        }

        /// window.open: never spawn a second web view.
        func webView(_ webView: WKWebView,
                     createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction,
                     windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url {
                if Config.isInternalHost(url) {
                    webView.load(navigationAction.request)
                } else {
                    UIApplication.shared.open(url)
                }
            }
            return nil
        }

        // MARK: Camera for getUserMedia QR scanning (microphone never granted)

        func webView(_ webView: WKWebView,
                     requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                     initiatedByFrame frame: WKFrameInfo,
                     type: WKMediaCaptureType,
                     decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            let isOurOrigin = origin.host.lowercased() == Config.appURL.host?.lowercased()
            if type == .camera && isOurOrigin && Config.allowsCamera {
                // Camera-enabled targets (POS) skip WebKit's per-site prompt;
                // iOS still shows the one-time system camera prompt
                // (NSCameraUsageDescription). Targets with RPOSAllowsCamera
                // false/absent (KDS) deny outright and ship no camera
                // permission string at all.
                decisionHandler(.grant)
            } else {
                decisionHandler(.deny)
            }
        }

        // MARK: Load lifecycle + 5 second retry (parity with Android onReceivedError)

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            cancelRetry()
            setReconnecting(false)
        }

        func webView(_ webView: WKWebView,
                     didFail navigation: WKNavigation!,
                     withError error: Error) {
            handleFailure(error)
        }

        func webView(_ webView: WKWebView,
                     didFailProvisionalNavigation navigation: WKNavigation!,
                     withError error: Error) {
            handleFailure(error)
        }

        /// Keep-alive: iOS killed the web process (long suspension or memory
        /// pressure). Reload immediately so the till comes back on its own.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.load(URLRequest(url: Config.appURL))
        }

        private func handleFailure(_ error: Error) {
            let nsError = error as NSError
            // NSURLErrorCancelled (-999) and legacy WebKit 102 "frame load
            // interrupted" fire when WE cancel a navigation (external link
            // handoff). They are not connectivity failures.
            if nsError.code == NSURLErrorCancelled { return }
            if nsError.domain == "WebKitErrorDomain" && nsError.code == 102 { return }

            setReconnecting(true)
            scheduleRetry()
        }

        private func scheduleRetry() {
            retryTimer?.invalidate()
            retryTimer = Timer.scheduledTimer(withTimeInterval: Config.retryInterval,
                                              repeats: false) { [weak self] _ in
                guard let self = self, let webView = self.webView else { return }
                // Retry the SAME url. Another failure re-enters handleFailure
                // and re-arms this timer, giving the endless 5 second loop.
                webView.load(URLRequest(url: Config.appURL))
            }
        }

        func cancelRetry() {
            retryTimer?.invalidate()
            retryTimer = nil
        }

        private func setReconnecting(_ value: Bool) {
            if Thread.isMainThread {
                connection.isReconnecting = value
            } else {
                DispatchQueue.main.async { self.connection.isReconnecting = value }
            }
        }

        // MARK: Zoom lockout

        func viewForZooming(in scrollView: UIScrollView) -> UIView? {
            nil
        }
    }
}
