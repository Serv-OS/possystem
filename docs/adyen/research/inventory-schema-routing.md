# Adyen Migration Audit — Payment Data Model + Processor Routing
Repo: `/Users/peterroberts/Library/CloudStorage/Dropbox/POSUP/Claude Code/Test POS app/possystem`
All paths relative to repo root. Ops DB = tbetcegmszzotrwdtqhi, Platform DB = yhzjgyrkyjabvhblqxzu.

---

## 1. THE PROCESSOR SWITCH — where "stripe vs ryft" lives

| Item | Detail |
|---|---|
| **Config column** | PLATFORM `locations.payment_processor` text NOT NULL default `'stripe'`, `CHECK (payment_processor in ('stripe','ryft'))` — `supabase/migrations/20260611_platform_ryft_foundation.sql` |
| **Resolver edge fn** | `supabase/functions/payments-processor/index.ts` — accepts EITHER id space (tries `locations.ops_location_id`, falls back to `locations.id`); hard-codes `loc.payment_processor === 'ryft' ? 'ryft' : 'stripe'` — an 'adyen' row would silently answer 'stripe' |
| **Client resolver** | `src/lib/payments/processor.js` — `getLocationProcessorInfo()` / `getLocationProcessor()`; caches per-location; **line 29 whitelist** `(data?.processor === 'ryft' || data?.processor === 'stripe')` — an unknown value is treated as non-definitive and downgraded to stripe. Fail-safe default is 'stripe' everywhere |
| **Admin setter** | `supabase/functions/payments-admin/index.ts` action `set_processor` (line ~137) rejects anything but 'stripe'/'ryft'; writes `locations.payment_processor`. Client UI: `src/admin/sections/AdminBillingManager.jsx` line 197 |
| **Onboarding** | `supabase/functions/payments-onboard/index.ts` — refuses unless `payment_processor === 'ryft'`; drives Ryft hosted onboarding → `merchant_ryft_accounts`; also serves LIVE balance + payouts to the BO report |

**Adyen must:** widen the platform CHECK to include `'adyen'`; make `payments-processor` return `'adyen'`; add `'adyen'` to the client whitelist in processor.js:29 (else every Adyen venue silently resolves stripe); three-way `set_processor`; a new `payments-onboard` branch doing Adyen account-holder onboarding into a new `merchant_adyen_accounts` table.

### 1b. Every client site that branches on processor

| File | Lines | What it does on 'ryft' vs 'stripe' | Adyen change |
|---|---|---|---|
| `src/surfaces/CheckoutModal.jsx` | 12, 51–100, 166–230, 351–460, 1205–1280, 1649–1660, 1980–2130 | ryft → `runRyftTerminalFlow()` (chargeRyftTerminal) OR PAX dispatch (`startTerminalJob` when `paxLookupDone && cardProcessor==='ryft' && paxTarget`); on-screen tip (Ryft has no reader tip prompt); stripe → `stripe-process-payment-on-reader` poll loop | third branch; decide Adyen tip location (terminal prompt exists on Adyen) |
| `src/components/SplitModal.jsx` | 48, 173–260, 391–430 | per-leg dispatch by `processorRef`; ryft legs go through terminal_jobs (`pos_split_leg`) | third branch, per-leg |
| `src/components/TabPreAuthTerminal.jsx` | 4, 24, 63–79, 235 | **definitive 'ryft' → state `ryft_unsupported`** (bar-tab pre-auth is Stripe-ONLY: Ryft is online-only for holds) | Adyen supports card-present pre-auth — either implement or an `adyen_unsupported` state |
| `src/surfaces/BarSurface.jsx` | 10, 189–200, 361, 396–415 | ryft-definitive check gates the pre-auth toggle; close stamps `processor` + `cardReceipt` on the check | third branch |
| `src/surfaces/KioskApp.jsx` | 36, 3036–3040, 2953–3018 | ryft → `startRyftTerminalPayment()` (findPaxTerminal → dispatchTerminalJob, `checkDraft.source:'kiosk_send_to_terminal'`, suppress_tip); stripe → reader edge fn | third branch |
| `src/surfaces/online/OnlineCheckout.jsx` | 28, 83, 622, 974, 1037–1038, 1173 | ryft → in-page `RyftPaymentForm`; payId = ps_ session id; writes it into `closed_checks.stripe_payment_intent_id` + `payment_intents` | AdyenPaymentForm (Drop-in); pspReference as payId |
| `src/surfaces/qr/QrCheckout.jsx` | 22, 58, 255, 320–400, 649 | tab metadata into `order_queue.customer` jsonb (see §6) | third branch + adyen jsonb keys |
| `src/surfaces/catering/CateringCheckout.jsx` | 14, 58, 167, 312 | same pattern as online | third branch |
| `src/surfaces/gift/GiftPurchaseSurface.jsx` | 14, 41–90, 241–260 | SERVER decides; response `processor==='ryft' && clientSecret` → in-page form, else Stripe hosted-checkout redirect | third response shape |
| `src/sync/TerminalJobReconciler.js` | 19, 32–43 | reconciler ONLY runs when `proc === 'ryft'` — a Stripe venue stays idle | must also run for 'adyen' if Adyen terminals use terminal_jobs |
| `src/backoffice/sections/CardReaders.jsx` | 17, 74 | processor gates Stripe reader auto-status-check; PAX pairing UI lives here | show Adyen terminal fleet |
| `src/surfaces/OrdersHub.jsx` | 237–268, 362–377, 424–560 | QR tab close: `tab.processor==='ryft'` → `ryftTab('capture'/'void'/'overage')`; stripe → `/api/stripe-capture` + `/api/stripe-charge-overage` (Vercel); **missing processor defaults 'stripe'** | third branch (adyen capture/void/MIT-overage) |
| `src/store/index.js` (refundCheck) | 5148–5216 | `check.processor === 'ryft' ? 'ryft-refund' : 'stripe-refund'`; body key `payment_session_id` vs `payment_intent_id`; **binary — an 'adyen' check would refund via STRIPE** | three-way route + `psp_reference` body key |
| `src/lib/payments/ryft.js` / `ryftTerminal.js` | whole files | Ryft SDK loader (`https://embedded.ryftpay.com/v2/ryft.min.js`), session creation, tab lifecycle, in-person poll loop | Adyen equivalents: `src/lib/payments/adyen.js` (Web SDK is npm-installable — note repo rule: static imports only), adyenTerminal.js |
| `android/paxpay/` (Java) | `PaymentFlow.java`, `ServerG8CloudClient.java`, `RecoveryRunner.java`, `MainActivity.java`, `ControllerResolver.java`, ui/* | PAX A920 app; charges happen SERVER-side via `terminal-job-charge` (app never holds keys) | if PAX stays: rewrite server charge on Adyen Terminal API; if Adyen hardware: whole PAX app replaced |

---

## 2. closed_checks (OPS) — the payment record

Base: `supabase-schema.sql:77` (stale — many live columns added later). The one row map: **`closedCheckRow()` in `src/lib/db.js:526–559`** (shared by `insertClosedCheck` + `upsertClosedCheck`); read maps at db.js:628–654 and 671–697. Record builder: `buildCloseRecord` `src/store/index.js:~4360–4426`.

| Column | Type / origin | Adyen equivalent must |
|---|---|---|
| `method` | text — 'card' / 'cash' / 'split' / 'card-external' / gift mixes | unchanged (tender, not processor) |
| `subtotal`, `service`, `tip`, `total` | numeric £ | unchanged |
| `tax_amount` (v4.6.19), `tax_breakdown` jsonb (v5.5.853) | VAT; feeds Daily Trading P&L | unchanged |
| `processor` | text, client-defaulted 'stripe' (db.js:558). **No DB CHECK constraint in repo** — verify live DB | write `'adyen'`; every `\|\| 'stripe'` fallback is a mislabel risk for old rows only |
| `stripe_payment_intent_id` | text — holds **pi_ OR Ryft ps_** (name is a lie). ryft-webhook matches on it (`supabase/functions/ryft-webhook/index.ts:183`) | hold Adyen pspReference too, OR add `psp_reference` and update webhook match |
| `payment_intents` | jsonb `[{id, amountMinor, card?}]` — one entry PER CARD LEG. Migration `supabase/migrations/20260529_closed_checks_payment_intents.sql`. Card-scheme block (brand/last4/auth/AID/CVM, v5.5.719) attached to leg[0] by `attachCardToIntents` `src/store/index.js:39–63` | same shape, id = pspReference per leg; card block from Adyen additionalData |
| `gift_card` | jsonb (v5.5.217; v5.5.902 split gift legs) — drives gift reversal on refund | unchanged |
| `refunds` jsonb + `status` | written by refundCheck + `updateClosedCheckRefunds` db.js:596; ALSO written server-side by ryft-webhook on dashboard refunds (line 257) | adyen-webhook must mirror the server-side refund reflection |
| `promo` | jsonb — `supabase/migrations/20260727_closed_checks_promo.sql` | unchanged |
| `source` | CHECK `closed_checks_source_check` — `20260729h_closed_checks_source_terminal.sql`; **rule: any new source value ⇒ widen constraint first** | no change unless a new channel is added |

---

## 3. terminal_devices + terminal_jobs (OPS) — PAX card-present

### terminal_devices — `supabase/migrations/20260722_terminal_devices.sql`
- `ryft_terminal_id` text — soft link → Platform `payment_devices.ryft_terminal_id`; unique partial idx `idx_td_ryft` (paired only).
- `tip_config` jsonb (writer: `20260723_terminal_settings.sql`), `bound_pos_device_id`, claim/heartbeat model, PIN throttle.
- Re-pair carry-forward of the Ryft link: `20260731_terminal_ryft_link.sql` (`claim_terminal_device` captures retiring row's `ryft_terminal_id`; `terminal_targets_for_pos` RPC returns it to the POS — DROP+CREATE drops grants, re-issue them).
- **Adyen:** add `adyen_terminal_id` (POIID) or generalise to `processor_terminal_id` + `processor`; replicate carry-forward + unique index; update `terminal_targets_for_pos` shape (and re-grant).

### terminal_jobs — `supabase/migrations/20260722b_terminal_jobs.sql`
- Money: `tip_basis_minor` / `due_minor` / `tip_minor` / `charge_minor` bigint + `tj_charge_identity` CHECK; `reported_minor` compared-not-trusted.
- **`processor` text NOT NULL default `'ryft'`** — jobs are Ryft-only today.
- Ryft settle columns: `payment_session_id` (ps_, unique partial idx), `account_id` (sub-account), `verified_source`, `verified_at` — `20260729_terminal_jobs_ryft_settle.sql`; single settle writer RPC `terminal_job_settle_from_processor`; `terminal_report_result`.
- Card metadata: `transaction_id`, `auth_code`, `card` jsonb, `decline_reason`.
- Mutexes: `idx_tj_one_live_per_check`, `idx_tj_one_live_per_terminal`; paid-guard migrations `20260730_terminal_double_charge_guard.sql`, `20260801_terminal_paid_guard_occupation.sql`, `20260802_tj_paid_guard_index.sql`; kiosk binding `20260804_terminal_kiosk_binding.sql`.
- `check_draft.source` values: `pax_table_pay`, `pos_send_to_terminal`, `pos_split_leg`, `kiosk_send_to_terminal`; reconciler filter `RECONCILABLE_SOURCES` `src/lib/payments/terminalJobs.js:496`.
- Table Pay bill stamp: `active_sessions.subtotal_minor` / `total_minor` / `totals_at` (bottom of 20260722b), fed by `sessionTotalsMinor()` in `src/lib/payments/checkTotals.js:91` via SessionSync; `terminal_start_table_payment` refuses without it.

### Edge fns
`terminal-job-create`, `terminal-job-charge`, `terminal-job-status`, `terminal-job-cancel`, `terminal-job-reconcile`. **`terminal-job-charge/index.ts` is the one that talks to the processor**: `createTerminalPayment` from `supabase/functions/_shared/ryft.ts`; reconciles ops↔platform terminal-id drift against `payment_devices` (lines 233–256); resolves sub-account + platformFee markup from `merchant_ryft_accounts` / `platform_settings` (lines 260–270); settles through `terminal_job_settle_from_processor` only.

**Adyen must:** relabel/parameterise `terminal_jobs.processor` (default 'ryft' would mislabel Adyen jobs); map `payment_session_id`→pspReference, `account_id`→merchant/store; rewrite terminal-job-charge on Adyen Terminal API (sync/async nexo) keeping the settle-writer + drift-reconcile pattern; keep client `src/lib/payments/terminalJobs.js` untouched (it is processor-blind).

---

## 4. payment_devices (PLATFORM) — reader/terminal registry

- Created Stripe-shaped: `supabase-billing-schema-v4.sql:22` (`stripe_reader_id` unique, `stripe_account_id`, `device_type`, `connection_kind` CHECK ('bluetooth','network','tap_to_pay'), `bound_pos_device_id`, status/battery/last_seen).
- Ryft-ified: `supabase/migrations/20260719_PLATFORM_ryft_terminal_pairing.sql` — adds `processor` (CHECK `payment_devices_processor_check` in ('stripe','ryft')), `ryft_terminal_id` + `uq_payment_devices_ryft_terminal_id`, `serial_number`, `bound_pos_device_id`, `status`, `registered_by_user_id`; relaxes 4 Stripe NOT NULLs; conditional CHECK `payment_devices_processor_fields_check` (stripe rows need Stripe fields; ryft rows need ryft_terminal_id). `connection_kind` stays NULL on non-Stripe rows so `getAssignedNetworkReader()` (`src/lib/networkReader.js`) never mistakes them for Stripe network readers.
- Writers: `supabase/functions/ryft-terminals/index.ts` (upsert onConflict `ryft_terminal_id`; reads `merchant_ryft_accounts.ryft_inperson_location_id`), `stripe-register-network-reader`, `stripe-unregister-reader`, `stripe-readers-status`, `stripe-assign-reader-to-pos`.
- Readers: `src/backoffice/sections/CardReaders.jsx:84`, `src/components/StatusDrawerCardReaders.jsx`, `src/lib/networkReader.js`, `src/lib/readerDisplay.js`, `src/surfaces/POSSurface.jsx`.
- **Adyen must:** widen BOTH check constraints; add `adyen_terminal_id` (+ unique) and require it on adyen rows; a registration fn (Adyen terminal fleet API or manual POIID entry); keep connection_kind NULL.

Related per-location reader config: `location_reader_settings` (PLATFORM, `supabase-billing-schema-v5.sql`) — tipping (`tipping_enabled`, `tip_percentages int[]`, `allow_custom_tip`, `smart_tip_threshold_minor`), idle screen, `stripe_configuration_id`. Ryft path froze tips onto `terminal_devices.tip_config` instead. **Adyen:** map tipping to Adyen terminal config or reuse tip_config path; `stripe_configuration_id` has no Adyen meaning.

---

## 5. Merchant accounts, pricing, ledger, disputes, webhooks (PLATFORM)

| Table | Migration | Key columns | Adyen equivalent |
|---|---|---|---|
| `merchant_stripe_accounts` | `supabase-billing-schema-v2.sql` (+markup v3) | stripe account id, charges/payouts/details flags, `cardpresent_markup_percent`, `online_markup_percent` | — (retire) |
| `merchant_ryft_accounts` | `20260611_platform_ryft_foundation.sql` + pricing `20260611b–f` | `ryft_account_id` (acc_), charges/payouts/details flags, `requirements` jsonb, `markup_percent`, `markup_fixed_pence`, `ryft_inperson_location_id` (20260719), `last_webhook_at` | `merchant_adyen_accounts`: account-holder id, balance-account id, store id(s), capability flags, markup columns, last_webhook_at |
| `platform_settings` | `supabase-billing-schema-v3.sql:28` | `default_ryft_markup_percent`, `default_ryft_markup_fixed_pence` | `default_adyen_markup_*` |
| `ryft_webhook_events` | `20260612b_ryft_webhook_dedupe.sql` | event_id PK dedupe | `adyen_webhook_events` (dedupe on pspReference+eventCode; HMAC verify — Ryft's is `RYFT_WEBHOOK_SECRET` in ryft-webhook:28) |
| `ryft_payments` | `20260612c_ryft_payments_ledger.sql` | server-truth capture/refund ledger; `matched_closed_check` (orphan-capture recovery); amount/amount_refunded minor | `adyen_payments` ledger written by adyen-webhook, same reconcile: match closed_checks via `stripe_payment_intent_id` = ref OR `payment_intents @> [{id}]` (ryft-webhook:183–188), terminal_jobs via `payment_session_id` (ryft-webhook:220) |
| `merchant_ryft_disputes` | `20260612_ryft_disputes.sql` | dispute_id, respond_by DEADLINE, status/category, evidence jsonb | `merchant_adyen_disputes` fed by CHARGEBACK/NOTIFICATION_OF_CHARGEBACK/REQUEST_FOR_INFORMATION webhooks; keep the countdown UX (`src/backoffice/sections/reports/RyftDisputes.jsx` + `supabase/functions/ryft-disputes`) |

**Platform-fee model:** platformFee = markup% × amount + fixed pence, computed in `ryft-create-payment-session/index.ts:65–96` and `terminal-job-charge/index.ts:260–270`, sent as Ryft `platformFee` on the sub-account session. **Adyen equivalent:** split at payment time (Adyen `splits[]` on /payments) or Balance Platform transfer — this is the revenue line, do not drop it.

**Payouts:** NO local payout/settlement tables. `src/backoffice/sections/reports/RyftPayouts.jsx` reads live balance + payout list through `payments-onboard`. Adyen: read-through to Balance Platform payouts in the new onboard/admin fn.

**SaaS billing:** `20260727c_saas_billing.sql` (PLATFORM) — GTV tiers, fee collected from the venue's **Ryft balance**; unique index enforces once-per-period. Adyen: collector must move to Adyen balance-account debits.

---

## 6. Bar tabs + QR tabs (pre-auth / holds)

### bar_tabs (OPS) — `migrations/2026-04-22-order-queue-bar-tabs-sync.sql:23`
- Columns: `pre_auth` boolean, `pre_auth_amount` numeric ONLY.
- **The hold identifiers are NOT persisted**: `preAuthPaymentIntentId`, `preAuthStripeAccount`, `preAuthHeldMinor` live only in the Zustand store (`src/store/index.js:3333–3360, 3479`) — `tabToRow()` in `src/sync/QueueSync.js:76–93` omits them. A till reload on another device loses the hold reference. Adyen migration is the moment to persist them (new columns or jsonb).
- Flow (all Stripe-only): open hold `src/components/TabPreAuthTerminal.jsx` (manual-capture PI via `stripe-process-payment-on-reader`; **Ryft venues get `ryft_unsupported`**); raise `stripe-increment-authorization`; release `stripe-cancel-reader-action`; capture `/api/stripe-capture` (Vercel, `api/stripe-capture.js`) — `src/surfaces/BarSurface.jsx:420–515`.
- **Adyen:** pre-auth = authorisation-only payment; raise = amountUpdates; capture = /captures; release = /cancels. Needs a third branch in TabPreAuthTerminal + BarSurface, or Adyen-only replacement.

### QR open tabs (order_queue.customer jsonb — NEVER bar_tabs, per house rule)
- Written by `src/surfaces/qr/QrCheckout.jsx:320–400`: `payment_intent_id` (universal pooling key — holds ps_ on Ryft), `processor`, `stripe_account`, `payment_method_id` (Stripe off-session overage), `payment_session_id` / `ryft_customer_id` / `ryft_payment_method_id` (Ryft stored-card overage, via `readRyftStoredCard` `src/lib/payments/ryft.js:67`), `tab_open`, `pre_auth_amount`, `tab_join_code`, surcharge snapshot.
- Closed by `src/surfaces/OrdersHub.jsx:362–560`: stripe → `/api/stripe-capture` + `/api/stripe-charge-overage` (Vercel); ryft → `ryftTab('capture'|'void'|'overage')` → `supabase/functions/ryft-tab`.
- **Adyen:** new jsonb keys (`adyen_psp_reference`, `adyen_shopper_reference`, `adyen_stored_pm_id`), an `adyen-tab` fn (capture/cancel/MIT overage on token), third branch in OrdersHub close + refund note at line 551.

### order_queue payment columns — `migrations/v5.5.57-order-queue-payment-fields.sql`
`paid` boolean, `payment_method` text (+ `kitchen_routed_at`). Kiosk writes `payment_method: 'card-external' | 'split'` (`src/surfaces/KioskApp.jsx:792,914`). Processor-agnostic — no Adyen change beyond honest labels.

---

## 7. Split-payment engine

- **Totals:** `src/lib/payments/checkTotals.js` — `computeCheckTotals()` (pure; the ONE pricing implementation) + `sessionTotalsMinor()` (minor-units stamp for Table Pay). **Processor-agnostic — no Adyen change.**
- **Legs:** `src/components/SplitModal.jsx` — each card portion pays independently; ryft legs run through terminal_jobs with `check_key` suffix `:leg` (`buildCheckKey` terminalJobs.js:98) and `check_draft.source:'pos_split_leg'`; stripe legs each get their own PaymentIntent.
- **Leg → record:** `src/surfaces/CheckoutModal.jsx:2237–2275` — collects `paymentIntents = portions.filter(method==='card' && paymentIntentId).map({id, amountMinor: base+legTip})`; leg tips re-read from `terminal_jobs.tip_minor` server rows (v5.5.908 — split legs have NO reconciler, the row is the only durable tip); completion stamps ONE `processor` for the whole check (`cardProcessor || 'stripe'`) — a split is single-processor by construction. Gift legs ride in `giftCards` → `closed_checks.gift_card`.
- **Refund of a split:** store `refundCheck` allocates front-to-back across `payment_intents[]`, caps each leg at its captured `amountMinor`, per-leg idempotency key `refund:{checkId}:{pi.id}` (store/index.js:5157–5203).
- **Adyen:** legs record pspReference in the same `{id, amountMinor}` shape; the whole-check `processor` stamp and per-leg refund allocation work unchanged once the third refund route exists. Per-leg partial-capture semantics must match (Adyen refund per pspReference).

---

## 8. Gift cards (PLATFORM) — payment touchpoints only

- `gift_cards` + `gift_card_transactions` (`migrations/v5.5.193-gift-cards-phase1.sql`) — append-only tender ledger keyed on `order_id`/`channel`; **processor-agnostic, no change**.
- `gift_card_purchases` (`migrations/v5.5.196-gift-card-purchases.sql`): `stripe_session_id`, `stripe_account_id`, `stripe_payment_intent_id`; + `processor` (default 'stripe') and `ryft_payment_session_id` — `supabase/migrations/20260727b_gift_purchases_ryft.sql`. **Adyen:** add `adyen_psp_reference`; widen the processor comment/contract.
- `supabase/functions/gift-checkout-session/index.ts:99–164` — SERVER decides processor from platform `locations.payment_processor` (fail-safe stripe); ryft branch reuses `ryft-create-payment-session`; **metadata is the fulfilment contract** (`purchase_id`).
- Fulfilment: `stripe-webhook-connect` (checkout.session.completed) vs `ryft-webhook:118–134` (PaymentSession.captured → status 'paid' + stamps session id). **Adyen:** AUTHORISATION-success webhook → same purchase_id metadata → fulfil.

---

## 9. Online / catering / QR pay-now session creation

- Stripe: `supabase/functions/stripe-create-payment-intent/index.ts` (direct charge on connected account from `merchant_stripe_accounts:75`); client `src/lib/stripeClient.js`.
- Ryft: `supabase/functions/ryft-create-payment-session/index.ts` (sub-account `Account` header + platformFee); client `src/lib/payments/ryft.js` (`createRyftSession`, `loadRyft` — external SDK URL) + `src/components/RyftPaymentForm.jsx`; test harness `src/surfaces/RyftTestSurface.jsx`.
- **Adyen:** `adyen-create-session` fn (/sessions with merchantAccount + splits), `AdyenPaymentForm` (Drop-in), render-branch at OnlineCheckout:1173, QrCheckout:649, CateringCheckout:312, GiftPurchaseSurface:241–260.

---

## 10. Refund + dispute fns

| Fn | Keyed by | Notes |
|---|---|---|
| `supabase/functions/stripe-refund` | `payment_intent_id` | idempotency_key passed from client |
| `supabase/functions/ryft-refund` | `payment_session_id` | resolves `merchant_ryft_accounts.ryft_account_id` per location |
| `supabase/functions/ryft-disputes` | location-scoped read of `merchant_ryft_disputes` | report `reports/RyftDisputes.jsx` |
| **Adyen needed** | `adyen-refund` (pspReference + amount_minor + idempotency), `adyen-disputes`, defend/accept actions | wire as third branch in store refundCheck:5151–5152 |

Loyalty/gift refund reversal (`loyalty-refund`, gift reversal via `closed_checks.gift_card`) is processor-independent.

---

## 11. Env vars + docs + misc

- Ryft env (edge fns): `RYFT_SECRET_KEY`, `RYFT_API_BASE` (sandbox default), `RYFT_PUBLIC_KEY`, `RYFT_WEBHOOK_SECRET` (`_shared/ryft.ts`, `ryft-webhook`). Stripe: `STRIPE_SECRET_KEY` etc. **Adyen:** `ADYEN_API_KEY`, `ADYEN_MERCHANT_ACCOUNT`, `ADYEN_HMAC_KEY`, `ADYEN_API_BASE` (+ Terminal API creds); shared client `supabase/functions/_shared/adyen.ts` mirroring `_shared/ryft.ts`.
- `supabase/functions/_shared/ryft.ts` — the ONE Ryft REST client (payment sessions, terminal payments, refunds, terminal receipt confirm).
- Docs to supersede: `RYFT_INTEGRATION_PLAN.md`, `STRIPE_SETUP.md`, `docs/PAXPAY_TRANSPORT_SPEC.md` (spec's money-safety rules are processor-agnostic — keep them).
- **Deploy drift warning (house rule):** every touched edge fn must be deployed manually; audit with `scripts/check-deploys.mjs`. ~13 stripe-*, 10 ryft-*, 3 payments-*, 5 terminal-job-* fns are in scope.

---

## 12. Summary — everything a third value `'adyen'` must touch

**DB (Platform):** `locations.payment_processor` CHECK; `payment_devices` two CHECK constraints + `adyen_terminal_id`; new `merchant_adyen_accounts`, `adyen_webhook_events`, `adyen_payments`, `merchant_adyen_disputes`; `platform_settings.default_adyen_markup_*`; `gift_card_purchases.adyen_psp_reference`; SaaS-billing collector source.
**DB (Ops):** `terminal_jobs.processor` (default!), `payment_session_id`/`account_id` semantics; `terminal_devices` adyen terminal link + `claim_terminal_device` carry-forward + `terminal_targets_for_pos` (re-grant!); `closed_checks.processor` value + id columns semantics; optionally persist bar-tab hold refs.
**Edge fns:** payments-processor, payments-admin (set_processor), payments-onboard, gift-checkout-session, terminal-job-charge (+cancel/reconcile settle paths), new adyen-create-session / adyen-refund / adyen-webhook / adyen-tab / adyen-disputes / adyen terminal registration; retire or fence stripe-*/ryft-* per venue.
**Client:** processor.js whitelist (line 29 — the silent-downgrade trap); 14 branch sites in §1b; refundCheck three-way; OrdersHub QR-close three-way; TerminalJobReconciler gate; new AdyenPaymentForm + payments/adyen.js.
**Behavioural invariants to preserve:** fail-safe never-charge-on-unknown (processor.js definitive flag), single settle writer, per-leg idempotent refunds, pre-minted closed_check_id single-closer election, platformFee revenue line, training-mode hard stops.