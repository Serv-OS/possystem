# Serv OS MPOS — Android app (order-taking) + Tap to Pay roadmap (iOS)

## What the Android app is

`:mpos` is a standalone Android app (`co.posup.rpos.mpos`) — a WebView pointed at the existing
web POS surface `?mode=mpos` — for taking orders tableside on a phone. It follows the same
"one Gradle module + one CI workflow per device app" pattern as `:app` (POS) and `:menuboard`
(Fire TV), and is built/installed independently.

- Module: `android/mpos/` (build.gradle, AndroidManifest.xml, `MainActivity.java`, strings, icons).
- CI: `.github/workflows/build-mpos.yml` → `:mpos:assembleDebug` → artifact **ServOS-MPOS-APK**
  (and an optional public URL if `SUPABASE_SERVICE_KEY` is set).
- Card payments use the surface's existing flows: an **assigned hardware reader** (WisePOS /
  Ryft PAX, via the REST flow in `src/surfaces/mpos/MCardFlow.jsx`), or a **simulated** approval
  in a browser / when no reader is assigned.

## Why Tap to Pay is NOT on Android here

Researched June 2026 against primary docs:

- **Ryft (the chosen processor) has no Android SoftPOS / Tap to Pay** — Ryft card-present is
  dedicated PAX hardware terminals only.
- Stripe *does* have Tap to Pay on Android, but those payments would settle through **Stripe**,
  not Ryft — which breaks the goal of standardising on Ryft.

So phone contactless ("tap on the device, no extra hardware") is being built on **iOS**, where
Apple's *Tap to Pay on iPhone* is available and Ryft can be the acquiring PSP. See the iOS plan
(produced by the `ryft-ios-taptopay-plan` workflow) for the verified processor decision,
architecture, Apple entitlement/onboarding, and distribution reality.

## The web Tap to Pay bridge is kept (for iOS)

The platform-agnostic web pieces stay in the codebase, dormant on Android, ready for the native
iOS app to implement the same contract:

- `window.RposTapToPay` bridge contract + `src/lib/tapToPay.js` (promise wrapper + feature
  detection — returns "unavailable" when no native bridge is injected).
- The native-tap branch in `src/surfaces/mpos/MCardFlow.jsx` (`tapToPayAvailable()` gate). On
  Android the bridge is absent, so it falls through to the assigned-reader / simulated path.

When the iOS app injects `window.RposTapToPay`, the existing web checkout drives the tap with no
further web changes.

## Install & test (Android)

1. Push the `:mpos` module → CI builds → download **ServOS-MPOS-APK** (or install from the
   public URL if the Supabase publish step is enabled).
2. Sideload onto the Android phone (allow unknown sources) and open **Serv OS MPOS**.
3. Take an order → pay by **Card**: with an assigned reader it runs the WisePOS/Ryft flow; in a
   browser / unassigned device it offers a simulated approval to test the flow end-to-end.

## Self-update (auto-update on relaunch)

The app updates itself, no Play Store. On launch (and on resume, throttled to ~3h) it reads
`app-releases/latest-mpos.json` from Supabase; if its `versionCode` is higher than the installed
one it downloads `mpos.apk` and fires the system installer (one tap: "Install"). First run per
device needs a one-time "allow install from this source" grant (Android 8+).

- Client: `android/mpos/.../UpdateChecker.java`; manifest has `REQUEST_INSTALL_PACKAGES` + a
  `FileProvider` (`res/xml/file_paths.xml`). Wired in `MainActivity` (check on launch + resume).
- Channel files: manifest `app-releases/latest-mpos.json` (canonical copy
  `android/release/latest-mpos.json`), APK `app-releases/mpos.apk`.

**Fixed-key signing is required** — Android only installs an update in place if it's signed with
the SAME key as the installed app. CI signs RELEASE builds with one keystore from repo secrets
`ANDROID_KEYSTORE_BASE64` / `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` /
`ANDROID_KEY_PASSWORD`; set `SUPABASE_SERVICE_KEY` too and CI auto-publishes the APK + manifest on
every push (a release = one push). The keystore (PKCS12, alias `servos`) is generated once and
kept OUT of the repo — back it up; losing it means the app can never auto-update again.

**To ship an update:** bump `versionCode` (+ `versionName`) in `android/mpos/build.gradle` AND in
`android/release/latest-mpos.json`, then push. CI builds the signed APK and publishes it; running
apps pick it up within ~3h or on next launch.

One-time migration: switching from the throwaway debug key to the fixed release key changes the
signature, so the currently-installed (debug) build must be **uninstalled + reinstalled once**
onto the first release-signed build. After that every update is automatic.
