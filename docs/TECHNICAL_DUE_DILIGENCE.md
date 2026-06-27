# ServOS — Technical Due Diligence

> Prepared for technical due diligence / investor review. Describes the architecture, technology,
> data model, security posture, integrations, and operational maturity of the ServOS platform,
> together with an honest risk register and remediation roadmap. Last updated: 27 June 2026.

---

## 1. Executive summary

**ServOS (RPOS — "Restaurant OS")** is a multi-tenant, multi-device SaaS point-of-sale and
operations platform for hospitality. A single codebase serves ~17 product surfaces (counter POS,
bar, table service, kitchen display, self-service kiosk, mobile POS, time clock, online ordering,
QR table ordering, customer loyalty portal, gift cards, digital menu boards, owner app, AI
assistant, review manager) from one React application, backed by Supabase (Postgres + Edge
Functions) and deployed on Vercel.

- **Codebase:** ~100k+ lines, ~250 source files; React 19 + Vite, Zustand state, Deno edge functions.
- **Tenancy:** every record scoped to a `location_id`; Postgres Row-Level Security + a service-role
  edge-function tier enforce tenant isolation.
- **Payments:** dual-processor (Stripe + Ryft), card-present and online, with refunds/disputes.
- **Coverage:** full hospitality lifecycle — menu, ordering, payments, KDS, stock/costing,
  workforce/payroll, HACCP/operations, delivery (own-courier + aggregators), CRM/loyalty, reporting.
- **Maturity:** in active production use on the live line; rapid, versioned release cadence
  (every change is versioned + changelogged); pure business logic is unit-tested.

This document is written to be **honest** — §10 lists known risks and the remediation roadmap.

---

## 2. Architecture overview

### 2.1 Shape
A **client-heavy SPA + serverless backend**:

- **Frontend:** one React 19 SPA (Vite build), rendering a surface chosen by URL (`?mode=pos`,
  `?mode=kds`, `/online/:slug`, etc.). State in a single Zustand store; multi-tab/multi-device
  coordination via BroadcastChannel + Supabase Realtime.
- **Backend:** Supabase — Postgres (system of record), Realtime (live sync), Storage (assets,
  receipts, APK), Auth, and **60+ Deno Edge Functions** that hold all third-party secrets and
  enforce tenant-aware authorisation. A small set of Vercel serverless routes proxy the AI API.
- **Native shell:** an Android WebView APK (Sunmi hardware) wraps the web app and exposes native
  bridges for the thermal printer and card reader; it self-updates from Supabase Storage.

### 2.2 Why this shape
- **One codebase, many surfaces** → feature parity and low maintenance overhead vs. separate apps.
- **Edge functions as the trust boundary** → secrets and cross-tenant operations never run in the
  browser; each function `verify_jwt=false` and performs its own auth (token + location-access
  check), mirroring a consistent pattern across the fleet.
- **Offline resilience** → POS devices buffer writes in a durable local queue and replay on
  reconnect; table sessions are reconciled across devices so service never loses data.

### 2.3 Core domain model (selected)
`locations` → `menus` → `menu_categories` → `menu_items` → `modifier_groups`/options;
`active_sessions` (open tables), `order_queue` (live orders), `closed_checks` (completed sales,
the financial record), `stock_levels`/ledger, `device_profiles`/`pos_devices`, plus subsystem
schemas for workforce (`wf_*`), operations/HACCP, delivery (`courier_deliveries`, `delivery_*`,
`venue_uber_config`), and the platform DB's gift-card/loyalty/user-role tables.

---

## 3. Technology stack

| Concern | Choice |
|---|---|
| UI | React 19, Vite 8 (no TypeScript; manual type discipline) |
| State | Zustand 5 (single store), BroadcastChannel, Supabase Realtime |
| Backend | Supabase: Postgres + RLS, Realtime, Storage, Auth, Edge Functions (Deno/TypeScript) |
| Payments | Stripe Terminal + Stripe Checkout; Ryft (dual processor) |
| Email / SMS | Resend (email), Twilio (SMS) via edge functions |
| Delivery | Stuart (own courier, per-location); HubRise (inbound aggregators) |
| Address | Mapbox (autocomplete + POI), postcodes.io (free postcode geocode) |
| AI | Anthropic Claude API via Vercel serverless proxy |
| Mobile | Android WebView (Sunmi), self-updating sideloaded APK |
| Hosting / CI | Vercel (build + envs), GitHub (source + push-protection + CI trigger) |
| Tests | `node --test` unit suite over pure business logic (pricing, surcharge, courier times, waitlist, ops, tax) — 150+ tests |

See [TECH_STACK.md](TECH_STACK.md) for the full vendor register.

---

## 4. Multi-tenancy & data architecture

- **Tenant key:** `location_id` on every operational row; `company_id`/org for higher-level grouping.
- **Isolation enforcement (defence in depth):**
  1. **Postgres RLS** — operational tables enable RLS; sensitive tables (delivery, HubRise, workforce
     PII) are **service-role-only** (RLS on, no client policies) and reachable only through edge
     functions.
  2. **Edge-function authorisation** — `requireToken` (any authenticated/anon session) for
     operational reads the POS device needs; `requireAccess` (back-office user with a
     `user_locations` row, or super-admin) for management/mutation actions. Every query is filtered
     by the caller's `location_id`.
  3. **Client tenant fence** — `lib/supabase.js` resolves and pins the active location; writers
     must resolve the real `location_id` (never a placeholder default).
- **Two databases** separate operational data (Ops DB) from cross-company identity, gift cards and
  loyalty (Platform DB), reducing blast radius and clarifying data ownership.
- **Auditability:** append-only, hash-chained workforce audit (`wf_audit`); append-only holiday and
  delivery-status ledgers; closed checks are immutable sales records with full line items + payment.

---

## 5. Integrations

| Integration | Direction | Mechanism | Notes |
|---|---|---|---|
| **Stripe** | Out | Terminal SDK + Checkout + webhooks | Card-present + online; refunds |
| **Ryft** | Out | API + webhooks | Second processor behind a `processor` seam; disputes |
| **HubRise** | **In** | Webhook (HMAC, idempotent on `event_id`) + catalog/86 push | Deliveroo / Uber Eats / Just Eat inbound orders |
| **Stuart** | Out | OAuth2; live pricing → dispatch → status; webhook (`?key=`) + server-side polling fallback | Per-location accounts; scheduled pickup; secrets never in the browser |
| **Resend** | Out | Edge function (`send-receipt`) + message-template merge | Receipts, confirmations, e-sign |
| **Twilio** | Out | Edge function (`send-sms`) | OTP, receipts, tracking, waitlist, marketing |
| **Mapbox** | Out | Geocoding v6 + Search Box (POI) | Public token, URL-restrictable |
| **Anthropic** | Out | Vercel serverless proxy (`api/ai.js`) | Server-side key |

**Integration design principles:** all credentials live server-side (edge env or per-tenant
service-role-only columns, never returned to the browser); inbound webhooks verify a signature/secret
and dedupe on a unique event id; outbound side-effects (dispatch, receipts) are best-effort and never
block the customer's payment/confirmation; provider seams (`dispatch_backend`, `processor`) allow
swapping vendors without UI changes.

---

## 6. Payments & PCI posture

- Card data is **never handled by ServOS code** — Stripe Terminal (reader-driven) and Stripe/Ryft
  hosted/SDK flows tokenise on the processor. The platform stores only payment **references**
  (intent/session ids, last-4 via the processor, amounts), keeping PCI scope to **SAQ-A / A-EP**
  class rather than handling PANs.
- Refunds and disputes route by the stored `processor` so money operations always hit the correct
  provider.
- Money is represented in minor units (pennies) in calculation paths and is unit-tested for
  penny-correctness (service charge, discounts, delivery surcharge, tronc/payroll).

---

## 7. Scalability & reliability

- **Stateless frontend** on Vercel's CDN; Postgres + Realtime scale with Supabase's managed tier.
- **Concurrency hardening** (shipped): DB indexes on hot paths; batched sync/print/replay;
  reserve-then-act idempotency on courier dispatch (unique index on `(location_id, order_ref)`) so
  client + cron + retries can never double-dispatch.
- **Offline-first POS:** durable offline write queue, session reconciler (10s poll), master/child
  heartbeat, print retry — designed so a venue keeps trading through network loss with no data loss.
- **Multi-device consistency:** Realtime channels + BroadcastChannel + periodic reconcilers; the
  "tables must never be lost" invariant is protected by multiple safeguards.

---

## 8. Deployment, CI/CD & release management

- **Source:** GitHub `Serv-OS/possystem`; secret-scanning **push protection** blocks any committed
  credential.
- **Build/deploy:** push to `develop` → Vercel builds the **dev** environment (the active QA line);
  `main` → production. Edge functions deploy via the Supabase CLI; database schema via reversible,
  numbered SQL migrations applied through the Supabase Management API (per-change authorised).
- **Release discipline:** every deploy bumps a single version source (`src/lib/version.js`) and adds
  a top-of-file changelog entry — giving a precise, human-readable history of every change in-product.
- **Native APK:** self-updating from Supabase Storage; version surfaced on `window.RPOS_VERSION` for
  field diagnostics.

See [METHODOLOGY.md](METHODOLOGY.md) for the engineering process in detail.

---

## 9. Observability, backup & DR

- **Backups:** Supabase managed Postgres backups / point-in-time recovery (provider-managed).
- **Telemetry:** edge-function logs (Supabase), Vercel build/runtime logs, in-app diagnostics
  (version, native-bridge status), and domain audit tables (workforce, delivery status events,
  receipt/SMS logs) for operational forensics.
- **Failure isolation:** per-card React error boundaries prevent one bad record from white-screening
  a surface (and tearing down printing); auto-reload on native network error.

---

## 10. Risk register & remediation roadmap (honest assessment)

| # | Area | Risk | Severity | Remediation |
|---|---|---|---|---|
| R1 | **Security — RLS coverage** | A known pre-existing gap in POS-core table RLS was identified in an internal audit; not all operational tables are fully tenant-fenced at the database layer (edge-fn fencing mitigates the primary access paths). | **High** | Complete an RLS pass over all operational tables; add automated cross-tenant access tests; formal pen-test before scale. **Disclose in DD.** |
| R2 | **No TypeScript** | Manual type discipline; runtime type bugs possible. | Medium | Incremental TS adoption on shared libs/edge functions; expand the pure-logic unit suite. |
| R3 | **Test depth** | Strong unit tests on pure logic; **no end-to-end/integration test framework** — UI paths rely on manual QA. | Medium | Add Playwright e2e for critical flows (checkout, payment, dispatch); CI gate. |
| R4 | **Account ownership / access** | Vendor accounts under a single founder identity; secrets rotation is manual. | Medium | Migrate to company-owned orgs, enforce 2FA + least-privilege, formal secret-rotation policy + a manager (e.g. Vault/Doppler). |
| R5 | **Prod cut-over** | The production branch (`main` / app.serv-os.app) trails the active `develop` line. | Low/Med | Execute the staging→prod cut-over plan; align native-app targets. |
| R6 | **Single-cloud dependency** | Hard dependency on Supabase + Vercel. | Low | Acceptable at stage; document RTO/RPO; portability via standard Postgres + static build. |
| R7 | **Compliance** | UK VAT on receipts ✓; allergen (Natasha's Law) confirmation ✓ + audit; full GDPR data-subject tooling (export/erase) is partial. | Medium | Build DSAR export/erasure tooling; data-retention policy; DPA register for processors. |

---

## 11. Compliance & domain correctness (strengths)

- **UK VAT:** tax computed per-rate with breakdowns on customer-facing receipts; P&L uses ex-VAT
  net sales; VAT treated as a liability, never profit.
- **Allergens:** EU/UK FIC ("Natasha's Law") — an allergen-confirmation gate on orders containing
  declared allergens, recorded to the order audit trail.
- **Payroll/tronc:** server-side, penny-exact, tamper-evident (hash-chained audit), statutory
  holiday accrual (12.07%), aligned to the UK Tipping Act / HMRC E24 considerations.
- **Age verification:** Challenge 21/25 flow with an audit log.

---

## 12. Intellectual property

- Proprietary application code in a private GitHub org (`Serv-OS`). Built on open-source
  (React/Vite/Zustand/Deno) and commercial SaaS (Supabase/Vercel/Stripe/etc.) under their licences.
  No GPL-encumbered components in the distributed client to the best of current knowledge
  (recommend a formal licence/SBOM audit as a DD deliverable).
