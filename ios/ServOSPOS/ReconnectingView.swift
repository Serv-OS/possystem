import SwiftUI

/// Minimal native overlay shown while the shell retries the POS URL.
/// Brand: Ink background #0F1211, Signal green #15C26A spinner.
struct ReconnectingView: View {
    private let ink = Color(red: 0x0F / 255, green: 0x12 / 255, blue: 0x11 / 255)
    private let signalGreen = Color(red: 0x15 / 255, green: 0xC2 / 255, blue: 0x6A / 255)

    var body: some View {
        ZStack {
            ink.ignoresSafeArea()

            VStack(spacing: 18) {
                ProgressView()
                    .progressViewStyle(.circular)
                    .tint(signalGreen)
                    .scaleEffect(1.5)

                Text("Reconnecting")
                    .font(.title3.weight(.semibold))
                    .foregroundColor(.white)

                Text("\(Config.displayName) retries automatically every few seconds.")
                    .font(.subheadline)
                    .foregroundColor(.white.opacity(0.6))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 40)
            }
        }
    }
}
