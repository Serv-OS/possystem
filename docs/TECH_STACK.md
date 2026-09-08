# ServOS — Technology & Vendor Register

> Single source of truth for every third-party service the platform depends on, its role,
> account ownership, and operational criticality. Maintained for operations + technical
> due diligence. Last updated: 27 June 2026.

## 1. Service register

| Layer | Vendor / Service | Role | Account / login | Criticality | Fallback / degradation |
|---|---|---|---|---|---|
| **Database & backend** | **Supabase** | Postgres database, Row-Level Security, Realtime, Storage, Edge Functions (Deno), Auth | Supabase org (2 projects — see §2) | **Critical** (system of record) | None — primary data store. Offline write-queue on clients buffers during outages. |
| **Hosting / deployment** | **Vercel** | Frontend hosting (static SPA build), preview/branch environments, serverless API routes (AI proxy) | "Peter Roberts' projects" team → `possystem` project | **Critical** (serves the app) | CDN-cached static assets; Supabase reachable independently. |
| **Version control / CI** | **GitHub** | Source control, branch protection, secret-scanning push protection, Vercel CI trigger | `Serv-OS/possystem` | **High** (build pipeline) | Local clones; Vercel can redeploy last good build. |
| **Email** | **Resend** | Transactional email — receipts, order confirmations, e-sign, welcome | `peter@serv-os.app` | **High** | Best-effort; failures logged, never block an order. |
| **SMS** | **Twilio** | Transactional SMS — OTP, receipts, order/courier tracking, waitlist, marketing | `peter@serv-os.app` | **High** | Best-effort; sandbox/log mode when unconfigured. |
| **Payments (in-person)** | **Stripe Terminal** | Card-present payments on POS / kiosk readers | Stripe (per-merchant connected) | **Critical (revenue)** | Cash fallback; offline reader retry. |
| **Payments (online + 2nd processor)** | **Stripe Checkout / Ryft** | Online card payments + dual-processor card-present/online (Ryft) | Stripe / Ryft (per-merchant) | **Critical (revenue)** | Processor seam (`processor` field) routes per venue; refund routes by processor. |
| **3rd-party order channels (3PO)** | **HubRise** | Inbound aggregator — Deliveroo / Uber Eats / Just Eat orders + catalog push + 86 sync | HubRise (per-merchant connection) | **Medium** (a sales channel) | Channel orders simply don't arrive; POS unaffected. |
| **Own-delivery courier** | **Stuart** | Self-delivery last-mile courier — live quote, dispatch, tracking; **per-location accounts** | Stuart (per-venue account) | **Medium** (a fulfilment option) | Out-of-coverage → collection offered; configurable fallback fee. |
| **Address / geocoding** | **Mapbox** | Address + business (POI) autocomplete with coordinates for couriers; (postcodes.io for free postcode geocode) | Mapbox (`servosapp`, public `pk.` token) | **Low** | Graceful fallback to free-typed address; postcodes.io needs no key. |
| **AI** | **Anthropic (Claude API)** | In-app shift assistant + AI features, proxied server-side | Anthropic API key (Vercel env) | **Low** | Feature degrades; core POS unaffected. |
| **Mobile runtime** | **Android WebView (Sunmi)** | Native APK wrapper for Sunmi hardware; thermal printer + card-reader bridges; self-update | Sideloaded APK (Supabase Storage) | **High** (hardware) | Self-updating; auto-reload on error. |

## 2. Supabase projects (two-database split)

| | Ops DB | Platform DB |
|---|---|---|
| Project ref | `tbetcegmszzotrwdtqhi` | `yhzjgyrkyjabvhblqxzu` |
| Purpose | All POS operational data (orders, menu, sessions, stock, workforce, delivery, payments) | Cross-org/company, users & roles, gift cards, loyalty |
| Edge Functions | Hosted here (60+) | — |
| Auth | Supabase Auth (back-office users) + device pairing (POS) + anonymous (kiosk/online/QR) | Supabase Auth (platform admins) |

## 3. Environments (Vercel)

| Environment | Git branch | Primary domains | Status |
|---|---|---|---|
| **dev** (custom) | `develop` | `dev.serv-os.app`, `possystem-liard.vercel.app`, `dev.pos-up.com` | **Active working/QA line** |
| **production** | `main` | `app.serv-os.app` | Currently behind the dev line (cut-over pending) |

Environment variables (Supabase URLs/anon keys, platform Supabase, `VITE_MAPBOX_TOKEN`, `VITE_USE_MOCK`) are set per-environment in Vercel. **Secrets are never committed** — GitHub secret-scanning push protection enforces this; server secrets (Stripe/Ryft/Twilio/Resend/Stuart/HubRise/Anthropic) live in Supabase Edge Function secrets and Vercel env only.

## 4. Account-ownership note

All third-party accounts are currently under the founder identity (`peter@serv-os.app` / Peter Roberts' Vercel team / Serv-OS GitHub org). **Pre-funding action:** migrate vendor accounts to a company-owned identity (shared org/billing) and enable 2FA + least-privilege team access across Supabase, Vercel, GitHub, Stripe, Ryft, Twilio, Resend.

See also: [TECHNICAL_DUE_DILIGENCE.md](TECHNICAL_DUE_DILIGENCE.md) · [TOPOLOGY.md](TOPOLOGY.md) · [METHODOLOGY.md](METHODOLOGY.md)
