# RPOS session handoff — 23 May (v5.5.207)

> CRITICAL FIX: Multi-tenant gift card isolation. All edge functions now resolve company via location_id instead of broken cross-DB user UUID lookup.

---

## What shipped today (23 May): v5.5.206 → v5.5.207

### v5.5.207 — CRITICAL: Gift card multi-tenant isolation fix
- **Root cause**: All 10 gift card edge functions used `resolveCompanyId(userId)` which looked up the Ops DB user UUID in Platform DB `user_company_roles`. Since these are different Supabase projects with different user tables, the UUID match was unreliable. When a super_admin switched locations in the BO, edge functions still returned data for whatever company the user UUID happened to match — not the location being viewed.
- **Fix 1 — Edge functions**: New `resolveCompanyForLocation(userId, locationId)` in `gift-card-utils.ts`. Priority: location_id → ops_location_id → platform location ID → user_company_roles fallback. All 10 authenticated edge functions updated.
- **Fix 2 — Client**: `callGift()` in GiftCards.jsx now automatically injects `location_id` (via `getActiveLocationSync()`) into every edge function request body.
- **Fix 3 — LocationSwitcher**: Super_admin users now scoped to their company via current location. Previously loaded ALL companies from ALL organisations. Now resolves user's company from their `location_id` and only shows that company's locations.
- **Fix 4 — gift-resend**: Refactored to use shared `authenticateCaller` + `resolveCompanyForLocation` from `gift-card-utils.ts` instead of inline duplicate implementations.

### v5.5.206 — Customers: sites-visited column + Gift voucher logo
- Customer list "Sites" column with multi-site badges
- Gift card voucher PDF includes branding logo

---

## Files changed in v5.5.207

| File | Change |
|------|--------|
| `src/lib/version.js` | 5.5.206 → 5.5.207 |
| `src/App.jsx` | CHANGELOG entry for v5.5.207 |
| `src/backoffice/sections/GiftCards.jsx` | `callGift()` auto-injects `location_id`; imports `getActiveLocationSync` |
| `src/backoffice/LocationSwitcher.jsx` | Super_admin scoped to company via current location |
| `supabase/functions/_shared/gift-card-utils.ts` | NEW `resolveCompanyForLocation()` function |
| `supabase/functions/gift-config/index.ts` | Uses `resolveCompanyForLocation` |
| `supabase/functions/gift-list/index.ts` | Uses `resolveCompanyForLocation` |
| `supabase/functions/gift-void/index.ts` | Uses `resolveCompanyForLocation` |
| `supabase/functions/gift-bulk-create/index.ts` | Uses `resolveCompanyForLocation` |
| `supabase/functions/gift-import/index.ts` | Uses `resolveCompanyForLocation` |
| `supabase/functions/gift-issue/index.ts` | Uses `resolveCompanyForLocation` |
| `supabase/functions/gift-reverse-redeem/index.ts` | Uses `resolveCompanyForLocation` |
| `supabase/functions/gift-resend/index.ts` | Refactored to shared utils |
| `supabase/functions/gift-lookup/index.ts` | Uses shared `resolveCompanyForLocation` (was inline) |
| `supabase/functions/gift-redeem/index.ts` | Uses shared `resolveCompanyForLocation` (was inline) |

---

## ⚠️ DEPLOYMENT REQUIRED — Edge Functions

The following 10 edge functions MUST be deployed to Supabase (Ops DB: `tbetcegmszzotrwdtqhi`) for the fix to take effect. The client-side changes (GiftCards.jsx, LocationSwitcher.jsx) deploy automatically via Vercel, but the edge functions need manual deployment:

| Function | Status | Notes |
|----------|--------|-------|
| `gift-config` | ⏳ Needs deploy | Uses resolveCompanyForLocation |
| `gift-list` | ⏳ Needs deploy | Uses resolveCompanyForLocation |
| `gift-void` | ⏳ Needs deploy | Uses resolveCompanyForLocation |
| `gift-bulk-create` | ⏳ Needs deploy | Uses resolveCompanyForLocation |
| `gift-import` | ⏳ Needs deploy | Uses resolveCompanyForLocation |
| `gift-issue` | ⏳ Needs deploy | Uses resolveCompanyForLocation |
| `gift-reverse-redeem` | ⏳ Needs deploy | Uses resolveCompanyForLocation |
| `gift-resend` | ⏳ Needs deploy | Refactored + resolveCompanyForLocation |
| `gift-lookup` | ⏳ Needs deploy | Now uses shared resolver |
| `gift-redeem` | ⏳ Needs deploy | Now uses shared resolver |

Deploy via Supabase Dashboard → Edge Functions → each function → paste code → Deploy.

---

## Still pending

- **Branding not taking effect** — Customer-facing gift card pages not reflecting branding color changes. Edge function works but values may be defaults. Needs investigation after isolation fix.
- **Card not found (MQFBEBZVDLJYLYQV)** — POS lookup failed. May be resolved by isolation fix (wrong company → wrong HMAC → no match). Re-test after edge function deployment.
- **User role check** — Verify pwar2804@gmail.com's role in `user_profiles`. If `super_admin`, consider changing to `owner`. The LocationSwitcher fix scopes super_admin to their company, but the role should match the intended access level.
- **Stripe webhook** — Online purchase status still "pending"; webhook not configured
- **Email deliverability** — Resend API key not configured
- **Order void → auto-reverse** — void order should refund gift card
