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
