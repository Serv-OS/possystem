# RPOS session handoff — 23 May (v5.5.200)

> Gift cards v5.5.200: RLS fix via edge function, phone/expiry support, all-cards view with filters, 4 edge functions deployed.

---

## What shipped today (23 May): v5.5.193 → v5.5.200

### v5.5.200 — RLS fix, phone/expiry, all-cards view, filters
- **RLS fix** — All `gift_brand_config` writes now route through `gift-config` edge function using `platformAdmin` (service_role), bypassing Platform DB RLS that blocked back office users (who authenticate on Ops DB, not Platform DB).
- **All cards view** — "Recent cards" tab replaced with "All cards" showing every gift card with filter dropdowns for status (active/redeemed/voided/expired), source (manual/online/bulk/import), and batch name search.
- **Phone number support** — `recipient_phone` field added to Issue, Bulk Create, and Import panels. Stored on `gift_cards` table for CRM integration. New column + partial index on Platform DB.
- **Expiry date support** — Date picker added to Issue, Bulk Create, and Import panels. Cards can now have expiry set at creation time.
- **Import panel updates** — CSV parser accepts phone column (col 3), batch-level `expires_at` applied to all imported cards.
- **New edge function**: `gift-config` — centralises all `gift_brand_config` operations (get, enable, disable, settings, branding) through service_role.
- **Updated edge functions**: `gift-issue` (phone + expiry), `gift-import` (phone + batch expiry), `gift-list` (filters + extra fields).
- **Schema**: `gift_cards.recipient_phone` column + index on Platform DB.

### v5.5.199 — Bulk create, import, branding, split checks, settings, RLS fix, URL fix
- Bulk create, import, per-feature branding, settings panel, split check gift cards, URL routing fix, schema additions.

### v5.5.198 — Resend, POS fix, flexible lookup, code visibility
- `gift-resend` edge function; POS `resolveCompanyForPOS()` fallback; smart search; `fulfilled_code` storage.

### v5.5.197 — BO management, branding, preview links
### v5.5.196 — Phase 2: customer-facing purchase, balance check, email delivery
### v5.5.193-195 — Phase 1: schema, edge functions, BO UI, POS tender

---

## Files changed in v5.5.200

| File | Change |
|------|--------|
| `src/lib/version.js` | 5.5.199 → 5.5.200 |
| `src/App.jsx` | CHANGELOG entry for v5.5.200 |
| `src/backoffice/sections/GiftCards.jsx` | BrandingPanel + SettingsPanel save via edge function, ImportPanel phone+expiry, AllCardsPanel filters |
| `supabase/functions/gift-config/index.ts` | **NEW** — config operations edge function |
| `supabase/functions/gift-issue/index.ts` | Added `recipient_phone`, already had `expires_at` |
| `supabase/functions/gift-import/index.ts` | Added `recipient_phone`, batch-level `expires_at` |
| `supabase/functions/gift-list/index.ts` | Filters (status, source, batch_name, search), extra select fields |

---

## Edge functions deployed (all 4 confirmed via Supabase Dashboard)

| Function | Status | DB |
|----------|--------|----|
| `gift-config` | ✅ NEW — deployed | Ops DB |
| `gift-list` | ✅ Updated — deployed | Ops DB |
| `gift-issue` | ✅ Updated — deployed | Ops DB |
| `gift-import` | ✅ Updated — deployed | Ops DB |

---

## Platform DB migration applied

```sql
ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS recipient_phone text;
CREATE INDEX IF NOT EXISTS idx_gift_cards_recipient_phone ON gift_cards (recipient_phone) WHERE recipient_phone IS NOT NULL;
```

---

## Still pending

- **CRM integration** — Wire gift cards into customers section using phone as unique identifier
- **Email deliverability** — Resend API key not configured
- **Twilio SMS** — user has account ready, wants SMS delivery
- **Stripe webhook** — not yet enabled for checkout.session.completed
- **Subdomain DNS** — `slug.pos-up.com` not configured (using dev.pos-up.com)
- **Order void → auto-reverse** — void order should refund gift card
- **Online ordering gift redemption** — apply gift cards during online checkout
- **Reporting** — gift card revenue/liability reports in BO
- **Gift card on receipts** — show gift card details on printed/email receipts
