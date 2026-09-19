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

## ADR-023: ezCater orders are filed as ServOS catering orders (v1, the simpler version)

**Context:** Peter's live ezCater test order HKX77V (18 Sep 2026) never reached the Back Office advance list or the till: it was written as `source 'ezcater'`, status `prep`, with `sent_at` = the delivery time, and every catering path (advance list, till release, catering-release cron, QueueSync's future catering test) keys on `source 'catering'`. A branch that taught every path about a second catering source (`fix/ezcater-catering-rules`) went through five review rounds and kept finding edge cases in the till queue code. Peter chose the simpler version.

**Decision:**
- The ezCater webhook writes `order_queue` in exactly the shape `CateringCheckout.jsx` writes: `source 'catering'`, status `received`, `event_date` and `collection_time` on the venue clock, `sent_at` = the kitchen fire time from `supabase/functions/_shared/cateringRules.js` (moved out of the checkout verbatim) with the venue's catering prep time, `kitchen_routed_at` null, `paid` true. It is marked only by `customer.channel = 'ezcater'` plus the ezCater order id and number (`_shared/ezcaterCatering.js`).
- The only differences, all keyed on `customer.channel`: no order-notify messages, no ServOS courier, no review ask, never unpaid, never refunded through our processors, and an order ezCater has not accepted is held (`customer.ezcater_awaiting_acceptance`, which the two release queries filter on) and shown as "Awaiting ezCater acceptance".
- Cancels and changes: cancelled sets status `cancelled` (before or after firing; after firing staff get a plain flag). A change before firing replaces items, times and totals in place; after firing the row is left alone and staff are flagged "Changed on ezCater after it went to the kitchen: see ezCater". A rejected modification is not a cancel.
- A venue with no catering prep time set gets a 60 minute fallback, flagged on the order (`customer.prep_fallback`).

**Deliberately left out of v1:** scheduled re-asks of ezCater, a re-check of the order just before it fires (ezCater recommends one), and detection of "cancelled for replacement" orders (ezCater sends no notification for the original). If ezCater replaces an order, the original stays in our queue until staff cancel it. Also not changed: the order screen (TV) SQL, so an ezCater order shows there as a catering order.

**Consequences:** No new catering path. There IS one queue code change: the kitchen claim in `routeKioskOrderPrints` (`src/store/index.js`) now refuses a cancelled row for every source, not only ezCater, and a collected row too (``.or(`status.is.null,status.not.in.${NOT_RELEASABLE_STATUSES_PG}`)``, the same `(collected,cancelled)` the release reads exclude; the `catering-release` cron claim uses `.not('status', 'in', NOT_RELEASABLE_STATUSES_PG)`), so a cancel, or staff marking it collected, that lands between a release's read and its claim never reaches the kitchen. Nothing else is cancelled or collected before it is routed today, so every other order behaves as before; a row with no status still claims, and a forced re-send from the Orders Hub goes on without the claim as it always did. The row written before this change (HKX77V, `source 'ezcater'`) is left exactly as it is by the webhook; staff cancel it by hand.

**Review round (18 Sep 2026):**
- A finished order is never brought back: when `ezcater_order_links` already knows the order and there is no queue row (staff collected or removed it), a later notification writes nothing. A new order has no link until after its first write, so it still inserts.
- An ezCater order cancelled AFTER it went to the kitchen raises the same red cancel popup and chime a HubRise cancel does (`channelCancelAlert`). HubRise is unchanged.
- An ezCater order still awaiting acceptance when its fire time passes gets one urgent activity entry from the catering-release cron, stamped once per order (`customer.ezcater_hold_alerted_at`).
- The webhook no longer writes its own "new order" activity entry; the `order_queue_activity` trigger already logs every insert, as "Catering order". Showing "ezCater" there would need SQL, so it was left.
- Release steps: `docs/EZCATER_V1_RELEASE.md`. ezCater sales are not written to `closed_checks`, so they are in no sales report (older than this work, not fixed here).

---

## ADR-024: ezCater menu sync, the conservative version (v1)

**Context:** Peter (18 Sep 2026) wants ezCater items matched BEFORE any order, not pasted by hand and not left to ezCater's menu team. The connected token can read menus (proven live, read only). The full sync on `feat/ezcater-menu-sync` routed wrong sizes and wrong items in review. Peter chose the simpler version.

**Decision:**
- "Sync ezCater menu" (staff only, Item matching card) and a daily sync (pg_cron hourly, a venue is due after 20 hours without a good sync) read the CURRENT menus (venue date) of every caterer mapped to the venue and write `ezcater_item_links` rows with their published ids (`ez_ids`): one row per plain item, one row per SIZE of a multi size item (key `<item>|size:<size>`, `ez_size_name` set), one row per option value when ezCater lets us read values. New rows are not yet ordered (`seen_count` 0). A sync never deletes a row, never changes a decision and never touches `seen_count`; a second sync inserts nothing.
- Auto links: EXACT means exact. The full ezCater name (item plus its size) must equal exactly one of our item names after only case, accents, whitespace and punctuation are folded (`exactName`); nothing else is dropped, so any size or container word ("Large", "Tray", "Box", "Serves 10") on one side only means no auto link. A single size item's only size takes part like a multi size item's sizes do; the one allowance is a size name whose every word the item name already says ("Italian Boxed Lunch" with its only size "Box", Box folded with Boxed), which adds nothing. So "Turkey Sandwich" sold only as a Box is not our plain "Turkey Sandwich": a Box and a Tray of the same food are different products. A size row also needs its size to be its own (not shared with a sibling). Options: exactly one of our options with the same exact name. Everything else waits for staff with suggestions.
- Order time: a line resolves to a synced size row ONLY when its published size id is on that row and the row has a decision. A plain single size item (size id on a plain row, or no size on the line) resolves by name as before. ANY other sized line stays unmatched and prints by name. Before migration 20260919m runs, nothing changes.
- Published ids are only ever ADDED to a row (new first, the old kept), complete read or not, so an order placed before a republish still matches when ezCater sends a change to it. Ids are UUIDs; if one ever sat on two rows the order time checks answer unmatched. A current menu that comes back null makes the read partial.
- Order time matches on the line's SIZE id only (the order's `menuItemSizeId` IS the menu's `sizes.id`, proven on HKX77V, 18 Sep 2026); the order's item id is never the menu's item id and is never matched.
- A failed link read never falls back to name guessing: only a PROVEN missing sync column (or missing links table) gives the old rules; any other failed read leaves every sized line unmatched.
- One sync per venue at a time (`ezcater_menu_sync_claim`, one conditional upsert, stale after 10 minutes). Link reads page past 1000 rows. The daily run starts no venue after 18 s (call_edge_fn's pg_net timeout is 25 s), nor one the slowest venue so far would not fit; the rest run the next hour.

**Consequences:** after ezCater republishes a menu, NEW orders' sized lines are unmatched (they print by name) until the next sync; staff can press Sync. Orders placed before the republish keep matching. Fewer rows auto link than a looser rule would (for example "Farmhouse Salad" sold only as "Serves 1" waits for staff); that is the price of never linking the wrong size. Staff clears made before this change behave as before. Migration: `20260919m_OPS_ezcater_menu_sync_v1.sql` (renamed: its first name clashed with a parked branch), run AFTER ezcater-connect and ezcater-webhook are deployed, then press Sync.
