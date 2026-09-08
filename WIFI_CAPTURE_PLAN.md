# WiFi Guest Data-Capture — build plan (phase 1 of marketing/CRM)

Brandable captive-portal page that captures guest details into the unified CRM, with
auto-segments ready for the campaign/automation engine that comes next. Built to mirror the
**Review Manager** pattern (BO container + public customer surface + anon tenant-fenced edge fn).

## Decisions (locked with the user)
- **Capture first, "get online" later.** Build the data-capture module as a standalone,
  launchable piece. The UniFi authorize-back step is a later phase.
- **Single marketing opt-in** (one box covering email + SMS → consent `channel='both'`).
- **DOB required + 18+ gate** — under-18s may use WiFi but can't opt into marketing.
- **Unified CRM = extend `customers`** (do NOT fork). Reuse existing `birthday` for DOB.
- Upsert key: phone when present, else `(org_id, lower(email))` (WiFi often has email, no phone).

## The UniFi reality (verified, 3/3)
No turnkey cloud API authorizes a UniFi guest remotely — Ubiquiti's internet-reachable Site
Manager API is **read-only** in 2026. The authorize action lives only on each console's **local**
Integration API (`POST /proxy/network/integration/v1/sites/{site}/clients/{id}/actions` with
`AUTHORIZE_GUEST_ACCESS` + per-console `X-API-Key`) and needs direct reachability. So authorize-back
is a **pluggable strategy** on `wifi_unifi_bindings.auth_method` (default `none` for capture-first):
- `unifi_voucher` — pre-generated UniFi guest passes; zero networking from the venue (the
  multi-tenant default when we build authorize). NB: a UniFi "voucher" = a WiFi access pass, not a discount code.
- `unifi_local_api` — seamless, needs the venue to expose the console (tunnel) + a local-admin API key.
- `unifi_legacy` — `cmd/stamgr authorize-guest` for old controllers.
- `onprem_relay` — post-launch on-prem agent (Stampede "Snap Box" equivalent) for no-inbound venues.

## Schema — APPLIED `supabase/migrations/20260615_wifi_capture.sql` (Ops DB)
- `customers` (extended): `first_name`, `last_name`, `is_local`, `source`, `sources[]` (reuses `birthday`, `name`, `email`, `phone`, `marketing_opt_in*`, `welcome_sent_at`).
- `customer_consents` — append-only PECR/GDPR ledger (channel, consented, exact consent_text, privacy_version, ip, ua, source).
- `wifi_portal_settings` — per-location editable portal (headline/subtext/bg/logo/accent/button, `fields` jsonb show+required, `age_gate`, marketing_copy, success/redirect/terms/privacy).
- `wifi_unifi_bindings` — per-location authorize binding (SECRETS, **no read policy**; encrypted key/creds/voucher pool, auth_minutes, limits, last_authorize_at/last_error).
- `wifi_captures` — capture event log (mac/ap/ssid, is_return, marketing_opt_in, authorized).
- RLS: reads fenced by `user_accessible_locations()` (SETOF text) like `review_*`; `location_id text`. Writes via service-role edge fns only.

## Surfaces / edge fns (to build)
- Public: `src/surfaces/WifiSurface.jsx` at `/wifi` (route via `customerUrl.js` + `CUSTOMER_MODES` in `App.jsx` + `CustomerBoot.jsx`, mirroring `/review`). Reads UniFi redirect params (`id`/`ap`/`t`/`url`/`ssid` + site from path). Renders editable fields incl Email/Phone/First/Last/DOB(required)/"Are you local?", single marketing opt-in (unticked), "Connect only" path (WiFi never gated on consent), 18+ gate.
- `supabase/functions/wifi-capture/` (anon, tenant-fenced; clone `review-submit`): `portal_config` + `capture` (upsert customer, write consent ledger, log capture, [later] call authorize, optional `send-welcome`).
- BO: `src/backoffice/sections/WifiManager.jsx` + `wifi/` (live-preview editor `WifiPortal`, `WifiSetup` for UniFi binding, `WifiDashboard` segments/CSV); register under the **Customers** nav group next to Reviews. `wifi-admin` edge fn (get/save config, save_binding write-only secrets, status, test, segments/export). `wifi-authorize` edge fn (later).

## Phased build order
1. ✅ Schema migration (applied + verified).
2. `wifi-capture` edge fn (capture → `customers` + `customer_consents` + `wifi_captures`).
3. `WifiSurface` public portal + routing.
4. BO `WifiManager` → `WifiPortal` live-preview editor + nav.
5. BO `WifiSetup` + `wifi-admin` + `WifiDashboard`/segments.
6. Authorize-back (`wifi-authorize`: voucher → local_api) — the "get online" step.
7. Post-launch: onprem_relay, legacy, persisted segments, campaigns/automations engine, fold online/kiosk/POS into the same `source`/`sources` model.

## UK GDPR/PECR (hard requirements)
WiFi access never conditional on marketing consent ("Connect only" path); explicit opt-in only
(no soft opt-in for WiFi); store full consent evidence (exact wording, privacy_version, ip, ua,
timestamp); easy withdrawal; venue = controller, Serv OS = processor; show privacy/terms links.

Reference files: `src/surfaces/ReviewSurface.jsx`, `src/surfaces/CustomerBoot.jsx`,
`src/lib/customerUrl.js`, `src/lib/customerLookup.js`, `supabase/functions/review-submit/index.ts`,
`src/backoffice/sections/review/ReviewCard.jsx`, `src/backoffice/sections/ReviewManager.jsx`,
`supabase/functions/send-welcome/index.ts`.
