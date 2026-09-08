import CoreLocation
import Foundation
import WebKit

/// Native location for the geofenced staff clock-in.
///
/// WHY A BRIDGE RATHER THAN navigator.geolocation:
/// WKWebView's own geolocation support has been inconsistent across iOS
/// versions and gives us no accuracy/staleness guarantees we can reason about.
/// More importantly, the clock-in fence is a HARD BLOCK, so the reading has to
/// come from CoreLocation directly, through a seam the web page cannot
/// synthesise by overriding a standard browser API.
///
/// This is the same shape as the existing biometric bridge:
///   web  → window.webkit.messageHandlers.rposLocation.postMessage({ id })
///   back → window.__rposLocationCallback(id, ok, jsonString)
///
/// The JSON is { lat, lng, accuracy, age_ms } on success, or { error } where
/// error is one of: denied | restricted | unavailable | timeout | off.
///
/// HONEST LIMIT: iOS gives apps no way to detect a simulated location, so a
/// jailbroken device can still lie. Android's isFromMockProvider is the
/// equivalent check on that platform. This is documented, not hidden.
final class LocationBridge: NSObject, CLLocationManagerDelegate, WKScriptMessageHandler {

    static let handlerName = "rposLocation"

    private let manager = CLLocationManager()
    private weak var webView: WKWebView?
    /// Request ids waiting on a fix. A single fix answers all of them.
    private var pending: [String] = []
    private var timeoutWork: DispatchWorkItem?

    /// Seconds before we give up on a fix. The staff app shows its own
    /// progress, so this only needs to be shorter than a person's patience.
    private let timeout: TimeInterval = 10

    init(webView: WKWebView) {
        self.webView = webView
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
    }

    // MARK: Web → native

    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == Self.handlerName else { return }
        let id = ((message.body as? [String: Any])?["id"] as? String) ?? ""

        guard CLLocationManager.locationServicesEnabled() else {
            return reply(id, ok: false, payload: ["error": "off"])
        }

        switch manager.authorizationStatus {
        case .notDetermined:
            // Ask now. The prompt is why NSLocationWhenInUseUsageDescription
            // must exist in this target's Info.plist; without it iOS kills the
            // app instead of prompting.
            pending.append(id)
            manager.requestWhenInUseAuthorization()
        case .denied:
            reply(id, ok: false, payload: ["error": "denied"])
        case .restricted:
            reply(id, ok: false, payload: ["error": "restricted"])
        case .authorizedWhenInUse, .authorizedAlways:
            pending.append(id)
            startFix()
        @unknown default:
            reply(id, ok: false, payload: ["error": "unavailable"])
        }
    }

    // MARK: CoreLocation

    private func startFix() {
        manager.requestLocation()
        // requestLocation has its own internal timeout but it is generous;
        // fail our own way so the clock screen never hangs.
        timeoutWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.flush(ok: false, payload: ["error": "timeout"])
        }
        timeoutWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout, execute: work)
    }

    func locationManagerDidChangeAuthorization(_ mgr: CLLocationManager) {
        guard !pending.isEmpty else { return }
        switch mgr.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways: startFix()
        case .denied:     flush(ok: false, payload: ["error": "denied"])
        case .restricted: flush(ok: false, payload: ["error": "restricted"])
        case .notDetermined: break   // still waiting on the person
        @unknown default: flush(ok: false, payload: ["error": "unavailable"])
        }
    }

    func locationManager(_ mgr: CLLocationManager, didUpdateLocations locs: [CLLocation]) {
        guard let loc = locs.last else {
            return flush(ok: false, payload: ["error": "unavailable"])
        }
        // Age matters: a cached fix from an hour ago at a different place would
        // otherwise sail through the fence. The server re-checks this too.
        let ageMs = Int(max(0, -loc.timestamp.timeIntervalSinceNow) * 1000)
        flush(ok: true, payload: [
            "lat": loc.coordinate.latitude,
            "lng": loc.coordinate.longitude,
            "accuracy": max(0, loc.horizontalAccuracy),
            "age_ms": ageMs,
        ])
    }

    func locationManager(_ mgr: CLLocationManager, didFailWithError error: Error) {
        flush(ok: false, payload: ["error": "unavailable"])
    }

    // MARK: native → web

    private func flush(ok: Bool, payload: [String: Any]) {
        timeoutWork?.cancel(); timeoutWork = nil
        let ids = pending
        pending = []
        ids.forEach { reply($0, ok: ok, payload: payload) }
    }

    private func reply(_ id: String, ok: Bool, payload: [String: Any]) {
        let json = (try? JSONSerialization.data(withJSONObject: payload))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        let escapedId = id.replacingOccurrences(of: "'", with: "\\'")
        let escapedJson = json
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
        let js = "window.__rposLocationCallback && window.__rposLocationCallback('\(escapedId)', \(ok), '\(escapedJson)');"
        DispatchQueue.main.async { [weak webView] in
            webView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }
}
