# RPOS session handoff — 26 May (v5.5.243)

> v5.5.243 deployed — online loyalty features: rewards step, phone detection, wallet buttons.

---

## What shipped today: v5.5.240 → v5.5.243

### v5.5.240 — Fix "No location assigned" on login
- Made profile query fallback unconditional; auto-select first location as safety net

### v5.5.241 — Fix login — remove fragile PostgREST joins
- Profile query no longer uses PostgREST embedded resources
- Org/location names fetched separately with graceful fallback
- Added bo_access column to user_profiles table

### v5.5.242 — Fix stock sync — bypass async location resolver
- Stock writes now pass getActiveLocationSync() directly (was using async getLocationId())
- Proper error logging via .then(res => { if (res?.error) ... })

### v5.5.243 — Online loyalty: rewards step, phone detection, wallet buttons
- **OnlineCheckout.jsx**: New 4-step flow (details → gift → rewards → pay). Rewards step only shows if loyalty signed in. Members can browse & redeem rewards for discounts.
- **Phone detection**: Debounced lookup on phone input (600ms). If member detected, shows "You're a member! Sign in" banner with Sign in / Dismiss buttons.
- **Wallet buttons**: Apple Wallet + Google Wallet buttons in LoyaltyModal "done" step. WalletButton component calls wallet-pass edge function.
- **Reward in closed_checks**: loyalty_reward field tracked for reporting; payment_method shows split breakdown.
- **LoyaltyManager.jsx**: Wallet discoverability info in PortalLink section.

---

## Loyalty system status (6 issues)

1. **POS not finding current customer** — CORS fix deployed (v5.5.242). Needs user verification.
2. **No way to redeem rewards on POS** — CheckoutModal already has this feature. Likely blocked by same CORS issue. Needs verification.
3. **Online ordering: no way to redeem rewards** — ✅ DONE (v5.5.243)
4. **Online ordering: phone should detect loyalty member** — ✅ DONE (v5.5.243)
5. **Apple Wallet: can't find it** — ✅ DONE (v5.5.243, wallet buttons in loyalty sign-in modal)
6. **"Failed to fetch" when updating a reward** — ✅ FIXED (CORS headers, deployed v5.5.242)

---

## Still pending

- **Verify POS issues #1 and #2** — user needs to test on Sunmi POS
- **Stock tracking verification** — v5.5.242 deployed, user needs to test on Sunmi
- **"Admin page bleeding into office page"** — reported but not yet investigated
- **Apple Pay / wallets on online ordering** — deferred post-launch item

---

## Key architecture notes

- Two Supabase projects: Ops (tbetcegmszzotrwdtqhi) + Platform (yhzjgyrkyjabvhblqxzu)
- Edge functions deployed with: `SUPABASE_ACCESS_TOKEN=sbp_... npx supabase functions deploy <name> --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt`
- CORS: All loyalty edge functions share cors headers from `_shared/loyalty-utils.ts` (includes Access-Control-Allow-Methods)
- Online ordering auth: signInAnonymously() creates anonymous sessions that edge fns accept
- `getActiveLocationSync()` — always use this on POS, never async `getLocationId()`
- Vercel deploys from `develop` branch
