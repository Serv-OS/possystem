import SwiftUI

/// Hosts the WebView full screen and overlays the native reconnect view
/// whenever the page cannot be reached. The overlay guarantees the operator
/// never stares at a white screen.
struct ContentView: View {
    @StateObject private var connection = ConnectionState()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            // Ink behind everything so any letterboxing matches the brand.
            Color(red: 0x0F / 255, green: 0x12 / 255, blue: 0x11 / 255)
                .ignoresSafeArea()

            POSWebView(connection: connection)
                .ignoresSafeArea()

            if connection.isReconnecting {
                ReconnectingView()
                    .transition(.opacity)
            }
        }
        .statusBarHidden(true)
        .persistentSystemOverlays(.hidden)
        .onAppear {
            // POS terminal must never sleep (parity with Android FLAG_KEEP_SCREEN_ON).
            UIApplication.shared.isIdleTimerDisabled = true
        }
        .onChange(of: scenePhase) { phase in
            // Re-assert after backgrounding; iOS can reset the idle timer flag.
            if phase == .active {
                UIApplication.shared.isIdleTimerDisabled = true
            }
        }
    }
}
