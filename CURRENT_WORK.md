# RPOS session handoff — 29 May (v5.5.327)

> Launch-readiness audit + 4 backlog features shipped. ~2 weeks (now days) from first customer (UK / GBP).
> Edge functions now deploy via **Supabase CLI + PAT** (no longer the dashboard).

---

## Auth email → Resend SMTP (config only, no version bump — 29 May)

Supabase **Auth** emails (password reset for back-office + admin) now send through **Resend**, branded as Serv OS from our domain. Both surfaces (`BackOfficeApp` + `CompanyAdminApp`) auth against the **Ops** project via the shared `supabase` client, so SMTP was set on Ops only.

- **Where:** Ops project (`tbetcegmszzotrwdtqhi`) → Auth config (`PATCH /v1/projects/.../config/auth`).
- **Settings:** `smtp_host=smtp.resend.com`, `smtp_port=465`, `smtp_user=resend`, `smtp_admin_email=noreply@serv-os.app`, `smtp_sender_name="Serv OS"`. Pass = a dedicated Resend key named **"Supabase Auth SMTP"** (Sending access). `serv-os.app` is verified in Resend.
- **Template:** branded recovery HTML set as `mailer_templates_recovery_content` (ember header, "Serv**OS**" wordmark, button, footer).
- **Verified end-to-end 29 May:** triggered `/auth/v1/recover` → Resend log shows *"Reset your Serv OS password"* from `"Serv OS" <noreply@serv-os.app>` → **Delivered** to Gmail, branded body rendered.
- **Not yet branded:** invite / confirmation / magic-link templates still use Supabase defaults (optional follow-up). Platform project (`yhzjgyrkyjabvhblqxzu`) has no custom SMTP — only matters if any flow ever auths against Platform directly (today nothing does).
- **Logo in email:** branded recovery template uses `receipt-assets/brand/servos-logo.png` (transparent ServOS lockup, uploaded to Ops Storage). Swap that object to rebrand; no template edit needed.
- **Deliverability fix (29 May):** reset mail was going to **spam**. Root cause: Resend's SPF/DKIM were **missing from Vercel DNS** (lost when DNS moved to Vercel nameservers; Resend's "Verified" badge was stale from the old host). Domain DMARC is `p=quarantine`, so failing both SPF+DKIM alignment → spam. **Fixed** by adding 3 records to **Vercel DNS** (serv-os.app): TXT `resend._domainkey` (DKIM key), TXT `send` = `v=spf1 include:amazonses.com ~all`, MX `send` = `feedback-smtp.us-east-1.amazonses.com` pri 10. dig-verified live on `ns1.vercel-dns.com`. DMARC kept at `p=quarantine` (now passes via DKIM alignment). SOA negative-TTL 600s.
- **Remaining deliverability polish (Resend insights, optional):** (1) reset link is a `supabase.co` URL → needs a Supabase custom auth domain (e.g. `auth.serv-os.app`) to match sender; (2) logo image is on `supabase.co` → could move to `app.serv-os.app`; (3) `noreply@` sender → a real monitored address scores better. All minor vs the auth fix.

---

## What shipped this session: v5.5.290 → v5.5.327

### Launch-readiness audit (→ v5.5.322)
Deep audit + fixes ahead of first customer. Highlights:
- **Auth / sign-out** — killed the "blank back office / logged-in-with-no-user" bug class. `ensureAuthToken()` no longer mints anonymous sessions in office mode; back office + super-admin portal reject anon sessions and clear the location cache on sign-out.
- **Cross-DB provisioning** — new-org / new-location now works end-to-end. `provision-location` mirrors Ops → Platform; `create-user` made idempotent (re-invite repairs instead of half-populating).
- **Company resolution fail-closed** — `resolveCompanyForLocation` returns 409 `location_not_provisioned` instead of silently resolving a multi-company user to the wrong tenant.
- **Loyalty** — tier auto-evaluation, redeem→check back-patch so refunds restore points, registration-bonus ledger fixed (no double-count).
- **Gift cards** — atomic `redeem_gift_card_atomic` RPC (idempotent, race-free).
- **VAT receipts** — full per-item + per-rate breakdown on the emailed digital receipt.
- **Stock / KDS / tables** — add-only auto-86, KDS picks up new production-centre items without refresh, tables never lost across config push / refresh / wake.

### Backlog features
- **v5.5.323 — Card refunds for split payments & bar tabs.** New `closed_checks.payment_intents` jsonb holds every card leg; `refundCheck` refunds each back to its own card. Per-leg idempotency on `stripe-refund`. Single-card path unchanged.
- **v5.5.324 — Bar-tab card pre-authorisation (real holds).** The toggle was cosmetic; now it places a real Stripe Terminal manual-capture hold at tab open (`TabPreAuthTerminal`), captures at close (`/api/stripe-capture`), and releases on void / pay-another-way (`stripe-cancel-reader-action`). `stripe-process-payment-on-reader` gained optional `capture_method`. Defaults OFF; badge shows only when a real hold exists.
- **v5.5.325 — Loyalty OTP brute-force lockout.** Per-code attempt cap (5) via new `loyalty_otp_codes.attempts`; locks the code after 5 wrong tries (the 45s send cooldown bounds new codes).
- **v5.5.326 — Multi-currency (GBP / USD / EUR).** New `lib/currency.js` (`money()`, `currencySymbol()`, `stripeCurrency()`); per-location `currency`; ~675 inline `£` displays swept to `money()`; all client Stripe calls send `stripeCurrency()`; `stripe-create-payment-intent` accepts EUR. Byte-for-byte for GBP.
- **v5.5.327 — Currency at location creation.** `provision-location` now copies `currency` Ops → Platform on create (was lost → USD location resolved as GBP). Create-location dropdowns (admin + back office) limited to GBP/USD/EUR from the `CURRENCIES` source (removed unsupported AED).

---

## System status

### Verified working (build-clean + smoke-tested; reader/live paths need hardware test)
- ✅ Split & bar-tab refunds return to original card(s)
- ✅ Bar-tab pre-auth hold → capture/release (needs a real reader to test end-to-end)
- ✅ Loyalty OTP lockout after 5 wrong attempts
- ✅ Multi-currency display + Stripe currency across POS / kiosk / online / QR / receipts / reports
- ✅ Currency chosen at location creation now actually applies
- ✅ New-org / new-location provisioning across all features
- ✅ Auth / sign-out (no blank back office)

### Needs live/hardware verification
- Bar-tab pre-auth on a real Stripe Terminal reader (hold → capture → refund; release on void)
- A USD location end-to-end (set currency → POS shows $ → card charged in USD)
- Voids/refunds to original method on the Sunmi in production

---

## Remaining backlog (deferred — see memory `project_post_launch_tasks.md`)
- **Consolidate `resolveCompanyForLocation`** — one shared copy instead of two (tech debt; redeploys ~18 fns).
- **Code-split bundles** — chunk-size warning; perf polish.
- **Apple Pay / wallets on online ordering** — needs per-venue domain verification.
- **Multi-currency tail** — see "Known limits" below.
- **`send-sms` source not in git** — deployed fn has no committed source (chip raised).

### Multi-currency known limits
- Cash-drawer **denomination labels** (£50 note, 50p, …) stay GBP — country-specific note/coin *sets*, not just symbols.
- **Platform billing tiers** (£99 / £149) stay GBP intentionally (platform charges venues in GBP).
- Currency is **per-location** (confirmed choice), not org-level — locations under one org can differ.

---

## Key architecture notes
- Two Supabase projects: Ops (`tbetcegmszzotrwdtqhi`) + Platform (`yhzjgyrkyjabvhblqxzu`).
- **Edge deploy:** `SUPABASE_ACCESS_TOKEN=… npx --yes supabase functions deploy <name> --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt` (CLI bundles `_shared`). PAT stashed at `/tmp/sbenv` this session.
- **Currency:** lives on BOTH `locations.currency` columns (Ops = creation seed, Platform = authoritative for the app). Created in Ops → `provision-location` copies to Platform; Location Settings edits Platform. App reads Platform via `locationTime.getLocationConfig` (POS/kiosk) and `CustomerBoot`/`lookupLocationBySlug` (online/QR/gift/portal), persisted to `localStorage['rpos-active-currency']` so `money()` resolves synchronously.
- **Money formatting:** never hardcode `£`/`'gbp'` — use `money()` / `currencySymbol()` / `stripeCurrency()` from `lib/currency.js`.
- **Closed-check payments:** `payment_intents` jsonb is the source of truth for auto-refundable card legs; `stripe_payment_intent_id` kept for back-compat.
- Deploy frontend: `git push origin develop` → Vercel auto-deploys.
- `getActiveLocationSync()` on POS boot, never async `getLocationId()`.
