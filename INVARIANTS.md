# INVARIANTS.md — Hard Rules That Must Never Be Violated

If a proposed change would violate any rule here, **stop and ask** before proceeding.

---

## Schema Constraints

- Every table in the Ops DB has a `location_id` column. **All queries must filter by `location_id`.** Never write or read across locations.
- `menu_items.id` values starting with `m-` are locally-generated. They exist in Supabase but are not UUID format — don't assume UUID.
- `active_sessions` uses `(location_id, table_id)` as the unique key (upsert on conflict). One row per table per location.
- `locations.quick_screen_ids` is a jsonb array of item ID strings.
- `menu_categories.spacer_slots` is a jsonb array of `{id: string, sortOrder: number}` objects.
- `menu_categories.default_course` is an integer: 0=Immediate, 1=Course 1, 2=Course 2, 3=Course 3.
- `gift_cards` uses `code_lookup` (HMAC-SHA256 hash) for secure code search. `code_plain` is a fallback only.
- `gift_card_transactions.idempotency_key` has a unique constraint — prevents double-debit on retries.
- `stock_levels` uses `(location_id, item_id)` as key. `remaining` must never go below 0 — the `decrement_stock` RPC enforces this.
- `eighty_six` uses `(location_id, item_id)` — one row per 86'd item per location. INSERT = out of stock, DELETE = back in stock.
- `locations.currency` exists on BOTH Ops and Platform DBs (GBP/USD/EUR, default GBP). **Platform is authoritative** for the running app; Ops is only the creation seed. `provision-location` copies Ops→Platform on INSERT only. Supported set is exactly the keys of `CURRENCIES` in `lib/currency.js`.
- `closed_checks.payment_intents` (jsonb `[{id, amountMinor}]`) is the source of truth for auto-refundable card legs (split portions, bar-tab holds). `stripe_payment_intent_id` is kept for back-compat / single-card.

---

## Required Ordering / Sequencing

- **Boot sequence in SyncBridge.jsx:** config push snapshot → floor plan + menu + sessions (parallel Promise.all) → settings (quick screen, show images). Never reorder these or sessions will flash as empty.
- **Version bump sequence on every deploy:** (1) update `src/lib/version.js`, (2) add CHANGELOG entry at top of array in `src/App.jsx`, (3) `npm run build`, (4) `git push origin develop`.
- **Category field sync:** When adding a field to `menu_categories`, update ALL of: (a) `sbUpsertCategory` in `store/index.js`, (b) `upsertMenuCategory` in `lib/db.js`, (c) the `catsRes.data.map()` in `SyncBridge.jsx`.
- **Stock decrement after order only:** Kiosk/online stock decrement must happen AFTER successful order submission (heartbeat confirmed), never before. POS decrements optimistically on `addItem`.
- **Gift card redeem before order close:** Gift card redemption (edge function call) must succeed before the order is written to `closed_checks`. If redemption fails, the order should not proceed with gift card credit.
- **Money formatting (multi-currency):** Never hardcode `£` or `'gbp'` for a money value. Use `money()` / `currencySymbol()` / `stripeCurrency()` from `lib/currency.js` so displays + Stripe charges follow the location's currency. (Genuine GBP-only chrome — cash denomination labels, platform billing tiers — is the documented exception.)

---

## API Contract Shapes

### `addItem(item, mods, cfg, opts)` in store
- `item` — full menu item object from store
- `mods` — array of `{groupLabel, label, price, qty?, itemId?}` 
- `opts` — `{notes, qty, linePrice, displayName}`
- Returns: new item appended to active table session or walk-in order

### Category object (in-store shape, camelCase)
```js
{ id, label, icon, color, menuId, parentId, sortOrder, accountingGroup, defaultCourse, spacerSlots, isSpecial }
```

### Session object
```js
{ items: [{uid, itemId, name, price, qty, mods, notes, allergens, course, fired, status, seat}], covers, seatedAt, sentAt, firedCourses }
```

### Config push snapshot (what Back Office sends to POS)
Must include: `menus`, `menuItems`, `menuCategories`, `tables`, `sections`, `quickScreenIds`, `profiles`, `modifierGroupDefs`, `instructionGroupDefs`, `taxRates`

### Gift card redeem response
```js
{ card_id, applied, remaining_balance, status, currency, idempotent? }
```

### Gift card redeem insufficient balance (400)
```js
{ error: 'Insufficient balance', balance: <available_minor>, requested: <requested_minor> }
```

---

## Security Boundaries

- **`VITE_SUPABASE_ANON_KEY` must never appear in git.** It's in Vercel env vars only. The local `.env.local` has a placeholder.
- **`loc-demo` must never be written to Supabase.** It's a mock sentinel. Every db write must verify `locationId !== 'loc-demo'` before proceeding.
- **POS devices authenticate via device pairing** (not user auth). Back office users authenticate via Supabase Auth. Kiosk/online use anonymous auth. Don't mix these flows.
- **RLS policies:** The `locations` table has an UPDATE policy requiring `location_id IN (SELECT location_id FROM user_profiles WHERE id = auth.uid())`. Anonymous/device writes to `locations` will be rejected unless using the back office auth session.
- **Gift card HMAC secrets** are stored in `gift_brand_config.hmac_secret` per company. Never log or expose these.
- **Edge functions use `platformAdmin`** (service-role client) for Platform DB access. Never expose the service-role key to the frontend.

---

## Location Isolation (v5.5.238)

Multi-location data bleed is a **critical severity** bug. These rules exist to prevent it at every layer:

### Location Resolution Priority Chain
`rpos-bo-location` (BO override) → `rpos-device.locationId` (POS pairing) → `user_profiles.location_id` (DB)
- `getActiveLocationSync()` — **synchronous**, localStorage-only, safe for boot paths. Used by SyncBridge.
- `getLocationId()` — **async**, calls `supabase.auth.getUser()`. **NEVER use in SyncBridge boot** — it hangs on POS/MPOS devices without auth sessions.

### Sign-Out Must Clear Location State
Every sign-out path must: (1) `localStorage.removeItem('rpos-bo-location')`, (2) `clearResolvedLocationId()`, (3) full page reload. The `onAuthStateChange(SIGNED_OUT)` handler is a safety net for session expiry and edge cases.

### Sign-In Must Validate Location Override
On sign-in, if `rpos-bo-location` is set and the user is not `super_admin`, validate the override against `fetchAccessibleLocations()`. Discard if the user can't access that location.

### Runtime Store Guard (`_dataLocationId`)
SyncBridge stamps `useStore._dataLocationId` after loading data. On subsequent boots, if the active location differs from `_dataLocationId`, all menu/table data is purged BEFORE loading fresh. Post-load validation filters out any `menuItems` whose `location_id` doesn't match.

### Tenant Fence (`enforceTenantFence`)
Runs at app load (App.jsx) and on every `setResolvedLocationId()` call. Compares active location to `rpos-active-location` tag — if they differ, `purgeStaleLocationData()` wipes all localStorage except the keep-set.

### RLS Policies
Menu tables (`menu_items`, `menu_categories`, `menus`, `menu_category_links`), `floor_tables`, and `config_pushes` have `_auth_write` policies requiring `auth.role() IN ('authenticated', 'anon')`. No permissive "allow all" policies exist on location-scoped tables.

---

## Table Session Integrity

Tables MUST never be lost between updates. These safeguards exist:

- **SessionSync.js:** Writes to `active_sessions` on meaningful change (item count, subtotal, void count, course fired, notes). 600ms debounce.
- **SessionReconciler.js:** Polls every 10s. Full session comparison — any difference (voids, mods, discounts, prices, notes) triggers update. Skips `activeTableId`.
- **Realtime DELETE guard:** Both `realtime.js` and `SessionSync.js` DELETE handlers check `activeTableId` and compare `seatedAt` timestamps before clearing a table.
- **3-second grace period:** `flushSessions` waits 3 seconds before deleting `active_sessions` rows for empty tables, preventing momentary clears from cascading into permanent deletion.
- **MasterSync:** `forceSyncFromSupabase` preserves local sessions with items when the Supabase row is missing (unflushed). Newer local sessions always win.

---

## Looks Wrong But Intentional

- **`isMock = !SUPABASE_URL || !SUPABASE_ANON`** — This evaluates at build time from env vars. In local dev, `VITE_SUPABASE_ANON_KEY=PASTE_YOUR_ANON_KEY_HERE` makes `isMock=true`. On Vercel, real keys make `isMock=false`. This is correct behaviour.
- **`_resolvedLocationId` module-level variable in `supabase.js`** — This is a module-singleton cache. Once resolved, `getLocationId()` returns the cached value synchronously (after the first async resolution). This is intentional for performance.
- **SessionReconciler skips `activeTableId`** — The table currently being edited by the operator is never overwritten by the reconciler, even if Supabase has a different version. This prevents clobbering work in progress.
- **Two separate session flush triggers** — `scheduleFlush()` debounces at 600ms. This is intentional to avoid hammering Supabase on rapid item additions.
- **`supabase.from(...).update(...).eq('id', item.id)` without `location_id` filter in `ItemImageUpload`** — This is intentional. Filtering by primary key `id` is sufficient and avoids the `getLocationId()` async lookup. The RLS policy still enforces location scoping.
- **`gridWithSpacers` merges spacers and items by `sortOrder`** — spacers have fractional/arbitrary sortOrder values to slot between items. When items are reordered, ALL sortOrders are reassigned as sequential integers via `reorderGrid()`.
- **Kiosk stock decrement fires-and-forgets** — `decrementStockRPC(...).catch(e => console.warn(...))`. This is intentional — a stock decrement failure should not block order submission. The stock will eventually be corrected by the next stock sync or manual count.
- **`resolveOptItemId` name-matching in KioskProductModal** — Falls back to matching modifier option names against sold-alone sub-items. This is intentional — many modifier options don't have explicit `itemId` links but represent the same physical product.
