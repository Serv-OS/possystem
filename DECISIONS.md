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

---

## ADR-021: Digital Menu Board — fill-by-explicit-columns, and device pairing via a dedicated table

**Context:** A digital menu board for TVs / Android-TV sticks needs to (a) always fill exactly one screen with no clipping and no half-empty gaps across wildly different menu sizes and screen resolutions, and (b) be assignable to a physical screen by non-technical staff without copying URLs per device — in a multi-tenant system where the device is unauthenticated hardware.

**Decision:**
- **Layout = explicit integer column count + `column-fill:auto`, font binary-searched to fill.** Columns fill top-to-bottom (a column breaks only when full); the root font grows until content just fills the chosen columns. We deliberately do **not** use `column-width:auto` (browser-chosen count) — Chromium clips overflow from an auto count *without* growing `scrollWidth`/`scrollHeight`, so the fit check can't see it and large text runs off-screen. With a fixed count, overflow creates a real extra column that `scrollWidth` reports, so the fit is reliable. "Text size" maps to the column count (more columns = larger fill type), since when filling a fixed area, fewer columns ⇒ *smaller* type — so a naïve font multiplier either overflows or underfills.
- **Pairing = a dedicated `menu_board_screens` table, not an overload of `pos_devices`.** A device self-registers an unclaimed row (`device_uid` defaults to `auth.uid()` from its anon session) and shows a high-entropy code; the operator claims it by code in Back Office. Chosen over reusing device pairing because a menu board isn't a till and needs its own lifecycle (unpaired → paired → reassign/unpair) and looser auth (anon, read-only).
- **Security is RLS + SECURITY DEFINER RPCs, no edge function.** A device can SELECT/heartbeat only its own row (`device_uid = auth.uid()`); Back Office sees only its venue's screens; there is **no UPDATE policy** — `claim`/`set`/`heartbeat` are SECURITY DEFINER functions that validate location access and always set `location_id` from the chosen board (never device-supplied). So pairing codes aren't enumerable cross-tenant and a device can never write its own `location_id`/`board_id`. After an adversarial RLS review, codes were raised to ~39-bit (8-char unambiguous) and `claim` gained a 30-min TTL to stop pre-claiming abandoned codes.

**Consequences:** One web surface (`?mode=menuboard`) serves both a direct `?board=<id>` link and the paired-device flow; the Android `menuboard` flavor (still to build) just boots to `?mode=menuboard`. Reviewed-and-confirmed multi-tenant-safe; the only deferred hardening is an optional per-caller rate-limit on `claim` (entropy+TTL already make brute-force infeasible). Spec: `MENU_BOARD_PLAN.md`; migrations `20260613_menu_boards.sql` + `20260614*_menu_board_screens*.sql`.

---

## ADR-022: Delete the standalone Items library (`sections/Items.jsx`) — MenuManager's Items tab is the one item editor

**Context:** `src/backoffice/sections/Items.jsx` (v4.6.1, ~950 lines) was built as a dedicated "Items library" meant to replace the item-management surface inside MenuManager, pending sign-off that never came. It was never wired into `BackOfficeApp.jsx` — nothing imported it, so it shipped as unreachable dead code for ~1,000 versions while MenuManager's own `ItemsLibrary` tab kept receiving all item-editor investment (sizes/variants, spacers, pizza, combo, instruction groups, visibility toggles, 86 toggle, duplicate-name guard). Its one distinctive feature — ownership scope (local/shared/global) — was absorbed into MenuManager's item editor in v4.6.3. Its latent archive/restore and partial-save DB-write bugs were fixed in v5.5.801, so mounting it was *safe* — the question was whether it was *useful*.

**Decision:** Delete it (v5.5.806, owner-confirmed 18 Jul 2026). Do not mount a second item editor. MenuManager's Items tab (`ItemsLibrary` in `MenuManager.jsx`) is the single item-management surface.

**Consequences:** One write path and one UI for item edits — avoids a UI-level "two save paths" divergence (the same failure mode as the `sbUpsertCategory`/`upsertMenuItem` gotcha). If a simpler, focused item-library UX is wanted later (the original food-hall pitch), build it against the current editor/feature set rather than resurrecting the v4.6 file (recoverable from git history before v5.5.806 if ever needed).

---

## ADR-023: An ezCater order IS a catering order (one rule set, shared by app and edge functions)

**Context:** 18 Sep 2026, Peter placed a live ezCater test order (HKX77V). It landed as a live 'prep' order with sent_at = the delivery time, on the caterer's US clock, went into every till's live queue days early, never reached the Back Office advance list, and order-notify sent OUR confirmation to ezCater's customer. Every catering rule in the code was written as `source === 'catering'`. Peter: "we need to ensure they follow the same rules as the rest of our catering system where they hit the POS at the right times and parameters set to fire into the kitchen as our own catering orders".

**Decision:** One rule set, `supabase/functions/_shared/cateringRules.js` (pure JS, re-exported by `src/lib/cateringRules.js`), imported by the app AND the edge functions: `CATERING_SOURCES = ['catering','ezcater']`, the venue clock (`wallTimeToInstantMs`, `venueWallClock`), the ONE fire rule (`cateringFireMs` = food ready time minus `catering_site_settings.prep_time_minutes`), the release gates, and the two things we never do for ezCater (`mayBookOurCourier`, `mayMessageCustomer`). The webhook writes an ezCater order exactly as CateringCheckout writes one: status 'received', venue date and time, sent_at = kitchen fire time, kitchen_routed_at left for the release. ezCater's "ready" time is `event.catererHandoffFoodTime` (documented as when the caterer must be ready to hand food to the customer or delivery partner), else `event.timestamp`. Changes after the kitchen has the order never move it; they are stamped on `customer.changedAfterFire` and alerted (`_shared/ezcaterCatering.js`). The channel stays visible everywhere as "ezCater".

**Consequences:** A new catering channel is one entry in `CATERING_SOURCES`, not a hunt for string compares (`cateringRules.test.js` fails on any new `source === 'catering'` in the covered files). An ezCater order not yet accepted in ezCater is held and visible, never fired. Order screen TVs need `20260918_OPS_ezcater_catering_order_screens.sql` (Peter runs it) to drop the two old ezCater exceptions.

**Round 2 (same day, review):** one write path for every ezCater answer, `_shared/ezcaterIngest.ts` (webhook, pre fire check, staff re-sync). (1) An uncancel then accept RESTORES a cancelled unfired order with a fresh fire time (a past one becomes now); after firing it is only flagged. (2) ezCater's Order schema has NO field linking a replacement to its original and sends no notification for the original, so a likely replacement makes us re-ask ezCater about the original at once, and every ezCater order is re-asked right before it fires (`prefireCheck`, 4 s timeout). ezCater's answer about that order decides; no answer NEVER blocks the kitchen (fire as planned, flagged `customer.ezcaterCheck`). The till cannot hold the token, so its release calls `ezcater-connect` action `prefire`; the kitchen_routed_at claim stays where it was. (3) No catering prep time set means a 60 minute fallback (`EZ_PREP_FALLBACK_MINUTES`), warned on the Connect screen and on each order, never 0. (4) Staff "Re-sync from ezCater" (Orders Hub, Back Office advance list): Back Office staff rule, or a till of the venue plus a staff PIN (`_shared/staffAuthority.ts`); never moves a fired order. (5) A plan for an unfired row is written only while kitchen_routed_at is null, else re-planned as fired; a time change after firing is judged against the order's own last ezCater times, not sent_at; capacity counts ezCater by count and by value only in the venue currency. Neither ServOS catering nor ezCater adds drive time for the caterer's own fleet: both fire at ready time minus prep.

**Round 3 (same day, review):** (A) Only a CANCEL is terminal (`EZ_DEAD`). A rejected new order is followed by ezCater's own cancelled; a rejected MODIFICATION sends nothing more and the accepted order stands (`ezEffectiveLifecycle`: it stays accepted, flagged `modificationRejected`). `replacedBy` is written only when ezCater says the original is cancelled and is not sticky: a later live answer revives an unfired original, staff can Undo (`undo_replacement`), and a fired replaced order stays cancelled with no uncancelled flag. (B) Every write to an existing order_queue row is guarded on `updated_at` (bumped by `trg_order_queue_updated_at` on every update) and replanned from a fresh read; flags patch only their own keys (`guardedUpdate`, `patchCustomer`). (C, D) The catering-release cron re-asks upcoming ezCater orders on a schedule (every 15 min for the next 4 h, held ones included; daily for the week ahead), re-times unfired orders when the venue prep time changes (also on Catering settings save), fires a fire time now in the past at once and flags it `lateFire`, and flags a held order still not accepted near its fire time (`unacceptedAlert`, a till alert). (E) Both kitchen_routed_at claims also require a releasable status in the same UPDATE (`UNCLAIMABLE_STATUSES_PG` plus `releasableOrFilter`); the Orders Hub fires catering only through `releaseCateringOrderNow`. (F) Staff means super_admin, user_locations or a granting company role, never user_profiles.location_id; an ezCater token is only ever the caterer's own connection, and connections are fenced by company. (G) The cron's re-asks run in parallel inside one time budget (`_shared/budget.js`); unreached orders fire unchecked, flagged. review-request never texts an ezCater customer.

**Round 4 (same day, review; the rule: where new automatic behaviour caused a bug, remove or narrow it; the bar is the kitchen gets an order exactly once, on time, printed):** (1) The cron's prep sweep is REMOVED: a failed `catering_site_settings` read looked like "no prep set" and re-timed every unfired order to the 60 minute fallback. Re-time on a prep change happens only on a staff save (`recompute_prep`), only with a successfully read, explicitly set prep (`readCateringVenue.prepReadOk`); any other write of an existing order uses the order's own prep and clock when a read failed (`venueForExisting`). (2) catering-release is a BACKSTOP again: it fires only its grace window query (unclaimed rows 3+ minutes past), exactly as before this branch. A re-ask may move sent_at; the till's release fires it, printed and routed to production centres. (3) Every ezCater answer is stamped on the row (`customer.ezcaterAnswer`: when its read began and came back). An answer whose read began before the row's answer came back is never written (`answerOlderThanRow`): it is read again from ezCater, or dropped; so a cancel written while a pre fire check matched items cannot be undone. Tills write ONLY `status` and `staff` on an ezCater row, as an update, never onto a cancelled row (`src/lib/ezcaterTillWrite.js`); the lifecycle, times and customer jsonb are the server's. (4) A HELD order keeps its real fire moment in sent_at (no rewrite to now); the re-ask batch reads wide and picks fairly per venue, released orders first (`pickRecheckBatch`). (5) SENT LATE only when a change moved the fire moment earlier into the past (`lateFirePlan({ fireAt, prevFireAt })`), never for a routine or backstop fire, never for a new order. (6) The unchecked flag is written inside the fire budget; `connectionForLocation` filters by company in the query (`_shared/ezcaterConnections.ts`); `connect_token` refuses (503) rather than store company_id null on a failed lookup; the pre fire answer carries no contact details (`prefireRowForTill`, merged over the till's own row); staff can **Send anyway** a held order (`send_anyway`, staff fence, `customer.sendAnyway = { at, by, byName }`, a cancel still wins).

**Round 5 (same day, review; fixes kept narrow):** (1) order_queue rows whose source is catering or ezcater are SERVER OWNED. A till may drop one from its own memory (held, moved later, cancelled before firing) but never deletes it: the QueueSync flush remembers server owned refs and never queues a delete for them, a collected one is written as its status instead, `removeFromQueue` is local only for them, and every till delete statement (flush, removeFromQueue, offline replay) carries `tillDeletableOrFilter()` so even a ref whose source the till never saw is safe. Migration `20260918d_OPS_ezcater_server_owned_rows.sql` makes the database skip a delete of such a row by the anon or authenticated role, for tills still on older code. (2) No re-creation: `ezcater_order_links` records `kitchen_fired_at`, `queue_status` and `queue_gone_at` (trigger in 20260918d); a notification for an order whose row is gone follows `goneOrderPlan`: fired or finished is not written again, cancelled comes back cancelled, a link from before 20260918d comes back marked as already sent with a warning for staff, and only a link that proves the kitchen never had it is written as unfired. (3) A held order accepted after its fire moment fires now and is flagged late (`lateFire.reason = 'accepted_late'`, "accepted on ezCater 40 minutes after it was due in the kitchen"). (4) A re-ask (or a staff prep save) never moves a released, due, unfired order's sent_at later (`keepDueFireMoment`), so the catering-release backstop fires it in the same run.
