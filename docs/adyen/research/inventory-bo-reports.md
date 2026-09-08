# BO Payment/Finance Reports & Customer-Facing Money UI — Adyen Migration Audit

Repo: `/Users/peterroberts/Library/CloudStorage/Dropbox/POSUP/Claude Code/Test POS app/possystem`
All paths below are relative to that root. Ops DB = `tbetcegmszzotrwdtqhi`; platform DB holds `merchant_ryft_accounts`, `merchant_ryft_disputes`, `gift_*` tables.

## 0. Shared data plumbing (read this first)

- **`src/backoffice/sections/BOReports.jsx`** is the reports shell. It loads `closed_checks` (ops DB) via `fetchClosedChecksRange(locId, from, to, 5000)` from `src/lib/db.js:660` and passes the mapped rows (`checks` prop) into every in-shell report. Realtime store checks are merged in, deduped by id.
- Payment fields persisted per check (`src/lib/db.js:556-558`): `closed_checks.stripe_payment_intent_id`, `closed_checks.payment_intents` (jsonb — all card legs, each optionally carrying a `card` block), `closed_checks.processor` (**defaults to `'stripe'`** on write AND on read-mapping at `db.js:649-651, 692-694`; also defaulted at `src/store/index.js:4416, 4940`). Refunds live in `closed_checks.refunds[]` jsonb + `status` (`paid` / `partial_refund` / `refunded` / `voided`).
- **Adyen equivalent:** every check must be stamped `processor:'adyen'` with the Adyen **pspReference** in the `payment_intents[]` leg id slot; the silent `'stripe'` default in 4 places is a migration landmine — make it explicit or re-default.

---

## 1. Report-by-report

### 1.1 Payments report — `src/backoffice/sections/reports/Payments.jsx`
- **Shows:** revenue/count/tips by payment-method bucket (cash / card / apple-pay / google-pay / split / other) with share %, CSV export, plus a cash-reconciliation helper panel.
- **Source:** `checks` prop → `closed_checks` aggregation in-memory. `bucket()` (line 12) normalises `check.method`; note line 18 treats `'stripe'|'terminal'|'contactless'|'chip'` as card synonyms.
- **Coupling:** processor-agnostic (own tables). Only string coupling: `bucket()`.
- **Adyen must:** ensure whatever `method` string Adyen payments record (recommend keeping `'card'`) maps into the card bucket; add `'adyen'` as a synonym for safety. Wallet detection (Apple/Google Pay) currently keys on the method string — Adyen card-present wallet taps will land in generic "card" unless the new capture path writes a wallet-aware method or the report reads `payment_intents[].card`.

### 1.2 Card Payments & Payouts — `src/backoffice/sections/reports/RyftPayouts.jsx` (catalog id `ryft_payouts`, label "Card payments & payouts")
- **Shows:** available/pending balance, Sales (recent) / Fees (recent) / Refunds (recent) tiles, payout table (created, amount, status, scheduleType, completed, failureReason), CSV export.
- **Source:** 100% live processor API. Self-fetching `POST /functions/v1/payments-onboard` with `action:'report'` (`supabase/functions/payments-onboard/index.ts:97-129`), which calls Ryft `listBalances`, `listPayouts(acct, 50)`, `listBalanceTransactions(opts, 50)` from `supabase/functions/_shared/ryft.ts`, scoped to the location's sub-account via platform `merchant_ryft_accounts.ryft_account_id`. Summary tiles are derived by regexing balance-transaction `type` for `capture`/`refund` and summing `feeTotal`.
- **Coupling:** HARD Ryft-coupled — full rebuild.
- **Adyen must:** replace with Adyen Balance Platform equivalents — balance per venue (balance account), payout history (Transfers/payout webhooks or Settlement details report), and per-period sales/fees/refunds from settlement detail lines instead of "last 50 balance transactions". Note today's report **ignores the BOReports period filter entirely** (fixed last-50 window) — fix that in the rebuild.

### 1.3 Disputes — `src/backoffice/sections/reports/RyftDisputes.jsx` (catalog id `ryft_disputes`, "Disputes & chargebacks")
- **Shows:** open-dispute count, at-stake total, per-dispute card (amount, status, category, reason, respond-by countdown with 72h urgency, recommended evidence), Accept / Challenge (free-text defence) actions.
- **Source:** hybrid. `list` reads OUR mirror table platform `merchant_ryft_disputes` via `supabase/functions/ryft-disputes/index.ts` (columns: `dispute_id, payment_session_id, amount, currency, status, category, reason_code, reason_description, respond_by, recommended_evidence, evidence, raw`). Rows are written by `supabase/functions/ryft-webhook/index.ts:340-372` on `Dispute.*` events (+ email alert `alertDispute` on `Dispute.created`). `accept` / `challenge` / `submit_evidence` call Ryft API (`acceptDispute`, `challengeDispute`, `addDisputeEvidence`) with the sub-account header, then `syncRow` refreshes the mirror.
- **Coupling:** API actions + webhook ingest are Ryft; the mirror-table pattern itself is processor-neutral.
- **Adyen must:** ingest Adyen dispute webhooks (chargeback notification lifecycle) into a renamed processor-neutral mirror table; implement accept (`acceptDispute`) and defend via Adyen Disputes API — **Adyen defence requires a defense-reason code plus typed defense documents (file upload), not free text**, so the text-only defence UI needs a document-upload step; keep the respond-by countdown (Adyen supplies defense period end).

### 1.4 Z Report — `src/backoffice/sections/reports/ZReport.jsx`
- **Shows:** printable 80mm end-of-day snapshot — sales ladder (gross → discounts/voids/refunds → net), tax by rate (re-derived from `taxRates` per item), service & tips, grand total, payment methods (raw `c.method` strings), order types, cash-drawer expected with hand-written Counted/Variance lines, manager sign-off. `shift.zNumber` shown ('—' when absent; file notes a future `z_reports` audit table).
- **Source:** `checks` prop (closed_checks aggregation) + store `taxRates`, `shift`, `locationProfile`.
- **Coupling:** processor-agnostic. Method labels print raw strings, so an Adyen-era method value flows straight through.
- **Adyen must:** nothing structurally; a best-in-class Z adds a card-batch section (captured vs refunded per scheme vs processor totals) — see gaps.

### 1.5 EOD Close — `src/backoffice/sections/EODClose.jsx`
- **Shows:** three-state close-day flow; day totals (revenue/cash/card/other/tax/tips/checks/covers), per-drawer cash-up cards (opening float, cash sales, drops, expenses, expected/declared/variance, denomination counts), payment-method table, close button that snapshots a `zReport` object into `finaliseShift`.
- **Source:** store `closedChecks` filtered by `c.shiftId === currentShift.id`, plus ops `drawer_sessions` and `cash_movements` by `shift_id`.
- **Coupling:** processor-agnostic EXCEPT line ~99-100: card bucket is `c.method === 'card' || c.method === 'stripe'` — hard-coded `'stripe'` string.
- **Adyen must:** include Adyen method strings in the card bucket (or normalise via the shared `bucket()`); the bigger ask is settlement awareness — EOD close never compares card takings to processor-captured totals (gap 5).

### 1.6 Shifts report — `src/backoffice/sections/reports/Shifts.jsx`
- **Shows:** business-day (or service-period, when `locationConfig.shifts` set) rollups — revenue, covers, tips, cash (method `'cash'` only), voids, discounts, refunds, per-server sessions; CSV.
- **Source:** closed-check timestamps only.
- **Coupling:** processor-agnostic. No Adyen work.

### 1.7 Cash Drawer report — `src/backoffice/sections/reports/CashDrawer.jsx`
- **Shows:** every drawer session in period with opening float, cash sales, drops, expenses, expected (recomputed from movements via `TYPE_META` signs), declared, variance, movement log, rollup tiles, CSV.
- **Source:** ops `drawer_sessions` (by `cash_in_at` window) + `cash_movements` (by `timestamp`), joined in-memory by `session_id`; drawer names from store `cashDrawers`.
- **Coupling:** processor-agnostic. No Adyen work.

### 1.8 CashDrawers section — `src/backoffice/sections/CashDrawers.jsx`
- Drawer registry (name, kick printer, strict 1:1 POS device binding) + `DrawerCashModal` cash-in/out. Ops tables as above. Processor-agnostic. No Adyen work.

### 1.9 Transactions browser — `src/backoffice/sections/Transactions.jsx` (catalog "Transactions & refunds")
- **Shows:** all closed checks with search (ref/server/customer/id), status/method/source filters, summary tiles (count, revenue, tips, service, refunded), expandable row (line items, discounts, totals, tax, refund history with manager+reason, delivery info, check id), email-receipt sender, and the **BO refund modal** (full or item-level, reason required, confirm checkbox) → `refundCheck`.
- **Source:** `checks` prop (closed_checks). Method filter values are raw `check.method` strings.
- **Coupling:** UI processor-agnostic; the refund ACTION is processor-routed (below).

### 1.10 Refund engine — `src/store/index.js` `refundCheck` (line 5008)
The single choke point every refund UI funnels through. On refund it:
1. Appends to `closedChecks[].refunds` + recomputes status; persists via `updateClosedCheckRefunds` (`src/lib/db.js:588`).
2. Reverses stock (`reverseForSale`), gift legs (`gift-reverse-redeem` via `reverseGiftCard`, full refunds only), loyalty (`loyalty-refund` edge fn).
3. **Card money:** collects legs from `check.paymentIntents[]` (fallback `stripePaymentIntentId`), routes by `check.processor` (line 5151): `'ryft'` → `supabase/functions/ryft-refund` (body `payment_session_id`, `amount_minor`, `idempotency_key: refund:{checkId}:{pi.id}`), else → `supabase/functions/stripe-refund` (body `payment_intent_id`, ...same). Allocates a partial refund front-to-back across legs, capping each multi-leg at its captured `amountMinor`. Fire-and-forget; failures are only `console.warn` + no ledger.
4. If method includes card but no captured leg exists → honest "refund manually" toast.
- **Refund UIs calling it:** BO `Transactions.jsx`; POS `src/components/CheckHistory.jsx` (item-select → reason → tender card/cash → process); plus `src/surfaces/CheckoutModal.jsx`, `src/surfaces/OrdersHub.jsx`, `src/surfaces/mpos/MOrderDetail.jsx`, `src/surfaces/qr/TabResumeScreen.jsx`.
- **Adyen must:** add a third branch — `check.processor === 'adyen'` → new `adyen-refund` edge fn refunding by **pspReference** (`/payments/{pspReference}/refunds`) with the same per-leg idempotency key; keep the leg-allocation maths untouched. Both existing refund edge fns only resolve the merchant account and call the processor — neither writes a refund ledger row (see gap 6).

### 1.11 Daily Trading P&L — `src/backoffice/sections/reports/DailyTrading.jsx` + `supabase/functions/trading-report`
- **Shows:** per-day forecast vs actual, ladder gross takings (inc VAT) → VAT → net sales → COGS → GP → waste/labour/overhead → operating profit.
- **Source:** server-side from `closed_checks` (`tax_amount` for VAT), `wf_*` labour, stock ledger. **There is no card-takings line** — takings are total-level, not per-method.
- **Coupling:** processor-agnostic. No Adyen work. (If a "card takings vs deposit" line is ever wanted, it belongs to the settlement-recon gap, not this fn.)

### 1.12 Receipt card-metadata block (customer-facing)
- **Normaliser:** `src/lib/cardReceipt.js` — pure functions `cardReceiptOf` / `cardReceiptLines` / `cardReceiptSummary`; fields brand, last4 (PCI-truncated), authCode, aid, applicationName, readMethod (entry mode), cvm; reads `check.cardReceipt` / `check.card_receipt` or falls back to `payment_intents[].card`.
- **Renderers:** ESC/POS `src/lib/printer.js:239` and HTML fallback `printer.js:~498-505`; email/plain-text receipts `src/lib/sendReceipt.js:324, 434`. All print "Please retain this receipt" per UK scheme rules.
- **Capture:** built at payment time from reader-poll payloads — `src/surfaces/CheckoutModal.jsx:1407/1486` and the reconciler path `src/store/index.js:4536` (`job.card` → `{brand|scheme, last4, auth_code→auth, aid, cvm, entry_mode}`), sourced from `stripe-poll-reader-action` / `ryft-terminal-poll`. Persisted onto `closed_checks.payment_intents[0].card` via `attachCardToIntents` (`store/index.js:39`).
- **Adyen must:** the new terminal-payment/poll edge fn must map the Adyen Terminal API response (cardSummary/maskedPan → last4, paymentBrand → brand/scheme, authCode, applicationId → AID, applicationLabel, POSEntryMode → entry_mode, CVM) into the exact same `card` object; `normalise()` already tolerates snake/camel variants, so zero renderer changes if the poll fn emits the same shape. Add Adyen brand strings (e.g. `mc`, `visa`) to `BRAND_LABEL` if raw scheme codes differ.

### 1.13 Gift card BO — `src/backoffice/sections/GiftCards.jsx`
- **Shows:** enable toggle, branding, issue/lookup/void/bulk, and **PurchasesPanel** (line ~1256): platform `gift_card_purchases` (amount_minor, status pending→paid→fulfilled, code_last4/fulfilled_code, sender/recipient, delivery_type) with manual `gift-fulfill` retry. Panel copy: "Gift cards bought by customers via Stripe Checkout".
- **Coupling:** card issuance/redemption ledger (`gift_cards`, `gift_card_transactions`) is our own — processor-agnostic. The **online purchase payment leg is Stripe Checkout** (gift-purchase flow + webhook drives `status:'paid'`).
- **Adyen must:** repoint the customer gift-purchase checkout to Adyen (Sessions/Pay by Link), drive `gift_card_purchases.status` from the Adyen AUTHORISATION webhook, and fix the UI copy. Refund-of-gift-purchase would also route via the Adyen refund fn.

---

## 2. Coupling summary

| Surface | File | Coupling |
|---|---|---|
| Payments report | `reports/Payments.jsx` | Agnostic (method-string synonym `'stripe'`) |
| Card Payments & Payouts | `reports/RyftPayouts.jsx` + `payments-onboard` fn | **HARD Ryft — rebuild** |
| Disputes | `reports/RyftDisputes.jsx` + `ryft-disputes`/`ryft-webhook` fns + `merchant_ryft_disputes` | **HARD Ryft — rebuild ingest + actions; keep mirror pattern** |
| Z Report | `reports/ZReport.jsx` | Agnostic |
| EOD Close | `sections/EODClose.jsx` | Agnostic (hard-coded `'stripe'` in card bucket, line ~100) |
| Shifts | `reports/Shifts.jsx` | Agnostic |
| Cash Drawer report / registry | `reports/CashDrawer.jsx`, `sections/CashDrawers.jsx` | Agnostic |
| Transactions & refunds | `sections/Transactions.jsx` → store `refundCheck` → `ryft-refund`/`stripe-refund` | UI agnostic; **refund routing needs `adyen` branch** |
| Daily Trading | `reports/DailyTrading.jsx` + `trading-report` fn | Agnostic |
| Receipt card block | `lib/cardReceipt.js`, `lib/printer.js`, `lib/sendReceipt.js` | Agnostic normaliser; **capture path must emit same shape** |
| Gift card BO | `sections/GiftCards.jsx` | Ledger agnostic; **online purchase = Stripe Checkout** |

## 3. Gaps vs a best-in-class hospitality processor report suite (build with Adyen)

1. **Settlement/payout reconciliation per venue** — payouts are a bare list with no drill-down: nothing joins a payout to the transactions/checks it settles, no "card takings on date D vs deposit on D+2" variance, no multi-location settlement rollup (LocationCompare has no money-movement view). Adyen settlement-detail reports key every line to a pspReference → joinable to `closed_checks.payment_intents`.
2. **Fees breakdown** — today one "Fees (recent)" tile summing `feeTotal` over the last 50 balance transactions. No per-transaction fee, no interchange/scheme/markup split, no fee-by-card-brand, no effective blended rate, no period alignment. (Negotiated markup exists in `merchant_ryft_accounts.markup_percent/markup_fixed_pence` but only surfaces on the onboarding card.)
3. **Chargeback lifecycle** — no status timeline/history per dispute, text-only defence with no evidence file upload (Adyen requires typed defense documents), no won/lost analytics or dispute-rate KPI, and `payment_session_id` is stored but never joined back to the originating closed check/receipt in the UI.
4. **Card-brand mix** — brand/last4/entry-mode are captured per check (`payment_intents[].card`) but NO report aggregates by scheme, wallet, or contactless/chip/keyed. Cheap win: aggregate existing data; Adyen reports add it server-side.
5. **Batch/settlement history in Z/EOD** — Z report and EOD close have zero card-batch awareness: no captured-vs-refunded per day vs processor totals, no auth'd-but-uncaptured list, no batch sequence numbers.
6. **Refund/decline ledger** — processor refunds are fire-and-forget (`console.warn` on failure; no table row), so a failed card refund is invisible in every report; declined payments never reach `closed_checks` at all, so decline-rate analytics are impossible. Adyen REFUND/REFUND_FAILED and AUTHORISATION(refused) webhooks should feed a payments-events ledger.
7. **Misc parity items** — payout-failure alerts, tips-on-card vs payout reconciliation (Tipping Act relevance), period-filtered processor reporting (current report is fixed last-50), and a `z_reports` audit table with auto-incrementing Z numbers (already flagged as future work in `ZReport.jsx:231`).