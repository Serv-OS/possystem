# Serv OS / RPOS — session handoff

> **Current build: v5.5.344** · live: https://possystem-liard.vercel.app · repo: **Serv-OS/possystem** (renamed from pwar2804aio).
> First customer imminent (UK / GBP). Pillars: don't break working functionality; resolve real `locationId` before any DB write; CSS vars not hardcoded colours; bump `version.js` + CHANGELOG every web deploy.

---

## This session (v5.5.328 → v5.5.344 + infra)

**Branding / UI**
- 328–329 — Back-office light/dark toggle + Serv OS logo in brand spots; wordmark in Instrument Serif.
- 330 / 333 — POS top bar: added logo + "current shift"; removed the non-working Covers/Sales/Avg stats.

**Tips**
- 331–332 — Tip prompt on split-card payments + capture split tips for reporting.
- 334–336 — Tip pool reworked: role-aware in all modes, manager excluded by default; kiosk / online / QR tips auto-flow into the house pool.

**Fixes**
- 337 — Gift card "Card not found" on POS → `code_plain` fallback in gift-lookup.
- 338 — Size variants now inherit the parent's per-order-type tax overrides (takeaway 0% etc.).
- 339 — Removed "Open terminals for testing" dev panel.

**Reports / MPOS / Admin / Online**
- 340 — Overview "Today's snapshot" dashboard (sales by source / user / product, discounts).
- 341–342 — MPOS: customer search, takeaway requires details, tax breakdown + prints on the bill, 86 on modifier options.
- 343 — Forgot-password for back-office + admin login (both share `BOLogin` on the Ops `supabase` client).
- 344 — Online ordering: **per-item notes** on the product screen; **86'd items blocked/greyed** in modifier groups (e.g. "Box of three"). Order note stays at checkout.

**Infrastructure (no app version bump)**
- **Email → Resend.** Supabase Auth SMTP wired to Resend; reset emails send from `noreply@serv-os.app` ("Serv OS"), branded template (logo = `receipt-assets/brand/servos-logo.png`), verified delivered. **Deliverability fixed:** added Resend DKIM + SPF + MX to **Vercel DNS** (they were lost when DNS moved to Vercel; DMARC `p=quarantine` was spam-foldering). dig-verified live.
- **Android self-update (v1.3).** In-app updater shipped (`UpdateChecker.java` + manifest/FileProvider + MainActivity hook); Supabase public bucket `app-releases` + `latest.json`. On launch / every ~3h → checks → downloads → one-tap install. ⚠️ Not production-real until signed CI (see Next #1).
- **GitHub renamed → Serv-OS.** Repo now `Serv-OS/possystem`; local remote repointed, refs updated, pushes verified. Auth now via **macOS keychain** (old leaked token revoked + replaced with a repo-scoped token; remote URL clean → no token in Dropbox-synced config). Vercel + Supabase logins are GitHub-OAuth, unaffected by the rename.

---

## Next stages (tomorrow)

1. **Android pipeline (biggest).** Make auto-update production-real: one fixed signing key + CI auto-publish to Supabase, then multi-app flavors (Kiosk / MPOS / KDS; Menu Board needs a web surface first). Full plan in **`android/AUTO_UPDATE_PLAN.md`**. Also: get v1.3 (the updater build) onto the tills via one manual install.
2. **Email polish (optional).** Confirm reset mail now inboxes (give DNS a few hours + mark older ones "Not spam"); consider a Supabase **custom auth domain** `auth.serv-os.app` so the reset *link* matches the sender; brand the invite / confirmation / magic-link templates too.
3. **Menu Board.** Build the `?mode=menuboard` web surface (digital menu display) — prerequisite for packaging that Android app.
4. **Account housekeeping.** Finish the GitHub email/password change if not done (Vercel/Supabase ride on GitHub SSO — nothing to change there); glance at Vercel to confirm a deploy fired after the rename.
5. **Deferred backlog** (memory `project_post_launch_tasks.md`): consolidate `resolveCompanyForLocation` (2 copies), code-split bundles, commit `send-sms` source to git, multi-currency tail (cash denominations), bar-tab pre-auth refinements, Apple Pay / wallets on online.
6. **Live/hardware verification:** bar-tab pre-auth on a real Stripe reader (hold → capture → refund), a USD location end-to-end, voids/refunds on the Sunmi.

---

## Key architecture / infra notes
- **Two Supabase projects:** Ops `tbetcegmszzotrwdtqhi` (POS data, edge fns, back-office + admin auth) + Platform `yhzjgyrkyjabvhblqxzu` (companies / users / gift / loyalty).
- **Edge deploy:** `SUPABASE_ACCESS_TOKEN=… npx --yes supabase functions deploy <fn> --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt` (PAT was at `/tmp/sbenv` this session — not persistent across sessions).
- **Frontend deploy:** `git push origin develop` → Vercel auto-deploys. Bump `src/lib/version.js` + top-of-CHANGELOG in `src/App.jsx` every web deploy.
- **GitHub:** `Serv-OS/possystem`; pushes authenticate via macOS keychain (osxkeychain), repo-scoped token.
- **Currency:** per-location `locations.currency` on BOTH projects; never hardcode `£`/`'gbp'` — use `lib/currency.js` (`money()`, `currencySymbol()`, `stripeCurrency()`). Active currency cached in `localStorage['rpos-active-currency']`.
- **Email:** Resend SMTP on Ops Auth (from `noreply@serv-os.app`); `serv-os.app` verified in Resend; DKIM/SPF/MX live in Vercel DNS; DMARC `p=quarantine` (passes via DKIM).
- **Android:** `co.posup.rpos` WebView wrapper; self-updates via `app-releases` bucket; build = GitHub Actions `.github/workflows/build-apk.yml` (currently **debug → artifact**). See `android/RELEASING.md` + `android/AUTO_UPDATE_PLAN.md`.
- **Closed-check `payment_intents` jsonb** = source of truth for auto-refundable card legs.

### Multi-currency known limits
- Cash-drawer denomination labels stay GBP (country-specific note/coin sets, not just symbols).
- Platform billing tiers stay GBP (platform charges venues in GBP).
- Currency is per-location (confirmed), not org-level.

---

## Prior session (context)
v5.5.290 → 327: launch-readiness audit (auth/sign-out, cross-DB provisioning, company-resolution fail-closed, loyalty, atomic gift redeem, VAT receipts, stock/KDS/tables) + backlog (split/bar-tab card refunds, bar-tab pre-auth holds, OTP lockout, multi-currency GBP/USD/EUR). See git history / CHANGELOG for detail.
