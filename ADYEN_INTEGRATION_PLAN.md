# ADYEN INTEGRATION PLAN — ServOS payments on Adyen for Platforms

> Drafted 1 Aug 2026 from a 10-agent discovery pass: 4 repo inventories of every Stripe/Ryft
> touchpoint + 6 researchers over live docs.adyen.com (every fact cited at source).
> Raw reports: `docs/adyen/research/*.md` — treat those as the reference layer under this plan.
> Reference UX target: Lightspeed "Financial services" (Peter's screenshots, 1 Aug 2026) —
> Lightspeed Payments IS Adyen under the hood, terminal ids `AMS1-xxxx`/`S1F2-xxxx` confirm it.

---

## 0. Locked decisions

| Decision | Choice |
|---|---|
| Model | **Adyen for Platforms — "Platform" flavour** (not Marketplace: no in-person; not Classic: legacy). Adyen's own docs recommend it for "ordering or point-of-sale solution" ISVs. |
| Onboarding | **Venues onboard THEMSELVES** via Adyen **hosted onboarding v4**, link generated from our Back Office (API-initiated). ServOS never touches KYC documents; **Adyen carries the KYC obligation**. |
| Pricing | **We set per-venue rates in the ServOS admin portal** (same as Ryft today) → implemented as Adyen **split configuration profiles** per store (basis points + fixed) with our margin booked as `Commission` to our **liable balance account**. |
| Hardware | **Adyen AMS1 only** (Android handheld, Castles-made, battery, camera, no printer — receipts print on OUR printers, same as the PAX decision v5.5.72x). |
| Terminal comms | **Cloud Terminal API** via the current `device-api-*` regional endpoints (NOT legacy `terminal-api-*` hosts). Our tills are web apps — local `terminal-ip:8443/nexo` is impossible from a browser; cloud fits the existing `terminal_jobs` server-dispatch architecture exactly. |
| Edge functions | **Raw REST from Deno** (X-API-Key header). The Adyen Node SDK requires Node 18+/node-https — no Deno support. Same pattern we proved with Ryft. |
| Gift cards | **STAY OURS.** Adyen's gift machinery only routes to external processors (Givex/SVS/etc.). We keep redeeming from our platform-DB ledger and send only the card remainder to Adyen. Zero gift rebuild. |

**API versions (best-current, from live docs 1 Aug 2026):**
Checkout **v72** · Terminal API **nexo 3.0 / v1** (device-api endpoints) · Management **v3** ·
Legal Entity Management **v4** · Balance Platform Configuration **v2** · Transfers **v4** ·
Disputes **v30** · Hosted onboarding **v4** · Web Drop-in/Components **v6**.

---

## 1. Per-venue Adyen anatomy (what "a venue" becomes)

```
ServOS company account
└─ Balance platform (one per region we acquire in: UK/EU + US)
   ├─ LIABLE balance account  ← our Commission lands here; chargebacks/fees default here
   └─ per venue:
      Legal entity (KYC)  →  Account holder  →  Balance account (per currency)
      + Transfer instrument (their verified bank account — payouts go here)
      + Business line (industry/MCC)
      + Store (physical location; terminals + payments route through it)
```

- Every payment carries `store` (+ splits or the store's split profile).
- Venue payout = **managed payouts** (weekday/weekly/monthly schedule, 1–2 day arrival) or
  **sweeps** via Balance Platform API (threshold/scheduled; enables a future "instant payout" button —
  the Lightspeed "Pay now" feature is a sweep).
- Our revenue = `Commission` split (bps + fixed) per payment → liable account. This replaces
  Stripe `application_fee_amount` and Ryft `platformFee` — the maths lives in one place:
  the split profile we write per store from the admin portal.

## 2. Keep / replace / retire (from the repo inventories)

**KEEP (processor-agnostic, already built and battle-tested):**
- `terminal_jobs` pipeline + client `src/lib/payments/terminalJobs.js` (processor-blind), job mutexes,
  paid-guards, reconciler, Table-Pay bill stamping, kiosk binding — the whole v5.5.7xx–9xx terminal war chest.
- `closed_checks` money model (`payment_intents[]` legs, card receipt block, tax, gift jsonb, refunds jsonb).
- Gift cards, loyalty, promo — untouched.
- Split/tender engine (`lib/payments/checkTotals.js`), refund allocation front-to-fill.
- Receipt printing on our printers; EMV receipt block rendering (`src/lib/cardReceipt.js`).

**REPLACE (Ryft/Stripe-specific → Adyen):**
- `terminal-job-charge` internals → Adyen Terminal API `PaymentRequest` (cloud sync w/ 150s+ timeout + `TransactionStatusRequest` recovery; async+webhook as fallback path).
- `ryft-create-payment-session` / `stripe-create-payment-intent` → `adyen-create-session` (Checkout v72 `/sessions` + splits + store).
- In-page card forms (Ryft SDK / Stripe Elements) → **Adyen Web Drop-in v6** (npm, static import).
- `ryft-webhook` / `stripe-webhook` → `adyen-webhook` (HMAC, dedupe, standard webhooks + Balance Platform webhooks).
- Onboarding fns → `adyen-onboard` (LEM v4 + Config v2 + hosted onboarding link + Management v3 store/split profile).
- PAX Android app (`android/paxpay`) → **retired on Adyen venues** (AMS1 is driven entirely server-side; no on-terminal app needed. Keep paxpay for remaining Ryft venues during coexistence).

**RETIRE at cutover:** `merchant_stripe_accounts` flows, Stripe reader registry paths, Ryft session polling.

## 3. Schema plan (Slice 0 — build now, no keys needed)

Ops DB:
- `terminal_devices`: add `adyen_terminal_id` (POIID `AMS1-{serial}`) + unique partial idx (paired) + carry-forward in `claim_terminal_device` + expose via `terminal_targets_for_pos` (**drop-recreate ⇒ re-grant — the v944 lesson**).
- `terminal_jobs`: `processor` default removed (explicit 'ryft' | 'adyen'); reuse `payment_session_id` column for pspReference (or add `psp_reference`); keep settle-writer RPC pattern.
- `bar_tabs`: **persist the hold** — `pre_auth_ref`, `pre_auth_processor`, `pre_auth_held_minor` (fixes the known Stripe-era gap where holds lived only in Zustand).
- `closed_checks`: no structural change — pspReference rides `payment_intents[].id` (+ `stripe_payment_intent_id` continues as the misnamed catch-all the webhooks match on; rename later, not during migration).

Platform DB:
- Widen `locations.payment_processor` CHECK → `('stripe','ryft','adyen')`.
- `merchant_adyen_accounts`: legal_entity_id, account_holder_id, balance_account_id, store_id, merchant_account, capability flags (receivePayments/payouts + verification status), `markup_percent`, `markup_fixed_pence`, onboarding_link_expires_at, last_webhook_at.
- `payment_devices`: widen both CHECKs; add `adyen_terminal_id` + unique; adyen rows require it.
- `adyen_webhook_events` (dedupe: pspReference+eventCode+success), `adyen_payments` ledger (server truth, matched_closed_check reconcile — mirror of `ryft_payments`).
- `adyen_payouts` + `adyen_payout_lines` (from settlement report ingestion — feeds the Payouts/Reconciliation tabs).
- `merchant_adyen_disputes` (respond-by deadline model copied from Ryft disputes).
- `platform_settings`: `default_adyen_markup_percent`, `default_adyen_markup_fixed_pence`.

Client routing (the three-way switch):
- `payments-processor` fn + `src/lib/payments/processor.js:29` whitelist + `payments-admin set_processor` → accept `'adyen'` (today an adyen value would **silently resolve to stripe** — first thing to fix).
- Third branch at every dispatch site (inventory §1b lists all 17 files:lines): CheckoutModal, SplitModal, KioskApp, OnlineCheckout, QrCheckout, CateringCheckout, GiftPurchase, OrdersHub, BarSurface, TabPreAuthTerminal, refundCheck, TerminalJobReconciler (runs for adyen too), CardReaders.

## 4. Edge function map (all raw REST, Deno)

| Fn | Purpose | Adyen APIs |
|---|---|---|
| `adyen-onboard` | create LE/AH/BA/business line/store, mint hosted-onboarding link, read verification status, write split profile from markup | LEM v4, BP Config v2, Mgmt v3 |
| `adyen-admin` | set rates (split profile update), payout schedule/sweeps, account status for BO, instant-payout trigger | Mgmt v3, BP Config v2, Transfers v4 |
| `adyen-create-session` | online/QR/catering/gift payment sessions with splits + store + tokenization flags | Checkout v72 `/sessions` |
| `adyen-payment-detail` | payment lookup for BO drill-in | Checkout v72 / ledger |
| `adyen-terminal-charge` | THE in-person fn — nexo `PaymentRequest` over cloud device-api `/sync` (tip prompt, pre-auth, partial-approval tender options), settle via `terminal_job_settle_from_processor`, EMV receipt block from `additionalResponse` | Terminal API v1 |
| `adyen-terminal-admin` | fleet: `GET /terminals`, reassign to store, settings; registers rows in `payment_devices` | Mgmt v3 |
| `adyen-modify` | capture / cancel / refund / amountUpdates (tab step-up) with idempotency keys | Checkout v72 |
| `adyen-webhook` | standard + BP webhooks: AUTHORISATION, CAPTURE, REFUND, CHARGEBACK lifecycle, REPORT_AVAILABLE, payout/sweep events → ledger + closed_checks reflection + dispute rows; HMAC verify; 2xx-ack-then-process | webhooks |
| `adyen-report-ingest` | on REPORT_AVAILABLE: download settlement details / payment accounting CSV, parse → `adyen_payouts(_lines)` + fee rows | Reporting |
| `adyen-disputes` | list/defend/accept + defense document upload | Disputes v30 |

⚠ **Edge fns deploy manually** — every one of these goes into `scripts/check-deploys.mjs` coverage from day one.

## 5. Build phases

**Phase 0 — foundations (NO keys):** schema above + three-way processor switch + `adyen-webhook` skeleton with HMAC + fixture-driven tests of the reconcile paths. *Ships dark.*

**Phase 1 — onboarding + admin (test keys):** `adyen-onboard`/`adyen-admin`; BO "Get paid with ServOS" screen (venue clicks Apply → hosted onboarding link → capability status chips); ServOS admin portal rates UI writing split profiles. Coexists with Ryft screens.

**Phase 2 — online payments (test keys):** Drop-in v6 into OnlineCheckout / QrCheckout / CateringCheckout / GiftPurchase behind the processor switch; 3DS2; Apple Pay/Google Pay (certificates via Mgmt API); tokenization for QR-tab overage (`UnscheduledCardOnFile` MIT).

**Phase 3 — in-person (test AMS1 units in hand):** `adyen-terminal-charge` + fleet BO + POS status drawer; kiosk + POS + split legs + Table-Pay on `terminal_jobs` with `processor='adyen'`; tip prompt ON TERMINAL (Adyen has what Ryft lacked); partial-approval handling; £-low live test script.

**Phase 4 — tabs + modifications:** bar-tab pre-auth on AMS1 (card-present pre-auth + `amountUpdates` step-up + capture/cancel) — **restores tabs on non-Stripe venues** (Ryft never could); refunds three-way in `refundCheck`; OrdersHub QR capture/void/overage third branch.

**Phase 5 — BO "Financial services" module (Lightspeed parity):** new BO group per the screenshots:
- **Overview** — balance (BP API), recent payments/payouts, account status, instant-payout button (sweep).
- **Payments** — KPI strip + list from `adyen_payments` ledger (status, brand+last4, payout status, location) + export + drill-in.
- **Payouts** — daily rows from `adyen_payouts` (destination last4, fees, amount, status).
- **Reconciliation** — card-sales↔payout bridging: our `closed_checks` vs settlement lines (we can ship what Lightspeed still has in Preview).
- **Disputes** — deadline-driven queue + defense upload + per-location dispute email recipients.
- **Documents** — monthly fee statements (report ingestion) per location.
- **Terminals** — fleet: serial/model/firmware/last-activity, assign-to-location, sync.
- **Settings** — processing rates card (read-only to venue; set by us), payout schedule, notifications.
- **Capital** — placeholder tab (Adyen Capital for platforms — commercial discussion later).

**Phase 6 — cutover machinery:** per-venue switch runbook (`set_processor 'adyen'` after capabilities green + terminal boarded), coexistence guarantees (Stripe/Ryft venues untouched), go-live checklists (34-item online + POS list from docs), SaaS billing collector moved to balance-account debits.

## 6. Hardware + ops runbook (AMS1)

- **No simulator exists.** Terminal testing = physical **test AMS1 units** ordered from the test Customer Area (Devices → Orders & returns), ~2 days dispatch, **region-locked** → order UK and US units separately, plus Adyen physical test cards. Real cards don't work in test.
- Boarding: assign terminal → store (Mgmt API `/terminals/{id}/reassign`, takes ≤3h to sync), power on, confirm store, ~30 min board. Store/merchant must have ≥1 payment method configured first.
- POIID = `AMS1-{serial}` — our `payment_devices.adyen_terminal_id`.
- AMS1 has **no printer** — receipts stay on our ESC/POS printers (already our chosen model).
- **Offline caveat (honest):** cloud Terminal API has effectively **no store-and-forward** — if the venue's internet dies, Adyen card payments stop (PAX/Ryft had the same practical constraint). Mitigation options later: local-comms hybrid or standalone mode; documented, not planned.
- Live lead times: merchant accounts ~4 days, store requests ~2 days, live terminals ~4 days — factor into venue go-lives.

## 7. Risks / open items

1. **AfP is commercially gated** — a self-serve test account gives Checkout + Terminal test access immediately, but the **balance platform (AfP) features on test usually need Adyen to enable them**. The commercial conversation should start now.
2. **Payfac obligations** — as platform, venues are Merchants of Record; we must pass sub-merchant data (store config carries it). Card-scheme payfac registration thresholds: ask Adyen.
3. **Unreferenced refunds + multiple partial captures need Adyen Support enablement** — request during onboarding.
4. **UK Tap to Pay on Android unsupported** (iPhone OK) — moot while AMS1-only, noted for future MPOS ambitions.
5. **Token portability across venues** (Unified Commerce) — account-structure precondition unconfirmed; ask Adyen.
6. **Two regions = two balance platforms** (UK/EU + US) — onboarding fn must pick by venue country.
7. Reconciler/report ingestion must tolerate **weekend/holiday payout gaps** and refunds netting inside payout batches.

## 8. What Peter does now (everything else is on me)

1. **Create the free test account** — adyen.com/signup (5 minutes, no contract). Gets us test API keys.
2. **Start the Adyen commercial conversation** — say: *UK+US hospitality POS ISV, Adyen for Platforms with hosted onboarding, sub-merchant venues, AMS1 fleet, need balance platform enabled on our test account.* Ask about payfac registration + AfP pricing.
3. **Order test AMS1 units** from the test Customer Area once it exists — one UK, one US, + test card pack.
4. Keep the Lightspeed access alive — we'll want detail screenshots (payment drill-in, dispute detail) as we build Phase 5.
