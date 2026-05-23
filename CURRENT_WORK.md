# RPOS session handoff — 23 May (v5.5.199)

> Gift cards feature substantially complete: bulk create, import, branding, split checks, settings, POS fix, flexible lookup, resend.

---

## What shipped today (23 May): v5.5.193 → v5.5.199

### v5.5.199 — Bulk create, import, branding, split checks, settings, RLS fix, URL fix
- **Bulk create** — `gift-bulk-create` edge function + BO panel. Create 1-500 anonymous cards with same value and a batch name. Download CSV of codes.
- **Import** — `gift-import` edge function + BO panel. Import cards from external systems with balances. Manual rows or CSV paste. Each card gets a new code; old code stored in notes.
- **Per-feature branding** — Branding tab in Gift Cards BO section. Logo upload, accent/background/foreground colour pickers. Stored on `gift_brand_config.branding` JSONB. Falls back to `location.online_branding` if not set. Live preview.
- **Settings panel** — Min/max card values, expiry rules (never or X months), currency selector. Saves to `gift_brand_config`.
- **Split check gift cards** — Gift card added as payment method in `SplitModal.jsx` PortionTender. Full code entry, lookup, redeem flow within each split portion.
- **RLS fix** — Added INSERT/UPDATE policies on `gift_brand_config` for authenticated users (was SELECT-only, caused "violates row-level security" error when enabling).
- **URL routing fix** — App.jsx now routes `gift`, `gift_balance`, `gift_success` modes to CustomerBoot (was only routing `online` and `qr`, causing blank page on `slug.pos-up.com/gift`).
- **Schema** — `gift_cards` gains `batch_id`, `batch_name`, `source` columns. `gift_brand_config` gains `branding` JSONB column.

### v5.5.198 — Resend, POS fix, flexible lookup, code visibility
- `gift-resend` edge function; POS `resolveCompanyForPOS()` fallback; smart search; `fulfilled_code` storage.

### v5.5.197 — BO management, branding, preview links
### v5.5.196 — Phase 2: customer-facing purchase, balance check, email delivery
### v5.5.193-195 — Phase 1: schema, edge functions, BO UI, POS tender

---

## Files changed in v5.5.199

| File | Change |
|------|--------|
| `src/lib/version.js` | 5.5.198 → 5.5.199 |
| `src/App.jsx` | CHANGELOG + URL routing fix (gift modes in CustomerBoot dispatch) |
| `src/backoffice/sections/GiftCards.jsx` | **Major rewrite**: bulk create, import, branding editor, settings panel, 8 tabs |
| `src/components/SplitModal.jsx` | Gift card payment method in split check tender |
| `src/surfaces/gift/giftHelpers.js` | `buildGiftTheme()` accepts optional `giftBranding` override |
| `supabase/functions/gift-bulk-create/index.ts` | **NEW** — bulk-create endpoint |
| `supabase/functions/gift-import/index.ts` | **NEW** — import endpoint |
| `migrations/v5.5.199-gift-rls-batch-import.sql` | RLS fix + new columns |

---

## Deployment checklist

1. **Run migration** on Platform DB: `v5.5.199-gift-rls-batch-import.sql`
   - Adds INSERT/UPDATE policies on `gift_brand_config`
   - Adds `batch_id`, `batch_name`, `source` columns to `gift_cards`
   - Adds `branding` JSONB column to `gift_brand_config`
2. **Also run** (if not already): `v5.5.198-gift-resend-code-storage.sql` (adds `fulfilled_code`)
3. **Deploy edge functions** via Supabase Dashboard:
   - `gift-bulk-create` — **NEW**
   - `gift-import` — **NEW**
   - `gift-redeem` — updated (POS fallback)
   - `gift-lookup` — updated (smart search + POS fallback)
   - `gift-fulfill` — updated (stores `fulfilled_code`)
   - `gift-resend` — **NEW** (from v5.5.198)
4. **Stripe webhook** — `checkout.session.completed` still needs enabling
5. **Email** — `send-receipt` still in log mode. Set `RECEIPT_EMAIL_PROVIDER=resend` + `RESEND_API_KEY`

---

## Still pending

- **Email deliverability** — Resend API key not configured
- **Twilio SMS** — user has account ready, wants SMS delivery
- **Stripe webhook** — not yet enabled for checkout.session.completed
- **Subdomain DNS** — `slug.pos-up.com` not configured (using dev.pos-up.com)
- **Order void → auto-reverse** — void order should refund gift card
- **Online ordering gift redemption** — apply gift cards during online checkout
- **Reporting** — gift card revenue/liability reports in BO
- **Gift card on receipts** — show gift card details on printed/email receipts
