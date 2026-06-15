# Serv OS / RPOS — session handoff

> **Current build: v5.5.473** · live: https://possystem-liard.vercel.app · dev: https://dev.serv-os.app · repo: **Serv-OS/possystem** (branch `develop`, Vercel auto-deploys).
> Multi-tenant hospitality POS (React 19 + Vite, Zustand, Supabase; no TypeScript, no tests). First customer is UK / GBP.
> **Pillars:** don't break working functionality · resolve the real `locationId` before any DB write (never `loc-demo`) · CSS vars not hardcoded colours · bump `src/lib/version.js` + add a `CHANGELOG` entry in `src/App.jsx` on every web deploy · money is `numeric`, never float.

Read alongside: **`CLAUDE.md`** (architecture/orientation), **`DECISIONS.md`** (ADRs), **`INVARIANTS.md`** (hard rules).

---

## What Serv OS is

A SaaS restaurant/bar POS with many device "surfaces" off one codebase (URL `?mode=…`): POS till, MPOS (mobile), Bar, Floor/Tables, KDS, Kiosk, Orders Hub, Customer Display, **Time Clock**, Back Office, and customer-facing Online/QR/Loyalty/Gift web flows. Two Supabase projects: **Ops DB** `tbetcegmszzotrwdtqhi` (all operational data, scoped by `location_id`, hosts the edge functions) and **Platform DB** `yhzjgyrkyjabvhblqxzu` (orgs, users, loyalty, gift cards). Back-office users authenticate with Supabase Auth; POS/clock/kiosk devices pair to a location and use **anonymous auth**.

---

## Recent arc (this block of sessions)

### 0. MPOS Android app + Stripe Tap to Pay (NEW — in progress, v5.5.473)
A real phone POS: the `:mpos` Gradle module (own `applicationId co.posup.rpos.mpos`, own CI), a WebView → `?mode=mpos` **plus a native Stripe Tap to Pay layer** (the menu-board/POS apps are pure WebViews; this one carries the Stripe Terminal SDK because Stripe forbids driving the NFC reader from a WebView). Native Kotlin (`MposApplication`/`TerminalManager`/`TapToPayBridge`) exposes `window.RposTapToPay`; `src/lib/tapToPay.js` wraps it and `src/surfaces/mpos/MCardFlow.jsx` runs the native tap (create `card_present` PaymentIntent → collect → confirm) with graceful fallback to the WisePOS/simulated path off-device. **Processor = Stripe** (researched: Ryft has no Tap-to-Pay/SoftPOS, only PAX hardware). Reuses existing edge fns `stripe-terminal-connection-token` + `stripe-create-payment-intent` — no new backend. **Debug build = simulated reader (test now, no real money); release build (signed + cert registered with Stripe) = real taps.** Full spec + go-live checklist: **`android/MPOS_TAP_TO_PAY.md`**.
- **Still to do:** create `.github/workflows/build-mpos.yml` via the GitHub web editor (PAT can't push workflow files) → first CI build → iterate any Kotlin/SDK compile fixes → sideload debug APK → test simulated tap → then the operator-side go-live steps (Terminal Location `tml_…` → `VITE_STRIPE_TERMINAL_LOCATION_ID`, release keystore + `MPOS_*` secrets, register cert SHA-256 with Stripe, enable TTP).

### 1. ServOS visual reskin (POS + Back Office)
"Liquid glass" design system applied across POS + Back Office, **zero behaviour change** — scoped via `data-skin="servos"` on `<html>`, light/dark via `[data-theme]` (persisted to `rpos-theme`). Customer-facing online/QR/kiosk UIs deliberately untouched. Back-office sidebar reorganised into a 10-section collapsible IA (`NAV_IA` in `BackOfficeApp.jsx`). Shared tokens/classes in `src/styles/globals.css`; brand in `ServOSBrand.jsx`; line-icon set in `ServOSIcons.jsx`.

### 2. Workforce module (NEW — the big one)
A complete staff-management system inside Back Office (sidebar group **Workforce**), per-location, wired to live financials. Sections: **Dashboard · Rota · Timesheets · Time off & availability · Staff · Onboarding · Compliance · Positions & rates · Tronc/tips · Announcements · Workforce settings.** See the dedicated section below.

### 3. Time Clock surface (NEW)
Dedicated `?mode=clock` tablet for staff to clock in/out + take breaks via PIN. Punches write timesheets server-side and feed the Workforce timesheets → pay → tronc/accrual chain. See below.

### 4. Tronc ↔ Tips report tie
Workforce → Tronc now **pulls the real weekly pool from the POS** (card tips + service charge from `closed_checks`, same data the Tips report uses) instead of a manual figure; the Tips report cross-references the audited Workforce payout.

### 5. Workforce depth — onboarding, documents, profiles, SMS, AI rota
- **Onboarding** is a real per-starter pipeline: offer letter, Right-to-Work upload, contract, bank details, POS access (the "first shift" step was removed).
- **Compliance** does **real file upload** to a **private `wf-documents` bucket** (per-location Storage RLS; short-lived signed URLs) instead of pasting a URL. A held doc with no expiry reads as Valid (RTW).
- **Staff profile** — click a staff member for a detail modal (pay/override, contact, **address + emergency contact**, documents, holiday, onboarding, recent timesheets, **bank details for payroll**).
- **Rota notifications** — publishing **texts each affected person** their shifts via `send-sms`.
- **AI rota builder** — Rota → "Build with AI" drafts a week from availability + coverage + forecast + target labour % via `/api/ai` (no-tools `rota` mode); inserted as draft.

### 6. Workforce depth (latest) — templates, e-sign, UK holiday, pay periods, rota actuals, payroll bank
- **Offer/contract templates** (`wf_doc_templates`): create/edit reusable templates with `{{merge}}` fields (Workforce → Settings); onboarding picks one, merges the person's details, and sends. Modelled on Deputy / Workforce.com. Built-in UK defaults.
- **In-app e-sign**: contract "Generate" → **"Sign now"** opens `/sign/<token>` on-device (or Email / Copy link) → candidate types name to sign; signature+timestamp+IP stored. Public page + `workforce-onboarding` edge fn; renders the merged contract inline.
- **UK holiday**: **hourly/irregular** staff accrue **12.07%** of worked hours (server-side, `accrual.run` skips salaried); **salaried** get a fixed **28-day** allowance. For variable-hours staff "a day" of leave = their **average paid hours per day** (`avgHoursPerDay`/`isHourly` in `labour.js`). WfLeave shows basis/accrued/taken/remaining per person.
- **Pay periods**: monthly, configurable start day (e.g. 26th → 26th–25th) on `wf_venue_settings`. Workforce → Pay **"Run payroll"** scopes approved timesheets to the period (`wfWeek.payPeriod`; `pay.period` edge fn takes from/to) with prev/next nav.
- **Rota actuals**: footer now shows **Actual wage** (from timesheets) + **Labour % (plan)** and **Labour % (actual)** alongside scheduled wage + forecast/actual sales.
- **Payroll bank**: full account stored (org-RLS-fenced) + sort + masked; shown on the staff profile so staff can be paid.
- **Email/SMS via SDK**: all workforce `send-receipt`/`send-sms`/`workforce-compute` calls go through `supabase.functions.invoke` (correct gateway auth) — fixed offers/contracts not sending.

### 7. (newest) Payments choice (Ryft), Review Manager + Google, Reporting suite, Owner app
- **Ryft payments** built alongside Stripe (dual-processor, chosen per location): card-present (CheckoutModal), online/QR/kiosk, **bar-tab pre-auth** (store card → capture on close), refunds, **disputes** (accept/challenge with a respond-by deadline), a reconciliation ledger (`ryft_payments`) kept in sync by webhooks, and admin onboarding/connect. Edge fns `ryft-*`, `payments-onboard/admin/processor`. See `RYFT_INTEGRATION_PLAN.md`.
- **Review Manager** (Back Office → Customers → Reviews): de-gated, **compliance-safe** (UK DMCC 2024 / US FTC Oct-2024 — no review-gating) reputation module. Approvals queue, branded customer review card at `/review` (inherits the venue brand kit + uploadable background), trigger engine (POS-driven SMS ask), dashboard, settings. Pulls/replies through **real platform APIs only** — Google (live path), TheFork/Trustpilot (stubbed until OAuth built). `review-*` edge fns + `review_*` tables.
- **Google connection** (one-time *platform* OAuth, not per customer): `review-google` flow + `_shared/google-reviews.ts`. OAuth client **"ServOS Reviews"** created + Supabase `GOOGLE_OAUTH_CLIENT_ID/_SECRET` set (13 Jun); each venue just clicks **Connect Google**. **v4 review-DATA API access is PENDING Google approval** (case `1-2668000040500`, ~7–10 business days — see Open items). Full state in memory `reference_google_review_oauth.md`.
- **Reporting suite** (Back Office → Reports):
  - **Daily trading (P&L)** — Sales → "Daily trading (P&L)". `trading-report` edge fn. Per-day operator **forecast** (with a "same weekday last year" suggestion learned from `closed_checks`) → full P&L ladder: **gross takings → less VAT (collected for HMRC, never profit) → net sales (ex-VAT) → less COGS (configurable %) → gross profit → less labour (theoretical rota vs actual timesheets) → less overhead → operating profit**, with per-day table (Gross/VAT/Net columns) + totals. VAT from `closed_checks.tax_amount` (fallback `total−net−service−tip`); gross = net + VAT (the `total` column is unreliable). COGS%/overhead stored in `wf_venue_settings.settings` jsonb — **no schema change**.
  - **Payroll** — Staff → "Payroll". Reads closed `wf_payroll_runs`; per-run wages/tips, expandable per-staff breakdown, CSV.
- **Owner app** (`?mode=owner`): mobile-first PWA. Back-office login → top-down snapshot across every location the owner can access (today net vs forecast, % to forecast, labour %, orders, avg check, tips, live orders + open tables, WTD vs last week, top sellers) in one `owner-snapshot` edge-fn call. Light/dark toggle (shared `rpos-theme`). Real ServOS logo via `ServOSBrand` components. `src/surfaces/OwnerSurface.jsx`.

### 8. (newest) Digital Menu Board (NEW)
A TV / Android-TV menu-board surface + a Back Office builder (Channels → **Menu boards**). Build a "screen" (a `menu_boards` row): pick categories (**drag to reorder**; mark any **Full width** to make a hero band), set orientation / columns / branding / **marketing mode** (fullscreen image or video, no menu), then Publish. The display (`?mode=menuboard`) **auto-fits to one screen** — columns fill **top-to-bottom** (`column-fill:auto` with an explicit integer column count so overflow is actually detected) and type scales up to fill the height; it never clips, even at large "Text size" (which maps to column count: more columns = bigger type). Shows descriptions, dietary badges, **allergens (comma-separated, on their own line under the description)**, variant sizes (indented with a price gap), and **"Sold out"** from the live 86 system. Live over Realtime on Publish; cache-first so it survives offline.
**Screen pairing** (NEW): a screen opened with no `?board` self-registers and shows a high-entropy **pairing code**; in Back Office → Channels → Menu boards → **Paired screens**, enter the code + pick a board to assign it (then reassign / unpair / remove, each with an Online / last-seen indicator). The device learns its board over Realtime (+ 20s poll + 60s heartbeat) and renders it live. New **`menu_board_screens`** table with **device-scoped RLS** (a device only sees its own row; BO only its venue's screens) + `SECURITY DEFINER` `claim`/`set`/`heartbeat` RPCs — no cross-tenant code enumeration. Hardened after a 5-agent adversarial RLS review: **~39-bit codes** (8-char unambiguous, was ~17-bit) + a **30-min claim TTL**. `?board=<id>` direct links still work as a manual fallback. Files: `src/surfaces/MenuBoardSurface.jsx`, `src/backoffice/sections/MenuBoards.jsx`; migrations `20260613_menu_boards.sql` + `20260614*_menu_board_screens*.sql`; spec `MENU_BOARD_PLAN.md`.

### (earlier in this block) Bar-tab card holds, multi-currency (`lib/currency.js`, `locations.currency`), MPOS hardening (86 on modifiers, tax breakdown, customer search), customer-display loyalty + theme.

---

## Workforce module — how it works (for whoever picks this up)

**Front end** — `src/backoffice/sections/Workforce.jsx` is the router; the staff list + add/edit modals live there. Each section is its own component in `src/backoffice/sections/workforce/` (`WfRota`, `WfTimesheets`, `WfTronc`, `WfPay`, `WfLeave`, `WfOnboarding`, `WfCompliance`, `WfAnnouncements`, `WfSettings`). Shared building blocks:
- `src/staff/wfData.js` — **the data-access layer**. Location/org-scoped CRUD for every `wf_*` table + `loadActualSales` / `loadTipPool` (from `closed_checks`) + `invokeCompute` (calls the edge function). Maps snake_case ↔ camelCase. Has a `localStorage` fallback when `isMock` so it's testable without a backend.
- `src/staff/wfUi.jsx` — shared ServOS UI primitives (Card, Badge, EmptyState, table styles, colours).
- `src/staff/wfWeek.js` — current-week (Mon–Sun) date model for the rota.
- `src/staff/labour.js` — labour engine: `resolveRate` (override → role base → salaried equiv, with provenance), `hoursOf`, `labourPct`, `troncRun` (largest-remainder, penny-exact), `accrueHolidayHours` (12.07%).

**Database** — `supabase/migrations/20260608_workforce.sql` (APPLIED to Ops DB). 18 `wf_*` tables (`wf_staff`, `wf_roles`, `wf_sections`, `wf_venue_settings`, `wf_shifts`, `wf_timesheets`, `wf_holiday_accrual`, `wf_time_off`, `wf_availability`, `wf_tronc_runs`, `wf_tronc_lines`, `wf_documents`, `wf_sales_forecast`, `wf_user_roles`, `wf_audit`, `wf_swap_requests`, `wf_onboarding`, `wf_announcements`, `wf_doc_templates`). Later migrations add bank/holiday/pay-period columns + the wf-documents bucket (`20260609*`, `20260609b`). Key properties:
- **Real tenant RLS** (NOT "allow all"): location-scoped via `user_accessible_locations()`, PII (`wf_staff`) org-scoped via `user_accessible_orgs()` — anonymous kiosk/clock sessions get an empty fence and cannot read payroll/PII. Helpers are defined in this migration (self-sufficient) + super-admin bypass.
- Money is `numeric` + currency-stamped; pay **rate/source snapshotted** onto shifts/timesheets so historical pay is reproducible.
- `wf_audit` + `wf_holiday_accrual` are **append-only** (UPDATE/DELETE/TRUNCATE revoked from client roles; audit has a prev_hash/row_hash chain).
- FKs onto staff are `ON DELETE RESTRICT` + staff are **soft-deleted** (`status='leaver'`) — pay/compliance history is never destroyed. Composite `(…,org_id)` FKs prevent cross-tenant linking. Finalised tronc runs are immutable (trigger).

**Server-side compute** — `supabase/functions/workforce-compute` (DEPLOYED). Pay-critical maths never runs on the client. Actions: `tronc.run` (largest-remainder split of the pool by published-shift hours × role points, writes `wf_tronc_runs`+`wf_tronc_lines`+audit), `accrual.run` (12.07% of approved hours → `wf_holiday_accrual`), `pay.period` (per-staff pay from approved timesheets), `labour` (daily sales). Runs as service-role; enforces the tenant fence itself by checking the caller's location access.

**The flow:** add staff → "Set as POS user" (creates a till login in `staff_members`, links `wf_staff.pos_user_id`) → build & **publish** the rota → staff clock in/out on the Time Clock → approve timesheets → Pay + Tronc + holiday accrual compute from the approved hours.

---

## Time Clock surface — how it works

`src/surfaces/TimeClockSurface.jsx`, routed by `deviceMode === 'clock'` in `App.jsx` (after the device-pairing check; pairs like a POS). Selectable in `ModeSelector.jsx`. Full-screen PIN pad → status (clocked out / on shift since / on break) → **Clock in / Start break / End break / Clock out** with a confirmation, then auto-returns to the pad.

Punches are written **server-side** by `supabase/functions/workforce-clock` (DEPLOYED): it validates the entered PIN against `staff_members` for the device's location (PINs never reach the client — more secure than the POS PIN pad), maps to `wf_staff` (auto-creating a minimal HR record if the POS user has none), snapshots the pay rate at clock-in, tracks the in-progress break via `wf_timesheets.break_open_at`, and computes `actual_hours`/`variance`/`pay_amount` at clock-out. These timesheets are exactly what Workforce → Timesheets/Pay/Tronc consume.

---

## Surfaces / modes

`?mode=` → `pos` · `mpos` · `bar` · `tables` · `kds` · `kiosk` · `orders` · `customer-display` · `clock` · **`menuboard`** (digital menu board — pairs to a board via a code, or open `?board=<id>` directly) · **`owner`** (owner snapshot PWA — BO login, no device pairing) · `office` (Back Office) · `admin` (internal Company Admin). Customer web: `/online/:slug`, `/customer/*`, `/gift/*`, `/qr/*`, `/sign/<token>` (Workforce contract e-sign), **`/review`** (Review Manager customer card). Mode is chosen in `ModeSelector` and saved to `rpos-device-mode` (the owner app is URL-bookmarked, not a device tile).

---

## Two Supabase projects + key tables

| | Ops DB `tbetcegmszzotrwdtqhi` | Platform DB `yhzjgyrkyjabvhblqxzu` |
|---|---|---|
| Holds | POS operational data + **all edge functions** | orgs, users, loyalty, gift cards |
| Client | `supabase` (lib/supabase.js) | `platformSupabase` |

**Ops tables:** `menu_items/categories/menus`, `modifier_groups`, `active_sessions`, `closed_checks`, `floor_tables`, `config_pushes`, `stock_levels`, `eighty_six`, `locations`, `device_profiles`, `pos_devices`, `staff_members`, `user_profiles`, `user_locations`, `order_queue`, `tax_rates`, `discount_definitions`, the 18 **`wf_*`** Workforce tables, **`review_*`** (Review Manager incl. `review_settings`, `review_google_tokens`, `review_requests`), **`ryft_payments`** (reconciliation ledger), **`menu_boards`** (digital menu-board screens/content) + **`menu_board_screens`** (paired physical TVs; device-scoped RLS + claim/set/heartbeat RPCs). **Edge functions** (Deno): gift/loyalty/stripe/send-* + `workforce-compute` / `workforce-clock` / `workforce-onboarding` + **`trading-report`** (Daily P&L) + **`owner-snapshot`** (owner app) + **`review-*`** (review-admin/sync/reply/submit/request/google) + **`ryft-*`** / **`payments-*`** (dual-processor payments). All `verify_jwt=false` and enforce their own tenant fence. **Storage:** private `wf-documents` bucket + `receipt-assets` (review card backgrounds). SMS (Twilio) + email (Resend) configured. **Platform env (Ops project) secrets** include `GOOGLE_OAUTH_CLIENT_ID/_SECRET`, `RYFT_SECRET_KEY`, Stripe + Resend keys.

---

## Build / deploy

```bash
npm run dev        # mock mode locally (isMock; no Supabase)
npm run build      # MUST be clean before pushing
git add … && git commit && git push origin develop   # Vercel auto-deploys
```
Every deploy: bump `src/lib/version.js` + add a top-of-array `CHANGELOG` entry in `src/App.jsx`. Edge functions deploy via the Supabase CLI (`SUPABASE_ACCESS_TOKEN=<PAT> npx supabase functions deploy <name> --project-ref tbetcegmszzotrwdtqhi`) — native bundler, no Docker needed. DB migrations are applied via the Supabase Management API (`POST /v1/projects/<ref>/database/query`) or the dashboard SQL editor.

---

## Open items / outstanding TODOs

### 🔴 Time-sensitive — don't forget
1. **Google review-data API approval — PENDING.** Business Profile **v4** access request submitted **13 Jun 2026**, case **`1-2668000040500`**, Google quoted **~7–10 business days** (≈ **24–27 Jun 2026**). Until granted, OAuth/"Connect Google" works but review list/reply calls **403**. **CHECK around 24–27 Jun**: the approval email lands on the submitting account **peter@posup.co.uk** (and/or the support case). When approved → enable the now-ungated "Google My Business API" in the `servos-crm` project; reviews then flow. (Full state: memory `reference_google_review_oauth.md`.)
2. **Revoke the Supabase PAT** used 13 Jun to deploy `trading-report`/`owner-snapshot` and to apply the `menu_board_screens` migrations — https://supabase.com/dashboard/account/tokens → Revoke (unless more deploys are imminent). Lives only in `/tmp/sbtoken`; never commit it.

### Review Manager / Google — to go fully live
3. **Consent screen → External + Google verification** of the `business.manage` scope. It's currently **Internal** (serv-os.app Workspace), but the verified Business Profile (**POSUP**) sits on `peter@posup.co.uk` *outside* that org — so even *testing* the Connect flow needs **External + Testing mode + peter@posup.co.uk added as a Test user**. Full verification removes the "unverified app" warning so any external venue can connect.
4. **TheFork + Trustpilot OAuth** connect flows (currently stubbed in `_shared/review-platforms.ts`). Rule: only surface a platform once a real connect exists.
5. **Review ask-engine cron** — schedule `review-request scan_all` (~every 15 min) so post-visit SMS asks fire automatically (manual run-now works today).

### Stock / inventory — deferred by user (memory `project_post_launch_tasks.md`)
6. **Finish the stock system, starting with `cost_price` on `menu_items`** (none today). Unlocks **real COGS** in Daily trading (P&L) + owner app (currently an estimated flat %). Thread via the 3 standard spots (db.js item upsert, store save path, SyncBridge mapping) + a MenuManager cost field.

### Reporting / owner app — polish
7. Owner app: optional "View on phone" QR in Back Office; deeper drill-downs.
8. Daily trading: surface a per-day **service charge / tips** line (tracked, not yet shown); CSV export.

### Menu board — built & live; still open
8a. **Pagination / auto-rotate** for menus too long for one screen, and/or **rotate between multiple boards** on one screen (e.g. food → drinks → promo).
8b. **Dayparting / scheduling** — auto-switch board by time of day (breakfast → lunch → dinner → marketing at close).
8c. **Fire TV / Android-TV APK flavor** (`menuboard` product flavor in `android/AUTO_UPDATE_PLAN.md`) + sideload guide, so it runs as a real installed app that boots straight to `?mode=menuboard`. *(The web surface + pairing are done; this is the device packaging.)*
8d. **Display hardening** — overscan safe-margins, nightly reload, burn-in mitigation for 24/7 screens.
8e. *(optional)* Rate-limit / lockout on `claim_menu_board_screen` — entropy (~39-bit) + 30-min TTL already make brute-force infeasible; a per-caller throttle is belt-and-braces, deferred.

### Workforce — still open from the prior block
9. **Workforce → Dashboard** legacy tiles → wire to live rota/sales.
10. **"Who's on shift now"** live view + optional clock-in shortcut on the POS PIN screen.
11. **UK vs US tip distribution** — offer the UK Tronc (hours × points) method inside the Tips *report* for UK venues (report is US-model; Workforce → Tronc is UK).
12. Swap-request approvals + announcements SMS (publish-rota SMS is live).

### Platform / infra — post-launch (memory `project_post_launch_tasks.md`)
13. **Apple Pay / Google Pay wallets** on online ordering (`<PaymentElement>` + per-venue Apple Pay domain verification).
14. Android self-update → production signing/CI (`android/AUTO_UPDATE_PLAN.md`). *(Menu Board web surface + pairing now built — see items 8a–8d; the Android `menuboard` flavor is 8c.)*
15. Multi-currency tail (denomination sets), bar-tab pre-auth refinements, `resolveCompanyForLocation` dedup, code-split bundles, commit `send-sms` source.

## Ops / secrets note
A Supabase **Personal Access Token** was used 13 Jun 2026 to deploy `trading-report` + `owner-snapshot` (written to `/tmp/sbtoken`, NOT committed). **Revoke it** once no more deploys are pending (item 2). `GOOGLE_OAUTH_CLIENT_ID/_SECRET`, `RYFT_SECRET_KEY`, Stripe + Resend keys live **only** in the Ops project's Edge Function secrets — never repo/bundle. Vercel env holds the real `VITE_SUPABASE_*`; `.env.local` is placeholders (mock).
