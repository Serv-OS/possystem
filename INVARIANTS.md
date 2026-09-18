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
- **RLS policies (Ops `locations`, 18 Sep 2026, migration 20260918e):** exactly four policies. SELECT is open to everyone (customer pages, kiosks and pairing read it; the row holds no secrets) and must NEVER call `user_accessible_locations()` (that function reads `locations`; it would recurse). UPDATE needs a real login with the venue in `user_accessible_locations()`; INSERT a real login into its own company (profile org or an org of a linked venue) or a super admin; DELETE super admin only. The anon key holds no write grant. The `locations_org_guard` trigger refuses any API change of `org_id` or `id` unless a super admin makes it, and gives a venue created through the API a server id. No till, kiosk, KDS or customer page writes Ops `locations`; never add a policy that lets them, or one that trusts `user_profiles.location_id`.
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
- **Gift cards (18 Sep 2026, enforced):** `gift-list` and gift-lookup search by name, email or last 4 are staff only (non anonymous, the database access rule in `_shared/staffAccess.ts`). A full 16 character code is proof of possession and stays open for lookup and redeem. `gift-redeem` by `card_id` without a resolving code needs staff, a claimed device of the company, or the member token whose proven phone the card is addressed to. A session from `signInAnonymously()` is never staff. Never match a member's cards by name or email; compare phones with `phonesMatch` (`_shared/giftCardMatch.ts`: GB and US digits, never an invented country code). gift-redeem checks idempotency BEFORE authority, so a retry of a debit that landed is never refused.
- **Gift card and loyalty money holes (18 Sep 2026, round three, enforced now):** gift-issue, gift-import, gift-bulk-create, gift-config (every action), gift-void, gift-resend and the POST/PATCH/DELETE of loyalty-config and loyalty-rewards are STAFF ONLY. "Staff" is one rule everywhere, `_shared/staffAccess.ts`: the database's `user_accessible_locations()` (user_locations, plus every venue for a verified super admin, since 20260918d; a profile venue is never access; a location id is matched only as its ONE resolved Ops id, `staffLocationKeys`, never the raw id as well), plus super_admin, plus a Platform user_company_roles row for the location's own company; never an anonymous session. gift-reverse-redeem: staff or a claimed device of the card's company, never the customer session that made the spend, once per spend (the refund row is written first as the claim). gift-fulfill: service role (the processor webhooks) or staff, and the payment is proven by the PROCESSOR (Stripe checkout session paid, Ryft session Captured, carrying this purchase id, covering the amount), never by the gift_card_purchases row. One card per purchase: the card id is derived from the purchase id (`_shared/giftFulfilPlan.ts`), so a retry or claim takeover finishes with the card already issued, never a second; a processor outage is a 503 `retryable` and the Stripe and Ryft webhooks answer non 2xx so the event is delivered again. loyalty-enroll: service role, the member's own token, staff or a claimed device, and only for a customer of that company's org. loyalty-member-lookup: enforced (no callers). gift-config never returns hmac_secret.
- **Kiosk pairing code is single use (18 Sep 2026, round three):** KioskSurface clears `devices.pairing_code` right after `claim_device`. Never keep it on the row: the live claim_device matches any row holding the code and overwrites device_uid, so a second tablet would steal the link (and the kiosk's Ryft card payments). A kiosk with no link is re-paired once from Back Office.
- **A login's venue, company and Back Office access are server written (18 Sep 2026, lockdown step 1, migration 20260918d):** `user_profiles.location_id` is only the venue Back Office opens on, NEVER access; access is `user_locations`, plus every venue for a verified super admin (`is_super_admin()`), in `user_accessible_locations()`, `_shared/staffAccess.ts`, `workforce-compute`, `src/lib/accessibleLocations.js` and the admin portal alike. A login belongs to a venue (profile-admin team_profiles, set_bo_access) only through a `user_locations` row, never through `staff_members.auth_user_id`. profile-admin has NO browser fallback (a missing function is a CORS-less 404, so the app must ship after it is deployed). A login reads and updates only its own profile row (full_name); a super admin reads all. `location_id`, `org_id` and `bo_access` are written only by the service role, i.e. the `profile-admin` edge function (decisions in `_shared/profileAdmin.ts`), `create-user` and `staff-portal`; guard triggers refuse any API change of them, and any move of a `user_locations` row to another venue or user, unless a super admin makes it. Never write those columns from the browser again, never re-add a profile arm to an access rule, and never send an anonymous session to profile-admin (`src/lib/profileAdmin.js` refuses one).
- **Online gift card purchases are server only (18 Sep 2026, 20260918_PLATFORM):** `gift_card_purchases` has one policy, to service_role; the browser reads it only through `gift-list` `{ kind: 'purchases' }` (staff). gift-fulfill stores `code_last4` only, never the plaintext code (it lives on `gift_cards.code_plain`, service role only; gift-resend reads it there).
- **Promo codes are looked up exactly (18 Sep 2026):** promo-redeem accepts only a code shaped like one the platform issues (`_shared/promoLookup.ts`), queries inside the venue's own org, and takes only the row equal to the code. Never pass raw input to `ilike` again.
- **Offers and codes stay in their company (18 Sep 2026, round four):** marketing-admin `save_offer` never upserts on a caller supplied id: no id inserts, an id only UPDATEs an offer that already exists in the caller's own org (`planSaveOffer`); `lookup_code` and `void_code` take an exact code (`normalisePromoCode`, escaped, `pickPromoRow`) and void ONE row by id; promo-redeem loads a code's offer with `org_id` = the venue's org (`offerInOrg`). Online gift purchases are fulfilled on `checkout.session.completed` AND `checkout.session.async_payment_succeeded` (the Connect endpoint must be subscribed to both).
- **Loyalty authority (18 Sep 2026, report first):** loyalty-earn, loyalty-redeem, loyalty-refund and the full reply of loyalty-member-lookup and loyalty-balance need a claimed device of the company, staff with the location, or the member's own token (`_shared/loyalty-authority.ts`). `LOYALTY_AUTHORITY_MODE` unset or `report` allows every call and writes the would be refusals to Ops `caller_authority_log`; only `enforce` refuses. Do not set `enforce` until that log is quiet for real tills, kiosks and online orders. The kiosk's frozen submitOrder gets the member token through `src/lib/memberSession.js`, never by editing submitOrder. Round three: a GOOD member token passes even with no session (portal refresh); a bad or expired one never blocks the staff or device arm; loyalty-refund never accepts a member token (`memberAllowed: false`); loyalty-earn earns from the server's own closed_checks row (`_shared/earnFromCheck.ts`), never from body items or subtotal once the row exists, and online earn sends the closed_checks id, not the display ref. caller_authority_log writes are never awaited and are rate limited (`_shared/authorityLogLimiter.ts`); read it with `supabase/queries/caller_authority_report.sql`.

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

## PAX terminal payments (Ryft)
- **`session.seatedAt` is write-once per occupation.** It is stamped only at session creation and carried (never re-stamped) through transfers. The occupation-aware paid-table guard (migration 20260801) uses `check_draft->>'seatedAt' = session->>'seatedAt'` to prove an approved terminal payment belongs to the CURRENT party — anything that rewrites `seatedAt` mid-occupation silently disables a money guard (or re-opens a double-charge / false-block). Do not add code that re-stamps it on an open session.
- **A terminal assignment is a fence, not a preference.** `terminal_devices.bound_pos_device_id` set → only that till may dispatch to it (client resolver + server 409 `TERMINAL_ASSIGNED_ELSEWHERE`). Unassigned → any till at the venue. Don't re-add "closest/most-recent terminal" fallbacks that ignore foreign bindings.
- **`terminal_devices.ryft_terminal_id` is stamped by EXPLICIT id only** (`ops_terminal_device_id` through ryft-terminals register/adopt, carried forward on re-pair by `claim_terminal_device`). Never reintroduce serial-string matching — the app's ops serial (`AID-…`) and the hardware serial live in different namespaces and can never match.
