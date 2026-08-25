import SwiftUI

/// ServOS POS iOS shell.
///
/// A thin WKWebView wrapper around the PROD POS web app, mirroring the Android
/// wrapper (android/.../MainActivity.java). v1 ships no hardware bridges:
/// window.RposPrinter is left undefined on purpose, so the web app's print
/// service falls back to the Supabase print_jobs queue (LAN print agent).
@main
struct ServOSPOSApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
