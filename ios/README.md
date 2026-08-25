# ServOS POS for iOS (WKWebView shell)

iPad-first WebView wrapper around the PROD POS web app, mirroring the Android wrapper in `android/`.

- **Loads** `https://possystem-liard.vercel.app/?mode=pos` (one constant in `ServOSPOS/Config.swift`; POS points at prod per the pointing matrix).
- **No .xcodeproj in git.** `xcodegen generate` builds it from `project.yml` (XcodeGen 2.46.0 installed).
- **No hardware bridges in v1.** `window.RposPrinter` is left undefined on purpose, so printing falls back to the Supabase `print_jobs` queue and the LAN print agent. The shell injects `window.RposIOS = { platform: 'ios', version: '1.0.0' }` so the web app can detect it.

## From zero to TestFlight (owner steps)

1. **Install Xcode** from the Mac App Store (large download, let it finish fully).
2. **Point the tools at it**, in Terminal:
   `sudo xcode-select -s /Applications/Xcode.app && sudo xcodebuild -license accept`
3. **Add your Apple ID**: Xcode -> Settings -> Accounts -> + -> your Apple Developer Apple ID.
4. **Generate and open the project**:
   `cd ios && xcodegen generate && open "ServOS POS.xcodeproj"`
5. **Pick the team**: select the "ServOS POS" target -> Signing & Capabilities -> Team (leave signing on Automatic). The bundle id `co.posup.rpos.pos` registers itself on first automatic signing.
6. **Create the app record**: appstoreconnect.apple.com -> Apps -> + -> New App -> platform iOS, name ServOS POS, bundle id `co.posup.rpos.pos`.
7. **Archive and upload**: in Xcode, Product -> Archive -> Distribute App -> TestFlight & App Store -> Upload.
8. **Add testers**: App Store Connect -> your app -> TestFlight -> Internal Testing -> add internal testers.

## Before App Store submission

- **App icon** is a placeholder slot. See `ServOSPOS/Assets.xcassets/AppIcon.appiconset/PLACEHOLDER.md`. Export the Signal green S mark on Ink from the Brand Guidelines; do not ship without it (archive validation fails).
- **Team id**: after step 5, put your 10 character team id into `project.yml` as `DEVELOPMENT_TEAM` under the target settings. Otherwise the next `xcodegen generate` forgets the team you picked in Xcode.

## Later automation

- Claude can archive and upload from the CLI once you hand over an **App Store Connect API key**: appstoreconnect.apple.com -> Users and Access -> Integrations -> App Store Connect API -> Team Keys -> Generate (role App Manager). Hand it over the same way as the Supabase PAT.
- `exportOptions.plist` is already set up for that (app-store-connect method, automatic signing).

## Legacy folder

- **`RestaurantOS/`** is the previous hand-assembled UIKit scaffold (bundle id `co.posup.rpos.ios`). It is NOT part of this build; XcodeGen only compiles `ServOSPOS/`. Its `Printer/PrinterBridge.swift` (WKScriptMessageHandler printer bridge) is a useful starting point if a native `RposPrinter` bridge is wanted in v2.

## What the shell does

- **Never sleeps**: `isIdleTimerDisabled` on, re-asserted whenever the app becomes active.
- **Never white-screens**: any load failure shows a native Reconnecting view and retries the same URL every 5 seconds until it loads. A killed web process reloads itself.
- **Stays put**: our host and `*.supabase.co` (plus localhost) load in the WebView; everything else opens in Safari.
- **POS-friendly WebView**: no pinch zoom, no scroll bounce, no long-press callouts, inline media with no tap (order chime works), camera granted to our origin for QR scanning, microphone always denied.
- **Orientation**: iPad all orientations, iPhone portrait only (runs on iPhone so TestFlight review cannot crash it).
