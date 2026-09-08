import Foundation

/// Central configuration for the ServOS iOS shells (POS, KDS, ...).
///
/// ONE source tree serves every app target. Anything app-specific lives in
/// that target's Info.plist (generated from its `info.properties` stanza in
/// `project.yml`), read here at runtime:
///
///   RPOSAppURL       (String, required)  — the web app URL this shell hosts
///   RPOSAllowsCamera (Bool, optional)    — grant camera to our origin
///                                          (default false = deny; a target
///                                          setting true must ALSO declare
///                                          NSCameraUsageDescription)
///   RPOSAllowsLocation (Bool, optional)  — expose window.RposLocation
///                                          (default false; a target setting
///                                          true must ALSO declare
///                                          NSLocationWhenInUseUsageDescription)
///
/// Shared, non-app-specific configuration stays as constants below.
enum Config {

    /// The web app this shell hosts, from the target's Info.plist.
    ///
    /// Per the staging-cutover pointing matrix these shells always point at
    /// PROD (MPOS and menuboard wrappers are the ones pointed at dev).
    /// POS: https://possystem-liard.vercel.app/?mode=pos
    /// KDS: https://possystem-liard.vercel.app/?mode=kds
    static let appURL: URL = {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: "RPOSAppURL") as? String,
              let url = URL(string: raw) else {
            // A target without a valid RPOSAppURL is a broken build; fail
            // loudly at launch rather than silently loading nothing.
            fatalError("RPOSAppURL missing or invalid in Info.plist")
        }
        return url
    }()

    /// Whether this app grants getUserMedia CAMERA requests from our origin.
    /// POS: true (QR scanning). KDS: false (never scans; no camera permission
    /// string in its Info.plist either). Missing key = deny, the safe default.
    static let allowsCamera: Bool =
        (Bundle.main.object(forInfoDictionaryKey: "RPOSAllowsCamera") as? Bool) ?? false

    /// Whether this app exposes the native location bridge (window.RposLocation).
    /// Staff: true — the geofenced clock-in needs a CoreLocation reading the web
    /// page cannot fake by overriding navigator.geolocation. Every other target:
    /// false, and they ship no location permission string at all, so they can
    /// never prompt. A target setting true MUST also declare
    /// NSLocationWhenInUseUsageDescription or iOS terminates the app on request.
    static let allowsLocation: Bool =
        (Bundle.main.object(forInfoDictionaryKey: "RPOSAllowsLocation") as? Bool) ?? false

    /// The app's user-facing name (used by native UI like ReconnectingView).
    static var displayName: String {
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
            ?? (Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String)
            ?? "ServOS"
    }

    /// Hosts that stay inside the WebView. Everything else opens in Safari.
    ///
    /// localhost / 127.0.0.1 cover on-LAN auxiliaries (e.g. loopback reader
    /// endpoints) so a future in-venue integration is not bounced to Safari.
    static let internalHosts: Set<String> = [
        "possystem-liard.vercel.app",
        "tbetcegmszzotrwdtqhi.supabase.co",  // Ops project (POS operational data)
        "yhzjgyrkyjabvhblqxzu.supabase.co",  // Platform project (gift cards, loyalty)
        "localhost",
        "127.0.0.1",
    ]

    /// Seconds between reconnect attempts after a navigation failure.
    /// Matches the Android wrapper's 5 second retry.
    static let retryInterval: TimeInterval = 5

    /// Marketing version (CFBundleShortVersionString), e.g. "1.0.0".
    /// Injected into the page as `window.RposIOS.version`.
    static var marketingVersion: String {
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0.0.0"
    }

    /// True when the URL should remain inside the WebView.
    static func isInternalHost(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        if internalHosts.contains(host) { return true }
        // Any *.supabase.co auxiliary (edge functions, storage CDN) stays in-app.
        if host.hasSuffix(".supabase.co") { return true }
        return false
    }
}
