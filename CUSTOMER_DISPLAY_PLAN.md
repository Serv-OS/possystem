# Customer display subsystem (hardware-matched) — build plan

**Decision: Option A** for payments — cards stay on the WisePOS E reader (the D3 Pro's NFC is
not Stripe-Tap-to-Pay certified; Stripe certifies D3 *Mini* / V3 Mix / L3 / V3 / T3 / T3 Pro /
CPad / Flex 3 — not D3 Pro). Research in chat + `android/AUTO_UPDATE_PLAN.md`.

**Refinement:** "customer display" is a **subsystem**, not one surface. The same content
(idle ads → live cart → payment status) is routed to whatever **destination** the terminal's
hardware has, chosen by a **per-terminal setting**. A venue with only a card reader uses the
reader screen; a venue with a D3 Pro / second monitor uses the rich screen; some use neither.

## Destinations
| Destination | Hardware | Status | Shows |
|---|---|---|---|
| **Card reader screen** | WisePOS E (no separate display) | **ALREADY BUILT** (v5.5.171+) | live cart line-items + total on the reader; tap / approved / declined native on the reader |
| **Dedicated second screen** | D3 Pro rear / external monitor | **NEW** | rich idle ads + live cart + payment status (web surface) |
| **None** | — | — | nothing |

(Optional **Auto** = use the dedicated screen if one is present, else fall back to the reader.)

## What already exists — reader path (reuse, don't rebuild)
- `src/lib/readerDisplay.js` → `pushReaderDisplay({lineItems, totalMinor, currency})` (debounced
  600ms) → edge fn **`stripe-update-reader-display`** → `setReaderDisplay` on the reader. The full
  live cart streams to the reader as the cashier rings up; `clearReaderDisplay()` resets to idle.
- Gated by **`payment_devices.customer_display_enabled`** (per reader), cached in localStorage
  (`rpos-reader-display-enabled`); **toggle UI already in BO → Card Readers** (`CardReaders.jsx:236`).
- Payment prompts (tap / insert / approved / declined) render **natively on the reader** during
  `stripe-process-payment-on-reader`.
- So "customer display on the reader" is **done**. New work = the dedicated-screen destination +
  the setting that picks the destination per terminal.

## The setting (the core of this request)
Add **`customer_display_mode`** to the **device profile** (`device_profiles`, Ops — hardware is
per terminal) with UI in `src/backoffice/sections/DeviceProfiles.jsx`:
- `off` · `reader` · `screen` (· `auto`)
- `reader` / `auto` → existing reader path (the per-reader `customer_display_enabled` stays as the
  reader's own on/off).
- `screen` / `auto`(when a screen is present) → new dedicated surface.

## Dedicated-screen destination (new build)
- Web surface **`?mode=customer-display`** (`src/surfaces/CustomerDisplaySurface.jsx`): idle ad
  carousel (reuse `device_profiles.kiosk_banners` / `kiosk_attract_video_url` / `kiosk-assets`
  bucket; attract logic in `KioskApp.jsx:887`) → live cart → payment status → thank-you / loyalty.
- Data: POS publishes cart + checkout state over a **Supabase Realtime *broadcast*** channel
  `display:<deviceId>`. Broadcast covers **counter/walk-in** orders that `active_sessions`
  (table-only) doesn't, carries payment state, and works same-device (D3 Pro main+rear) or separate.
- Android: rear screen runs the surface via Sunmi's **Vice-Screen / Customer-Display SDK**; ships
  as a **"Customer Display" flavor** in the multi-app pipeline (`android/AUTO_UPDATE_PLAN.md`).

## Shared plumbing
- One cart+payment event source in the POS feeds the **active destination(s)**, gated by
  `customer_display_mode`:
  - cart change → (`reader`) `pushReaderDisplay()` and/or (`screen`) broadcast.
  - **Lift `CheckoutModal` payment state** (`restState`: init→starting→collecting→approved/declined)
    out of the modal so the dedicated screen can show paying / approved / declined (the reader shows
    this natively already).

## Build order
1. **`customer_display_mode`** column on `device_profiles` + setting UI in `DeviceProfiles.jsx`
   (Off / Card reader / Dedicated screen [/ Auto]).
2. Route the **existing** cart push through the setting (reader path already works → just gate it).
3. New **`CustomerDisplaySurface.jsx`** + `?mode=customer-display` route (idle ads + live cart) —
   browser-testable with a mock broadcast.
4. POS **broadcaster** (cart + lifted checkout state) → `display:<deviceId>`.
5. Back-office customer-display **creative config** (reuse the kiosk banner uploader).
6. **Android** second-screen wiring (Sunmi vice-screen SDK) + flavor in CI.

## Notes
- Reader destination is limited to line-items + total + native payment UI (no rich ads) — that's
  the WisePOS E hardware ceiling; it's the graceful fallback when there's no dedicated screen.
- Payments unchanged (WisePOS E). If tap-on-customer-screen ever becomes required → a
  Stripe-certified Sunmi (D3 **Mini** / V3 Mix / T3 Pro) + native Tap to Pay (separate project).
