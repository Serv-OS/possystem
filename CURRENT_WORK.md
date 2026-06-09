# Serv OS / RPOS — session handoff

> **Current build: v5.5.379** · live: https://possystem-liard.vercel.app · repo: **Serv-OS/possystem** (branch `develop`, Vercel auto-deploys).
> Multi-tenant hospitality POS (React 19 + Vite, Zustand, Supabase; no TypeScript, no tests). First customer is UK / GBP.
> **Pillars:** don't break working functionality · resolve the real `locationId` before any DB write (never `loc-demo`) · CSS vars not hardcoded colours · bump `src/lib/version.js` + add a `CHANGELOG` entry in `src/App.jsx` on every web deploy · money is `numeric`, never float.

Read alongside: **`CLAUDE.md`** (architecture/orientation), **`DECISIONS.md`** (ADRs), **`INVARIANTS.md`** (hard rules).

---

## What Serv OS is

A SaaS restaurant/bar POS with many device "surfaces" off one codebase (URL `?mode=…`): POS till, MPOS (mobile), Bar, Floor/Tables, KDS, Kiosk, Orders Hub, Customer Display, **Time Clock**, Back Office, and customer-facing Online/QR/Loyalty/Gift web flows. Two Supabase projects: **Ops DB** `tbetcegmszzotrwdtqhi` (all operational data, scoped by `location_id`, hosts the edge functions) and **Platform DB** `yhzjgyrkyjabvhblqxzu` (orgs, users, loyalty, gift cards). Back-office users authenticate with Supabase Auth; POS/clock/kiosk devices pair to a location and use **anonymous auth**.

---

## Recent arc (this block of sessions)

### 1. ServOS visual reskin (POS + Back Office)
"Liquid glass" design system applied across POS + Back Office, **zero behaviour change** — scoped via `data-skin="servos"` on `<html>`, light/dark via `[data-theme]` (persisted to `rpos-theme`). Customer-facing online/QR/kiosk UIs deliberately untouched. Back-office sidebar reorganised into a 10-section collapsible IA (`NAV_IA` in `BackOfficeApp.jsx`). Shared tokens/classes in `src/styles/globals.css`; brand in `ServOSBrand.jsx`; line-icon set in `ServOSIcons.jsx`.

### 2. Workforce module (NEW — the big one)
A complete staff-management system inside Back Office (sidebar group **Workforce**), per-location, wired to live financials. Sections: **Dashboard · Rota · Timesheets · Time off & availability · Staff · Onboarding · Compliance · Positions & rates · Tronc/tips · Announcements · Workforce settings.** See the dedicated section below.

### 3. Time Clock surface (NEW)
Dedicated `?mode=clock` tablet for staff to clock in/out + take breaks via PIN. Punches write timesheets server-side and feed the Workforce timesheets → pay → tronc/accrual chain. See below.

### 4. Tronc ↔ Tips report tie
Workforce → Tronc now **pulls the real weekly pool from the POS** (card tips + service charge from `closed_checks`, same data the Tips report uses) instead of a manual figure; the Tips report cross-references the audited Workforce payout.

### (earlier in this block) Bar-tab card holds, multi-currency (`lib/currency.js`, `locations.currency`), MPOS hardening (86 on modifiers, tax breakdown, customer search), customer-display loyalty + theme.

---

## Workforce module — how it works (for whoever picks this up)

**Front end** — `src/backoffice/sections/Workforce.jsx` is the router; the staff list + add/edit modals live there. Each section is its own component in `src/backoffice/sections/workforce/` (`WfRota`, `WfTimesheets`, `WfTronc`, `WfPay`, `WfLeave`, `WfOnboarding`, `WfCompliance`, `WfAnnouncements`, `WfSettings`). Shared building blocks:
- `src/staff/wfData.js` — **the data-access layer**. Location/org-scoped CRUD for every `wf_*` table + `loadActualSales` / `loadTipPool` (from `closed_checks`) + `invokeCompute` (calls the edge function). Maps snake_case ↔ camelCase. Has a `localStorage` fallback when `isMock` so it's testable without a backend.
- `src/staff/wfUi.jsx` — shared ServOS UI primitives (Card, Badge, EmptyState, table styles, colours).
- `src/staff/wfWeek.js` — current-week (Mon–Sun) date model for the rota.
- `src/staff/labour.js` — labour engine: `resolveRate` (override → role base → salaried equiv, with provenance), `hoursOf`, `labourPct`, `troncRun` (largest-remainder, penny-exact), `accrueHolidayHours` (12.07%).

**Database** — `supabase/migrations/20260608_workforce.sql` (APPLIED to Ops DB). 18 `wf_*` tables (`wf_staff`, `wf_roles`, `wf_sections`, `wf_venue_settings`, `wf_shifts`, `wf_timesheets`, `wf_holiday_accrual`, `wf_time_off`, `wf_availability`, `wf_tronc_runs`, `wf_tronc_lines`, `wf_documents`, `wf_sales_forecast`, `wf_user_roles`, `wf_audit`, `wf_swap_requests`, `wf_onboarding`, `wf_announcements`). Key properties:
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

`?mode=` → `pos` · `mpos` · `bar` · `tables` · `kds` · `kiosk` · `orders` · `customer-display` · **`clock`** · `office` (Back Office) · `admin` (internal Company Admin). Customer web: `/online/:slug`, `/customer/*`, `/gift/*`, `/qr/*`. Mode is chosen in `ModeSelector` and saved to `rpos-device-mode`.

---

## Two Supabase projects + key tables

| | Ops DB `tbetcegmszzotrwdtqhi` | Platform DB `yhzjgyrkyjabvhblqxzu` |
|---|---|---|
| Holds | POS operational data + **all edge functions** | orgs, users, loyalty, gift cards |
| Client | `supabase` (lib/supabase.js) | `platformSupabase` |

**Ops tables:** `menu_items/categories/menus`, `modifier_groups`, `active_sessions`, `closed_checks`, `floor_tables`, `config_pushes`, `stock_levels`, `eighty_six`, `locations`, `device_profiles`, `pos_devices`, `staff_members`, `user_profiles`, `user_locations`, `order_queue`, `tax_rates`, `discount_definitions`, + the 18 **`wf_*`** Workforce tables. **Edge functions** (Deno): 44 gift/loyalty/stripe/send-* + **`workforce-compute`** + **`workforce-clock`**.

---

## Build / deploy

```bash
npm run dev        # mock mode locally (isMock; no Supabase)
npm run build      # MUST be clean before pushing
git add … && git commit && git push origin develop   # Vercel auto-deploys
```
Every deploy: bump `src/lib/version.js` + add a top-of-array `CHANGELOG` entry in `src/App.jsx`. Edge functions deploy via the Supabase CLI (`SUPABASE_ACCESS_TOKEN=<PAT> npx supabase functions deploy <name> --project-ref tbetcegmszzotrwdtqhi`) — native bundler, no Docker needed. DB migrations are applied via the Supabase Management API (`POST /v1/projects/<ref>/database/query`) or the dashboard SQL editor.

---

## Open items / next

1. **Workforce → Dashboard** still shows the legacy summary tiles (staff count is real; wage/labour read zero until shifts + a sales forecast exist) — wire it to the live rota/sales next.
2. **"Who's on shift now"** live view (Workforce or POS) + an optional clock-in shortcut on the POS PIN screen as a secondary entry point.
3. **UK vs US tip distribution** — the Tips *report* calculator is the US model (tip-out/shared-by-role); Workforce → Tronc is the UK Tipping Act model (hours × points). Consider offering the UK method inside the report for UK venues.
4. Staff/manager **comms** (publish-rota SMS, swap approvals) are scaffolded — wire to the `send-sms` edge function.
5. Android self-update pipeline → production-real signing/CI (see `android/AUTO_UPDATE_PLAN.md`); Menu Board surface.

## Ops / secrets note
A Supabase **Personal Access Token** was used this session to apply the Workforce migration + deploy the two edge functions. All of that is done — **revoke the PAT** in the Supabase dashboard unless more DB/function deploys are imminent. Never commit it. Vercel env holds the real `VITE_SUPABASE_*` keys; `.env.local` is placeholders (mock).
