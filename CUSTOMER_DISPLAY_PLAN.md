# Customer-facing display (Sunmi D3 Pro rear screen) — build plan

**Decision: Option A** — the D3 Pro acts as a customer display; **card payments stay on the
WisePOS E reader** (the D3 Pro's NFC is *not* Stripe-Tap-to-Pay certified — Stripe certifies
the D3 *Mini*, V3 Mix, L3, V3, T3/T3 Pro, CPad, Flex 3, **not** the D3 Pro). Research in chat
+ `android/AUTO_UPDATE_PLAN.md` for device context.

## What it shows
- **Idle:** branded ad / promo carousel (+ optional attract video).
- **Active sale:** live order mirror — items, mods, qty, running total — as the cashier rings up.
- **Payment:** "Please follow the card reader" + amount → ✓ Approved / ✗ Declined → thank-you / loyalty prompt.

## Architecture (same device: D3 Pro 15.6″ main + 10″ rear)
Main screen = POS (`?mode=pos`); rear screen = new **`?mode=customer-display`** surface. Same device, so:

- **Live data — Supabase Realtime *broadcast* channel** keyed by device id (`display:<deviceId>`).
  The POS publishes `{ items, total, state }`; the display subscribes + renders. Broadcast is
  ephemeral, low-latency, needs no new table, and works whether the display is the same device
  or a separate one.
  - *Why not `active_sessions`:* that's **table/dine-in only** — counter/walk-in orders (the
    D3 Pro's main use) aren't written there. Broadcasting the cart explicitly covers all order
    types and carries the payment state too. (`active_sessions` realtime pattern is in
    `src/sync/SessionSync.js:210` if we ever want a persistent fallback.)
- **Idle ads — reuse the kiosk media config:** `device_profiles.kiosk_banners` (JSONB
  `[{screen,imageUrl,label}]`), `kiosk_attract_video_url`, `kiosk_idle_timeout_sec`, brand
  colours/logo; assets in the **`kiosk-assets`** bucket; attract render logic in
  `src/surfaces/KioskApp.jsx:887`. MVP reuses these; add dedicated `customer_display_*` fields
  later if a venue wants different creative on kiosk vs display.
- **Android:** render the rear screen via Sunmi's **Vice-Screen / Customer-Display SDK** — a
  custom second-screen app that loads `?mode=customer-display` (add the dual-screen identifier
  to the manifest; it's the Android `Presentation` API underneath). Ships as a **"Customer
  Display" flavor** in the multi-app plan, or a `Presentation` inside the POS app.

## Build order
1. **`src/surfaces/CustomerDisplaySurface.jsx`** + route in `src/App.jsx` (~L5375, after the
   kiosk check). Idle carousel + live-cart view + payment states. Testable in the browser with a
   mock broadcast.
2. **POS broadcaster** — publish cart changes + checkout state to `display:<deviceId>`. Cart is
   already in the store; checkout state is **local to `src/surfaces/CheckoutModal.jsx`**
   (`restState`: init→starting→collecting→approved/declined) → lift/emit it.
3. **Idle ↔ active switching** + ad rendering (reuse kiosk attract logic).
4. **Payment states** wired from the checkout broadcast.
5. **Back-office config** (MVP+) — a "Customer display" section to set the ad creative (reuse the
   kiosk banner uploader in `src/backoffice/sections/KioskSettings.jsx`).
6. **Android second-screen** wiring (Sunmi vice-screen SDK) + flavor in CI.

## Gaps to build (from codebase scan)
- No realtime channel for the live cart **at a counter** (`active_sessions` is table-only) → the
  broadcast channel above.
- Checkout payment state is **local to CheckoutModal** → emit it to the broadcast.
- No `customer-display` mode / route / surface yet → add.
- Android second-screen rendering not set up → Sunmi vice-screen SDK.

## Reuse notes
- `payment_devices.customer_display_enabled` already exists and `src/lib/readerDisplay.js`
  pushes line items to the **WisePOS E's own small screen** — the D3 rear screen is the richer
  version of the same idea; share the cart/state plumbing.
- Pairing: `devices` table + pairing code (`src/surfaces/PairingScreen.jsx`); device identity via
  `getActiveLocationSync()` in `src/lib/supabase.js`. Same-device display just listens to its own
  device's broadcast; a *separate* display device would pair + bind to a till.
- Payments unchanged (WisePOS E). If "tap on the customer screen" ever becomes required → a
  Stripe-certified Sunmi (D3 **Mini** / V3 Mix / T3 Pro) + native Tap to Pay (separate project).
