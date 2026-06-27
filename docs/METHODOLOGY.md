# ServOS — Engineering Methodology

> How the platform is built, tested, reviewed, and shipped. Written for technical due diligence
> and team onboarding. Last updated: 27 June 2026.

## 1. Development model

- **Trunk-style on `develop`.** Feature work lands on `develop`, which auto-deploys to the **dev**
  environment (the live QA line at `dev.serv-os.app`). `main` is the production branch.
- **Vertical slices.** Features are delivered in small, reversible, end-to-end slices (schema →
  data layer → edge function → UI → tests), each independently shippable. Large features ship
  "build-now, go-live owner-gated": code complete + tested, with the migration/credentials applied
  on the owner's authorisation.
- **Reuse-first.** New work is mapped onto existing engines (e.g. the delivery quote/surcharge/
  dispatch seam, the receipt pipeline, the print orchestrator) before anything new is written.

## 2. Release process (every deploy)

1. **Version bump** — update the single source of truth `src/lib/version.js`.
2. **Changelog** — add a top-of-list entry in the in-app `CHANGELOG` (`src/App.jsx`), written in
   plain English (it is shown in-product), describing what changed and why.
3. **Build green** — `npm run build` must pass; `node --test` must pass.
4. **Ship** — push to `develop` (Vercel builds dev); deploy any changed Edge Functions via the
   Supabase CLI; apply any DB migration (numbered, reversible) via the Management API on
   per-change authorisation. **Edge functions that write new columns deploy *after* their migration.**

This gives an auditable, human-readable history of every production change inside the product.

## 3. Database change management

- **Numbered, reversible migrations** in `supabase/migrations/` (e.g. `20260630c_courier_times.sql`),
  each with a commented rollback block.
- **Additive-first** — prefer adding columns/constraints over destructive change; widen CHECK
  constraints rather than break them.
- **Tenant posture by default** — new sensitive tables enable RLS with no client policies
  (service-role-only) and are reached through an edge function; secrets are never stored in
  client-readable columns.
- **Migrations are applied to the live Ops DB only with explicit per-change authorisation.**

## 4. Testing & quality

- **Unit tests** (`node --test`, 150+) cover the **pure business logic** where correctness is
  financial or safety-critical: tax/VAT, service charge, discounts, delivery surcharge & quote
  mapping, courier time/lateness, waitlist estimation, operations/HACCP engine, tronc/payroll maths.
  Money is pennies-correct and explicitly tested.
- **Adversarial review.** Substantial changes are reviewed by an automated multi-agent review pass
  (independent reviewers per dimension → adversarial verification of each finding) before deploy;
  confirmed findings are fixed in the same release. This has repeatedly caught real defects
  (e.g. a constraint that would have silently no-op'd courier dispatch; a column-name mismatch that
  blocked online orders from saving) before they reached production.
- **Manual QA** on the dev line for UI flows; **no e2e framework yet** (roadmap item — Playwright).
- **Training mode** — a per-device flag that commits nothing (no real sales, prints, charges or
  courier dispatch), so staff can be trained against the live build safely.

## 5. Conventions & invariants

- camelCase in JS / snake_case in SQL, mapped explicitly both directions.
- Static imports only in bundled code (dynamic imports silently fail in the Vite bundle).
- Always resolve the real `location_id` before any DB write — never trust a column default.
- Never render an order's address/customer object directly (serialise it) — guarded by per-card
  error boundaries.
- New "complete/clear order" paths must take payment first if money is owed.
- New order channels must route delivery fees through the shared quote service (never compute
  distance fees locally except the configured fallback).

## 6. Documented knowledge base

A persistent knowledge base (`CLAUDE.md`, `DECISIONS.md`, `INVARIANTS.md`, `CURRENT_WORK.md` +
per-feature notes) captures architecture, decisions, invariants and gotchas, and is read at the
start of every work session — keeping institutional knowledge out of individual heads.

## 7. Environments & promotion

`develop` (dev env, QA) → `main` (production). Environment variables are per-environment in Vercel;
the native APK targets are documented in the staging cut-over plan. Promotion to production is a
`develop → main` merge plus matching Edge Function deploys + migrations.
