# Serv OS / RPOS — session handoff

> **Current build: v5.5.699** · live: https://possystem-liard.vercel.app · dev: https://dev.serv-os.app · repo: **Serv-OS/possystem** (branch `develop`, Vercel auto-deploys).
> Multi-tenant hospitality POS (React 19 + Vite, Zustand, Supabase; no TypeScript, no tests). First customer is UK / GBP.
> **Pillars:** don't break working functionality · resolve the real `locationId` before any DB write (never `loc-demo`) · CSS vars not hardcoded colours · bump `src/lib/version.js` + add a `CHANGELOG` entry in `src/App.jsx` on every web deploy · money is `numeric`, never float.

Read alongside: **`CLAUDE.md`** (architecture/orientation), **`DECISIONS.md`** (ADRs), **`INVARIANTS.md`** (hard rules).

---

## What Serv OS is

A SaaS restaurant/bar POS with many device "surfaces" off one codebase (URL `?mode=…`): POS till, MPOS (mobile), Bar, Floor/Tables, KDS, Kiosk, Orders Hub, Customer Display, **Time Clock**, Back Office, and customer-facing Online/QR/Loyalty/Gift web flows. Two Supabase projects: **Ops DB** `tbetcegmszzotrwdtqhi` (all operational data, scoped by `location_id`, hosts the edge functions) and **Platform DB** `yhzjgyrkyjabvhblqxzu` (orgs, users, loyalty, gift cards). Back-office users authenticate with Supabase Auth; POS/clock/kiosk devices pair to a location and use **anonymous auth**.

---

## Recent arc (this block of sessions)

### Triple item naming actually wired (v5.5.790) — SHIPPED
Owner bug: menu items have three names (POS button / RECEIPT / KITCHEN-KDS) but receipts and the
KDS/kitchen tickets always printed the POS name. Root cause: order lines only snapshotted `name` at
add time — the save/load paths (`receipt_name`/`kitchen_name` columns, SyncBridge/BackOfficeApp/
realtime/useSupabaseInit mappings, config-push snapshot, both item upsert paths) were all already
correct.
- **New resolvers** `kitchenOverride(item)` / `receiptOverride(item)` in `src/lib/itemDisplay.js`:
  return the explicit name ONLY when it differs from the item's base `name` (both save paths default
  the DB columns to the display name, so a populated column ≠ explicitly set). Lines carry the
  override or `null` — synthesized variant line names ("Lager — Pint") and no-override items render
  exactly as before.
- **Line snapshot:** store `addItem` (POS/MPOS/tables), `BarSurface.addToRound` (bar tabs),
  `KioskApp.submitOrder` itemsPayload, `OnlineSurface.addToCart` (+receiptName; feeds online + QR),
  and the online/QR/catering checkout queue-item builders. Names ride into `active_sessions`,
  `closed_checks` and `order_queue` jsonb, so KDS via `routeKioskOrderPrints` and receipt reprints/
  emails from history all see them.
- **Render:** `printer.js` `buildCustomerReceipt`+`buildReceiptHtml` → `receiptName || name`,
  `buildKitchenTicket` → `kitchenName || name`; `sendReceipt.js` (all 3 bodies) → `receiptName ||
  name`. Existing consumers (store `createKdsTickets`/`addRoundToTab`/`transferTable`/
  `routeKioskOrderPrints`, OrdersHub, ReceiptModal) already read the fallback chains.
- POS on-screen order panel + customer-facing surfaces intentionally keep the POS/menu name.
  Modifiers were explicitly out of scope. Verified in dev mock (seed "Soup of the day" → Orders hub
  shows "SOUP"; pre-existing lines unchanged). Build clean.

### Workforce rota — standard shifts, copy shift/week, clash warnings (v5.5.789) — SHIPPED
Owner ask: preset "standard shifts" for speed, copy shifts and whole weeks, and flag holiday/
availability clashes when placing someone. All in `WfRota.jsx` + a new pure helper:
- **Standard shifts:** venue presets (name/start/finish/break/section/colour) stored on
  `wf_venue_settings.settings.shiftTemplates` (jsonb — NO new table). "Standard shifts" button on the
  rota manages them; they render as one-tap prefill chips in the add/edit-shift modal. Saved via the
  full-settings upsert (`saveSettings` writes the whole row — always spread the existing settings).
- **Copy shift:** "Copy" in the shift editor → person + day pickers → draft copy. Rate is
  RE-snapshotted for the target person (`resolveRate`), never carried across.
- **Copy week:** header button → target week picker (default next week) → all shifts cloned as
  DRAFTS via `saveShiftsBulk` (one round-trip). Skips leavers (not in the `loadStaff` list — it
  excludes `status='leaver'`) and copies that would overlap existing shifts in the target week
  (loaded fresh before insert). Jumps the view to the target week; audit-logged (`rota.copy_week`).
- **Clash warnings:** `src/staff/wfClash.js` (pure, unit-tested — `wfClash.test.js`, 6 tests):
  hard shift-overlap block (`findClash`, moved out of WfRota) + soft warnings from APPROVED
  `wf_time_off` rows covering the date and `wf_availability.per_day` (`{day:0..6 Mon-first,
  state:'unavailable'}`). Warnings NEVER block — modal shows "⚠ Jane is on holiday that day" and the
  button becomes "Save anyway"/"Copy anyway"; grid chips of flagged shifts get an amber ⚠. Copy-week
  places flagged shifts but counts them in the results toast ("N with warnings").
- Verified in dev mock mode end-to-end (templates → chip prefill → warning → save anyway → copy
  shift → copy week). Build clean, 248/248 node tests pass.

### Menu-category membership sweep (v5.5.786–788) — SHIPPED
The rule (POS v4.7.6): a category is "in menu M" if `menu_categories.menu_id === M` (primary home)
**OR** a `menu_category_links` row joins it (or its parent) to M. Several surfaces applied only half:
- **v5.5.786 OnlineSurface** — links-ONLY filter dropped home-menu categories with no link row
  (Salads/Sides/Dessert vanished online). Fixed to primary-OR-linked.
- **v5.5.788 sweep of the other surfaces:** **CateringSurface** had the same links-only bug against
  `catering_public_settings.menu_ids` → now primary-OR-linked(-or-parent-linked), keeping the
  no-menus-chosen → show-all legacy path. **MPOS MMenu** had the MIRROR bug (primary `menuId` only,
  links ignored — linked categories showed on POS/bar, never on the phone) → now fetches
  `fetchMenuCategoryLinks()` like BarSurface v5.5.741 and applies primary-OR-linked; search inherits.
  **KioskApp** already had primary-OR-linked; added the missing parent-linked clause for sub-categories.
  KioskSurface = pairing wrapper only (no filtering); BarSurface fixed earlier (v5.5.741).
- **Checklist for any NEW surface that picks categories by menu:** primary `menu_id` OR linked OR
  parent-linked — never links-only, never primary-only.

### Cross-device table reservations (v5.5.740) — SHIPPED (isolated design)
Peter: a reservation made on one POS didn't show on the others. Root cause: `setReservation` only
updated local `store.tables` (`_updateTable`); nothing persisted, and the real-time table sync
(`active_sessions`) only carries tables with an open ORDER.
- **First attempt (REVERTED):** carried reservations as a `{__reserved:true}` marker session inside
  `active_sessions`. Adversarial review found 10 issues — it leaked as phantom occupied/seated/stalled
  tables into the SyncBridge boot loader, SessionReconciler, MasterSync, `rpos-session-backup`,
  `manager-snapshot`, `owner-snapshot`, Back Office overview — and could **overwrite a live order**.
  Reverted whole (nothing shipped).
- **Shipped design:** a DEDICATED, isolated table **`public.table_reservations`** (migration
  `20260707`, applied: unique per loc+table, permissive RLS, REPLICA IDENTITY FULL, in
  `supabase_realtime`) + **`src/sync/ReservationSync.js`** on its own realtime channel. It touches ONLY
  `table_reservations` — never `active_sessions`, SessionSync, the session backup, reports, or the
  snapshots. **Safety invariant:** `_applyReservation`/`_clearReservation` start with
  `if (t.session) return t` — a live order is never wiped/downgraded. Verified by a 2nd review (all
  findings low-severity reservation-robustness; zero live-order risk), then those fixed: `_lastSent`
  latches only after a confirmed write (checks `.error`); `loadReservations` reconciles (heals missed
  realtime events); reconnect + 30s periodic self-heal; flush trigger ignores broadcast echoes
  (`isApplyingRef`). Wired in SyncBridge; `setReservation` stamps `reservedAt`.
- **Design rule going forward:** table-state that must sync and ISN'T a live order gets its own
  table + channel — never overload `active_sessions`.

### AI assistant wired across the system (v5.5.735) — SHIPPED (phase 1)
Peter: assistant said "couldn't find any info" about a donut that went to 86; wants it to answer most questions in detail. Root cause: it could 86 an item but had NO read tool over the 86 list, and `getStoreState` only passed 8 slices.
- **Architecture** (unchanged): `api/ai.js` = stateless proxy (mode foh/boh/rota → allowlist + system prompt → Anthropic). Tools execute CLIENT-side in `src/lib/aiTools.js` `executeTool(name, input, storeState)` — reads the passed store snapshot AND already imports the ops-DB `supabase` client for direct queries. `AIChat.jsx` runs the tool loop + builds `getStoreState()`.
- **7 new read tools** (in aiTools.js + api/ai.js TOOL_DEFINITIONS, added to BOTH ALLOWED_TOOLS_FOH/BOH): `get_86_status` (resolves archived names from DB so a 86'd-then-archived item is never misreported), `get_stock_status`, `lookup_item` (price/allergens/variants/mods/stock/86), `search_activity` (activity_events "when/who did X"), `get_order_queue`, `get_waitlist`, `get_menu_overview`.
- **86 now logs to activity_events** (`store.toggle86` → `logActivity(kind:'stock', actorName:staff)`), so 86 changes show in the bell feed AND `search_activity` finds them going forward. Past 86s have no history but `get_86_status` still reports them + since-when from the `eighty_six.created_at` row.
- **getStoreState widened**: + dailyCounts, orderQueue, waitlist, staffMembers, discountPresets, menus. **Model** bumped `claude-sonnet-4-6` → `claude-sonnet-5`.
- Reviewed by a 15-agent adversarial pass (RLS/columns/model-id/donut path): 11/12 refuted, 1 low finding fixed. DB columns verified vs QueueSync (order_queue) + activity.js (activity_events).
- **DEFERRED (phase 2)**: customers/loyalty + gift cards (Platform DB — the AI's `supabase` is ops-DB only), staff-on-shift (wf_timesheets — RLS review), deliveries (courier_deliveries), full report tools, and a "reason" field on 86. Can't live-test locally (needs the deployed ANTHROPIC_API_KEY) — Peter verifies on dev.

### Menu-cache-on-sign-in + per-user checkout (v5.5.734) — SHIPPED
Two fixes shipped together.
- **Category flicker on every login (Peter reported "categories move around then move back").** Root cause: `<SyncBridge>` is rendered in BOTH the PIN-screen and signed-in branches (App.jsx:8651 + :8660), so it **remounts on every login** and re-runs boot hydration — which applied the pushed config snapshot (correct order) then let a parallel direct DB re-fetch overwrite `menuCategories` with a DB-ordered copy. Fix: the pushed snapshot is now **authoritative** for menu data; `SyncBridge` guards the DB-fetch writes for menuItems/menuCategories/menus/modifierGroupDefs with `!snapHas(k)` (DB is a fallback only when nothing was pushed). A new Push to POS still refreshes via realtime. This is the "cache the menu, only refresh on push, function locally" model Peter asked for.
- **Per-operator counter checkout on a shared till.** Switch operator → outgoing person's in-progress COUNTER order (`walkInOrder` + customer/orderType/pendingLoyaltyReward/deliveryQuote) is PARKED under their staff id (`heldOrders`), incoming person gets their own held order back (toast "Your held order is back — N items") or a clean empty checkout. Table orders untouched (live on `tables[].session`). Pure logic + 14 tests in `src/lib/cartHold.js`; store `login`/`logout` call `operatorSwitchPatch`/`logoutPatch`. In-memory holds (like walkInOrder itself — ephemeral until sent/paid).
- **4 regressions caught by adversarial review + fixed before ship** (all verified CLOSED by a second review): (HIGH) card-swap mid-payment nulling the live cart → CardUserSwitch refuses to switch while `_signoutBlock > 0`; (HIGH) card-swap with a table open destroying the dormant counter cart → `hasHoldableCart` no longer gates on `activeTableId`; (HIGH) sent-but-unpaid order double-recorded (held + Orders Hub) → sent orders (`sentAt`/`ref`) are never parked, they stay in Orders Hub; (MED) pay/send auto-sign-out timer signing out the NEXT operator → identity check + `login`/`logout` cancel the pending `_autoSignoutTimer`. ⚠ Known residual (accepted): `BarSurface.captureHeldTab` charges without holding `_signoutBlock`, but a swap there can't orphan the charge (record built from the `tab` closure, not live state).

### Per-device auto sign-out policy (v5.5.731 + v5.5.732 guard) — SHIPPED
Peter: "program user behavior … sit on a device profile level. How do users log out: Manually (scan another card / user-icon logout), Timed (15-second increments of no activity), or by cashing off / clicking send on an order." Manual card-swap already existed (`CardUserSwitch`). Added the other two triggers, configurable per device profile.
- **Migration** `supabase/migrations/20260702_signout_policy.sql` (APPLIED): `device_profiles += signout_idle_seconds int / signout_on_pay bool / signout_on_send bool` (all default off → existing tills unchanged).
- **BO** `DeviceProfiles.jsx`: DB↔profile map both ways + new-form defaults + a "Sign-out behaviour" editor (idle `<select>` Off…5min in 15s steps + on-pay / on-send toggles).
- **Boot** `App.jsx` config builder threads `deviceConfig.signout = {idleSeconds,onPay,onSend}`.
- **Idle trigger** = `<AutoSignout>` component in the POS staff shell (next to `<CardUserSwitch>`): pointerdown/keydown/wheel/touchstart re-arm the timer; on fire it `logout()` + toast. Guarded ≥5s.
- **Pay/send trigger** = store `maybeAutoSignout('pay'|'send')` — 1.4s after the confirmation toast, re-checks `staff`, then `logout()`. Hooked after "Sent to kitchen" (send) + in `recordClosedCheck` and the walk-in pay path (pay).
- **v5.5.732 payment-safety guard (important):** a re-entrant store counter `_signoutBlock` + `blockSignout()/unblockSignout()`. `CheckoutModal` and `TabPreAuthTerminal` hold it while mounted, so a customer taking >15s to tap the reader (NOT POS DOM activity) can't trip the idle timer, unmount checkout, and orphan a charge. While held, the idle timer **re-arms instead of logging out** → a genuinely-idle till still signs out once the payment finishes. `maybeAutoSignout` is intentionally NOT blocked (it fires only after the payment completes).

### ServOS Manager app — NEW surface `?mode=manager` (v5.5.694) — ALL 5 TABS LIVE (read); writes deferred
The owner app + ops tablet merged into one **role-adaptive phone app** (Capacitor store build later; separate from the Sunmi POS APK). Build prompt: `ServOS Manager - Claude Code prompt.md`; design: `ServOS Manager - design spec.html` (reuse the existing `[data-skin=servos]` glass system — confirmed, no new CSS).

**Done (additive, shipped, 194 tests green):**
- **Pure engine + tests** in `src/lib/manager/`: `floor.js` (open-table states + the configurable **stalled** rule), `team.js` (on-shift / no-show / break-due / live labour pennies), `timesheets.js` (anomaly flags), `kitchen.js` (below-par + 86 + batch status), `access.js` (role→tab flags per §3 presets + per-person permission overrides). Each `*.test.js`.
- **Surface** `src/surfaces/ManagerSurface.jsx` + `src/surfaces/manager/*` — mirrors `OperationsSurface` boot (pairs via **ops_devices** claim-code + heartbeat → staff PIN via `opsPinLogin`), floating bottom tab bar (Home/Reports/Team/Ops/Kitchen) gated by role, dark/light toggle, `CardErrorBoundary`. **All 5 tabs now render LIVE data** (read-only): Home glance, Reports (takings + floor + stalled nudge), Team (on-shift/no-shows/breaks/live labour), Ops (compliance/maintenance/alerts, reuses `lib/ops/data`), Kitchen (below-par stock by supplier). Management *writes* (approvals, raise-PO, batch cooks) are the remaining slices.
- Wired: `App.jsx` dispatch (`deviceMode==='manager'` → `<KioskAutoUpdate/><ManagerSurface/>`) + import; ModeSelector "Manager" card.
- **(v5.5.692) `manager-snapshot` edge fn DEPLOYED + Reports/Team LIVE.** `supabase/functions/manager-snapshot/index.ts` (single venue, `requireToken` + fence: device claimed to this loc via `ops_devices.device_uid=auth.uid()` **+ `active=true`** (v5.5.693 hardening — a decommissioned till can't read takings), or `user_locations`/super_admin). Returns today money (net=`closed_checks.subtotal` ex-VAT, mirrors owner-snapshot), live floor (`active_sessions.session`→`floor.js`), live team (`wf_timesheets`+today `wf_shifts`+`wf_staff` names+`effective_rate`→`team.js`), and (v5.5.693) **kitchen** (below-par stock — see next). Client: `src/lib/manager/data.js`. ⚠ tz: reads `locations.timezone` from OPS DB (owner-snapshot uses PLATFORM) — defaults Europe/London (fine for the UK customer; revisit for non-UK).
- **(v5.5.693) Kitchen LIVE (read-only).** Snapshot returns a `kitchen.items` block from the **greenfield stock system** (`inventory_items` + `par_levels` + `suppliers`, all confirmed live in ops DB — 6 tracked items, 1 par). `ManagerKitchen` renders below-par/reorder stock grouped by supplier (one PO each) via the tested `kitchen.js` `belowPar`/`bySupplier`. The kitchen read is isolated (`try/catch` → `[]`) so a stock-read failure never breaks money/floor/team. NOTE: `eightySixed` is hard-`false` for ingredients (the `eighty_six` table keys menu items, not inventory items) — fine for v1; 86-overlay is a later enhancement. **`prep_schedule` does NOT exist** (confirmed) — batch cooks need that NEW additive table.
- **(v5.5.694) Live Home + shared snapshot.** Snapshot lifted into `ManagerSurface` (one 30s poll, passed via `ctx.snap`/`ctx.snapErr`/`ctx.refreshSnap`); Home/Reports/Team/Kitchen all read it → **instant tab switches, single network call**. **ManagerHome** now a live "at a glance": net-sales (ex-VAT) hero + pulse tiles (open tables / on shift / to order), each role-gated and tapping to its tab; reuses `classifyFloor`/`onShiftNow`/`belowPar` so the numbers match the detail tabs.
- **(v5.5.695) Ops FOLDED IN — full writes, ONE codebase (per Peter's "remove the standalone OPS view … so there isn't multiple surfaces to manage").** Extracted `OperationsSurface`'s post-auth body into a shared exported **`OpsContent({loc,venueName,operator,onLogout,chrome})`**. Standalone `?mode=ops` renders `<OpsContent chrome />` (AppShell header+bell — unchanged); **Manager Ops tab** (`ManagerOps.jsx`) renders `<OpsContent chrome={false} />` bare inside the Manager Shell, alerts via a bell on the Ops Home card. Manager Ops is now the FULL interactive Ops (temp rounds + breach→corrective→auto-maintenance, opening/closing/cleaning checklists w/ photo sign-off, goods-in delivery checks, maintenance, alerts) — replaced the old read-only dashboard. Writes go through the same location-fenced `lib/ops/data` + `lib/ops/checklists`. Adversarial review (10 agents): **6 raised, 0 real**. Theme: OpsContent does NOT force the dark skin (only the standalone default does) → embedded follows the Manager light/dark toggle. **`?mode=ops` kept working — NO prod cutover** (entry point + ModeSelector "Ops" card still there). ⚠ **Open decision:** whether to fully retire the `?mode=ops` entry/ModeSelector card now that the Manager app covers it (staff PIN = Home/Ops/Kitchen). ⚠ **Pre-existing gap (flagged, NOT fixed here):** ops writes don't honour training mode — but `isTrainingMode()` can't be true on `ops_devices`-paired devices (training flag is `device_profiles`-only), so it never fires; do a dedicated guard pass if ops ever runs on a training till.
- **OUT (decided this turn):** owner-reports-as-home / multi-venue switch — Peter: "that looks more hard to do, leave that one out." Single venue stays.

**Verification of the money/auth endpoint:** adversarial review workflow `wf_196d11bb-be7` (26 agents) — **23 raised, 0 confirmed real**. Money mirrors owner-snapshot, the 3-path fence holds, data shapes align. Two noted-not-fixed: (a) `active`-flag hardening → applied v5.5.693; (b) floor `lastFiredAtMs` = `session.sentAt` is the FIRST kitchen send, so the "stalled since last course" heuristic measures since-first-send (the session shape has no per-course fire timestamp — fixing needs POS-core/store changes, out of additive Manager scope).

**Build-out of the 4 mockup functions (Peter picked all four, 29 Jun):**
- **(v5.5.697) Role tick-boxes DONE** — `StaffManager.jsx` PERM_GROUPS got a "Manager app" group (`manager_reports/team/approvals/ops/kitchen`); per-person overrides on top of the role preset, persisted via the existing `togglePerm`/`permissions text[]` path. No migration.
- **(v5.5.697) Home bento DONE** — `ManagerHome.jsx` rebuilt to the "balanced dashboard" mockup: takings hero (ex-VAT) + sub-stats, "needs you now" bar, live 2×2 status bento (Floor/Team/Ops/Kitchen), all role-gated from `ctx.snap` + the engines.
- **(v5.5.697) Kitchen incoming DONE** — snapshot adds `kitchen.deliveries` (open SENT/PARTIAL POs + delivery status) + `ops{openMaintenance,activeAlerts}`; `ManagerKitchen.jsx` shows "on order · incoming". Goods-in CHECK stays in Ops → Deliveries.
- **(v5.5.698) Team approvals DONE — PIN-secured.** New `manager-approve` edge fn (deployed): double-fenced — device authorised for venue + the approver **resolved server-side from their PIN** (re-matched against `staff_members`; NEVER a client-supplied id) + must be Manager/Owner or have `manager_approvals`. Writes `wf_timesheets.status='approved'` / `wf_time_off.status='approved'|'denied'` + appends `wf_audit` under the resolved person. Snapshot `team` now returns `pendingTimesheets`+`pendingTimeOff`. `ManagerTeam` Approvals section is PIN-locked until a manager unlocks. ⚠ An adversarial review CAUGHT a real privilege-escalation/audit-forgery hole (client-supplied operator_id) → fixed by PIN re-verification + re-verified `fixed=true`. Residual (non-blocking): no DB unique on `staff_members(location_id,pin)` (PINs assumed unique per location, matches ops_pin_login).
- **(v5.5.699) Kitchen batch cooks DONE — migration APPLIED (Peter authorised 29 Jun).** New `20260629_prep_schedule.sql` → **`prep_schedule`** (recurring template, RLS = `user_accessible_locations`, BO-edited) + **`prep_log`** (daily completion, RLS = `ops_can_write` so a claimed device can record). `src/lib/prep.js` (fetch/save/delete schedule + `recordPrep` — training-gated, upsert one-per-day on `(location_id,schedule_id,prep_date)`). Snapshot `kitchen.batches` = today's scheduled prep (today's weekday via `days_of_week` 0=Sun..6=Sat; null/empty=every day) + today's `prep_log`, passing raw dueDate+dueTime (client builds dueAtMs in venue tz). `ManagerKitchen` "Batch cooks · today" via `kitchen.js` `groupBatches` (overdue/due/done) + one-tap **Record**. NEW BO screen **`OpsPrepSchedule.jsx`** (Operations → Prep schedule) wired in `BackOfficeApp.jsx`. **ALL 4 mockup functions now done.**
- **Still not built:** raise-PO from the app (goods-in/check stays in Ops → Deliveries); Capacitor packaging.
5. **Multi-venue — OUT OF SCOPE (decided).** The Manager app runs **one venue** (the paired location); no venue switcher, no cross-location rollups. An owner with multiple sites uses the (more complex) web Back Office. `multi_venue` removed from `access.js` (v5.5.691).
6. **Capacitor packaging** (iOS + Android store builds, push for no-shows/approvals, secure token storage, biometric unlock) — native, needs tooling + Apple/Play accounts; Sunmi POS APK path untouched.

**Reuse map** (full): workflow `wh82a4sfc` output — `tasks/wh82a4sfc.output`. **Guardrails:** out-of-scope = payments/checkout, POS core, KDS, courier/delivery seam, broad RLS pass — stop & ask.

### 0. MPOS Android app (NEW, v5.5.474) + phone Tap-to-Pay verdict
**Android MPOS app shipped as an order-taker.** The `:mpos` Gradle module (own `applicationId co.posup.rpos.mpos`, own CI `build-mpos.yml`) is a thin WebView → `?mode=mpos`, same "one module per device app" pattern as `:app`/`:menuboard`. Card payments use the surface's existing flows (assigned WisePOS/Ryft reader, or simulated). **No native Tap to Pay on Android** — the customer is standardising on **Ryft, which has no Android SoftPOS**. Doc: `android/MPOS_TAP_TO_PAY.md`. Pending: its own app icon (the "S. MPOS" mark) — placeholder icons in place until the asset file is dropped.

**Phone Tap-to-Pay decision is OPEN (verified June 2026, run `wf_26d03500-f0a`).** Adversarially confirmed (3/3 voters): **Ryft Tap to Pay on iPhone does NOT exist** — Apple's UK Tap-to-Pay-on-iPhone PSP list (https://developer.apple.com/tap-to-pay/regions/) excludes Ryft; Ryft's iOS SDK is in-app card + Apple Pay only; Ryft in-person = PAX hardware terminals. So "tap on the phone, no hardware" is **only** buildable via **Stripe** (iPhone via Stripe Terminal iOS SDK, or the Android Stripe-Terminal route), which means **Stripe as a second in-person processor** alongside Ryft. To stay 100% on Ryft, the only option is a **Ryft PAX terminal (extra hardware)**.
- **Reusable for whichever phone-tap path:** the `window.RposTapToPay` bridge contract, `src/lib/tapToPay.js`, and the `MCardFlow.jsx` native branch are processor/OS-agnostic (an iOS Swift `WKWebView` + `TapToPayBridge.swift` implements the same contract; the web side is reused). The Android-native Stripe Terminal layer built earlier this session was **removed** when scope changed to "order-taking Android app"; it's recoverable from git history if the Stripe-on-Android path is chosen.
- **Decision needed from user:** (a) "phone, no hardware" ⇒ Stripe (iPhone or Android) + accept a 2nd processor; or (b) "all in-person on Ryft" ⇒ Ryft PAX terminal + accept hardware. Then: iPhone (App Store/TestFlight, Apple entitlement, no sideload) vs Android (sideloadable today).

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
