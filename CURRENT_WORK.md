# RPOS session handoff — 27 May (v5.5.290)

> v5.5.290 deployed — gift card partial payment, 86 sync fixes, modifier group stock enforcement.

---

## What shipped today: v5.5.286 → v5.5.290

### v5.5.286 — Fix gift card "Card not found" on kiosk
- **Root cause:** Deployed edge function was old version without `card_id` support. Even v5.5.282 had mutually exclusive `if (code) / else if (card_id)` branches.
- **Fix:** Three-tier fallback in `gift-redeem` edge function: HMAC code lookup → card_id direct → code_plain fallback. Deployed via Supabase dashboard.
- **Diagnostic logging:** Each lookup miss logs `console.warn` for debugging.

### v5.5.287 — Kiosk + online orders now decrement stock
- **Root cause:** Kiosk `submitOrder` and `OnlineCheckout` never called `decrementStockRPC`. Only POS decremented via store's `addItem → decrementDailyCount`.
- **Fix:** Added `decrementStockRPC` calls for each cart item + modifier sub-items in both `KioskApp.jsx` (after heartbeat, before order number) and `OnlineCheckout.jsx` (both gift-card-only and Stripe payment paths).
- Only items with active stock tracking (in `dailyCounts`) are decremented.

### v5.5.288 — Fix 86 state inconsistency across kiosk browsers
- **Root cause:** Same kiosk open in 2 browsers — one showed item out of stock, the other didn't. The `eighty_six` Realtime subscription is a single WebSocket channel; if one browser misses an INSERT, its 86 list is stale.
- **Fix 1:** Redundant `is86` check: menu grid now checks `dailyCounts[id].remaining <= 0` alongside `eightySixIds`.
- **Fix 2:** Stock subscription auto-86: when `stock_levels` Realtime handler sees `remaining <= 0`, item is added to `eightySixIds`.
- **Fix 3:** 30-second periodic re-fetch of `eighty_six` table merges missed WebSocket events.

### v5.5.289 — Block 86'd items in modifier groups on kiosk
- **Root cause:** Item 86'd on POS/back office was blocked on kiosk menu grid but still selectable as a modifier option. Options without explicit `itemId` link weren't checked.
- **Fix:** New `resolveOptItemId` helper falls back to name-matching against sold-alone sub-items. Both render and click handler use it.
- **Bonus:** Mods array enriched with resolved `itemId` so stock decrement works for name-matched modifier options too.

### v5.5.290 — Gift card partial payment on kiosk
- **Root cause:** Manual gift card entry with insufficient balance showed "Insufficient balance" error — dead end for customer.
- **Fix:** `redeemManualGiftCard` auto-retries with available balance when edge function returns `{ error: 'Insufficient balance', balance: X }`.
- **Auto-start card reader:** New `useEffect` watches `giftCardPayment` — after partial gift card applied, card reader starts automatically for remaining balance.

---

## System status

### Verified working
- ✅ Gift card redemption on kiosk (linked cards + manual code entry)
- ✅ Gift card partial payment (applies available balance, remainder to card)
- ✅ Stock decrementing on kiosk and online orders
- ✅ 86 state consistent across multiple kiosk browsers
- ✅ 86'd items blocked in modifier groups
- ✅ Loyalty OTP on kiosk (earn points, redeem rewards)
- ✅ Online ordering with gift cards and loyalty
- ✅ POS checkout with split payments, gift cards, loyalty
- ✅ Table session sync across devices (hardened in v5.5.283)

### Still pending
- **Apple Pay / wallets on online ordering** — deferred post-launch item
- **Edge function deploy via CLI** — needs `SUPABASE_ACCESS_TOKEN` configured
- **Verify POS loyalty issues** — CORS fix deployed (v5.5.242), needs verification on Sunmi
- **"Admin page bleeding into office page"** — reported but not investigated

---

## Key architecture notes

- Two Supabase projects: Ops (`tbetcegmszzotrwdtqhi`) + Platform (`yhzjgyrkyjabvhblqxzu`)
- Edge functions deployed via Supabase dashboard Code editor (CLI needs `SUPABASE_ACCESS_TOKEN`)
- Kiosk/online use anonymous auth (`signInAnonymously()`); company resolved via `resolveCompanyForLocation()`
- Deploy: `git push origin develop` → Vercel auto-deploys
- `getActiveLocationSync()` — always use on POS boot, never async `getLocationId()`
- Stock decrement: POS via store action, kiosk/online via direct `decrementStockRPC()` after order
- 86 sync: three independent signals (Realtime, stock auto-86, 30s re-fetch)
