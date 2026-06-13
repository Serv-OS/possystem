# CLAUDE.md — RPOS Persistent Knowledge Base

> **Read this file at the start of every session before touching any code.**
> Also read: `DECISIONS.md`, `INVARIANTS.md`, `CURRENT_WORK.md`

---

## Project Overview

**RPOS** — Restaurant OS. A multi-tenant, multi-device SaaS POS system for hospitality.
Live at: https://possystem-liard.vercel.app
GitHub: Serv-OS/possystem
Current version: see `src/lib/version.js` (currently v5.5.468)
Codebase: ~97,000 lines across 246 source files

**Product surfaces:**

| Surface | Entry Point | Description |
|---|---|---|
| POS | `?mode=pos` | Front-of-house terminal for taking orders (counter, bar, table service) |
| Back Office | `?mode=office` | Menu management, floor plan, reports, staff, settings, loyalty, gift cards |
| KDS | `?mode=kds` | Kitchen display system — ticket-based order flow for kitchen/bar |
| Bar | `?mode=bar` | Bar tabs surface — open/close tabs, quick ordering |
| Tables | `?mode=tables` | Floor plan — table management, seat tracking, course firing |
| Kiosk | `?mode=kiosk` | Self-service ordering kiosk with Stripe Terminal card reader |
| MPOS | `?mode=mpos` | Mobile POS for tableside ordering (phone/tablet) |
| Time Clock | `?mode=clock` | Dedicated staff clock in/out + breaks tablet (PIN → server-side timesheets) |
| Orders Hub | `?mode=orders` | Live order queue for collection/delivery |
| Online Ordering | `/online/:slug` | Customer-facing web ordering (pickup/delivery) |
| Customer Portal | `/customer/*` | Loyalty portal — points, rewards, stamp cards |
| Gift Cards | `/gift/*` | Purchase, check balance, and manage gift cards |
| QR Order | `/qr/*` | QR code table ordering for dine-in customers |
| AI Assistant | `?mode=ai` | Claude-powered shift assistant for staff |
| Owner App | `?mode=owner` | Mobile owner snapshot — top-down KPIs across all accessible locations (back-office login; URL-bookmarked PWA, not a paired device) |
| Review card | `/review` | Customer-facing branded review card (Review Manager) |
| Menu Board | `?mode=menuboard` | Digital menu board for a TV / Android-TV stick. Pairs to a board via a code shown on screen (or open `?board=<id>` directly); auto-fits to one screen and live-updates on publish |

---

## Tech Stack

| Layer | Technology |
|---|---|
| UI | React 19 + Vite 8 (no TypeScript) |
| State | Zustand 5 (single store in `src/store/index.js`, ~4500 lines) |
| Database | Supabase (Postgres + Realtime + Storage + Edge Functions) |
| Auth | Supabase Auth (back office) + device pairing (POS) + anonymous auth (kiosk/online) |
| Payments | Stripe Terminal (in-person) + Stripe Checkout (online) |
| Deploy | Vercel (frontend on `develop` branch) + Supabase Edge Functions |
| Print | Node.js print agents (`print-agent.js`, `print-bridge.js`) — ESC/POS thermal |
| SMS | Twilio via `send-sms` edge function (OTP, receipts, marketing) |
| Mobile | Android WebView wrapper in `android/` for Sunmi hardware; sideloaded + **self-updating** via Supabase Storage (see `android/RELEASING.md`) |
| PWA | `public/manifest.json` + `public/sw.js` |
| AI | Claude API via Vercel serverless (`api/ai.js`) |

**No test framework. No TypeScript. No SSR.**

---

## Folder Structure

```
src/
  App.jsx              — Root router, surface switcher, CHANGELOG array (~5950 lines)
  main.jsx             — React entry point, ErrorBoundary
  store/index.js       — Single Zustand store (~4500 lines); DB writers, all shared state
  lib/
    supabase.js        — Two Supabase clients (ops + platform); tenant fence; location resolution
    db.js              — Data access layer (upsert*, decrement/restore stock RPCs)
    version.js         — Single source of truth for version string
    realtime.js        — Supabase Realtime subscriptions (sessions, 86, stock, config)
    i18n.js            — Internationalisation (multi-language kiosk/online)
    stripe.js          — Stripe Terminal SDK integration
    stripeClient.js    — Stripe.js client for online payments
    tax.js             — Tax calculation logic
    serviceCharge.js   — Service charge logic (auto/manual, percentage/fixed)
    discountEngine.js  — Discount application engine (item/order/BOGO/category)
    printer.js         — ESC/POS print formatting (receipts, kitchen tickets)
    receiptRaster.js   — Receipt rasterization for Sunmi built-in printer
    receiptBranding.js — Custom logo/header/footer on receipts
    sendReceipt.js     — Email/SMS receipt delivery
    customerLookup.js  — Customer search + loyalty member detection
    openingHours.js    — Location opening hours logic
    itemAvailability.js— Menu item availability rules (daypart, schedule)
    itemDisplay.js     — Display name resolution (menuName/kitchenName/receiptName)
    locationTime.js    — Timezone-aware date helpers
    orderChime.js      — Audio notification for new orders
    aiTools.js         — AI assistant tool definitions for Claude
    forceCancelReader.js— Force-cancel stuck Stripe Terminal actions
    networkReader.js   — Network reader discovery and registration
    readerDisplay.js   — Stripe reader display management
    qrTabStorage.js    — QR table ordering session persistence
    qrTableSession.js  — QR table session management
  surfaces/
    POSSurface.jsx     — Main POS UI (~2100 lines)
    CheckoutModal.jsx  — POS checkout flow (~1400 lines) — payments, split, tips, loyalty
    BarSurface.jsx     — Bar tabs surface
    TablesSurface.jsx  — Floor plan / table management
    KioskApp.jsx       — Self-service kiosk (~4000 lines) — full ordering flow
    KioskProductModal.jsx — Kiosk item configurator (~1200 lines) — modifiers, variants, stock
    KioskSurface.jsx   — Kiosk boot/pairing wrapper
    MPOSSurface.jsx    — Mobile POS for tableside
    OrdersHub.jsx      — Live order queue management
    OtherSurfaces.jsx  — KDS, collection queue, order tracker
    PINScreen.jsx      — Staff PIN login
    PairingScreen.jsx  — Device pairing flow
    DeviceSetup.jsx    — Initial device setup
    ModeSelector.jsx   — Surface selection screen
    CustomerBoot.jsx   — Customer-facing URL router
    online/
      OnlineSurface.jsx     — Online ordering storefront
      OnlineCart.jsx         — Online cart UI
      OnlineItemSheet.jsx   — Online item detail/configurator
      OnlineCheckout.jsx    — Online checkout (~1700 lines) — gift cards, loyalty, Stripe
      OrderTracker.jsx      — Customer order tracking
    customer/
      CustomerPortal.jsx    — Loyalty portal (points, rewards, stamp cards)
    gift/
      GiftPurchaseSurface.jsx — Buy gift cards online
      GiftBalanceSurface.jsx  — Check gift card balance
      GiftSuccessSurface.jsx  — Post-purchase confirmation
    qr/
      QrCheckout.jsx         — QR code table ordering checkout
      TabResumeScreen.jsx    — Resume existing QR tab
  backoffice/
    BackOfficeApp.jsx       — Back office root, auth, navigation, "Push to POS"
    sections/
      MenuManager.jsx       — Menu, categories, items, modifiers (~3100 lines)
      LoyaltyManager.jsx    — Loyalty program setup (~2100 lines)
      GiftCards.jsx          — Gift card management (~1700 lines)
      Customers.jsx          — Customer database and profiles
      DeviceProfiles.jsx     — Terminal/kiosk device configuration
      DeviceRegistry.jsx     — Registered devices list
      KioskRegistry.jsx      — Kiosk device management
      KioskSettings.jsx      — Kiosk branding, menus, timeouts
      CardReaders.jsx        — Stripe Terminal reader management
      OnlineOrdering.jsx     — Online ordering settings
      DiscountManager.jsx    — Discount/promo code management
      StaffManager.jsx       — Staff accounts, roles, PINs
      FloorPlanBuilder.jsx   — Drag-and-drop table layout editor
      LocationSettings.jsx   — Location details, hours, branding
      BOReports.jsx          — Reports hub
      Transactions.jsx       — Transaction history browser
      Inventory.jsx          — Stock/inventory management
      Items.jsx              — Global item library
      TaxManager.jsx         — Tax rate configuration
      PrintRouting.jsx       — Print station/ticket routing rules
      PrinterRegistry.jsx    — Printer discovery and pairing
      ReceiptBranding.jsx    — Receipt logo/header/footer customisation
      EODClose.jsx           — End-of-day close-out
      Shift.jsx              — Shift management
      CashDrawers.jsx        — Cash drawer reconciliation
      PettyCash.jsx          — Petty cash tracking
      Challenge21.jsx        — Age verification (Challenge 21/25)
      Challenge21Report.jsx  — ID check audit log
      CompanyAdmin.jsx       — Company/org settings
      MultiLocation.jsx      — Multi-location management
      PerMenuPricingTiers.jsx — Per-menu pricing overrides
      CanvasMenu.jsx         — Visual menu editor
      MenuVisualizer.jsx     — Menu structure visualiser
      MessageTemplates.jsx   — SMS/email template editor
      NetworkStatus.jsx      — Device connectivity dashboard
      AIAssistantSection.jsx — AI assistant settings
      reports/               — 20 report modules (sales, product mix, tax, tips, etc.)
  components/          — Shared modals and UI widgets (~30 components)
  sync/
    SyncBridge.jsx         — Boot loader, BroadcastChannel sync, data mapping
    SessionSync.js         — Table sessions → Supabase on change
    SessionReconciler.js   — 10s poll for cross-device session consistency
    OfflineQueue.js        — Durable write queue for offline resilience
    QueueSync.js           — Order queue sync
    DataSafe.js            — Pending check reconciliation on reconnect
    MasterSync.js          — Master/child device heartbeat
    PrintOrchestrator.js   — Multi-printer job routing
    PrintRetrier.js        — Failed print job retry logic
  data/                — Seed data and mock items for dev/mock mode
  styles/globals.css   — CSS custom properties, kiosk theming
api/
  ai.js                — Vercel serverless: Claude AI endpoint
supabase/
  functions/           — 60+ Supabase Edge Functions (Deno/TypeScript); all verify_jwt=false, each enforces its own tenant fence
    _shared/           — Shared utilities (CORS, auth, HMAC, gift card helpers, review-platforms, google-reviews)
    gift-*             — 14 gift card functions (issue, redeem, void, balance, etc.)
    loyalty-*          — 8 loyalty functions (earn, redeem, OTP, rewards, etc.)
    stripe-*           — 13 Stripe functions (payments, readers, webhooks, etc.)
    send-receipt       — Email receipt delivery
    send-sms           — Twilio SMS (OTP, receipts)
    send-welcome       — New loyalty member welcome message
    wallet-pass        — Apple/Google Wallet pass generation
    create-user        — Platform user provisioning
    workforce-compute  — Server-side pay/tronc/holiday-accrual/labour (service-role; tenant-fenced; tamper-evident audit)
    workforce-clock    — Time Clock punches: PIN→staff_members→wf_timesheets (server-side; breaks; rate snapshot)
  workforce-onboarding — Contract e-sign (public /sign/<token> page)
  trading-report     — Daily Trading P&L (forecast + same-weekday-LY; sales/VAT/COGS/labour/overhead ladder)
  owner-snapshot     — Owner app (?mode=owner) multi-location top-down snapshot in one call
  review-*           — Review Manager: review-admin / sync / reply / submit / request / google (one-time platform OAuth)
  ryft-* / payments-* — Ryft dual-processor payments (card-present, tabs, refunds, disputes) + onboard/admin/processor
```

---

## Two Supabase Projects

| | Ops DB | Platform DB |
|---|---|---|
| Project ID | `tbetcegmszzotrwdtqhi` | `yhzjgyrkyjabvhblqxzu` |
| Purpose | All POS operational data | Company/user/org management, gift cards, loyalty |
| Client | `supabase` from `lib/supabase.js` | `platformSupabase` from `lib/supabase.js` |
| Auth | Supabase Auth (back office users) | Supabase Auth (platform admins) |
| Edge Functions | Hosted here (44 functions) | — |
| Location UUID | `7218c716-eeb4-4f96-b284-f3500823595c` | — |
| Company UUID | `a1b2c3d4-0001-0001-0001-000000000001` | — |

**Key Platform DB tables:** `gift_cards`, `gift_card_transactions`, `gift_brand_config`, `loyalty_members`, `loyalty_points_log`, `loyalty_rewards`, `loyalty_stamp_cards`, `user_company_roles`, `companies`

**Key Ops DB tables:** `menu_items`, `menu_categories`, `menus`, `modifier_groups`, `active_sessions`, `closed_checks`, `floor_tables`, `config_pushes`, `stock_levels`, `eighty_six`, `locations`, `device_profiles`, `pos_devices`, `order_queue`, `staff_members`, `user_profiles`, `user_locations`, `discount_definitions`, `tax_rates`, `menu_boards` (digital menu-board screens/content), `menu_board_screens` (paired physical TVs — device-scoped RLS + `claim`/`set`/`heartbeat` SECURITY DEFINER RPCs)

**Workforce tables (18, prefix `wf_`):** `wf_staff` (HR, org-scoped PII), `wf_roles` (positions/rate card), `wf_sections`, `wf_venue_settings`, `wf_shifts` (rota), `wf_timesheets` (clock vs scheduled), `wf_holiday_accrual` (append-only ledger), `wf_time_off`, `wf_availability`, `wf_tronc_runs` + `wf_tronc_lines`, `wf_documents` (compliance), `wf_sales_forecast`, `wf_user_roles`, `wf_audit` (append-only, hash-chained), `wf_swap_requests`, `wf_onboarding`, `wf_announcements`. Real tenant RLS via `user_accessible_locations()` / `user_accessible_orgs()`. Schema: `supabase/migrations/20260608_workforce.sql`. See Workforce in the Key Feature Systems section.

---

## Key Feature Systems

### Payments
- **In-person:** Stripe Terminal via `stripe-process-payment-on-reader` edge function → poll → confirm. Supports counter POS, bar, and kiosk. Reader assignment per device profile.
- **Online:** Stripe Checkout Sessions via `stripe-create-payment-intent`. Supports card, Apple Pay (future).
- **Split payments:** Split by amount, by item, or equal split on POS.
- **Gift card payments:** Full or partial payment on POS, kiosk, and online. Partial gift card auto-applies available balance and collects remainder by card.

### Stock & 86 System
- **Stock tracking:** `stock_levels` table (`par`, `remaining` per item per location). Decremented via atomic `decrement_stock` Postgres RPC.
- **86 (out of stock):** `eighty_six` table tracks operator-marked items. Kiosk/online hide or grey out 86'd items.
- **Stock decrement sources:** POS (via store `addItem` → `decrementDailyCount`), kiosk (`submitOrder` calls `decrementStockRPC`), online checkout (both payment paths call `decrementOnlineStock`).
- **Cross-browser 86 sync:** Three independent signals — (1) `eighty_six` Realtime subscription, (2) `stock_levels` remaining ≤ 0 auto-86, (3) 30-second periodic re-fetch. Modifier options also check 86 status via name-matching fallback.

### Loyalty System
- **Points-based:** Earn points on purchases (configurable per-£ rate). Redeem for rewards (discounts, free items).
- **Stamp cards:** Digital stamp cards with configurable stamps-to-reward ratio.
- **OTP verification:** Phone-based login via SMS OTP for kiosk/online loyalty access.
- **Customer portal:** Web portal for members to view points, rewards, stamp cards.
- **Wallet passes:** Apple Wallet + Google Wallet pass generation.
- **Cross-surface:** Works on POS (checkout modal), kiosk (loyalty screen), and online (rewards step).

### Gift Card System
- **Issuance:** Back office manual issue, bulk create, or customer self-purchase online.
- **Redemption:** POS checkout, kiosk (linked cards via OTP + manual code entry), online checkout.
- **Security:** HMAC-SHA256 code lookup index with per-org secret. Three-tier fallback: HMAC → card_id → code_plain.
- **Partial payment:** Automatically applies available balance; remainder collected by card reader.
- **Management:** Back office gift card dashboard — issue, void, view transactions, resend.

### Multi-Device Sync
- **Config Push:** Back office broadcasts menu/config snapshot to all POS devices via `config_pushes` table + Realtime.
- **Session Sync:** Open table sessions written to `active_sessions` on meaningful change. `SessionReconciler` polls every 10s as fallback.
- **BroadcastChannel:** Same-machine multi-tab sync for shared state keys.
- **Master/Child:** `MasterSync` heartbeat between primary and secondary devices.
- **Offline resilience:** `OfflineQueue` buffers writes when Supabase is unreachable; replays on reconnect.

### Printing
- **Print routing:** Configurable print stations (bar, kitchen, receipt). Rules by category, order type, or item.
- **Protocols:** ESC/POS thermal printing via Node.js print agents. Sunmi built-in printer via Android bridge.
- **Receipt branding:** Custom logo, header, footer, social media links.
- **Retry:** `PrintRetrier` auto-retries failed print jobs.

### Kiosk System
- **Full ordering flow:** Order type → menu → item config → cart → tip → loyalty → payment → confirmation.
- **Branded theming:** Custom colors, logo, banners per location via `[data-kiosk-theme]` CSS vars.
- **Multi-language:** `i18n.js` supports multiple languages with operator-configured translations.
- **Stock enforcement:** Menu grid shows "Sold out" for 86'd items. Product modal enforces stock limits on qty selector and modifier options. Modifier options checked via both `itemId` link and name-matching fallback.
- **Stripe Terminal:** Server-driven card payment via edge function → reader → poll → confirm.
- **Allergen filtering:** Customer-facing allergen picker highlights items containing selected allergens.

### Online Ordering
- **Storefront:** Menu browsing, item configuration, cart management.
- **Checkout:** Customer details → gift card → loyalty rewards → Stripe payment.
- **Order tracking:** Real-time order status tracking page.
- **Configurable:** Per-location enable/disable, order types (pickup/delivery), service charges.

### Reporting (24 reports)
Sales Summary, Product Mix, Payments, Tax, Tips, Servers, Tables, Menu Engineering, DailyTrend, Daypart, Item Trend, Order Types, KDS Performance, Shifts, Cash Drawer, Z Report, Catalog, Loyalty, Exceptions, Location Compare, **Daily Trading (P&L)**, **Payroll**, Card Payments & Payouts (Ryft), Disputes.
- **Daily Trading (P&L)** (`reports/DailyTrading.jsx` + `trading-report` edge fn) — operator sets a per-day forecast (suggests same-weekday-last-year); full P&L ladder **gross takings → less VAT (HMRC, never profit) → net sales → less COGS (configurable %) → gross profit → less labour (theoretical rota vs actual timesheets) → less overhead → operating profit**. VAT from `closed_checks.tax_amount`; gross = net + VAT. COGS%/overhead in `wf_venue_settings.settings`. Net sales (ex-VAT) is the P&L revenue basis.
- **Payroll** (`reports/PayrollReport.jsx`) — closed `wf_payroll_runs`: per-run wages/tips, per-staff breakdown, CSV.

### Workforce / Staff Management (Back Office → Workforce)
- **Per-location** staff-management module: Dashboard, Rota, Timesheets, Time off & availability, Staff, Onboarding, Compliance, Positions & rates, Tronc/tips, Announcements, Settings. It follows the BO location selector (no per-module venue switcher; multi-site rollups belong in Reports).
- **Front end:** router `src/backoffice/sections/Workforce.jsx`; sections in `src/backoffice/sections/workforce/*`; data layer `src/staff/wfData.js`; shared UI `src/staff/wfUi.jsx`; week model `src/staff/wfWeek.js`; labour maths `src/staff/labour.js`.
- **Live financials:** money is `numeric` + currency-stamped; pay rate/source snapshotted onto shifts/timesheets; FKs onto staff are `ON DELETE RESTRICT` with soft-delete (`status='leaver'`); `wf_audit` + `wf_holiday_accrual` are append-only.
- **Server-side compute** (`workforce-compute` edge fn, service-role): `tronc.run` (largest-remainder, penny-exact), `accrual.run` (12.07% statutory), `pay.period`, `labour`. The client never computes money for the record.
- **Flow:** add staff → "Set as POS user" (links `wf_staff.pos_user_id` ↔ `staff_members`) → build + publish rota → clock in/out → approve timesheets → pay/tronc/accrual.

### Time Clock (`?mode=clock`)
- Dedicated second-tablet surface (`src/surfaces/TimeClockSurface.jsx`): PIN pad → status → Clock in / Start break / End break / Clock out. Pairs to a location like a POS.
- Punches write **server-side** via `workforce-clock` (validates PIN against `staff_members` for the location — PINs never reach the client; maps to `wf_staff`, auto-creating an HR record if needed; tracks breaks via `wf_timesheets.break_open_at`; snapshots rate; computes hours/pay at clock-out). Feeds Workforce → Timesheets/Pay/Tronc.

### Digital Menu Board (`?mode=menuboard`)
- TV / Android-TV display surface (`src/surfaces/MenuBoardSurface.jsx`) + Back Office builder (`src/backoffice/sections/MenuBoards.jsx`, Channels → Menu boards). A "screen" is a `menu_boards` row: chosen categories (drag-reorder; `span:'all'` = full-width hero), orientation/columns/branding/marketing-mode, published live.
- **Auto-fit:** content flows column-by-column (`column-fill:auto`) into an **explicit integer column count** so overflow is reliably detected (NOT `column-width:auto`, which lets Chromium clip silently); the root font binary-searches to fill one screen. "Text size" maps to column count (more columns = larger fill type). Shows descriptions, dietary badges, allergens (comma-separated, under the description), variants (indented), and 86 "Sold out". Cache-first; live via Realtime channel `menuboard:<loc>:<board>`.
- **Screen pairing** (`menu_board_screens`): no `?board` → the device `ensureAuthToken()`s, self-registers an unclaimed row (`device_uid` default `auth.uid()`), shows a ~39-bit code, subscribes `mbscreen-<id>` + 20s poll + 60s `mb_screen_heartbeat`. Operator pairs by code in BO → `claim_menu_board_screen(code,board)` (validates location access, sets `location_id` from the board, 30-min TTL). Reassign/unpair via `set_menu_board_screen`. **RLS is tight:** a device sees only its own row, BO only its venue's screens, all writes go through the three SECURITY DEFINER RPCs — no cross-tenant code enumeration, no device-written `location_id`.

---

## Domain Concepts

- **Location** — a single venue. All data is scoped to `location_id`.
- **Device Profile** — configuration for a terminal (POS counter, bar, kiosk, etc.). Links to Stripe reader.
- **Session** — an open table order; stored in `active_sessions`, loaded at boot, synced via Realtime.
- **Config Push** — back office broadcasts a snapshot to all POS devices via `config_pushes` table.
- **Menu** → **Categories** → **Items** → **Modifier Groups** → **Options** (the menu hierarchy).
- **Course** — item firing timing: 0=Immediate, 1=Course 1 (starters), 2=Course 2 (mains), 3=desserts. Set per **category**.
- **86'd** — item marked out of stock. Three sources: operator manual, stock exhaustion, daily count depletion.
- **Quick Screen** — curated grid of fast-access items on POS; IDs stored in `locations.quick_screen_ids`.
- **Spacer** — blank layout cell in menu grid; stored as `spacerSlots` on `menu_categories.spacer_slots`.
- **Closed Check** — completed order written to `closed_checks` with full line items, payment details, loyalty/gift card info.
- **Order Queue** — `order_queue` table for kiosk/online orders awaiting preparation.
- **Stock Levels** — `stock_levels` table with `par` (daily par) and `remaining` (current count) per item per location.
- **Loyalty Member** — customer enrolled in loyalty program. Points, stamp cards, rewards, gift cards linked to phone number.

---

## How to Run / Build / Deploy

```bash
# Dev (mock mode — no Supabase needed)
npm run dev

# Build
npm run build

# Preview built output
npm run preview

# Deploy — push to develop, Vercel auto-deploys preview
git add <files> && git commit -m "vX.Y.Z — description" && git push origin develop

# Edge function deploy — via Supabase dashboard Code editor (CLI needs SUPABASE_ACCESS_TOKEN)
```

**Environment variables (set in Vercel dashboard, NOT in git):**
```
VITE_SUPABASE_URL=https://tbetcegmszzotrwdtqhi.supabase.co
VITE_SUPABASE_ANON_KEY=<real key>
VITE_USE_MOCK=false
VITE_PLATFORM_SUPABASE_URL=https://yhzjgyrkyjabvhblqxzu.supabase.co
VITE_PLATFORM_SUPABASE_ANON_KEY=<real key>
```

Local `.env.local` has placeholder values — `isMock=true` locally, real values on Vercel.

**Every deploy MUST:**
1. Update `src/lib/version.js` with new version string
2. Add a new entry at the top of `CHANGELOG` in `src/App.jsx`
3. `npm run build` — verify clean before pushing

---

## Conventions

- **camelCase in store/JS, snake_case in Supabase.** Always map both directions explicitly.
- **Static imports only in bundled code.** Dynamic `import(...).then()` silently fails in the Vite bundle. Use static `import` at the top of the file.
- **No localStorage for persistent data.** Everything must go to Supabase. localStorage is only for offline fallback caching.
- **Always resolve locationId before any DB write.** Never use `LOCATION_ID = 'loc-demo'` as a real value.
- **Version bump on every deploy** — `version.js` + `CHANGELOG` in `App.jsx`.
- **No TypeScript, no tests** — be careful with types, validate manually.
- **CSS custom properties** — use `var(--bg)`, `var(--acc)`, `var(--t1)` etc., never hardcode colours.
- **Kiosk/online use anonymous auth** — `signInAnonymously()`. Edge functions accept both authenticated and anonymous callers.
- **Company resolution** — `resolveCompanyForLocation(userId, locationId)` resolves company_id via location_id (ops → platform lookup), falling back to `user_company_roles`. Required for all gift card and loyalty operations.
- **Edge function deploy** — via Supabase dashboard Code editor (Monaco API). CLI needs `SUPABASE_ACCESS_TOKEN` which is not set in the environment.

---

## Gotchas (Lessons Learned the Hard Way)

### The `loc-demo` Trap
`LOCATION_ID = 'loc-demo'` is exported from `supabase.js` and used as default parameter in db.js. It is **truthy**, so naive `if (!locationId)` checks don't catch it. **Every db function must check `!locationId || locationId === 'loc-demo'`**.

### Two Category Save Paths
`sbUpsertCategory()` in `store/index.js` and `upsertMenuCategory()` in `db.js` are **separate functions**. When a field is added to one, it must be added to the other. `store/index.js` is what actually fires on every `updateCategory()` call.

### Dynamic Imports Break in Bundle
`import('../lib/db.js').then(...)` inside event handlers or callbacks silently fails in the Vite production bundle. Always use static top-level imports.

### Snake_case ↔ CamelCase Mapping
Supabase returns `default_course`, `parent_id`, `sort_order`, `spacer_slots` etc. The store expects `defaultCourse`, `parentId`, `sortOrder`, `spacerSlots`. The mapping lives in `SyncBridge.jsx` `catsRes.data.map()`. If you add a new column, add the mapping there AND in `sbUpsertCategory`.

### Spacer Slots
Spacers are NOT menu items. They're stored as `spacerSlots: [{id, sortOrder}]` on the category in memory and as `spacer_slots jsonb` in `menu_categories`. They're merged with real items by `sortOrder` at render time.

### Config Push vs Supabase Direct
The POS loads data two ways at boot:
1. `fetchLatestConfigPush()` — snapshot from back office "Push to POS" (contains menu, categories, etc.)
2. Direct Supabase queries — floor plan, sessions, modifier groups, quick screen IDs
If something isn't in both paths, it may not appear on the POS after reload.

### Course Assignment
`defaultCourse` is set per **category**, inherited by items at the moment they're added to an order (in `addItem` in store). The `fired` flag (immediate-fire) must use the **same category fallback chain** as `course`. Both must walk: `item.cat → item.cats[0] → parentItem.cat`.

### isMock Mode
If `VITE_SUPABASE_ANON_KEY` is missing/placeholder, `isMock=true` and `supabase=null`. All db writes silently return early. This is the local dev state. Production Vercel has real keys.

### Kiosk vs POS Stock Decrement
POS decrements stock via the Zustand store's `addItem` → `decrementDailyCount` action. Kiosk and online ordering bypass the store entirely — they call `decrementStockRPC()` directly after order submission. Both paths call the same `decrement_stock` Postgres RPC.

### Modifier Option 86 Check
Modifier options link to menu items via `opt.itemId`. If `itemId` isn't explicitly set, the kiosk product modal falls back to name-matching against sold-alone sub-items via `resolveOptItemId()`. Without this, 86'd items remain orderable through modifier groups.

### Gift Card Code Lookup
Gift cards use HMAC-SHA256 for code lookup (indexed via `code_lookup` column). The edge function tries three fallback paths: (1) HMAC lookup, (2) `card_id` direct, (3) `code_plain` direct. This handles HMAC secret rotation and cards with null `code_plain`.

### Tables MUST Never Be Lost
Tables MUST never be lost between updates (config push, refresh, wake-from-sleep). Multiple safeguards exist: SessionSync flush debounce, SessionReconciler 10s poll, activeTableId skip, seatedAt timestamp guards on Realtime DELETE handlers, 3-second grace period before Supabase row deletion.

---

## Rules for Claude

1. **Always read `CLAUDE.md`, `DECISIONS.md`, `INVARIANTS.md`, and `CURRENT_WORK.md` at the start of every chat before editing code.**
2. Never modify files outside the scope given without asking.
3. Run `npm run build` before and after changes and fix any errors before deploying.
4. Prefer small, reviewable diffs — fix one thing at a time.
5. If a change would violate `INVARIANTS.md`, stop and ask.
6. Update `CURRENT_WORK.md` at the end of each session with what was done, what's in progress, and what's next.
7. Every deploy: update `src/lib/version.js` AND add a top-of-CHANGELOG entry in `src/App.jsx`.
8. Never use dynamic imports inside bundled component code — static imports only.
9. Never write `loc-demo` to Supabase — always resolve the real locationId first.
10. When adding a DB column, update: the SQL schema, `sbUpsertCategory`/`upsertMenuCategory` (both!), and the SyncBridge mapping.
11. The 6 Build Pillars: (1) New schema for large features (2) Don't break existing functionality (3) Build for scale/stability/no data loss (4) Forward thinking (5) Update AI with new capabilities (6) Always resolve properly, not with patches.
12. OrdersHub function in POSSurface.jsx is DEAD code — the live one is `src/surfaces/OrdersHub.jsx`.
13. QR open-tabs MUST NOT touch `bar_tabs` schema — use `order_queue.customer` jsonb instead.
14. Always resolve real locationId before any DB write — never trust the column default.
