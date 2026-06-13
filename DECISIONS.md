# DECISIONS.md — Architectural Decision Records

Short ADR entries for non-obvious choices in the codebase.

---

## ADR-001: Single Zustand Store for All State

**Context:** Multi-surface app (POS, Bar, KDS, Back Office) with shared state (tables, menu, sessions, 86 list, etc.).

**Decision:** One flat Zustand store (`src/store/index.js`) shared across all surfaces via `useStore()`.

**Consequences:** Simple cross-surface access; large file (~4500 lines); no selector memoisation discipline required but store updates re-render all subscribers.

---

## ADR-002: Two Supabase Projects (Ops DB + Platform DB)

**Context:** Need to separate POS operational data from company/user management to allow multi-tenancy and independent scaling.

**Decision:** Ops DB (`tbetcegmszzotrwdtqhi`) holds all POS data scoped by `location_id`. Platform DB (`yhzjgyrkyjabvhblqxzu`) holds orgs, users, billing, gift cards, loyalty.

**Consequences:** Two clients in `lib/supabase.js`; joins across projects not possible at DB level; all cross-project logic is in application code. Edge functions use `platformAdmin` (service-role) to access Platform DB.

---

## ADR-003: `loc-demo` as Mock Sentinel (Not Null)

**Context:** `LOCATION_ID` needs a default value. Empty string would be falsy and break URL construction; null would be falsy.

**Decision:** `LOCATION_ID = 'loc-demo'` exported from `supabase.js` as a truthy sentinel for mock/dev mode.

**Consequences:** **Critical gotcha** — all db functions must check `=== 'loc-demo'` not just falsy. Any function that forgets this will silently write to a non-existent location. See INVARIANTS.md.

---

## ADR-004: Config Push Architecture (Back Office → POS)

**Context:** POS devices (Sunmi terminals) need to receive menu/config updates from back office without a page reload.

**Decision:** Back office writes a `config_pushes` snapshot to Supabase. POS loads latest snapshot at boot AND listens for new pushes via Realtime. `SyncBridge.jsx` handles both paths.

**Consequences:** POS always has a config snapshot from the last push. Changes to categories/menus/items require a manual "Push to POS" from back office. Quick Screen and session data load separately (direct Supabase query, not config push).

---

## ADR-005: BroadcastChannel for Same-Machine Multi-Tab Sync

**Context:** Multiple browser tabs on the same machine (e.g., dev testing) need to share operational state (tables, 86 list, KDS tickets).

**Decision:** `SyncBridge.jsx` uses `BroadcastChannel` to sync `SHARED_KEYS` state between tabs on the same origin.

**Consequences:** Same-machine tabs stay in sync instantly. Cross-device sync relies on Supabase Realtime + `SessionSync.js` + `SessionReconciler.js` (10s poll fallback).

---

## ADR-006: Session Sync — Write on Item Add, Reconcile Every 10s

**Context:** Table sessions (open orders) must be visible on all devices in real-time.

**Decision:** `SessionSync.js` writes to `active_sessions` on any meaningful state change (item add/remove, open/close, covers, voids, discounts, notes). `SessionReconciler.js` polls every 10s and reconciles via full session comparison (Supabase wins for non-active tables).

**Consequences:** Near-real-time cross-device session visibility. Reconciler won't overwrite the `activeTableId` (currently being edited) to avoid clobbering work in progress. DELETE events have seatedAt timestamp guards and 3-second grace period.

---

## ADR-007: Spacers as Category Metadata, Not Menu Items

**Context:** Operators want to add blank grid cells between POS buttons to improve visual layout.

**Decision:** Spacers are stored as `spacerSlots: [{id, sortOrder}]` on `menu_categories.spacer_slots` (jsonb column). They're merged with real items at render time by `sortOrder`. They are NOT menu items — no `menu_items` rows created.

**Consequences:** Zero data model complexity; spacers don't appear in search, allergen filters, or item counts; they survive Push to POS because category data is included in config snapshots.

---

## ADR-008: Static Imports Only in Bundled Code

**Context:** Dynamic `import('../lib/db.js').then(...)` was used inside event handlers to lazy-load the db module.

**Decision:** All imports must be static (top-level `import` statements) in any file that's part of the Vite bundle.

**Consequences:** Vite correctly tree-shakes and chunks static imports. Dynamic imports inside callbacks silently fail in the production bundle (the Promise never resolves, no error thrown). This caused multiple data-loss bugs before being identified.

---

## ADR-009: Version String as Single Source of Truth

**Context:** Version badge appears in POS header, back office header, and What's New modal.

**Decision:** `src/lib/version.js` exports `VERSION`. `App.jsx` imports it and uses it for all display. `CHANGELOG` array in `App.jsx` is the in-app changelog. Also exposed as `window.RPOS_VERSION` for Sunmi APK diagnostics.

**Consequences:** Every deploy requires updating `version.js` AND adding a `CHANGELOG` entry. Forgetting either makes the version badge stale.

---

## ADR-010: No TypeScript, No Tests

**Context:** Rapid iteration speed was prioritised; project started as a prototype.

**Decision:** Plain JavaScript with JSDoc comments where helpful. No unit or integration tests.

**Consequences:** Must verify correctness manually. Type errors only surface at runtime. `npm run build` is the only automated check — run it before every deploy.

---

## ADR-011: Anonymous Auth for Kiosk and Online Ordering

**Context:** Kiosk and online surfaces are customer-facing — no user account exists. Edge functions need a valid Supabase auth token.

**Decision:** Kiosk and online surfaces call `signInAnonymously()` to get an auth session. Edge functions accept both authenticated and anonymous callers. Company resolution for anonymous callers falls back to `resolveCompanyForLocation()` which looks up `company_id` from the `locations` table via Platform DB.

**Consequences:** No user_company_roles row for anonymous sessions — can't use the standard role-based company lookup. Every edge function that needs `company_id` must call `resolveCompanyForLocation(userId, locationId)` with the location_id fallback path.

---

## ADR-012: Gift Card HMAC Lookup with Multi-Tier Fallback

**Context:** Gift card codes must be securely searchable without storing plaintext. But HMAC secrets can rotate, and imported cards may not have matching HMACs.

**Decision:** Gift card codes are hashed via HMAC-SHA256 with a per-org secret and stored in `code_lookup`. The `gift-redeem` edge function tries three lookup paths: (1) HMAC lookup, (2) `card_id` direct, (3) `code_plain` fallback.

**Consequences:** Secure by default, but resilient to secret rotation and data imports. Diagnostic logging on each fallback for debugging.

---

## ADR-013: Stock Decrement at Different Layers

**Context:** Three ordering surfaces (POS, kiosk, online) all need to decrement stock, but they have different state management approaches.

**Decision:** POS decrements via Zustand store action (`addItem` → `decrementDailyCount`) which does optimistic local update + RPC call. Kiosk and online bypass the store and call `decrementStockRPC()` directly after successful order submission.

**Consequences:** POS gets instant local feedback. Kiosk/online decrement slightly later (after order confirmed). All three paths call the same atomic `decrement_stock` Postgres RPC, so race conditions are handled at the DB level.

---

## ADR-014: Redundant 86 Signals for Kiosk Reliability

**Context:** Kiosk may miss `eighty_six` Realtime INSERT events if a WebSocket drops during sleep/wake or network reconnect.

**Decision:** Three independent 86 signal sources: (1) `eighty_six` table Realtime subscription, (2) `stock_levels` remaining ≤ 0 auto-adds to `eightySixIds`, (3) 30-second periodic re-fetch of `eighty_six` table. The kiosk `is86` check uses all three.

**Consequences:** Any single signal source failing doesn't leave items available when they shouldn't be. The 30s poll is a lightweight single-column query. Modifier options also resolve 86 status via name-matching when `itemId` isn't explicitly linked.

---

## ADR-015: Edge Functions via Supabase Dashboard (Not CLI)

**Context:** Supabase CLI requires `SUPABASE_ACCESS_TOKEN` environment variable which is not set in the development environment.

**Decision:** Deploy edge functions via the Supabase dashboard Code editor. The code is maintained in `supabase/functions/` in git and copy-pasted to the dashboard for deployment.

**Consequences:** Slightly manual deployment process. Code in git may drift from deployed version if someone forgets to deploy. The Monaco editor in the dashboard can be automated via `window.monaco.editor.getEditors()[0].setValue(code)`.

**SUPERSEDED by ADR-016.**

---

## ADR-016: Edge Function Deploy via Supabase CLI + PAT (supersedes ADR-015)

**Context:** Dashboard / Management-API deploys ship a single file body and do NOT bundle `_shared/` imports — silently breaking functions that import shared utils. Dashboard tokens also expire mid-session.

**Decision:** Deploy with the Supabase CLI authenticated by a Personal Access Token:
`SUPABASE_ACCESS_TOKEN=… npx --yes supabase functions deploy <name> --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt`. The CLI bundles `_shared/` correctly. The user supplies the PAT on request.

**Consequences:** Reliable deploys that include shared deps. Smoke-test each deploy with an unauth `curl` (expect 401/405, not 500 — proves imports resolve). `supabase/.temp` is gitignored. NOTE: some deployed functions' source isn't committed (e.g. `send-sms`) — reconcile before treating git as the source of truth.

---

## ADR-017: Multi-Currency — Per-Location, `money()` Helper, Two-Column Model

**Context:** Currency was hardcoded `£` / `'gbp'` across ~675 sites. Needed GBP/USD/EUR to demonstrate multi-market capability without destabilising the GBP launch customer.

**Decision:**
- Currency is set **per location** (not org-level — a single org may span markets). Chosen at location creation and editable in Location Settings; options are exactly GBP/USD/EUR, rendered from the single `CURRENCIES` map in `lib/currency.js`.
- All money formatting goes through `money()` / `currencySymbol()` / `stripeCurrency()`. `money(n)` returns exactly the old `£${n.toFixed(2)}` for GBP, so the codebase-wide sweep is a **no-op for GBP** and only changes symbol/code for USD/EUR.
- Currency lives on BOTH `locations.currency` columns: **Ops = creation seed**, **Platform = authoritative** for the running app. `provision-location` copies Ops→Platform on INSERT only (never on re-provision, so it can't clobber a Location Settings edit). The app reads the Platform value (`locationTime.getLocationConfig` for POS/kiosk, `CustomerBoot`/`lookupLocationBySlug` for online/QR/gift/portal) and caches it in `localStorage['rpos-active-currency']` for synchronous `money()` resolution.

**Consequences:** Adding a currency means updating only `CURRENCIES` (+ allowing it in `stripe-create-payment-intent`). Known limits left for later: cash-drawer denomination *sets* and platform billing tiers stay GBP. `money()` reads localStorage per call (cheap); a brand-new non-GBP device may flash GBP once before the value persists.

---

## ADR-018: Workforce Module — Real RLS + Server-Side Pay Compute

**Context:** Workforce (rota/timesheets/tronc/pay/holiday) touches live financials. The app's existing pattern often used permissive "allow all" RLS with an app-layer fence, and computed money client-side. Neither is acceptable for payroll, especially because POS/kiosk/clock devices authenticate **anonymously** (a real `authenticated` Postgres role with no `user_locations` rows).

**Decision:**
- **Real tenant RLS on every `wf_*` table** using the project's `user_accessible_locations()` (location-scoped) and `user_accessible_orgs()` (PII, `wf_staff`) helpers — defined in `supabase/migrations/20260608_workforce.sql` so it's self-sufficient. Anonymous sessions get an empty fence → cannot read payroll/PII.
- **Pay-critical maths is server-side** (`workforce-compute` edge fn, service-role): tronc (largest-remainder, penny-exact), holiday accrual (12.07%), period pay. The client only displays. Anonymous **clock** punches go through `workforce-clock` (validates PIN server-side, writes `wf_timesheets`).
- **Money integrity:** `numeric` + currency-stamped everywhere; effective rate + source snapshotted onto shifts/timesheets; FKs onto staff are `ON DELETE RESTRICT` + soft-delete (`status='leaver'`); `wf_audit` + `wf_holiday_accrual` append-only (UPDATE/DELETE/TRUNCATE revoked from client roles; audit hash-chained); finalised tronc runs immutable (trigger); composite `(…, org_id)` FKs prevent cross-tenant linking.

**Consequences:** Two new edge functions to maintain; clients must call them rather than writing money rows. Migration was validated with a transactional dry-run + per-table column-insert test before applying, and the wf_ RLS depends on the helper functions existing (now created by the migration itself). Decided server-side compute over client maths per the operator: "linked to live financials, needs to be 100% correct."

---

## ADR-019: Daily Trading (P&L) — forecast that learns, VAT broken out, COGS as settings

**Context:** Owners wanted a "real-life holistic" daily P&L: set a forecast per day that learns from history, then see theoretical vs actual costs against real sales. The system has real **sales** (`closed_checks`) and real **labour** (rota `wf_shifts.computed_cost` + actual `wf_timesheets`), but **no per-item cost** (`menu_items` has no `cost_price`) and no overhead config.

**Decision:**
- Computed server-side by the **`trading-report`** edge fn (reuses the tenant-fence pattern; `verify_jwt=false`, validates `user_locations`/super_admin). Per-day rows + period totals.
- **Forecast** is operator-set (`wf_sales_forecast`, net target) with a **"same weekday last year"** suggestion learned from `closed_checks` (date − 364 days = same weekday). Treated as a **net** figure.
- **VAT is broken out and is never profit.** Ladder: gross takings (inc VAT) → **less VAT** → net sales (ex-VAT) → less COGS → gross profit → less labour → less overhead → operating profit. VAT comes from `closed_checks.tax_amount` (fallback `max(0, total − net − service − tip)` for pre-v4.6.19 checks). **Gross = net + VAT** — deliberately NOT the `total` column, which is unreliable in real data (observed `total` < `subtotal`). Net sales (subtotal, ex-VAT) is the P&L revenue basis.
- **COGS % + daily overhead are operator estimates** stored in `wf_venue_settings.settings` jsonb (`cogs_pct`, `daily_overhead`) — **no schema migration**. Applied to both forecast (theoretical) and actuals.

**Consequences:** COGS is an estimate until the stock system adds `cost_price` to items (then derive real COGS from `closed_checks.items` × cost; keep the flat-% as fallback). Labour shows theoretical (rota) vs actual (approved/paid timesheets), bucketed by venue tz. The same engine feeds the Owner app (`owner-snapshot`).

---

## ADR-020: Review Manager — de-gated, real-API-only, one-time platform Google OAuth

**Context:** A design handoff proposed routing happy guests to public review sites and unhappy ones to a private form ("review gating"). That is now **illegal** (UK DMCC Act 2024; US FTC Consumer Reviews Rule, Oct 2024). Also, of the many review platforms, only a few expose real read+reply APIs.

**Decision:**
- **No review-gating.** Every guest always sees the public review path; the private feedback option is additive, never a diversion. Built INTO RPOS (Back Office → Customers → Reviews), reusing comms/CRM/Claude/multi-tenancy.
- **Only surface a platform we can genuinely connect to.** Google has a live read+reply path; TheFork/Trustpilot are stubbed until OAuth is built; everything else (Yelp/Facebook/TripAdvisor/delivery apps) is excluded.
- **Google uses ONE platform OAuth client** ("ServOS Reviews", in the `servos-crm` Google Cloud project), not one per customer — each venue just clicks **Connect Google** (`review-google` flow, refresh tokens stored server-side in `review_google_tokens`, hijack-guarded). Client secret lives **only** in Supabase env (`GOOGLE_OAUTH_CLIENT_ID/_SECRET`).
- **Audience starts Internal, goes External + verified at launch.** Internal (serv-os.app Workspace) needs no verification but only org accounts can connect; real external venues require the consent screen switched to **External** + Google verification of the sensitive `business.manage` scope. Review **data** (v4 API) is separately access-gated by Google (~1–2 week approval).

**Consequences:** The reviews feature ships connect-ready but review data flows only after Google's v4 approval. Per-venue setup is just a sign-in. Full operational state is tracked in memory `reference_google_review_oauth.md`.
