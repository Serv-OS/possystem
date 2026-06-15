# Serv OS MPOS — Android app with Stripe Tap to Pay

Mobile point-of-sale for a phone: take orders tableside (`?mode=mpos`) and take **contactless
card payments on the phone itself** via **Stripe Tap to Pay on Android** — no separate card
reader. This is the `:mpos` Gradle module, built and shipped independently of the POS (`:app`)
and Menu Board (`:menuboard`) apps.

---

## Why Stripe (not Ryft)

Researched June 2026 against primary docs:

- **Ryft has no Tap to Pay / SoftPOS product.** Ryft card-present = dedicated **PAX hardware
  terminals** (A920Pro / A50 / A35); its Android SDK is online/in-app card entry only.
- **Stripe Tap to Pay on Android** is GA in the UK and is the only realistic phone-NFC path —
  and Stripe is already integrated in this codebase.

So phone contactless = **Stripe**. Ryft stays for online + (if ever wanted) PAX terminals.

## Why it has to be native

Stripe is explicit: **a WebView/browser cannot drive the NFC reader.** The Tap to Pay
collection must run in native Android code (Stripe Terminal SDK). So `:mpos` is *not* a thin
WebView like the menu board — it carries the Stripe Terminal / Tap to Pay SDK (Kotlin) and
bridges it to the web POS.

## Architecture

```
 Web POS UI (?mode=mpos, the existing React app, in a WebView)
        │   window.RposTapToPay  (JS bridge)         ▲ window.__rposTapCallback(id, json)
        ▼                                            │
 TapToPayBridge.kt  ──►  TerminalManager.kt  ──►  Stripe Terminal SDK (Tap to Pay reader)
                              │                          │
                              │ ConnectionTokenProvider  │ collect → confirm (the tap)
                              ▼                          ▼
        edge fn: stripe-terminal-connection-token   phone NFC + Stripe
        edge fn: stripe-create-payment-intent (channel:card_present)
```

- Web (`src/surfaces/mpos/MCardFlow.jsx`) feature-detects the bridge (`tapToPayAvailable()`).
  Inside the MPOS app it runs the **native** tap; in a browser / on a non-MPOS device it falls
  back to the existing WisePOS reader path or the simulated flow. Nothing else changes.
- The money path stays **Stripe** end-to-end; success calls the same `onApproved()` →
  `clearTable()` / `recordWalkInClosed()` finalisation as every other card payment.
- **No new edge functions** — reuses `stripe-terminal-connection-token` and
  `stripe-create-payment-intent` (already supports `channel:'card_present'`).

## Files

| Path | What |
|---|---|
| `android/mpos/build.gradle` | module: Stripe Terminal+TapToPay 5.6.0, arm64 ABI, R8 release, release signing |
| `android/mpos/src/main/AndroidManifest.xml` | NFC + fine-location + foreground-service perms, `.MposApplication` |
| `android/mpos/src/main/java/.../MposApplication.kt` | `TerminalApplicationDelegate.onCreate` |
| `android/mpos/src/main/java/.../TerminalManager.kt` | init/discover/connect/collect/confirm/cancel + ConnectionTokenProvider |
| `android/mpos/src/main/java/.../TapToPayBridge.kt` | `@JavascriptInterface` → `window.RposTapToPay` |
| `android/mpos/src/main/java/.../MainActivity.java` | WebView → `?mode=mpos`, wires the bridge, requests location |
| `android/build.gradle` | re-adds the Kotlin gradle plugin classpath (only `:mpos` uses it) |
| `android/settings.gradle` | `include ':mpos'` |
| `src/lib/tapToPay.js` | web client for the bridge (promise wrapper + feature detection) |
| `src/surfaces/mpos/MCardFlow.jsx` | native Tap to Pay branch in the card flow |

---

## Two phases

### Phase A — test now (simulated, no real money)

A **debug** build runs the Tap to Pay reader in **simulated** mode
(`isSimulated = BuildConfig.DEBUG`). This proves the *entire* chain — connect → create
PaymentIntent → collect → confirm → finalise/print — with a fake card. No release signing and
no certificate registration required.

Still needed even for simulation: the merchant's Stripe account is **connected**
(`charges_enabled`) and a **Terminal Location** exists (see checklist), because
`stripe-terminal-connection-token` validates the connected account and `connectReader` needs a
Location id.

### Phase B — go live (real taps)

Real Tap to Pay refuses to run on a debug-signed / debuggable APK (it does hardware
attestation). To take real money you must **release-sign** the app and **register that signing
certificate with Stripe**. The code is identical; only the build signing flips, and
`isSimulated` becomes `false` automatically in the release build.

---

## Go-live checklist (the steps only you can do)

1. **Enable Tap to Pay on your Stripe account.** UK is GA; confirm Tap to Pay on Android is
   enabled for the connected account you charge through (the one in `merchant_stripe_accounts`).
2. **Create a Stripe Terminal Location** (Dashboard → Terminal → Locations, on the *connected*
   account) and copy its `tml_…` id. Set it as a Vercel env var so the app can pass it to
   `connectReader`:
   ```
   VITE_STRIPE_TERMINAL_LOCATION_ID=tml_xxxxxxxx
   ```
   (Until this is set, the app degrades to the simulated screen with a clear message — order
   taking still works.)
3. **Release keystore + GitHub secrets.** Generate a keystore once (needs a JDK):
   ```
   keytool -genkeypair -v -keystore mpos-release.jks -alias mpos \
     -keyalg RSA -keysize 2048 -validity 10000
   ```
   Then add repo secrets: `MPOS_KEYSTORE_BASE64` (`base64 -i mpos-release.jks`),
   `MPOS_KEYSTORE_PASSWORD`, `MPOS_KEY_ALIAS` (`mpos`), `MPOS_KEY_PASSWORD`, and switch the
   workflow to the release job (below).
4. **Register the release certificate with Stripe.** Get the SHA-256:
   ```
   keytool -list -v -keystore mpos-release.jks -alias mpos | grep SHA256
   ```
   Give Stripe that fingerprint for Tap to Pay attestation (via your Stripe contact / the Tap to
   Pay onboarding for platforms). Without this, real taps fail attestation.
5. **Phone requirements:** Android **13+**, GMS-certified (Play Store present), NFC, not rooted,
   security patch within the last 12 months. The app must be in the foreground during a tap.

---

## CI workflow — `.github/workflows/build-mpos.yml`

The PAT used for code pushes can't create workflow files, so add this via the GitHub web editor
(Serv-OS account) — same as `build-menuboard.yml`. **Phase A** content (debug, simulated):

```yaml
name: Build MPOS APK (Tap to Pay)
# Standalone build for the Mobile POS (co.posup.rpos.mpos) with NATIVE Stripe Tap to Pay.
# Independent of POS (build-apk.yml) and Menu Board (build-menuboard.yml).
on:
  push:
    branches: [ main, develop ]
    paths:
      - 'android/mpos/**'
      - 'android/settings.gradle'
      - 'android/build.gradle'
      - '.github/workflows/build-mpos.yml'
  workflow_dispatch:
jobs:
  build:
    runs-on: ubuntu-latest
    env:
      SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          java-version: '17'
          distribution: 'temurin'
      - uses: android-actions/setup-android@v3
      - run: chmod +x android/gradlew
      - name: Build MPOS APK (debug = simulated Tap to Pay)
        working-directory: android
        run: ./gradlew :mpos:assembleDebug --no-daemon --stacktrace
      - name: Upload MPOS APK
        uses: actions/upload-artifact@v4
        with:
          name: ServOS-MPOS-APK
          path: android/mpos/build/outputs/apk/debug/*.apk
          retention-days: 90
      # Optional no-PC install: publish to a public URL. No-op until SUPABASE_SERVICE_KEY is set.
      #   https://tbetcegmszzotrwdtqhi.supabase.co/storage/v1/object/public/app-releases/mpos.apk
      - name: Publish MPOS APK to Supabase (if configured)
        if: ${{ env.SUPABASE_SERVICE_KEY != '' }}
        run: |
          APK=$(find android/mpos/build/outputs/apk/debug -name '*.apk' | head -1)
          curl -fsS -X POST \
            "https://tbetcegmszzotrwdtqhi.supabase.co/storage/v1/object/app-releases/mpos.apk" \
            -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
            -H "x-upsert: true" \
            -H "Content-Type: application/vnd.android.package-archive" \
            --data-binary @"$APK"
```

### Phase B — release-signed job (swap in when going live)

Replace the build/upload steps with a release-signed build once the `MPOS_*` secrets exist:

```yaml
      - name: Decode keystore
        run: echo "${{ secrets.MPOS_KEYSTORE_BASE64 }}" | base64 -d > android/mpos/mpos-release.jks
      - name: Build MPOS release (real Tap to Pay)
        working-directory: android
        env:
          MPOS_KEYSTORE_FILE: ${{ github.workspace }}/android/mpos/mpos-release.jks
          MPOS_KEYSTORE_PASSWORD: ${{ secrets.MPOS_KEYSTORE_PASSWORD }}
          MPOS_KEY_ALIAS: ${{ secrets.MPOS_KEY_ALIAS }}
          MPOS_KEY_PASSWORD: ${{ secrets.MPOS_KEY_PASSWORD }}
        run: ./gradlew :mpos:assembleRelease --no-daemon --stacktrace
      - name: Upload MPOS release APK
        uses: actions/upload-artifact@v4
        with:
          name: ServOS-MPOS-Release-APK
          path: android/mpos/build/outputs/apk/release/*.apk
          retention-days: 90
```

---

## Install & test (Phase A)

1. Push the `:mpos` module → CI builds → download **ServOS-MPOS-APK** (or, if the Supabase
   publish step is on, install from the public URL with the Fire-TV-style "Downloader" flow / a
   browser on the phone).
2. Sideload onto the Android phone (allow unknown sources). Open **Serv OS MPOS**.
3. Grant **Location** when prompted (required by Tap to Pay).
4. Take an order → pay by **Card**. With a debug build you'll get the **simulated** reader; a
   test card approves with no real money. Confirm the check closes and the receipt prints.
5. When ready for real taps, do the go-live checklist and switch the workflow to the release job.
