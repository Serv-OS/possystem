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
