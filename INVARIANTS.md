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
  - v5.5.901 (kiosk + online): "before close" means **at commit, not at apply**. Entering a card only stages `{card_id, applied, commit_key, pending_commit}` in client state (`lib/giftCommit.js`); `gift-redeem` fires inside the submit path, before the `closed_checks` insert, keyed to the check id (`closed_check_id` → server-derived idempotency key) so retries can't double-debit. Where a card leg has ALREADY been charged the order must still be written on a gift failure — record the truth via `giftCardCheckRecord` instead of losing the order. Where the gift card is the ONLY payment, a failed/short redemption must ABORT the order (`allowPartial: false`).
  - v5.5.902 (POS: CheckoutModal + SplitModal) — **every surface now stages at apply and debits at commit. There is no apply-time `gift-redeem` caller left in `src/`.** Three POS-specific rules:
    - **The check id is minted CLIENT-SIDE, once per checkout** (`CheckoutModal.getCheckId()`), rides out as `paymentInfo.closedCheckId`, and the store adopts it as `closed_checks.id`. It must be the SAME id the gift debit was keyed to — that is the only reason `refundCheck`'s `gift-reverse-redeem` can find the ledger row. Never re-mint it per payment attempt.
    - **Split legs key on the PAIR `<checkId>:<portionId>`, never either alone.** The check id alone collapses one card used on two portions of a bill onto a single debit; the portion id alone (`p0`, `s3`, `ip0`, `ca0` — positional, reused by every split at the venue) collides across different checks and gives the next customer a free meal.
    - **PAX / send-to-terminal debits at DISPATCH, not at `complete()`** — dispatch is that path's point of no return (the terminal charges a due already net of the gift, and `TerminalJobReconciler` can close the check from any till without this modal). It commits with `allowPartial: false` (the frozen due can't be renegotiated) and puts the resulting record in `check_draft.giftCard` so the reconciler-closed check is still reversible.
  - v5.5.903 — **a debit taken before there is a check must be REVERSED when that payment provably dies.** Only the PAX path debits early, so it is the only path that owes an undo (`lib/giftCommit.reverseGiftCard` — the single `gift-reverse-redeem` request shape, shared with `store.refundCheck`). Three rules, all of them money:
    - **"Provably dead" is the whole gate.** A server-SETTLED `declined` / `cancelled` / `expired` status, or a cancel the server itself confirmed (`cancelTerminalJob` → `r.ok`). Never on a live job, a refused cancel (`ALREADY_CAPTURED`), `unknown`, or a dispatch whose response was merely lost — any of those may still be paid and closed by the reconciler **with that leg on the check**, and reversing hands the customer the goods AND their balance.
    - **Never reverse a leg the closing check claims.** `clearTable` cancels a live job for the check it is closing; if that check records the same `idempotency_key` (staff backed out to cash and the idempotent re-commit booked it), it is accounted for. Compare keys via `giftLegs(giftRecordFrom(paymentInfo))`.
    - **A successful reversal must RETIRE the check id** (`checkIdRef.current = null`). The redeem row survives its own reversal, so re-applying the same card under the same check id derives the same `giftcommit:<check>:<card>` key, returns `already_applied`, and discounts the bill while debiting nothing. On a FAILED reversal the opposite holds: keep the id and put the leg back on the bill (`applyGift(record)`) so the money the customer has already spent is still honoured.
  - Multiple gift cards on one check live in the EXISTING `gift_card` jsonb as `{...primaryLeg, legs:[...]}` — no new column, so the top-level `card_id` + `idempotency_key` pair every older reader expects is untouched. Build it with `giftRecordFrom()`, read it with `giftLegs()`; never hand-destructure `legs`.
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
Must include: `menus`, `menuItems`, `menuCategories`, `tables`, `sections`, `quickScreenIds`, `quickScreenMode`, `quickScreenAuto`, `profiles`, `modifierGroupDefs`, `instructionGroupDefs`, `taxRates`

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
- **Never mint a new anonymous session while a refresh token is still in storage** (v5.8.57, `lib/authSession.js`, ported in the database fence release). auth-js reports `session: null` BOTH for "no session here" and for "the refresh call failed on the network" (`AuthRetryableFetchError`, which deliberately keeps the stored session: GoTrueClient `_callRefreshToken`). Treating the second as the first swaps `auth.uid()` and silently cuts a paired till, kiosk, menu board TV or order screen TV off every row fenced on `devices.device_uid` / `menu_board_screens.device_uid`. `ensureAuthToken` retries the refresh briefly, then falls back to the device's own stored token, and only signs in anonymously when storage holds no refresh token at all.
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
- **Floor plan SECTIONS (`src/lib/sectionPlan.js`, 18 Sep 2026):** a venue's section list has one owner, `public.sections` (key `(location_id, id)` from migration 20260918c). Back Office writes the WHOLE list on every section change (upsert on `location_id,id`, sort_order from the order, then delete only the rows it read that are gone), checked against the list the tab last read; before the migration the save reports "Run the sections database update first" and puts the screen back. The saved list wins over the built in defaults and any pushed list on every load path (TablePlanSync, SyncBridge boot, useSupabaseInit, Back Office load, Push to POS snapshot); a failed or empty read never replaces a saved list a device has (store, or its `rpos-saved-sections` copy); a venue with nothing saved keeps its pushed list or the defaults. A section that still has tables cannot be removed, and a till always shows a table whose section is not in the list (All, and the Other chip). Never move tables to 'main' in memory, never map sections rows without `hidden`.
- **Table DEFINITIONS vs SESSIONS (`src/lib/tablePlan.js`, v5.9.4):** a table's definition (label, layout, section, covers) has one owner, the saved plan (`floor_tables`). **No device clock orders anything.** Copies are ordered by the DATABASE clock (`floor_tables.updated_at`, trigger-set, migration 20260918b) and, when a copy has no server time, by this machine's observation counter (`_seq`, localStorage, never a clock); a stamped copy always beats an unstamped one. A delete is a tombstone: a server one (`floor_table_tombstones.deleted_at`, trigger-set) wins only if later than the copy's `updated_at` (re-creating an id clears it); a local one (no tombstone table yet) only beats unstamped copies observed before it. A successful non-empty plan read is the plan version (`{ seq, ids, srvReadAt }`); whether a table is in the plan (retire when absent, admit when incoming) is decided ONLY by this machine's observation order, never by a server time (updated_at is stamped before the writer commits, so no read time proves absence; `srvReadAt` is diagnosis only); an old-code push (no stamps) can add or rename nothing a plan read has decided. The database refuses to bring a deleted id back (trigger `floor_tables_guard_tombstone`, 20260918b) unless the write sets `recreate_deleted = true`, which only the new client sends and only on the insert of a table a person just added; the trigger never stores true. The compare-and-set base holds the RAW column values (nulls stay null, `.is(col, null)`). Absence alone (failed or empty read, empty or partial config, broadcast without the table) never removes a table. A table holding an OPEN session (`isSessionClosed` decides) is never dropped: it stays reachable as `planRemoved`, and an open session whose table is missing (cold boot, split child, another till's order) gets its table REBUILT (`rebuildOrphans`, SyncBridge boot and SessionReconciler). Back Office writes are compare-and-set (`lib/tablePlanDb.js saveTableChecked`: insert-only for new tables, `WHERE updated_at =` or every column `=` what the tab read), never a blind upsert, and never for a `planRemoved` or tombstoned table. Never re-introduce a blind `label: st.label` overwrite, an unconditional "add every incoming table", a `Date.now()` comparison in table merges, or an upsert of a whole table row from Back Office.

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

---

## Workforce / Payroll (live financials — `wf_*` tables)

- **Never compute pay money on the client for the record.** Tronc, period pay and holiday accrual are computed server-side by the `workforce-compute` edge function; clock punches by `workforce-clock`. The client may *preview* but must not write money rows directly. (RLS blocks it anyway for anonymous devices.)
- **`wf_*` money is `numeric` with scale, never float**, and carries a currency. The effective pay rate + its source must be **snapshotted** onto `wf_shifts`/`wf_timesheets` at write time so historical pay is reproducible.
- **Staff are soft-deleted** (`wf_staff.status='leaver'`), never hard-deleted. All FKs onto `wf_staff` are `ON DELETE RESTRICT`. Deleting a staff member that has history must fail, not cascade.
- **`wf_audit` and `wf_holiday_accrual` are append-only** — UPDATE/DELETE/TRUNCATE are revoked from `authenticated`/`anon`. Corrections are new rows, never edits. `wf_audit` rows form a `prev_hash`/`row_hash` chain — only write them via the edge function's `writeAudit`.
- **A finalised tronc run is immutable** (status ≠ `draft`) — a trigger blocks deletion; supersede via an audited correction, never edit.
- **`wf_*` RLS is real, not "allow all."** Every table is location-scoped via `user_accessible_locations()` except `wf_staff` (org-scoped PII via `user_accessible_orgs()`). Those helpers are created by `20260608_workforce.sql` — don't drop them. Anonymous (kiosk/clock/online) sessions MUST never read payroll/PII.
- **`(location_id, org_id)` must be a real pair from `locations`** — composite FKs enforce it. Resolve `org_id` from the location (or trust `orgCtx.orgId`) so writes don't violate the fence.
- **Clock PINs are validated server-side only** — `workforce-clock` matches the PIN against `staff_members`; never send the staff PIN list to a clock client.

---

## Reporting / Tax / Reviews

- **Net sales (`closed_checks.subtotal`, ex-VAT) is the P&L revenue basis. VAT is NEVER revenue or profit.** The Daily Trading (P&L) report and Owner app must always show VAT as a separate line ("collected for HMRC"), not fold it into sales or profit.
- **Daily Trading gross = net + VAT**, computed from `subtotal` + `tax_amount`. Do **not** use `closed_checks.total` as "gross" — it's unreliable in real data (can be less than `subtotal`; may include service/tip). VAT prefers `tax_amount`; fallback `max(0, total − subtotal − service − tip)` only for legacy checks with null `tax_amount`.
- **COGS % and daily overhead are operator estimates** (in `wf_venue_settings.settings`), not real costs — there is no per-item `cost_price` yet. Don't present estimated COGS as actual cost. When `cost_price` lands, derive real COGS but keep the flat-% as fallback.
- **Tronc/tips are not sales** — never add `tip` (or `service`, unless modelling service charge explicitly) into the sales/net/gross figures.
- **Review Manager must never re-introduce review-gating** — happy and unhappy guests get the same public review path (UK DMCC Act 2024 / US FTC Oct-2024). The private feedback option is additive only.
- **One platform Google OAuth client for reviews, never per-customer.** The Google client secret lives only in Supabase Edge Function env (`GOOGLE_OAUTH_CLIENT_SECRET`) — never in the repo, bundle, or client. Venues connect by signing in; the platform never holds venue Google passwords.
- **Edge functions enforce their own tenant fence.** `trading-report` / `owner-snapshot` / `review-*` run `verify_jwt=false` and must validate the caller (`user_locations` / super_admin / service-role) before returning a location's data — RLS is not doing it for them.

## Accounting days (Xero now, QuickBooks next; ADR-025, v5.9.11)

- **Money is booked by the VENUE BUSINESS DAY** (`supabase/functions/_shared/businessDay.js`: platform `locations.timezone` + `business_day_start`, DST safe), never a UTC day or the device clock. A day that has not ended is never posted.
- **Every closed_checks write records `tenders`** built where the payment was taken (`src/lib/accounting/tenders.js`), listing everything that settled the bill (money, gift card, booking credit, loyalty and promo credit). Never derive tenders from a surface's `total` alone: the till books gross, kiosk, online and terminal jobs book net of credits.
- **Every closed_checks insert or upsert goes through `writeClosedCheckRow`** (`src/lib/closedCheckWrite.js`), and every camelCase check becomes a row through `closedCheckRow` (`src/lib/closedCheckRow.js`). No hand copies of the row map.
- **Loyalty and promo credit are discounts, never takings.** Tips are never revenue by default.
- **Refunds are booked on the day of the refund** (`refunds[].timestamp`), not the check's close.
- **The accounting sync log is never deleted.** `xero_sync_log` rows are claimed, updated in place and keep their history (`_shared/syncRun.ts`); a posting is marked sending before the request and posted after it.

## Menu board / screen pairing (`menu_board_screens`)

- **A menu-board device never writes its own `location_id`/`board_id`.** Those are set only by the SECURITY DEFINER RPCs (`claim_menu_board_screen` / `set_menu_board_screen`) after validating the caller's location access, and `location_id` is always taken from the chosen board's row (never device-supplied, never a default). The table has **no UPDATE policy** — do not add one; route all mutations through the RPCs. (Same "resolve real locationId" rule as everywhere else.)
- **A device sees only its own screen row** (`device_uid = auth.uid()`); Back Office sees only its venue's screens. Do not widen the SELECT policy to expose unpaired rows broadly — that would let pairing codes be enumerated across tenants. Claiming is by code (a capability the operator reads off the physical screen).
- **Pairing codes stay high-entropy + TTL'd.** Codes are ~39-bit (8-char unambiguous alphabet) and `claim` rejects screens not seen in 30 min. Don't drop back to short/low-entropy codes or remove the TTL without an alternative throttle.
- **Don't break the `?board=<id>` direct-link path** when changing the pairing flow — it's the manual fallback and is used by the Back Office preview/Copy-screen-link.

## Order screens (`order_status_displays`, migration 20260911_OPS_order_status_displays.sql)

- **Order screens never read or subscribe to order_queue; only order_status_feed.** The feed resolves the caller's own paired screen by `auth.uid()` and takes no location argument.
- **Order screen names are shortened inside SQL** (`_osd_name`). Never return a full name to the TV and trim it in JS. The JS mirror is `src/lib/orderScreen/orderScreenStatus.js`; change both together.
- **An order screen is a menu_board_screens row, never a devices row.** A devices row would pass `pos_can_access` and give a public TV tenant wide reads.
- **order_status_pings carries no personal data.** It is only a realtime nudge (location_id, bumped_at). The screen re-calls the feed; it never renders from a payload.
- **The order_queue trigger never waits on another order write.** The shared ping row and old mark cleanup use `FOR UPDATE SKIP LOCKED`, and ping rows are seeded, never upserted, by order writes. A plain upsert there queued every order write at a venue behind the first and could deadlock. Display saves only insert a ping row when a plain select finds none (ON CONFLICT waits on a row an open order write has updated).
- **What a TV shows is only as trustworthy as order_queue.** While any order_queue policy lets any caller insert or update with `true` (the "allow all" policy, until the 20260907b fence file 3 lands), `order_status_names_enabled()` is false and the feed returns NO names for any source. Do not weaken that check or bypass it with a setting: anyone with the public key could otherwise put any words on a customer facing TV. Once the fence is in, customer typed names (kiosk, online, QR, catering) still show only after a status change made in a separate request, which stops a single insert but is NOT proof of staff on its own; names never carry an @ or any digit and keep letters only.
- **Online, catering and QR refs show their last 3 characters** (the full ref is an order tracking lookup key), widened to 4 only when two visible rows in one section share those 3.
- **Order screen logos under receipt-assets `locations/<venue>/orderscreen/` are fenced by RESTRICTIVE storage policies** (osd_logo_*_fence): only signed in Back Office users of that venue may write there. Upload with `upsert: false` and a new name.

## Database fence stage 1 (docs/FENCE_STAGE_1_APP.md, 18 Sep 2026)

- **A till is never unpaired because it could not read its own row.** Only a SUCCESSFUL read that says `status = 'removed'` is a removal (`lib/deviceFence.js classifyDeviceRead`). A read error, or no row (after file 2 row level security hides it from a till that lost its link), is unknown: the till keeps its pairing and its open work and shows the red banner (`components/DeviceLinkBanner.jsx`). Only the server's answer to the re-link (`reclaim_device` 'invalid') sends it to the pairing screen, and even then `rpos-device` is kept so pairing it again keeps every table.
- **An empty read of shared rows while the link is uncertain is unknown, never "no tables / no orders / no tickets"** (`trustSharedRead` with `lib/deviceLink.js isDeviceLinkUncertain`). SessionReconciler, QueueReconciler, MasterSync.forceSyncFromSupabase and the KDS load all check it before acting on an empty read.
- **A refused write is parked, never lost.** OfflineQueue keeps it; on `rpos-device-relinked` the items whose error was a permission error are released (attempts and status reset, buffered time KEPT, so the staleness and replay guards still apply). DataSafe sends kept sales again on the same event.
- **0 rows is not "sent"** (fix round 2, the zero row blocker). Row level security answers an update or delete of a row it hides with success and 0 rows. Every update and delete of `bar_tabs`, `active_sessions`, `order_queue`, `closed_checks`, `kds_tickets` and `print_jobs` that must change a row goes through `lib/rowWrites.js` (`mustChangeRow`, `mustChangeRows`) or OfflineQueue's replay, which count the rows changed and, on 0, ask `device_status` AFTER the write answered: not linked means PARKED (`parked_link`, released on relink), linked means gone (done). Never add a bare `.update()` or `.delete()` of those tables from a device that only checks `error`. A later write of the same row waits behind a parked one (order kept); a kept `active_sessions` delete always carries its occupation (`session->>seatedAt`). Compare and set claims (kitchen routing, print job claims and sweeps) are the exception: 0 rows is their normal answer.
- **No card payment starts on a device that is not linked** (fix round 2). Every card start (reader, terminal job, split leg, tab hold or capture, MPOS, QR capture) calls `deviceLink.confirmLinkBeforeCard()` first; the kiosk mounts `ScreenPay` only inside `KioskPayLinkGate`. Never start a reader, terminal job or capture before it, and never put the gate inside ScreenPay or submitOrder (card path guard).
- **A QR tab closed short is never charged again** (fix round 2, S5). Its card hold was already captured on the phone (`tab_close_short`); the till closes it booking only what was paid (`orderPayment.shortTabClosedCheck`), and the rest is its own sale.
- **The boot re-link uses the device secret, never a code read back from the table.** Codes are server made (12 symbols, shown `XXXX-XXXX-XXXX`, typed with or without dashes), 60 minutes, single use. The one time `device_secret` lives in `rpos-device.deviceSecret` (tills) or `rpos-kiosk-secret` (kiosks, in the tenant fence keep set). Once the fence functions exist a code saved before this release is never sent and is dropped from `rpos-device` (fix round A15): only the secret, or pairing again, links a till.
- **A device's venue never changes while it is linked** (fix round, 19 Sep). Only the super admin or a Back Office login of BOTH venues may move it, and a move unpairs it. A linked till writes only its heartbeat columns on its own row (`last_seen`, `app_version`, `status` active/online, `session_token`, `kds_settings`); nothing in the app may write any other devices column from a till.
- **Pairing codes are readable only by that venue's Back Office and the super admin** (from file A on). A row holding a live code is hidden from everyone else, tills of the same venue included. Never add a till or customer read of `devices.pairing_code`.
- **"Paid" on a public (online, QR, catering) order is decided by the server from ITS OWN valuation** (fix round 2, 19 Sep): every line priced from the menu by id (`menu_items`, a size is its own row, options from `modifier_groups.options` by id; never below the menu price for the channel; whole quantities; nothing voided), less only discounts the server proves (the active `discount_rules`, worked out again in SQL; a promo code it uses up itself; a loyalty redemption row keyed to this order's check), against verified money (card and gift proofs bound to this order). The amount due is never below the page's own totals. Short of it the order is `payment_state 'short'` (money proven) or `'checking'` (none yet), with the amounts in `customer.order_pricing`, never paid. So: every line sends `itemId` and every option its `id`; a customer page mints ONE order ref and ONE check id `chk-<ref>-<random>` per checkout (gift, loyalty and promo keys bind to the order through it); `discount_rules` stays writable only by Back Office and `stamp_transactions` only by the server, or the server can no longer trust them. A proof whose `meta.order_ref` names another order never counts.
- **`payment_state 'checking'` is a third state, never charged again** (`lib/orderPayment.js orderPaymentState`: 'paid' | 'checking' | 'unpaid'). **`'short'`** (fix round 2) comes with `payment_unverified` and is never charged in full again either: staff may take only the difference, then a manager confirms. The Orders Hub, MPOS and the checkout modal never offer the charge step or the pay flow for it; staff use Check payment (payment-proof, then `verify_public_order_payment`) or a manager's Confirm payment (`confirm_public_order_payment`, with a note). The customer is told the venue is confirming the payment and is never asked to pay again.
- **Parked writes are released on relink, and on the first link of a page** (fix round A12: after Pair again the page reloads and the boot link answers 'linked'). Once per page for 'linked', so a write refused for another reason can never loop.
- **Customer pages never write order_queue, closed_checks or active_sessions directly** once the server functions exist: `place_public_order` and `settle_qr_tab`, with payment proofs written only by the `payment-proof` edge function from the processor's own record. Money that was taken is never dropped: without proof the order is still placed, unpaid, `payment_unverified`, for staff to confirm.
- **The QR floor sync only ever writes or removes a session whose `source` is 'qr'** (`lib/qrTableSession.js`, and the `order_queue_qr_floor` trigger after file 2). A till's session on the same table is never touched.
- **Money edge functions decide WHO is calling, never "has a JWT"** (19 Sep 2026, docs/FENCE_STAGE_1_APP.md section 13). Every gift card, loyalty, promo and card refund function authorises the caller as one of: staff of the venue (a `user_locations` link, a verified super admin, or a company role for the venue's company; never an anonymous session, never `user_profiles.location_id`), a device BOUND to the venue (the device arm of `pos_can_access`: after 20260919a `bound_via` set and status active or online; before it the 18 Sep rule), the member's own loyalty session token (their own customer id only), a code holder (a full gift card or promo code), or the service role. Issuing, importing, voiding, configuring, fulfilling, putting a spend back, refunding a card and writing loyalty settings are never open to a customer session. The loyalty till paths (earn, redeem, refund, the full balance) report before file A and enforce by themselves after it (`LOYALTY_AUTHORITY_MODE` forces either); every other money path is enforced always. Gather the facts only through `_shared/callerFacts.ts` (via `_shared/loyalty-utils.ts`) and decide with `gift-authority.ts`, `loyalty-authority.ts`, `deviceAuthority.ts`, `staffAccess.ts`. A member's gift cards are matched only on the phone proven with the one time code (never a name or an email), and loyalty-earn earns only from the server's own closed check.
- **FENCE STAGE 1 FALLBACK** marks every branch that runs today's path while a server function does not exist yet. They all go once 20260919b has run (the cleanup list is in docs/FENCE_STAGE_1_APP.md section 10).

## PAX terminal payments (Ryft)
- **`session.seatedAt` is write-once per occupation.** It is stamped only at session creation and carried (never re-stamped) through transfers. The occupation-aware paid-table guard (migration 20260801) uses `check_draft->>'seatedAt' = session->>'seatedAt'` to prove an approved terminal payment belongs to the CURRENT party — anything that rewrites `seatedAt` mid-occupation silently disables a money guard (or re-opens a double-charge / false-block). Do not add code that re-stamps it on an open session.
- **A terminal assignment is a fence, not a preference.** `terminal_devices.bound_pos_device_id` set → only that till may dispatch to it (client resolver + server 409 `TERMINAL_ASSIGNED_ELSEWHERE`). Unassigned → any till at the venue. Don't re-add "closest/most-recent terminal" fallbacks that ignore foreign bindings.
- **`terminal_devices.ryft_terminal_id` is stamped by EXPLICIT id only** (`ops_terminal_device_id` through ryft-terminals register/adopt, carried forward on re-pair by `claim_terminal_device`). Never reintroduce serial-string matching — the app's ops serial (`AID-…`) and the hardware serial live in different namespaces and can never match.

## Back Office second sign in step (docs/SECOND_STEP.md, 19 Sep 2026)
- **Nothing of the Back Office, admin portal or Owner app loads before `SecondStepGate` passes.** Profile reads, role checks and data loads wait for `secondStepOk`; a session that drops back to password only (aal1) closes the gate again. Anonymous sessions (tills, kiosks, KDS, TVs, host stands, Manager app, customers) are never gated, anywhere.
- **The server check only ever refuses.** `_shared/second-step.ts` `secondStepRefusal(req)` sits straight after the CORS preflight line of every function a real login can use, and never grants anything: each function still proves the caller with `getUser`. Anonymous callers, the service role and calls with no token always pass. A new edge function that lets a real login act must add the same line (the wiring test lists them).
- **One switch, OFF by default:** `public.second_step_settings.enforce` (service role only). The SQL rule `second_step_decide` and the edge rule `classifyCaller`/`mustRefuse` must agree; the parity test reads the SQL self test rows. Change both together.
- **Never drop `public.second_step_check_request()` while `pgrst.db_pre_request` names it:** every Data API request would fail. The roll back resets the role setting first, in a separate paste.
- **A person's session is their own:** app start never gives the Back Office, admin, Owner or Staff surfaces an anonymous session, and a till whose Back Office sign in is revoked takes a fresh device session and claims itself again.
- **Face ID domain:** `WEBAUTHN_HOSTS` in `src/lib/secondStep/rules.js` must match the Supabase relying party origins. Never use auth-js `mfa.webauthn.register()`: on a failed enrol it unenrolls the login's VERIFIED factor of the same name.
- **Every login keeps an authenticator app** (the backup that works in our apps and on the tills). Only an owner (their staff) or a ServOS super admin (anyone else) resets factors, through `second-step-reset`, which needs the caller's own second step and writes `second_step_resets` before removing anything.
