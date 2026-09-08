# Fingerprint sign-in (Sunmi D3 Pro) — integration status & how to finish it

> Staff fingerprint authentication on the Sunmi D3 Pro. Last updated: 27 June 2026.

## TL;DR
- The **web side is built and live** (feature-flagged — invisible until the device's native bridge
  reports the capability, PIN always available as fallback).
- The **native bridge is built**: `window.RposBiometric`. `verify()` (1:1 confirm) works *now* on the
  D3 Pro via Android's framework `BiometricPrompt` — no extra SDK.
- **True 1:N staff login** ("tap → the till knows which staff") needs **Sunmi's fingerprint SDK**
  (capture + template match), downloaded from the **Sunmi developer portal** (sign-in required — not
  public, not on Sunmi's GitHub). Drop it into the two marked TODOs and flip one flag.

## Why 1:N needs the Sunmi SDK
Android's standard biometric API (`BiometricPrompt`) only does **1:1 verification** — "is this an
enrolled user of the device?" It never exposes the fingerprint template and **cannot tell which of
your staff tapped**. Identifying a specific staff member (1:N) requires capturing + matching
fingerprint templates, which is exactly what Sunmi's *Fingerprints Development* SDK module provides.
The D3 Pro's built-in reader is otherwise marketed for device unlock / SUNMI One ID.

## The web ↔ native contract (already implemented)
Native object `window.RposBiometric`:
| Method | Web call | Native callback `window.__rposBiometricCallback(id, ok, jsonStr)` |
|---|---|---|
| `isAvailable()` | sync | returns `{"available":bool,"identify":bool,"verify":bool,"enroll":bool}` |
| `identify(id)` | 1:N login | ok + `{"staffRef":"<staff id>"}`, or `{"error":"no_match"}` |
| `verify(reason, id)` | 1:1 confirm | ok=true on match, or `{"error":"canceled"}` |
| `enroll(staffRef, label, id)` | register | ok + `{"templateId":"…"}` |

Web side: [`src/lib/biometric.js`](../src/lib/biometric.js) (wrapper) · fingerprint login button in
[`src/surfaces/PINScreen.jsx`](../src/surfaces/PINScreen.jsx) (shown only when `identify` is supported).
`staffRef` is the ServOS `staff_members.id` — `enroll()` keys the template by it, `identify()` returns it.

Native side: [`android/.../biometric/BiometricBridge.java`](../android/app/src/main/java/co/posup/rpos/biometric/BiometricBridge.java),
wired in `MainActivity`, permissions in `AndroidManifest.xml`.

## Finish 1:N (the only remaining work)
1. **Get the SDK** — sign in at developer.sunmi.com → *Fingerprints / Biometric (Fingerprint)
   Development Guide* → download the AAR + sample. Confirm it supports **enrol with a custom id +
   1:N identify** on the D3 Pro (vs L-series only). If it's verify-only, 1:N login isn't possible on
   this hardware and we stop at step-up `verify()`.
2. **Add the dependency** — drop the AAR in `android/app/libs/` and add it to `android/app/build.gradle`
   `dependencies { implementation files('libs/<sunmi-fingerprint>.aar') }` (+ any Sunmi maven repo).
3. **Wire the TODOs** in `BiometricBridge.java`:
   - `enroll(staffRef, …)` → run the SDK enrolment, associating the template with `staffRef`.
   - `identify(…)` → capture + 1:N match → `notifyJS(id, true, "{\"staffRef\":\"" + matchedId + "\"}")`.
   - set `SUNMI_SDK_WIRED = true` so `isAvailable()` reports `identify`/`enroll`.
4. **Enrolment UI** — add an "Enrol fingerprint" action per staff on a *device-side* screen (the
   reader is on the till, not the BO browser) calling `biometricEnroll(staff.id)`.
5. **Build + install** — trigger the CI APK build (`.github/workflows/build-apk.yml`) → upload to the
   `app-releases` bucket → the D3 Pro self-updates (see `android/RELEASING.md`; debug-signing may need
   a one-off manual reinstall).

## Test on the D3 Pro
- **Bridge present:** open the POS, devtools/console → `window.RposBiometric.isAvailable()` returns JSON.
- **verify() (works now):** any flow calling `biometricVerify()` shows the system fingerprint prompt.
- **1:N login (after SDK):** enrol a staff fingerprint → on the PIN screen tap **"Sign in with
  fingerprint"** → it logs that staff in. Bad/unknown finger → "not recognised", PIN still works.

## ⚠️ Compliance (do before go-live)
Fingerprints are **special-category data under UK GDPR (Art. 9)**: capture **explicit staff consent**,
run a **DPIA**, encrypt templates at rest (keep them in the device secure store — never send raw
prints/templates to the server; ServOS stores only the `staffRef ↔ template` association), define
**retention/erasure**, and **always keep PIN as the non-biometric alternative** (mandatory — the ICO
has penalised forced biometric staff clocking). Log biometric auth events to the audit trail.
