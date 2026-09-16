import SwiftUI

/// ServOS POS iOS shell.
///
/// A thin WKWebView wrapper around the PROD POS web app, mirroring the Android
/// wrapper (android/.../MainActivity.java). Build 5 (v5.8.83) adds the printer
/// bridge (PrinterBridge.swift): the POS target prints straight to the venue's
/// receipt printers over Wi-Fi. Other targets keep no bridge, so their prints
/// fall back to the Supabase print_jobs queue (LAN print agent).
@main
struct ServOSPOSApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
