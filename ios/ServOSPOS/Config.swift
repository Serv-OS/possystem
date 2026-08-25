import Foundation

/// Central configuration for the ServOS POS iOS shell.
///
/// Single source of truth for the target URL, mirroring the Android wrapper's
/// `POS_URL` constant in `android/.../MainActivity.java`.
enum Config {

    /// The web app this shell hosts.
    ///
    /// Per the staging-cutover pointing matrix the POS shells always point at
    /// PROD (MPOS and menuboard wrappers are the ones pointed at dev).
    /// Same URL as the Android POS APK.
    static let posURL = URL(string: "https://possystem-liard.vercel.app/?mode=pos")!

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
