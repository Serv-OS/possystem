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

**Context:** Peter (18 Sep 2026) wants ezCater items matched BEFORE any order, not pasted by hand and not left to ezCater's menu team. The connected token can read menus (proven live, read only). The full sync on `feat/ezcater-menu-sync` routed wrong sizes and wrong items in review. Peter chose the simpler version. Three review rounds of this version kept finding loose name matches at order time, and round 3 found that rows keyed by a folded name let two ezCater products share one row, its ids and its decision. Review round 4 (18 Sep 2026) made matching exact by construction. The menu sync ships as its own release, after the ezCater orders release (v5.9.9).

**The rule, in plain words:** after the sync is set up, orders only use matches made before the order: exact names found by the sync, or matches staff saved, and only for the exact name and size they were made for. There is no name guessing at order time. Anything else prints by name.

**Decision:**
- **Exact by construction.** Every row a sync writes is keyed by the exact full name of ONE ezCater product: `exact:` plus `exactName(item name + size)` (a multi size item's size, or a single size item's only size), or for an option `exact:` plus the exact name of the item it customizes, `|`, the exact group, `|`, and the exact value (item scoped since review round 5). `exactName` folds only case, accents, apostrophes, `&` and whitespace or ordinary punctuation; no tray, pan, box, serves, bracketed part or size word is dropped. So two ezCater products whose names differ by any word never share a row, its published ids (`ez_ids`) or a decision. Under the old folded keys "Caesar Salad" and "Caesar Salad (Serves 20)", "Sandwich Platter" and "Sandwich Platter Tray", "Sandwich Platter (Large)" and "Sandwich Platter (Small)", two sizes with no name, and "Bread: White" and "Bread Size: White" each shared one row. A row's exact full name never changes, so its ids are only ever added (new first, 200 kept); a rename on ezCater is a new row. The same exact name on two items or two menus is one product by name: one row, both ids (Potbelly's live menu lists "Bottled Water" under two categories). Two sizes of ONE item with the same exact name get no row at all, because no name can say which one an order means; the sync message names them.
- **Unicode exact names and item scoped options (review round 5, 19 Sep 2026).** `exactName` keeps every letter and number in any script, number fractions ("½" and "1/2" are `1/2`, "¼" is `1/4`) and every symbol or emoji other than ordinary punctuation, one word per symbol; it folds case fully, compatibility forms (NFKD), and accents on Latin, Greek and Cyrillic letters only. So "Ziti ½ Pan" and "Ziti ¼ Pan" are two rows, and "Pho 大" or "Wings 🌶🌶🌶" never auto link our plain "Pho" or "Wings" (the ASCII rule of round 4 dropped all of that). An option row is keyed by its item, group and value, and carries the item's name (`ez_item_name`, new in 20260919m), so one staff match on "Size: Large" routes that customization only on the item it was made for; at order time the key is built from the name of the line the customization is on. A staff option decision from before (a row saved before the sync, or an option row a sync keyed without its item) is kept as it was only when its group and value are exactly the row's AND a whole read of ezCater's current menus shows exactly one item offering them; otherwise it is carried for staff to look at again. An item row a sync keyed under the ASCII rule passes its decision on through `decided_as`, so it is kept only for the name it was made for. Earlier option rows are never written, never route, and the card lists them with the rows from before the sync.
- **The sync.** "Sync ezCater menu" (staff only, Item matching card) and a daily sync (pg_cron hourly, a venue is due after 20 hours without a good sync) read the CURRENT menus (venue date) of every caterer mapped to the venue. A sync never deletes a row, never touches `seen_count`, never changes a staff decision, and never writes a row saved before it.
- **Auto links (`matched_by 'exact'`).** An item auto links only when its full name equals exactly one of our item names: the item plus its size, where a single size item's only size counts unless every word of it is already in the item name ("Italian Boxed Lunch" sold as "Box"; that allowance is in the auto link comparison only, never in a key). The size with no name of an item with several sizes never auto links. An option auto links only when the group AND the value are both exact and exactly one of our options matches: "Bread: White" is never our "White" in the Cheese group. Every sync decides every automatic row again with our whole menu: the one exact match (kept, moved, or set) or cleared, guarded on the values read, so a person who saved first wins. An automatic row off the current menu keeps its link only while its stored name is still exactly the one item of ours it points at. With our menu read only in part nothing is linked, moved or cleared.
- **A moved decision carries its ids.** The guarded re-decide of a row the read covered writes the new target AND the refreshed ezCater facts (`ez_ids`, names, `synced_at`) in ONE statement; the separate refresh skips that row, and a row whose decision write fails is not refreshed. A failed refresh can never leave a moved match next to old ids (round 3 reproduced that on Postgres: an old Caesar Regular line routed to our Large).
- **Staff decisions from before the sync are carried over, never lost.** When a sync first writes a product's row it copies the staff decision (a match, or "Not on our menu") saved on the row that product had under the old key rules (its name with its size, then its name alone; today's key, then the legacy one), with what that row showed (`decided_as`). When that is the new row's exact full name the match is used as it was. Otherwise the card asks staff to look again ("Still right" or "Change") and orders do not use it until they do: a "Turkey Sandwich" matched before the sync is sold as "Turkey Sandwich Box". The old rows are never written again, and the card keeps them readable, apart, read only.
- **Order time, after 20260919m (`planSyncedLineMatches`):** a line matches ONLY when `exactName(its name + its size name)` IS a synced row's exact full name, AND its published size id is on that row, AND that row holds a trusted decision: a staff match made for that name, or an exact auto link from a sync. The order's `menuItemSizeId` IS the menu's `sizes.id` (proven on HKX77V, 18 Sep 2026); the order's item id is never the menu's item id and is never matched. A customization matches only by the exact name of its line (the item), its exact group and value, AND its published id (`customizationId`, not yet seen on a live order: if it is not the menu's value id, no customization ever matches and each prints by name). The exact name check can only ever match fewer lines than the id alone, and it closes the window after ezCater renames a size in place (same id, new name) before the next sync. No name guessing at order time: not `autoLinkDecision`, not the saved name links, not the legacy key fallback, not a folded name, not a posItemId, not an item code. Every other line prints by name, and an order writes nothing but the seen counters of the synced rows it landed on. The card stops offering item codes for ezCater.
- **Before migration 20260919m runs**, the order time rules are exactly the ones on main (`planNameMatches` is main's `planLineMatches`, unchanged). A failed or partial link read never falls back to name guessing: only a PROVEN missing sync column (or missing links table) gives main's rules, and a failure of the read after that proof (without the sync columns) is then main's own answer to a failed link read (the name rules on the menu, nothing written). Any other failed or cut short read sends the order through printing by name, writing nothing.
- **ezCater's own ids never route after the migration.** Every bail path of the matcher (a failed or partial link read, the time budget, an exception) takes `itemId` off lines and customizations (it holds `posItemId` and `posCustomizationId`) unless the link read proved the venue is before 20260919m. ezCater confirmed posItemId stays null for this integration, so this changes no real order.
- **Saves.** After 20260919m the card saves a synced row by its key and the edge function only UPDATES it (never creates one), recording what the screen showed as `decided_as`. A save of any other row after the migration comes from a Back Office tab loaded before it and is refused: "This page is out of date. Reload it, then match again." Before the migration a save is exactly main's.
- Writes: the decisions (with their facts), then inserts, then refreshes. The refresh names only the ezCater fact columns; `source` got a default of `'auto'` in 20260919m because Postgres builds the full insert tuple before ON CONFLICT DO UPDATE, and without a default every refresh of an existing row failed on the NOT NULL `source`.
- One sync per venue at a time (`ezcater_menu_sync_claim`, one conditional upsert, stale after 10 minutes). Link reads page past 1000 rows. The daily run starts no venue after 18 s (call_edge_fn's pg_net timeout is 25 s), nor one the slowest venue so far would not fit; the rest run the next hour. An ok sync stamps `last_ok_at` with its own `synced_at`, so the card lists a synced name the last whole sync did not write as no longer on their menu: last, never work to do, and its match still routes a change to an older order.

**Consequences:** from the moment 20260919m runs until the first sync, every ezCater line prints by name, so the release note runs the migration and the sync together, outside service. After ezCater republishes a menu, NEW orders print by name until the next sync; staff can press Sync. After ezCater renames a product or a size, the new name needs its own match. Fewer rows auto link than a looser rule would (Potbelly's live menu sells most items as one size named "1", so "Farmhouse Salad for a Group" waits for staff); that is the price of never linking the wrong size. Staff matches made before the release on items whose ezCater name now says a size need one "Still right". An order line that carries no size name (`menuItemSizeName`) is not the exact name of a sized product, so it prints by name. Item codes and posItemId no longer route ezCater orders once the sync is set up (ezCater confirmed posItemId stays null for this integration).

**Known limit (not fixed):** two DIFFERENT ezCater items sold under exactly the same full name (two "Brownie" items at two prices, in two categories) are one row, because nothing in the name tells them apart, so one staff match routes both. Two sizes of one item with the same name are left out instead and print by name.

Migration: `20260919m_OPS_ezcater_menu_sync_v1.sql` (renamed: its first name clashed with a parked branch; `decided_as` added in review round 3; no schema change in round 4, keys are text; `ez_item_name` added in round 5, so a copy run before round 5 must be run again), run AFTER ezcater-connect and ezcater-webhook are deployed, outside service, then press Sync.
